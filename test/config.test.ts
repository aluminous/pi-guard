import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, globalGuardConfigPath, mergeConfig } from "../src/config.ts";
import { getEffectiveDisposition } from "../src/capabilities.ts";
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
    assert.deepEqual(merged.diagnostics.filter((line) => !line.includes("is legacy")), []);
  });

  it("warns that configured rule tiers are inert in capability mode", () => {
    const merged = mergeConfig(testConfig(), { classifier: { rules: { allow: ["My Rule: fine."] } } }, "test.json");
    assert.match(merged.diagnostics[0]!, /test\.json\.classifier\.rules is legacy/);
    assert.match(merged.diagnostics[0]!, /disposition table/);
    // Still parsed and merged, so old configs keep loading without error.
    assert.ok(merged.classifier.rules.allow.includes("My Rule: fine."));
  });

  it("warns when deleting an unknown rule name", () => {
    const merged = mergeConfig(testConfig(), { classifier: { rules: { allow: ["No Such Rule:"] } } }, "test.json");
    assert.equal(merged.diagnostics.length, 2);
    assert.match(merged.diagnostics[1]!, /cannot delete unknown rule "No Such Rule"/);
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

describe("config provenance", () => {
  it("seeds every default list entry and rule with source \"default\"", () => {
    const config = testConfig();
    assert.equal(config.provenance.lists["filesystem.denyRead"]["~/.ssh"], "default");
    assert.equal(config.provenance.lists["environment.allow"]["PATH"], "default");
    assert.equal(config.provenance.lists["commands.allow"]["grep *"], "default");
    assert.ok(Object.values(config.provenance.rules.soft_deny).every((p) => p.source === "default" && p.overrides === undefined));
    assert.deepEqual(config.provenance.deletedRules.soft_deny, {});
  });

  it("labels replaced arrays with the writing source, entry by entry", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] }, environment: { unset: ["MY_SECRET"] } }, "global.json");
    assert.deepEqual(merged.provenance.lists["filesystem.denyRead"], { "/only/this": "global.json" });
    assert.deepEqual(merged.provenance.lists["environment.unset"], { MY_SECRET: "global.json" });
    assert.equal(merged.provenance.lists["filesystem.allowWrite"]["."], "default", "untouched lists keep default provenance");
  });

  it("records name-merge override and delete provenance", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        classifier: {
          rules: {
            soft_deny: [
              "Git Push to Default Branch:",
              "Production Deploy: deploying to the staging cluster is routine.",
              "My Custom Rule: never touch the vendor directory.",
            ],
          },
        },
      },
      "project.json",
    );
    assert.deepEqual(merged.provenance.rules.soft_deny["production deploy"], { source: "project.json", overrides: "default" });
    assert.deepEqual(merged.provenance.rules.soft_deny["my custom rule"], { source: "project.json" });
    assert.equal(merged.provenance.rules.soft_deny["git push to default branch"], undefined, "deleted rules leave the provenance map");
    assert.deepEqual(merged.provenance.deletedRules.soft_deny, { "Git Push to Default Branch": "project.json" });
  });

  it("tracks last-writer-wins across layered global then project merges", () => {
    const afterGlobal = mergeConfig(
      testConfig(),
      { network: { allowedDomains: ["global.example"] }, classifier: { rules: { hard_deny: ["Data Exfiltration: global version."] } } },
      "global.json",
    );
    assert.deepEqual(afterGlobal.provenance.lists["network.allowedDomains"], { "global.example": "global.json" });
    const afterProject = mergeConfig(
      afterGlobal,
      { network: { allowedDomains: ["project.example"] }, classifier: { rules: { hard_deny: ["Data Exfiltration: project version."] } } },
      "project.json",
    );
    assert.deepEqual(afterProject.provenance.lists["network.allowedDomains"], { "project.example": "project.json" });
    assert.deepEqual(afterProject.provenance.rules.hard_deny["data exfiltration"], { source: "project.json", overrides: "global.json" });
  });

  it("resets rule provenance and deletions when replace is true", () => {
    const afterDelete = mergeConfig(testConfig(), { classifier: { rules: { allow: ["Source Control Reads:"] } } }, "global.json");
    assert.ok(afterDelete.provenance.deletedRules.allow["Source Control Reads"]);
    const merged = mergeConfig(afterDelete, { classifier: { rules: { replace: true, allow: ["Only Rule: nothing else."] } } }, "project.json");
    assert.deepEqual(merged.provenance.rules.allow, { "only rule": { source: "project.json" } });
    assert.deepEqual(merged.provenance.deletedRules.allow, {});
  });

  it("restores provenance when a deleted rule is re-added by a later layer", () => {
    const afterDelete = mergeConfig(testConfig(), { classifier: { rules: { hard_deny: ["Data Exfiltration:"] } } }, "global.json");
    const afterAdd = mergeConfig(afterDelete, { classifier: { rules: { hard_deny: ["Data Exfiltration: back again."] } } }, "project.json");
    assert.deepEqual(afterAdd.provenance.rules.hard_deny["data exfiltration"], { source: "project.json" });
    assert.deepEqual(afterAdd.provenance.deletedRules.hard_deny, {});
  });
});

