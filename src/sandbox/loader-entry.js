/**
 * Sandboxed child bootstrap — loads customer bundle under Node --permission.
 *
 * Keep in sync with the agent runner `src/child/loader-entry.js`.
 */

const bundlePath = process.env.__CHILD_BUNDLE_PATH__;
if (!bundlePath) {
  process.stderr.write("[child] missing __CHILD_BUNDLE_PATH__\n");
  process.exit(1);
}

const MESSAGE_MAX_CHARS = 2048;
const FIELDS_MAX_CHARS = 8192;

function truncateMessage(message) {
  if (message.length <= MESSAGE_MAX_CHARS) {
    return message;
  }
  const suffix = "…[truncated]";
  return message.slice(0, MESSAGE_MAX_CHARS - suffix.length) + suffix;
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return undefined;
  }
  if (Object.keys(fields).length === 0) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(fields);
    if (serialized.length <= FIELDS_MAX_CHARS) {
      return fields;
    }
    return {
      _agentLogFieldsTruncated: true,
      _originalBytes: serialized.length,
      _preview: serialized.slice(0, FIELDS_MAX_CHARS - 80) + "…[truncated]",
    };
  } catch {
    return { _agentLogFieldsError: "not_serializable" };
  }
}

function formatArg(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args) {
  return args.map((value) => formatArg(value)).join(" ");
}

function isStructuredLogArg(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "message" in value || "fields" in value;
}

function consoleLogPayload(level, args) {
  const sessionId = process.env.SESSION_ID?.trim();
  let message = "";
  let fields;

  if (args.length > 0 && isStructuredLogArg(args[0])) {
    const structured = args[0];
    if (structured.message != null) {
      message = String(structured.message);
    }
    if (
      structured.fields != null &&
      typeof structured.fields === "object" &&
      !Array.isArray(structured.fields)
    ) {
      fields = structured.fields;
    }
    if (args.length > 1) {
      const rest = formatArgs(args.slice(1));
      message = message ? `${message} ${rest}` : rest;
    }
  } else {
    message = formatArgs(args);
  }

  const payload = {
    type: "log",
    level,
    message: truncateMessage(message),
    ts: Date.now(),
    ...(sessionId ? { sessionId } : {}),
  };

  const sanitizedFields = sanitizeFields(fields);
  if (sanitizedFields) {
    payload.fields = sanitizedFields;
  }

  return payload;
}

function installConsoleOverride(level) {
  return (...args) => {
    process.send?.(consoleLogPayload(level, args));
  };
}

console.debug = installConsoleOverride("debug");
console.log = installConsoleOverride("info");
console.info = console.log;
console.warn = installConsoleOverride("warn");
console.error = installConsoleOverride("error");

const { pathToFileURL } = await import("node:url");

try {
  await import(pathToFileURL(bundlePath).href);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.send?.({
    type: "agent_error",
    sessionId: "",
    message: `Bundle load failed: ${message}`,
  });
  process.exit(1);
}
