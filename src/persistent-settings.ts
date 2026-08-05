import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CapabilityId, Disposition } from "./capabilities.ts";
import type { CapabilitiesConfig, RailConfig, StatusLineMode } from "./config.ts";

/** The on-disk shape of a custom class: exactly what capabilities.classes entries look like. */
export interface PersistedCapabilityClass {
  id: string;
  name?: string;
  definition: string;
  disposition?: Disposition;
}

function configPath(): string {
  return path.join(getAgentDir(), "extensions", "rail.json");
}

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function withConfigLock<T>(fn: () => T): T {
  const filePath = configPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const lock = lockPath(filePath);
  let acquired = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      mkdirSync(lock);
      acquired = true;
      break;
    } catch (error) {
      lastError = error;
      sleepSync(20 + attempt * 5);
    }
  }

  if (!acquired) throw lastError instanceof Error ? lastError : new Error(`Could not acquire config lock: ${lock}`);

  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readConfigUnlocked(): RailConfig {
  const filePath = configPath();
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RailConfig) : {};
}

export function updatePersistentClassifierSettings(update: { enabled?: boolean; model?: string }): void {
  withConfigLock(() => {
    const filePath = configPath();
    const current = readConfigUnlocked();
    const next: RailConfig = {
      ...current,
      classifier: {
        ...(current.classifier ?? {}),
        ...update,
      },
    };
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  });
}

/** Writes one disposition row to the global config; `undefined` deletes the row so the class falls back to its default. */
export function updatePersistentDisposition(id: CapabilityId, disposition: Disposition | undefined): void {
  withConfigLock(() => {
    const filePath = configPath();
    const current = readConfigUnlocked();
    const dispositions = { ...(current.dispositions ?? {}) };
    if (disposition === undefined) delete dispositions[id];
    else dispositions[id] = disposition;
    const next: RailConfig = { ...current, dispositions };
    if (Object.keys(dispositions).length === 0) delete next.dispositions;
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  });
}

/**
 * Writes one custom class to the global config; `undefined` removes it. Mirrors
 * updatePersistentDisposition: read-modify-write under the same lock, and the
 * section disappears once it is empty so the file does not accumulate husks.
 */
export function updatePersistentCapabilityClass(id: string, entry: PersistedCapabilityClass | undefined): void {
  withConfigLock(() => {
    const filePath = configPath();
    const current = readConfigUnlocked();
    const capabilities: CapabilitiesConfig = { ...(current.capabilities ?? {}) };
    const classes = [...(capabilities.classes ?? [])];
    const at = classes.findIndex((existing) => isObjectRecord(existing) && existing.id === id);
    if (entry === undefined) {
      if (at !== -1) classes.splice(at, 1);
    } else if (at === -1) {
      classes.push(entry);
    } else {
      classes[at] = entry;
    }
    if (classes.length > 0) capabilities.classes = classes;
    else delete capabilities.classes;
    writeFileSync(filePath, JSON.stringify(pruneCapabilities({ ...current, capabilities }), null, 2), "utf8");
  });
}

/** Writes one built-in definition override; `undefined` restores the shipped wording. */
export function updatePersistentCapabilityDefinition(id: string, definition: string | undefined): void {
  withConfigLock(() => {
    const filePath = configPath();
    const current = readConfigUnlocked();
    const capabilities: CapabilitiesConfig = { ...(current.capabilities ?? {}) };
    const definitions = { ...(capabilities.definitions ?? {}) };
    if (definition === undefined) delete definitions[id];
    else definitions[id] = definition;
    if (Object.keys(definitions).length > 0) capabilities.definitions = definitions;
    else delete capabilities.definitions;
    writeFileSync(filePath, JSON.stringify(pruneCapabilities({ ...current, capabilities }), null, 2), "utf8");
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Drops an empty capabilities section, so removing the last class leaves no stub behind. */
function pruneCapabilities(config: RailConfig): RailConfig {
  const next = { ...config };
  if (next.capabilities && Object.keys(next.capabilities).length === 0) delete next.capabilities;
  return next;
}

export function updatePersistentStatusLine(mode: StatusLineMode): void {
  withConfigLock(() => {
    const filePath = configPath();
    const next: RailConfig = { ...readConfigUnlocked(), statusLine: mode };
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  });
}

export function getPersistentConfigPath(): string {
  return configPath();
}
