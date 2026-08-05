// The Ctrl+S write path. These exercise the real file writers, so every test
// redirects the agent dir to a temp fixture first — nothing here may touch the
// developer's own ~/.pi/agent/extensions/rail.json.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { RailConfig } from "../src/config.ts";
import {
  getPersistentConfigPath,
  updatePersistentCapabilityClass,
  updatePersistentCapabilityDefinition,
  updatePersistentDisposition,
  updatePersistentStatusLine,
} from "../src/persistent-settings.ts";
import { withTempAgentDir } from "./helpers.ts";

/** withTempAgentDir plus a reader for whichever config file the writers chose. */
function withPersistedConfig(fn: (read: () => RailConfig, agentDir: string) => void): void {
  withTempAgentDir((agentDir) => {
    fn(() => JSON.parse(readFileSync(getPersistentConfigPath(), "utf8")) as RailConfig, agentDir);
  });
}

describe("persisting capability classes", () => {
  it("creates, updates, and removes a class, leaving no empty section behind", () => {
    withPersistedConfig((read) => {
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
    withPersistedConfig((read) => {
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      updatePersistentCapabilityClass("beta", { id: "beta", definition: "B.", disposition: "deny" });
      updatePersistentCapabilityClass("alpha", undefined);
      assert.deepEqual(read().capabilities?.classes?.map((entry) => (entry as { id: string }).id), ["beta"]);
    });
  });

  it("writes and clears built-in definition overrides", () => {
    withPersistedConfig((read) => {
      updatePersistentCapabilityDefinition("read-project", "Rephrased.");
      assert.deepEqual(read().capabilities?.definitions, { "read-project": "Rephrased." });
      updatePersistentCapabilityDefinition("read-project", undefined);
      assert.equal(read().capabilities, undefined);
    });
  });

  it("does not disturb unrelated settings already in the file", () => {
    withPersistedConfig((read) => {
      updatePersistentDisposition("modify-project", "deny");
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      const config = read();
      assert.deepEqual(config.dispositions, { "modify-project": "deny" });
      assert.equal(config.capabilities?.classes?.length, 1);
    });
  });
});

// Ctrl+S must land in the file loadConfig actually read. Writing rail.json
// while the live config is a legacy guard.json would fork the user's settings
// across two files that both load.
describe("persisting into the file that was loaded", () => {
  const globalDir = (agentDir: string) => path.join(agentDir, "extensions");
  const seed = (agentDir: string, name: string, body: unknown) => {
    mkdirSync(globalDir(agentDir), { recursive: true });
    writeFileSync(path.join(globalDir(agentDir), name), JSON.stringify(body, null, 2), "utf8");
  };
  const read = (agentDir: string, name: string) =>
    JSON.parse(readFileSync(path.join(globalDir(agentDir), name), "utf8")) as RailConfig;

  it("creates rail.json when no config file exists yet", () => {
    withTempAgentDir((agentDir) => {
      updatePersistentDisposition("modify-project", "deny");
      assert.equal(getPersistentConfigPath(), path.join(globalDir(agentDir), "rail.json"));
      assert.deepEqual(read(agentDir, "rail.json").dispositions, { "modify-project": "deny" });
      assert.equal(existsSync(path.join(globalDir(agentDir), "guard.json")), false);
    });
  });

  it("writes back into a legacy guard.json rather than forking a new rail.json", () => {
    withTempAgentDir((agentDir) => {
      seed(agentDir, "guard.json", { backend: "none" });
      assert.equal(getPersistentConfigPath(), path.join(globalDir(agentDir), "guard.json"));

      updatePersistentDisposition("modify-project", "deny");
      updatePersistentStatusLine("auto");

      const persisted = read(agentDir, "guard.json");
      assert.equal(persisted.backend, "none", "the settings already in the legacy file survive");
      assert.deepEqual(persisted.dispositions, { "modify-project": "deny" });
      assert.equal(persisted.statusLine, "auto");
      assert.equal(existsSync(path.join(globalDir(agentDir), "rail.json")), false, "no second config file appears");
    });
  });

  it("writes to rail.json and leaves the shadowed guard.json alone when both exist", () => {
    withTempAgentDir((agentDir) => {
      seed(agentDir, "guard.json", { backend: "none" });
      seed(agentDir, "rail.json", { backend: "seatbelt" });
      assert.equal(getPersistentConfigPath(), path.join(globalDir(agentDir), "rail.json"));

      updatePersistentDisposition("modify-project", "deny");

      assert.deepEqual(read(agentDir, "rail.json"), { backend: "seatbelt", dispositions: { "modify-project": "deny" } });
      assert.deepEqual(read(agentDir, "guard.json"), { backend: "none" }, "the shadowed file is never touched");
    });
  });
});
