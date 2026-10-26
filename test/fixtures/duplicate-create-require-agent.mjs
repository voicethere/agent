import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { createRequire } from "node:module";
import { defineAgent } from "@voicethere/agent";
defineAgent({ onSessionStart() {} });
