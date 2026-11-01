/**
 * Triggers several Node warnings plus ordinary console / stderr output.
 * Reports the number of customer-registered warning listener calls via console.log.
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
let customerListenerCalls = 0;
process.on("warning", () => {
  customerListenerCalls += 1;
});

process.emitWarning("cust", "ExperimentalWarning");
process.emitWarning("dep", { type: "DeprecationWarning", code: "DEP9999" });
process.emitWarning("x".repeat(5000), "CapWarning");
const emitter = new EventEmitter();
for (let i = 0; i < 11; i += 1) emitter.on("x", () => {});
// DEP0005
// eslint-disable-next-line no-new
new (require("node:buffer").Buffer)(1);

console.error("boom");
process.stderr.write("raw boom\n");

setTimeout(() => {
  console.log(`customer-listener-calls:${customerListenerCalls}`);
}, 300);
