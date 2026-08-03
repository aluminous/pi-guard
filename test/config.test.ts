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

  it("applies a valid statusLine mode and rejects an invalid one", () => {
    const merged = mergeConfig(testConfig(), { statusLine: "auto" }, "test.json");
    assert.equal(merged.statusLine, "auto");
    const rejected = mergeConfig(testConfig(), { statusLine: "sometimes" as never }, "test.json");
    assert.equal(rejected.statusLine, "always");
    assert.equal(rejected.diagnostics.length, 1);
    assert.match(rejected.diagnostics[0]!, /statusLine/);
  });

  it("replaces arrays wholesale rather than concatenating", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, ["/only/this"]);
    assert.deepEqual(merged.filesystem.allowWrite, DEFAULT_CONFIG.filesystem.allowWrite);
  });

  it("toggles filesystem and network restriction layers independently", () => {
    const merged = mergeConfig(
      testConfig(),
      { filesystem: { enabled: false }, network: { enabled: false }, classifier: { enabled: true } },
      "classifier-focused.json",
    );
    assert.equal(merged.filesystem.enabled, false);
    assert.equal(merged.network.enabled, false);
    assert.equal(merged.classifier.enabled, true);
    assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
    assert.deepEqual(merged.network.allowedDomains, DEFAULT_CONFIG.network.allowedDomains);
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

  it("merges classifier rules by name: override in place, delete with empty body, append new", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        classifier: {
          rules: {
            soft_deny: [
              "Git Push to Default Branch:",
              "Production Deploy: deploying to the staging cluster is routine; only prod-* deploys need approval.",
              "My Custom Rule: never touch the vendor directory.",
            ],
          },
        },
      },
      "test.json",
    );
    const softDeny = merged.classifier.rules.soft_deny;
    assert.equal(softDeny.some((rule) => rule.startsWith("Git Push to Default Branch:")), false);
    const deployIndex = softDeny.findIndex((rule) => rule.startsWith("Production Deploy:"));
    assert.equal(softDeny[deployIndex], "Production Deploy: deploying to the staging cluster is routine; only prod-* deploys need approval.");
    assert.equal(deployIndex, DEFAULT_CONFIG.classifier.rules.soft_deny.findIndex((rule) => rule.startsWith("Production Deploy:")) - 1, "override keeps position (one earlier rule was deleted)");
    assert.equal(softDeny.at(-1), "My Custom Rule: never touch the vendor directory.");
    assert.equal(merged.classifier.rules.allow.length, DEFAULT_CONFIG.classifier.rules.allow.length, "untouched lists keep defaults");
    assert.deepEqual(merged.diagnostics, []);
  });

  it("warns when deleting an unknown rule name", () => {
    const merged = mergeConfig(testConfig(), { classifier: { rules: { allow: ["No Such Rule:"] } } }, "test.json");
    assert.equal(merged.diagnostics.length, 1);
    assert.match(merged.diagnostics[0]!, /cannot delete unknown rule "No Such Rule"/);
  });

  it("replaces rule lists wholesale when replace is true", () => {
    const merged = mergeConfig(
      testConfig(),
      { classifier: { rules: { replace: true, allow: ["Only Rule: nothing else."], soft_deny: [] } } },
      "test.json",
    );
    assert.deepEqual(merged.classifier.rules.allow, ["Only Rule: nothing else."]);
    assert.deepEqual(merged.classifier.rules.soft_deny, []);
    assert.deepEqual(merged.classifier.rules.hard_deny, DEFAULT_CONFIG.classifier.rules.hard_deny, "omitted lists keep defaults even with replace");
  });

  it("lets a project layer re-override a global rule override by name", () => {
    const afterGlobal = mergeConfig(testConfig(), { classifier: { rules: { hard_deny: ["Data Exfiltration: global version."] } } }, "global.json");
    const afterProject = mergeConfig(afterGlobal, { classifier: { rules: { hard_deny: ["Data Exfiltration: project version."] } } }, "project.json");
    const matches = afterProject.classifier.rules.hard_deny.filter((rule) => rule.startsWith("Data Exfiltration:"));
    assert.deepEqual(matches, ["Data Exfiltration: project version."]);
  });

  it("does not mutate DEFAULT_CONFIG through merges", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    mergeConfig(testConfig(), { filesystem: { denyRead: ["/mutated"] }, classifier: { rules: { allow: ["mutated"] } } }, "test.json");
    assert.deepEqual(DEFAULT_CONFIG, before);
  });
});
