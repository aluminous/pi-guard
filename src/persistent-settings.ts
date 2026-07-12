import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GuardConfig } from "./config.ts";

function configPath(): string {
  return path.join(getAgentDir(), "extensions", "guard.json");
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

function readConfigUnlocked(): GuardConfig {
  const filePath = configPath();
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GuardConfig) : {};
}

export function updatePersistentClassifierSettings(update: { enabled?: boolean; model?: string }): void {
  withConfigLock(() => {
    const filePath = configPath();
    const current = readConfigUnlocked();
    const next: GuardConfig = {
      ...current,
      classifier: {
        ...(current.classifier ?? {}),
        ...update,
      },
    };
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  });
}

export function getPersistentConfigPath(): string {
  return configPath();
}
