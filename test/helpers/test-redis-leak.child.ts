// Child process for test-redis-leak.test.ts: opens the docker-backed test
// Redis and exits (or hangs, for a kill test) without calling close().
import { spawnSync } from "node:child_process";
import { openTestRedis } from "./test-redis.js";

const harness = await openTestRedis();
const labelled = spawnSync(
  "docker",
  ["ps", "-aq", "--filter", `label=voicethere-agent-test-pid=${process.pid}`],
  { encoding: "utf8" },
)
  .stdout.split("\n")
  .filter(Boolean).length;
console.log(`${harness ? "OPENED" : "NO_REDIS"} ${process.pid} ${labelled}`);
if (process.env.LEAK_CHILD_HANG === "1") {
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
