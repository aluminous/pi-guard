// The Ctrl+S write path. These exercise the real file writers, so every test
// redirects the agent dir to a temp fixture first — nothing here may touch the
// developer's own ~/.pi/agent/extensions/guard.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RailConfig } from "../src/config.ts";
import {
  getPersistentConfigPath,
  updatePersistentCapabilityClass,
  updatePersistentCapabilityDefinition,
  updatePersistentDisposition,
} from "../src/persistent-settings.ts";
import { makeFixtureDir } from "./helpers.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Runs fn with the agent dir pointed at a throwaway fixture, then restores the
 * environment. The redirect is asserted before anything writes: if the env var
 * ever stops being honoured, these tests must fail rather than quietly start
 * editing the developer's real guard.json.
 */
function withTempAgentDir(fn: (read: () => RailConfig) => void): void {
  const fixture = makeFixtureDir();
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = fixture.dir;
  try {
    assert.equal(getAgentDir(), fixture.dir, "the agent dir redirect must hold before any write");
    fn(() => JSON.parse(readFileSync(getPersistentConfigPath(), "utf8")) as RailConfig);
  } finally {
    if (previous === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previous;
    fixture.cleanup();
  }
}

describe("persisting capability classes", () => {
  it("creates, updates, and removes a class, leaving no empty section behind", () => {
    withTempAgentDir((read) => {
      updatePersistentCapabilityClass("touches-customer-data", {
        id: "touches-customer-data",
        definition: "Customer records.",
        disposition: "ask",
      });
      assert.deepEqual(read().capabilities?.classes, [
        { id: "touches-customer-data", definition: "Customer records.", disposition: "ask" },
      ]);

      // Same id rewrites in place rather than appending a duplicate.
      updatePersistentCapabilityClass("touches-customer-data", {
        id: "touches-customer-data",
        name: "Customer data",
        definition: "Rewritten.",
        disposition: "deny",
      });
      assert.deepEqual(read().capabilities?.classes, [
        { id: "touches-customer-data", name: "Customer data", definition: "Rewritten.", disposition: "deny" },
      ]);

      updatePersistentCapabilityClass("touches-customer-data", undefined);
      assert.equal(read().capabilities, undefined, "the last removal takes the section with it");
    });
  });

  it("keeps sibling classes when one is removed", () => {
    withTempAgentDir((read) => {
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      updatePersistentCapabilityClass("beta", { id: "beta", definition: "B.", disposition: "deny" });
      updatePersistentCapabilityClass("alpha", undefined);
      assert.deepEqual(read().capabilities?.classes?.map((entry) => (entry as { id: string }).id), ["beta"]);
    });
  });

  it("writes and clears built-in definition overrides", () => {
    withTempAgentDir((read) => {
      updatePersistentCapabilityDefinition("read-project", "Rephrased.");
      assert.deepEqual(read().capabilities?.definitions, { "read-project": "Rephrased." });
      updatePersistentCapabilityDefinition("read-project", undefined);
      assert.equal(read().capabilities, undefined);
    });
  });

  it("does not disturb unrelated settings already in the file", () => {
    withTempAgentDir((read) => {
      updatePersistentDisposition("modify-project", "deny");
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      const config = read();
      assert.deepEqual(config.dispositions, { "modify-project": "deny" });
      assert.equal(config.capabilities?.classes?.length, 1);
    });
  });
});
