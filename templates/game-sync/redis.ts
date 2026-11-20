/**
 * Redis Lua scripts and helpers for game-sync world buffer.
 */
import { MAX_LIVE_OBJECTS } from "./protocol.js";
import {
  OBJECT_ID_HEADERS_BLOB,
  OBJECT_SLOT_BYTE_LENGTH,
  WORLD_BYTE_LENGTH,
  REDIS_SIM_AT_KEY,
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
} from "./world-layout.js";

export { OBJECT_ID_HEADERS_BLOB };

/**
 * Atomic allocate: find first empty slot, enforce global live cap, write 9-float record.
 * Returns objectId (1-based) or -1 when world is full.
 *
 * ARGV[4] = 32-byte tail (8 floats: pos + dir without objectId header)
 * ARGV[5] = 100-byte objectId header lookup blob
 * ARGV[6] = sim-lock token; KEYS[2] = sim-lock key. Returns -3 (writes nothing) when the
 * lock no longer holds this token (TTL lapsed and another pod took it).
 */
export const LUA_ALLOCATE_OBJECT = `
local key = KEYS[1]
local size = tonumber(ARGV[1])
local slot_bytes = tonumber(ARGV[2])
local max_slots = tonumber(ARGV[3])
local tail = ARGV[4]
local headers = ARGV[5]

if redis.call('GET', KEYS[2]) ~= ARGV[6] then
  return -3
end

local world = redis.call('GET', key)
if not world then
  world = string.rep(string.char(0), size)
elseif #world < size then
  world = world .. string.rep(string.char(0), size - #world)
elseif #world > size then
  world = string.sub(world, 1, size)
end

local live = 0
local empty_off = nil
for i = 0, max_slots - 1 do
  local off = i * slot_bytes + 1
  local b1, b2, b3, b4 = string.byte(world, off, off + 3)
  if b1 == 0 and b2 == 0 and b3 == 0 and b4 == 0 then
    if empty_off == nil then empty_off = off end
  else
    live = live + 1
  end
end

if live >= max_slots or empty_off == nil then
  return -1
end

local slot_index = math.floor((empty_off - 1) / slot_bytes)
local object_id = slot_index + 1
local header = string.sub(headers, (object_id - 1) * 4 + 1, object_id * 4)
local new_slot = header .. tail
if #new_slot ~= slot_bytes then
  return -2
end

world = string.sub(world, 1, empty_off - 1) .. new_slot .. string.sub(world, empty_off + slot_bytes)
redis.call('SET', key, world)
return object_id
`;

/**
 * Zero the fixed slot for objectId when the header matches.
 * Returns 1 on success, 0 when slot empty or objectId mismatch, -3 (writes nothing) when
 * the sim lock (KEYS[2]) no longer holds the token in ARGV[6].
 */
export const LUA_RELEASE_OBJECT = `
local key = KEYS[1]
local size = tonumber(ARGV[1])
local slot_bytes = tonumber(ARGV[2])
local max_slots = tonumber(ARGV[3])
local object_id = tonumber(ARGV[4])
local headers = ARGV[5]

if redis.call('GET', KEYS[2]) ~= ARGV[6] then
  return -3
end

if object_id < 1 or object_id > max_slots then
  return 0
end

local world = redis.call('GET', key)
if not world then
  return 0
elseif #world < size then
  world = world .. string.rep(string.char(0), size - #world)
elseif #world > size then
  world = string.sub(world, 1, size)
end

local slot_index = object_id - 1
local off = slot_index * slot_bytes + 1
local header = string.sub(headers, (object_id - 1) * 4 + 1, object_id * 4)
local current = string.sub(world, off, off + 3)
if current ~= header then
  return 0
end

local zero_slot = string.rep(string.char(0), slot_bytes)
world = string.sub(world, 1, off - 1) .. zero_slot .. string.sub(world, off + slot_bytes)
redis.call('SET', key, world)
return 1
`;

/** Release the sim lock only while it still holds this token (KEYS[1] = lock, ARGV[1] = token). */
export const LUA_RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * One round trip for a tick: the world, the stored sim time and Redis' own clock (ms), so
 * every pod measures dt against the same clock whatever its local skew.
 * KEYS = world, sim-at. Returns {world or '', sim-at or '', now}.
 */
export const LUA_READ_WORLD = `
local world = redis.call('GET', KEYS[1])
local sim_at = redis.call('GET', KEYS[2])
local t = redis.call('TIME')
local now = string.format('%.0f', t[1] * 1000 + math.floor(t[2] / 1000))
return { world or '', sim_at or '', now }
`;

/**
 * Conditional world write: only while the lock holds the token, SET the world and sim-at
 * together. KEYS = lock, world, sim-at; ARGV = token, world bytes, sim-at ms.
 * Returns 1 when written, 0 when the lock was lost (nothing written).
 */
export const LUA_COMMIT_WORLD = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
return 1
`;

export const REDIS_EVAL_KEYS = {
  worldKey: REDIS_WORLD_KEY,
  lockKey: REDIS_SIM_LOCK_KEY,
  simAtKey: REDIS_SIM_AT_KEY,
  worldByteLength: String(WORLD_BYTE_LENGTH),
  slotByteLength: String(OBJECT_SLOT_BYTE_LENGTH),
  maxSlots: String(MAX_LIVE_OBJECTS),
  headers: OBJECT_ID_HEADERS_BLOB,
} as const;