describe("capabilities config", () => {
  const globalPath = globalGuardConfigPath();
  const projectPath = "/repo/.pi/guard.json";

  it("parses custom classes, defaulting name to the id and disposition to ask", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { classes: [{ id: "touches-customer-data", definition: "Customer records." }] } },
      globalPath,
    );
    assert.deepEqual(config.capabilities.classes, [
      { id: "touches-customer-data", name: "touches-customer-data", definition: "Customer records.", default: "ask" },
    ]);
    assert.equal(config.provenance.capabilityClasses["touches-customer-data"], globalPath);
  });

  it("skips invalid class entries with a diagnostic and still loads the rest", () => {
    const config = mergeConfig(
      testConfig(),
      {
        capabilities: {
          classes: [
            { id: "Not Kebab", definition: "x" },
            { id: "read-project", definition: "shadowing a built-in" },
            { id: "no-definition" },
            { id: "bad-disposition", definition: "x", disposition: "maybe" },
            { id: "good-one", definition: "A real class." },
          ],
        },
      },
      globalPath,
    );
    assert.deepEqual(config.capabilities.classes.map((entry) => entry.id), ["good-one"]);
    const diagnostics = config.diagnostics.join("\n");
    assert.match(diagnostics, /classes\[0\]: id must be kebab-case/);
    assert.match(diagnostics, /classes\[1\]: "read-project" is a built-in class/);
    assert.match(diagnostics, /classes\[2\]: definition must be a non-empty string/);
    assert.match(diagnostics, /classes\[3\]: disposition must be/);
  });

  it("merges classes by id across layers, keeping position so the namer prefix does not shuffle", () => {
    const base = mergeConfig(
      testConfig(),
      {
        capabilities: {
          classes: [
            { id: "alpha", definition: "Global alpha." },
            { id: "beta", definition: "Global beta." },
          ],
        },
      },
      globalPath,
    );
    const merged = mergeConfig(base, { capabilities: { classes: [{ id: "alpha", definition: "Project alpha." }] } }, projectPath);
    assert.deepEqual(merged.capabilities.classes.map((entry) => entry.id), ["alpha", "beta"], "position is preserved");
    assert.equal(merged.capabilities.classes[0]!.definition, "Project alpha.", "project wins per id");
    assert.equal(merged.provenance.capabilityClasses.alpha, projectPath);
    assert.equal(merged.provenance.capabilityClasses.beta, globalPath, "untouched classes keep their source");
  });

  it("accepts built-in definition overrides and rejects unknown keys", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { definitions: { "read-project": "New wording.", "made-up": "nope" } } },
      globalPath,
    );
    assert.deepEqual(config.capabilities.definitions, { "read-project": "New wording." });
    assert.equal(config.provenance.capabilityDefinitions["read-project"], globalPath);
    assert.match(config.diagnostics.join("\n"), /definitions\.made-up: not a built-in capability class/);
  });

  it("lets a config set a disposition for a class it defines in the same file", () => {
    const config = mergeConfig(
      testConfig(),
      {
        capabilities: { classes: [{ id: "touches-customer-data", definition: "Customer records." }] },
        dispositions: { "touches-customer-data": "deny" },
      },
      globalPath,
    );
    assert.equal(config.dispositions["touches-customer-data"], "deny");
    assert.equal(getEffectiveDisposition(config, undefined, "touches-customer-data").disposition, "deny");
  });

  it("still rejects a disposition for a class nobody declared", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "never-declared": "deny" } }, globalPath);
    assert.match(config.diagnostics.join("\n"), /dispositions\.never-declared: unknown capability class/);
  });
});
