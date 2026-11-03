import { FLOW_SCHEMA_VERSION } from "./schema.js";

export interface FlowMigration {
  from: number;
  to: number;
  up(doc: Record<string, unknown>): Record<string, unknown>;
}

/** Empty for schema v1; the first schema change adds an entry here. */
export const FLOW_MIGRATIONS: FlowMigration[] = [];

export interface FlowMigrationResult {
  doc: unknown;
  migrated: boolean;
  /** Version found on the input, or null when it has none. */
  from: number | null;
}

export function migrateFlowWith(
  list: FlowMigration[],
  input: unknown,
): FlowMigrationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { doc: input, migrated: false, from: null };
  }
  const rec = input as Record<string, unknown>;
  const from = typeof rec.version === "number" ? rec.version : null;
  if (from === null) return { doc: input, migrated: false, from };
  const target = Math.max(FLOW_SCHEMA_VERSION, ...list.map((m) => m.to));
  let doc: Record<string, unknown> = rec;
  let version = from;
  let migrated = false;
  while (version < target) {
    const step = list.find((m) => m.from === version);
    if (!step) break;
    doc = { ...step.up(structuredClone(doc)), version: step.to };
    version = step.to;
    migrated = true;
  }
  return { doc: migrated ? doc : input, migrated, from };
}

export function migrateFlow(input: unknown): FlowMigrationResult {
  return migrateFlowWith(FLOW_MIGRATIONS, input);
}
