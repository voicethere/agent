/**
 * Sandboxed child bootstrap — loads customer bundle under Node --permission.
 *
 * Keep in sync with voicethere/runner `src/child/loader-entry.js`.
 */

const bundlePath = process.env.__CHILD_BUNDLE_PATH__;
if (!bundlePath) {
  process.stderr.write("[child] missing __CHILD_BUNDLE_PATH__\n");
  process.exit(1);
}

function formatArgs(args) {
  return args.map((value) => String(value)).join(" ");
}

console.log = (...args) => {
  process.send?.({ type: "log", level: "info", message: formatArgs(args) });
};

console.info = console.log;

console.error = (...args) => {
  process.send?.({ type: "log", level: "error", message: formatArgs(args) });
};

console.warn = (...args) => {
  process.send?.({
    type: "log",
    level: "info",
    message: `[warn] ${formatArgs(args)}`,
  });
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
