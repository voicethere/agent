/**
 * Redis Lua scripts and helpers for game-sync world buffer.
 */
import { MAX_LIVE_OBJECTS } from "./game-sync-protocol.js";
import {
  objectIdHeaderBytes,
  OBJECT_SLOT_BYTE_LENGTH,
  WORLD_BYTE_LENGTH,
  REDIS_WORLD_KEY,
} from "./game-sync-world-layout.js";

/** Concatenated 4-byte float32 headers for objectId 1..MAX_LIVE_OBJECTS. */
export function buildObjectIdHeadersBlob(): Buffer {
  const parts: Buffer[] = [];
  for (let objectId = 1; objectId <= MAX_LIVE_OBJECTS; objectId += 1) {
    parts.push(objectIdHeaderBytes(objectId));
  }
  return Buffer.concat(parts);
}

export const OBJECT_ID_HEADERS_BLOB = buildObjectIdHeadersBlob();

/**
 * Atomic allocate: find first empty slot, enforce global live cap, write 9-float record.
 * Returns objectId (1-based) or -1 when world is full.
 *
 * ARGV[4] = 32-byte tail (8 floats: pos + dir without objectId header)
 * ARGV[5] = 100-byte objectId header lookup blob
 */
export const LUA_ALLOCATE_OBJECT = `
local key = KEYS[1]
local size = tonumber(ARGV[1])
local slot_bytes = tonumber(ARGV[2])
local max_slots = tonumber(ARGV[3])
local tail = ARGV[4]
local headers = ARGV[5]

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
 * Returns 1 on success, 0 when slot empty or objectId mismatch.
 */
export const LUA_RELEASE_OBJECT = `
local key = KEYS[1]
local size = tonumber(ARGV[1])
local slot_bytes = tonumber(ARGV[2])
local max_slots = tonumber(ARGV[3])
local object_id = tonumber(ARGV[4])
local headers = ARGV[5]

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

export const REDIS_EVAL_KEYS = {
  worldKey: REDIS_WORLD_KEY,
  worldByteLength: String(WORLD_BYTE_LENGTH),
  slotByteLength: String(OBJECT_SLOT_BYTE_LENGTH),
  maxSlots: String(MAX_LIVE_OBJECTS),
  headers: OBJECT_ID_HEADERS_BLOB,
} as const;
