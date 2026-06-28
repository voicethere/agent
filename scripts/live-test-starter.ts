import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionPod, type VoiceSessionContext, type VoiceSessionHandler } from "@node-webrtc-rust/helpers";
import { SignalingServer } from "@node-webrtc-rust/signaling";
import type { SpeechEvent, SttVendor, TtsVendor, VoiceAgentConfig } from "@node-webrtc-rust/sdk/voice";

import type { ChildToParentMessage, ParentToChildMessage } from "../src/protocol.js";
import { resolveBundlePath, startSandboxedChild, type SandboxedChild } from "../src/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(__dirname, "..");
const DEFAULT_BUNDLE_PATH = join(AGENT_ROOT, "dist/agent.js");
const PORT = Number(process.env.LIVE_TEST_STARTER_PORT ?? process.env.PORT ?? 8080);
const SIGNALING_PATH = "/ws";
const PAGE_PATH = process.env.LIVE_TEST_PAGE_PATH?.trim() || "/examples/live-test/index.html";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface LiveSession {
  roomId: string;
  child: SandboxedChild;
  peers: Set<string>;
  pendingStartAck: Set<string>;
  bufferedBySession: Map<string, ParentToChildMessage[]>;
}

const liveRooms = new Map<string, LiveSession>();
const sessionContexts = new Map<string, VoiceSessionContext>();
const sessionToRoom = new Map<string, string>();

function coerceBinaryPayload(value: unknown): Buffer | Uint8Array | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object") {
    const maybeBufferLike = value as { type?: unknown; data?: unknown };
    if (maybeBufferLike.type === "Buffer" && Array.isArray(maybeBufferLike.data)) {
      return Buffer.from(maybeBufferLike.data);
    }
  }
  return null;
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeSessionId(ctx: VoiceSessionContext): string {
  return ctx.peerId;
}

function resolveRoomId(ctx: VoiceSessionContext, podRef: { current?: SessionPod }): string {
  const roomFromContext = ctx.roomId?.trim();
  if (roomFromContext) return roomFromContext;

  const sessions = podRef.current?.listSessions() ?? [];
  if (sessions.length === 1) {
    return sessions[0]?.sessionId ?? ctx.peerId;
  }

  return ctx.peerId;
}

function resolveVoiceConfig(): { config: VoiceAgentConfig; label: string } {
  const sttProvider = process.env.VOICE_STT_PROVIDER?.trim();
  const ttsProvider = process.env.VOICE_TTS_PROVIDER?.trim();
  const sherpaStt = process.env.SHERPA_STT_MODEL_PATH?.trim();
  const sherpaTts = process.env.SHERPA_TTS_MODEL_PATH?.trim();
  const sttLanguage = process.env.SHERPA_STT_LANGUAGE?.trim() || process.env.VOICE_STT_LANGUAGE?.trim() || "en";
  const ttsVoice = process.env.SHERPA_TTS_SPEAKER?.trim() || process.env.VOICE_TTS_VOICE?.trim() || "0";

  if (sherpaStt && sherpaTts) {
    return {
      label: `local-sherpa (${sttLanguage})`,
      config: {
        stt: { provider: "local-sherpa", modelPath: sherpaStt, language: sttLanguage },
        tts: { provider: "local-sherpa", modelPath: sherpaTts, voice: ttsVoice },
        events: { mode: "both" },
      },
    };
  }

  const resolvedSttProvider: SttVendor = (sttProvider as SttVendor | undefined) ?? "mock";
  const resolvedTtsProvider: TtsVendor = (ttsProvider as TtsVendor | undefined) ?? "mock";

  return {
    label: `${resolvedSttProvider}/${resolvedTtsProvider}`,
    config: {
      stt: {
        provider: resolvedSttProvider,
        model: process.env.VOICE_STT_MODEL?.trim() || undefined,
        language: process.env.VOICE_STT_LANGUAGE?.trim() || undefined,
        apiKey: process.env.OPENAI_API_KEY?.trim() || process.env.DEEPGRAM_API_KEY?.trim() || process.env.ASSEMBLYAI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined,
      },
      tts: {
        provider: resolvedTtsProvider,
        model: process.env.VOICE_TTS_MODEL?.trim() || undefined,
        voice: process.env.VOICE_TTS_VOICE?.trim() || undefined,
        apiKey: process.env.OPENAI_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || process.env.CARTESIA_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined,
      },
      events: { mode: "both" },
    },
  };
}

