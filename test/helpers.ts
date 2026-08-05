import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type ResolvedRailConfig } from "../src/config.ts";

export function testConfig(overrides?: (config: ResolvedRailConfig) => void): ResolvedRailConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  overrides?.(config);
  return config;
}

export function makeFixtureDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pi-rail-test-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
