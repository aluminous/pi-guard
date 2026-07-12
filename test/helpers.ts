import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type ResolvedGuardConfig } from "../src/config.ts";

export function testConfig(overrides?: (config: ResolvedGuardConfig) => void): ResolvedGuardConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  overrides?.(config);
  return config;
}

export function makeFixtureDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pi-guard-test-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