function sendToChild(session: LiveSession, sessionId: string, message: ParentToChildMessage): void {
  if (
    session.pendingStartAck.has(sessionId) &&
    (message.type === "speech_event" ||
      message.type === "data_channel_message" ||
      message.type === "data_channel_binary" ||
      message.type === "idle_timeout")
  ) {
    const queue = session.bufferedBySession.get(sessionId) ?? [];
    queue.push(message);
    session.bufferedBySession.set(sessionId, queue);
    return;
  }
  session.child.send(message);
}

function closeSession(sessionId: string): void {
  const roomId = sessionToRoom.get(sessionId);
  if (!roomId) return;
  const session = liveRooms.get(roomId);
  if (!session) return;
  try {
    session.child.send({ type: "session_end", sessionId });
  } catch {
    // no-op
  }
  session.peers.delete(sessionId);
  session.pendingStartAck.delete(sessionId);
  session.bufferedBySession.delete(sessionId);
  sessionContexts.delete(sessionId);
  sessionToRoom.delete(sessionId);

  if (session.peers.size === 0) {
    session.child.kill("SIGTERM");
    liveRooms.delete(roomId);
  }
}

function mapChildMessageToSession(roomId: string, message: ChildToParentMessage, pod: SessionPod): void {
  const session = liveRooms.get(roomId);
  if (!session) return;

  const targetSessionId = "sessionId" in message ? message.sessionId : undefined;
  const targetCtx = targetSessionId ? sessionContexts.get(targetSessionId) : undefined;

  switch (message.type) {
    case "session_start_ack":
      session.pendingStartAck.delete(message.sessionId);
      for (const buffered of session.bufferedBySession.get(message.sessionId) ?? []) {
        session.child.send(buffered);
      }
      session.bufferedBySession.delete(message.sessionId);
      return;
    case "log":
      console.log(`[child:${roomId}] ${message.level}: ${message.message}`);
      return;
    case "agent_error":
      console.error(`[child:${roomId}] agent_error: ${message.message}`);
      return;
    case "speak":
      if (!targetCtx) return;
      void targetCtx.speak(message.text, { nonBlocking: true });
      return;
    case "send_to_client":
      if (!targetCtx) return;
      targetCtx.sendToClient(message.payload);
      return;
    case "send_binary_to_client":
      if (!targetCtx) return;
      {
        const rawPayload =
          (message as { data?: unknown; payload?: unknown }).data ??
          (message as { data?: unknown; payload?: unknown }).payload;
        const payload = coerceBinaryPayload(rawPayload);
        if (!payload) {
          console.error(
            `[child:${roomId}] invalid send_binary_to_client payload for session ${targetSessionId ?? "unknown"}`,
          );
          return;
        }
        targetCtx.sendBinaryToClient(payload, message.channel);
      }
      return;
    case "disconnect_client":
      if (!targetSessionId || !targetCtx) return;
      pod.disconnectPeer(targetSessionId, targetCtx.peerId, message.reason);
      return;
    case "idle_timeout_done":
      return;
    default:
      return;
  }
}

