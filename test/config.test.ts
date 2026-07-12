import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

describe("mergeConfig", () => {
  it("overrides scalar and nested fields and records the source", () => {
    const merged = mergeConfig(testConfig(), { enabled: false, backend: "none", classifier: { enabled: true, model: "openai/gpt-4o-mini" } }, "test.json");
    assert.equal(merged.enabled, false);
    assert.equal(merged.backend, "none");
    assert.equal(merged.classifier.enabled, true);
    assert.equal(merged.classifier.model, "openai/gpt-4o-mini");
    assert.deepEqual(merged.sources, ["defaults", "test.json"]);
  });

  it("replaces arrays wholesale rather than concatenating", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, ["/only/this"]);
    assert.deepEqual(merged.filesystem.allowWrite, DEFAULT_CONFIG.filesystem.allowWrite);
  });

  it("rejects invalid values with a diagnostic instead of applying them", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        backend: "windows" as never,
        filesystem: { denyRead: [42] as never },
        classifier: { timeoutMs: -5 },
      },
      "test.json",
    );
    assert.equal(merged.backend, DEFAULT_CONFIG.backend);
    assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
    assert.equal(merged.classifier.timeoutMs, DEFAULT_CONFIG.classifier.timeoutMs);
    assert.equal(merged.diagnostics.length, 3);
  });

  it("layers project config over global config", () => {
    const afterGlobal = mergeConfig(testConfig(), { network: { enabled: false } }, "global.json");
    const afterProject = mergeConfig(afterGlobal, { network: { enabled: true, allowedDomains: ["example.com"] } }, "project.json");
    assert.equal(afterProject.network.enabled, true);
    assert.deepEqual(afterProject.network.allowedDomains, ["example.com"]);
    assert.deepEqual(afterProject.sources, ["defaults", "global.json", "project.json"]);
  });

  it("does not mutate DEFAULT_CONFIG through merges", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    mergeConfig(testConfig(), { filesystem: { denyRead: ["/mutated"] }, classifier: { rules: { allow: ["mutated"] } } }, "test.json");
    assert.deepEqual(DEFAULT_CONFIG, before);
  });
});
