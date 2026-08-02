#!/usr/bin/env node
/**
 * Prebuild seed bundles for every product template with seedOnCreate: true.
 * Invoked from npm run build after tsc.
 */
import { buildSeedTemplateBundles } from "./index.js";

await buildSeedTemplateBundles();
