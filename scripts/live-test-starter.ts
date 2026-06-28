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
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface LiveSession {
  sessionId: string;
  peerId: string;
  child: SandboxedChild;
  pendingStartAck: boolean;
  buffered: ParentToChildMessage[];
  ctx: VoiceSessionContext;
}

const liveSessions = new Map<string, LiveSession>();
const peerToSession = new Map<string, string>();

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeSessionId(ctx: VoiceSessionContext): string {
  return ctx.roomId?.trim() || ctx.peerId;
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

function sendToChild(session: LiveSession, message: ParentToChildMessage): void {
  if (
    session.pendingStartAck &&
    (message.type === "speech_event" ||
      message.type === "data_channel_message" ||
      message.type === "data_channel_binary" ||
      message.type === "idle_timeout")
  ) {
    session.buffered.push(message);
    return;
  }
  session.child.send(message);
}

function closeSession(sessionId: string): void {
  const session = liveSessions.get(sessionId);
  if (!session) return;
  try {
    session.child.send({ type: "session_end", sessionId });
  } catch {
    // no-op
  }
  session.child.kill("SIGTERM");
  liveSessions.delete(sessionId);
  peerToSession.delete(session.peerId);
}

function mapChildMessageToSession(sessionId: string, message: ChildToParentMessage, pod: SessionPod): void {
  const session = liveSessions.get(sessionId);
  if (!session) return;

  switch (message.type) {
    case "session_start_ack":
      session.pendingStartAck = false;
      for (const buffered of session.buffered.splice(0)) {
        session.child.send(buffered);
      }
      return;
    case "log":
      console.log(`[child:${sessionId}] ${message.level}: ${message.message}`);
      return;
    case "agent_error":
      console.error(`[child:${sessionId}] agent_error: ${message.message}`);
      return;
    case "speak":
      void session.ctx.speak(message.text, { nonBlocking: true });
      return;
    case "send_to_client":
      session.ctx.sendToClient(message.payload);
      return;
    case "send_binary_to_client":
      session.ctx.sendBinaryToClient(message.data, message.channel);
      return;
    case "disconnect_client":
      pod.disconnectPeer(sessionId, session.peerId, message.reason);
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
      const existing = liveSessions.get(sessionId);
      if (existing && existing.peerId !== ctx.peerId) {
        closeSession(sessionId);
      }

      if (liveSessions.has(sessionId)) return;

      const child = startSandboxedChild({
        sessionId,
        bundlePath,
        onStderr(message, childPid) {
          console.error(`[child:${childPid}] ${message}`);
        },
      });

      const live: LiveSession = {
        sessionId,
        peerId: ctx.peerId,
        child,
        pendingStartAck: true,
        buffered: [],
        ctx,
      };
      liveSessions.set(sessionId, live);
      peerToSession.set(ctx.peerId, sessionId);

      child.onMessage((message) => {
        mapChildMessageToSession(sessionId, message as ChildToParentMessage, podRef.current!);
      });
      child.onExit((code, signal) => {
        console.error(`[child:${sessionId}] exited code=${String(code)} signal=${String(signal)}`);
        closeSession(sessionId);
      });

      sendToChild(live, {
        type: "session_start",
        sessionId,
        env: {
          SESSION_ID: sessionId,
          PEER_ID: ctx.peerId,
          ...(process.env.PROJECT_ID ? { PROJECT_ID: process.env.PROJECT_ID } : {}),
          ...(process.env.BUILD_ID ? { BUILD_ID: process.env.BUILD_ID } : {}),
        },
      });
    },
    onSpeechEvent(ctx, event: SpeechEvent) {
      const session = liveSessions.get(normalizeSessionId(ctx));
      if (!session) return;
      sendToChild(session, { type: "speech_event", sessionId: session.sessionId, event });
    },
    onDataChannelMessage(ctx, payload) {
      const session = liveSessions.get(normalizeSessionId(ctx));
      if (!session) return;
      sendToChild(session, {
        type: "data_channel_message",
        sessionId: session.sessionId,
        payload,
      });
    },
    onDataChannelBinary(ctx, data, channel) {
      const session = liveSessions.get(normalizeSessionId(ctx));
      if (!session) return;
      sendToChild(session, {
        type: "data_channel_binary",
        sessionId: session.sessionId,
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
    voiceConfig,
    sessionMode: "voice",
    syncChannel: { enabled: true },
    voiceHandler: createVoiceHandler(bundlePath, podRef),
  });
  podRef.current = pod;

  console.log(`[live-test] starter ready on :${PORT}`);
  console.log(`[live-test] signaling: ${signalingUrl}`);
  console.log(`[live-test] voice config: ${voiceLabel}`);
  console.log(`[live-test] bundle: ${bundlePath}`);
  console.log(`[live-test] open: http://127.0.0.1:${PORT}/examples/live-test/index.html`);

  const shutdown = async () => {
    for (const sessionId of [...liveSessions.keys()]) {
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