function createVoiceHandler(bundlePath: string, podRef: { current?: SessionPod }): VoiceSessionHandler {
  return {
    onPeerConnected(ctx) {
      const sessionId = normalizeSessionId(ctx);
      const roomId = resolveRoomId(ctx, podRef);

      if (sessionContexts.has(sessionId)) {
        closeSession(sessionId);
      }

      let live = liveRooms.get(roomId);
      if (!live) {
        const child = startSandboxedChild({
          sessionId: roomId,
          bundlePath,
          onStderr(message, childPid) {
            console.error(`[child:${childPid}] ${message}`);
          },
        });

        live = {
          roomId,
          child,
          peers: new Set<string>(),
          pendingStartAck: new Set<string>(),
          bufferedBySession: new Map<string, ParentToChildMessage[]>(),
        };
        liveRooms.set(roomId, live);

        child.onMessage((message) => {
          mapChildMessageToSession(roomId, message as ChildToParentMessage, podRef.current!);
        });
        child.onExit((code, signal) => {
          console.error(`[child:${roomId}] exited code=${String(code)} signal=${String(signal)}`);
          for (const peerSessionId of [...live!.peers]) {
            sessionContexts.delete(peerSessionId);
            sessionToRoom.delete(peerSessionId);
          }
          liveRooms.delete(roomId);
        });
      }

      live.peers.add(sessionId);
      live.pendingStartAck.add(sessionId);
      live.bufferedBySession.set(sessionId, []);
      sessionContexts.set(sessionId, ctx);
      sessionToRoom.set(sessionId, roomId);

      sendToChild(live, sessionId, {
        type: "session_start",
        sessionId,
        env: {
          SESSION_ID: sessionId,
          ROOM_ID: roomId,
          PEER_ID: ctx.peerId,
          ...(process.env.PROJECT_ID ? { PROJECT_ID: process.env.PROJECT_ID } : {}),
          ...(process.env.BUILD_ID ? { BUILD_ID: process.env.BUILD_ID } : {}),
        },
      });
    },
    onSpeechEvent(ctx, event: SpeechEvent) {
      const sessionId = normalizeSessionId(ctx);
      const roomId = sessionToRoom.get(sessionId);
      if (!roomId) return;
      const session = liveRooms.get(roomId);
      if (!session) return;
      sendToChild(session, sessionId, { type: "speech_event", sessionId, event });
    },
    onDataChannelMessage(ctx, payload) {
      const sessionId = normalizeSessionId(ctx);
      const roomId = sessionToRoom.get(sessionId);
      if (!roomId) return;
      const session = liveRooms.get(roomId);
      if (!session) return;
      sendToChild(session, sessionId, {
        type: "data_channel_message",
        sessionId,
        payload,
      });
    },
    onDataChannelBinary(ctx, data, channel) {
      const sessionId = normalizeSessionId(ctx);
      const roomId = sessionToRoom.get(sessionId);
      if (!roomId) return;
      const session = liveRooms.get(roomId);
      if (!session) return;
      sendToChild(session, sessionId, {
        type: "data_channel_binary",
        sessionId,
        data,
        channel,
      });
    },
    onPeerDisconnected(ctx) {
      closeSession(normalizeSessionId(ctx));
    },
    onPeerSignalingLost(ctx) {
      closeSession(normalizeSessionId(ctx));
    },
  };
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body.length ? (JSON.parse(body) as unknown) : {};
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const rawPath = req.url?.split("?")[0] ?? "/";
  const target = rawPath === "/" ? "/examples/live-test/index.html" : rawPath;
  const normalized = normalize(target).replace(/^(\.\.[/\\])+/, "");
  const absolute = resolve(AGENT_ROOT, `.${normalized.startsWith("/") ? normalized : `/${normalized}`}`);
  if (!absolute.startsWith(AGENT_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  try {
    const content = await readFile(absolute);
    res.writeHead(200, { "Content-Type": MIME_TYPES[extname(absolute)] ?? "application/octet-stream" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const requestedBundle = process.env.LIVE_TEST_AGENT_BUNDLE_PATH?.trim();
  const bundlePath = resolveBundlePath(
    requestedBundle
      ? isAbsolute(requestedBundle)
        ? requestedBundle
        : resolve(AGENT_ROOT, requestedBundle)
      : undefined,
    DEFAULT_BUNDLE_PATH,
  );
  const { config: voiceConfig, label: voiceLabel } = resolveVoiceConfig();
  const sessionMode = process.env.LIVE_TEST_SESSION_MODE?.trim() === "data-only" ? "data-only" : "voice";

  const podRef: { current?: SessionPod } = {};

  const httpServer = createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/rooms") {
      try {
        const json = (await parseJsonBody(req)) as { room?: string; sessionId?: string };
        const room = json.room?.trim() || json.sessionId?.trim();
        if (!room) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "room is required" }));
          return;
        }
        await podRef.current?.ensureSession(room);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ room }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (await serveStatic(req, res)) return;

    res.writeHead(404);
    res.end("Not found");
  });

  const signaling = new SignalingServer({ server: httpServer, path: SIGNALING_PATH });
  await signaling.listen(PORT);

  const signalingUrl = process.env.LIVE_TEST_SIGNALING_WS_URL?.trim() || `ws://127.0.0.1:${PORT}${SIGNALING_PATH}`;
  const pod = new SessionPod(signaling, {
    signalingUrl,
    iceServers: ICE_SERVERS,
    sessionMode,
    voiceConfig,
    syncChannel: { enabled: true },
    voiceHandler: createVoiceHandler(bundlePath, podRef),
  });
  podRef.current = pod;

  console.log(`[live-test] starter ready on :${PORT}`);
  console.log(`[live-test] signaling: ${signalingUrl}`);
  console.log(`[live-test] session mode: ${sessionMode}`);
  if (sessionMode === "voice") {
    console.log(`[live-test] voice config: ${voiceLabel}`);
  }
  console.log(`[live-test] bundle: ${bundlePath}`);
  console.log(`[live-test] open: http://127.0.0.1:${PORT}${PAGE_PATH}`);

  const shutdown = async () => {
    for (const sessionId of [...sessionContexts.keys()]) {
      closeSession(sessionId);
    }
    await pod.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
