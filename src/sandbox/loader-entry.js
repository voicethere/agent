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

function formatArgs(args) {
  return args.map((value) => String(value)).join(" ");
}

function consoleLogPayload(level, message) {
  const sessionId = process.env.SESSION_ID?.trim();
  return {
    type: "log",
    level,
    message,
    ...(sessionId ? { sessionId } : {}),
  };
}

console.log = (...args) => {
  process.send?.(consoleLogPayload("info", formatArgs(args)));
};

console.info = console.log;

console.error = (...args) => {
  process.send?.(consoleLogPayload("error", formatArgs(args)));
};

console.warn = (...args) => {
  process.send?.(consoleLogPayload("info", `[warn] ${formatArgs(args)}`));
};

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
