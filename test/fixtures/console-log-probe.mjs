/**
 * Exercises loader-entry console overrides (plain and structured args).
 */
console.log("plain-info");
console.debug("plain-debug");
console.warn("plain-warn");
console.error("plain-error");
console.log({ message: "structured", fields: { key: "value" } });
