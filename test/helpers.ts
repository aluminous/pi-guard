import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Runs fn with the agent dir pointed at a throwaway fixture, then restores the
 * environment. The redirect is asserted before fn runs: if the env var ever
 * stops being honoured, tests that write config must fail rather than quietly
 * start editing the developer's real rail.json.
 */
export function withTempAgentDir(fn: (agentDir: string) => void): void {
  const fixture = makeFixtureDir();
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = fixture.dir;
  try {
    assert.equal(getAgentDir(), fixture.dir, "the agent dir redirect must hold before any write");
    fn(fixture.dir);
  } finally {
    if (previous === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previous;
    fixture.cleanup();
  }
}
