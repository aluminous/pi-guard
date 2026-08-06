import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  globalRailConfigPath,
  loadConfig,
  mergeConfig,
  resolveConfigFile,
  type RailConfig,
} from "../src/config.ts";
import { getEffectiveDisposition } from "../src/capabilities.ts";
import { makeFixtureDir, testConfig, withTempAgentDir } from "./helpers.ts";

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

  it("loads a config carrying retired classifier.rules with one diagnostic and no error", () => {
    const merged = mergeConfig(
      testConfig(),
      { classifier: { enabled: true, rules: { allow: ["My Rule: fine."], soft_deny: [], hard_deny: ["Whatever:"] } } } as Partial<RailConfig>,
      "test.json",
    );
    assert.equal(merged.diagnostics.length, 1);
    assert.match(merged.diagnostics[0]!, /Ignoring test\.json\.classifier\.rules/);
    assert.match(merged.diagnostics[0]!, /disposition table/);
    assert.match(merged.diagnostics[0]!, /capabilities\.definitions/);
    // The rest of the classifier block still applies, and nothing rule-shaped survives.
    assert.equal(merged.classifier.enabled, true);
    assert.equal((merged.classifier as unknown as Record<string, unknown>).rules, undefined);
  });

  it("does not mutate DEFAULT_CONFIG through merges", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    mergeConfig(testConfig(), { filesystem: { denyRead: ["/mutated"] } }, "test.json");
    assert.deepEqual(DEFAULT_CONFIG, before);
  });
});

// Every list takes the same two forms, so these exercise the shared chokepoint
// through one representative list each rather than repeating nine times.
describe("config list replace/extend", () => {
  it("treats {replace: true} exactly like the bare array it is spelled out as", () => {
    const bare = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] } }, "test.json");
    const explicit = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: true, values: ["/only/this"] } } }, "test.json");
    assert.deepEqual(explicit.filesystem.denyRead, bare.filesystem.denyRead);
    assert.deepEqual(explicit.provenance.lists["filesystem.denyRead"], bare.provenance.lists["filesystem.denyRead"]);
  });

  it("appends to the inherited list under {replace: false}, inherited entries first", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: false, values: ["/extra/secret"] } } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, [...DEFAULT_CONFIG.filesystem.denyRead, "/extra/secret"]);
  });

  it("extends every list, not just the filesystem ones", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        filesystem: { allowWrite: { replace: false, values: ["~/scratch"] }, denyWrite: { replace: false, values: ["~/.terraform.d"] } },
        environment: { allow: { replace: false, values: ["MY_VAR"] }, unset: { replace: false, values: ["MY_SECRET"] } },
        network: { allowedDomains: { replace: false, values: ["registry.npmjs.org"] } },
        commands: { allow: { replace: false, values: ["shellcheck *"] } },
      },
      "test.json",
    );
    assert.deepEqual(merged.filesystem.allowWrite, [...DEFAULT_CONFIG.filesystem.allowWrite, "~/scratch"]);
    assert.deepEqual(merged.filesystem.denyWrite, [...DEFAULT_CONFIG.filesystem.denyWrite, "~/.terraform.d"]);
    assert.deepEqual(merged.environment.allow, [...DEFAULT_CONFIG.environment.allow, "MY_VAR"]);
    assert.deepEqual(merged.environment.unset, [...DEFAULT_CONFIG.environment.unset, "MY_SECRET"]);
    assert.deepEqual(merged.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "registry.npmjs.org"]);
    assert.deepEqual(merged.commands.allow, [...DEFAULT_CONFIG.commands.allow, "shellcheck *"]);
  });

  it("drops duplicates instead of repeating an entry the inherited list already has", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: false, values: ["~/.ssh", "/extra", "/extra"] } } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, [...DEFAULT_CONFIG.filesystem.denyRead, "/extra"]);
  });

  it("extends an empty list into just its own values", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { allowRead: { replace: false, values: ["~/reference"] } } }, "test.json");
    assert.deepEqual(merged.filesystem.allowRead, ["~/reference"]);
  });

  describe("provenance", () => {
    it("labels only the added entries, leaving inherited sources intact", () => {
      const merged = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: false, values: ["/extra/secret"] } } }, "global.json");
      const sources = merged.provenance.lists["filesystem.denyRead"];
      assert.equal(sources["/extra/secret"], "global.json");
      assert.equal(sources["~/.ssh"], "default", "an inherited entry keeps the source that introduced it");
    });

    it("credits the layer that introduced an entry, not the one that restates it", () => {
      const afterGlobal = mergeConfig(testConfig(), { commands: { allow: { replace: false, values: ["cargo *"] } } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { commands: { allow: { replace: false, values: ["cargo *", "just *"] } } }, "project.json");
      const sources = afterProject.provenance.lists["commands.allow"];
      assert.equal(sources["cargo *"], "global.json");
      assert.equal(sources["just *"], "project.json");
    });
  });

  describe("three layers", () => {
    it("accumulates through extend on extend", () => {
      const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: { replace: false, values: ["global.example"] } } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: { replace: false, values: ["project.example"] } } }, "project.json");
      assert.deepEqual(afterProject.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "global.example", "project.example"]);
      const sources = afterProject.provenance.lists["network.allowedDomains"];
      assert.equal(sources["github.com"], "default");
      assert.equal(sources["global.example"], "global.json");
      assert.equal(sources["project.example"], "project.json");
    });

    it("discards both earlier layers when the last one replaces", () => {
      const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: { replace: false, values: ["global.example"] } } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: ["project.example"] } }, "project.json");
      assert.deepEqual(afterProject.network.allowedDomains, ["project.example"]);
      assert.deepEqual(afterProject.provenance.lists["network.allowedDomains"], { "project.example": "project.json" });
    });

    it("extends whatever the previous layer replaced with, not the defaults", () => {
      const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: ["global.example"] } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: { replace: false, values: ["project.example"] } } }, "project.json");
      assert.deepEqual(afterProject.network.allowedDomains, ["global.example", "project.example"]);
      assert.deepEqual(afterProject.provenance.lists["network.allowedDomains"], {
        "global.example": "global.json",
        "project.example": "project.json",
      });
    });
  });

  describe("malformed forms leave the list exactly as it was", () => {
    const cases: Array<{ name: string; value: unknown; diagnostic: string }> = [
      { name: "missing values", value: { replace: false }, diagnostic: `"values" is required` },
      { name: "non-boolean replace", value: { replace: "false", values: ["/x"] }, diagnostic: `"replace" must be true or false` },
      { name: "absent replace", value: { values: ["/x"] }, diagnostic: `"replace" must be true or false` },
      { name: "unknown key", value: { replace: false, values: ["/x"], merge: true }, diagnostic: "unexpected key merge" },
      { name: "non-string values", value: { replace: false, values: [7] }, diagnostic: "expected an array of strings" },
      { name: "a bare string", value: "everything", diagnostic: "expected an array of strings" },
    ];

    for (const { name, value, diagnostic } of cases) {
      it(name, () => {
        const merged = mergeConfig(testConfig(), { filesystem: { denyRead: value as never } }, "test.json");
        assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
        assert.deepEqual(merged.provenance.lists["filesystem.denyRead"], DEFAULT_CONFIG.provenance.lists["filesystem.denyRead"]);
        assert.ok(
          merged.diagnostics.some((entry) => entry.includes("test.json.filesystem.denyRead") && entry.includes(diagnostic)),
          `expected a diagnostic naming the list and ${diagnostic}; got ${JSON.stringify(merged.diagnostics)}`,
        );
      });
    }

    it("leaves an earlier layer's extension standing", () => {
      const afterGlobal = mergeConfig(testConfig(), { commands: { allow: { replace: false, values: ["cargo *"] } } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { commands: { allow: { replace: false } as never } }, "project.json");
      assert.deepEqual(afterProject.commands.allow, afterGlobal.commands.allow);
      assert.equal(afterProject.provenance.lists["commands.allow"]["cargo *"], "global.json");
    });
  });
});

describe("config provenance", () => {
  it("seeds every default list entry with source \"default\"", () => {
    const config = testConfig();
    assert.equal(config.provenance.lists["filesystem.denyRead"]["~/.ssh"], "default");
    assert.equal(config.provenance.lists["environment.allow"]["PATH"], "default");
    assert.equal(config.provenance.lists["commands.allow"]["grep *"], "default");
  });

  it("labels replaced arrays with the writing source, entry by entry", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] }, environment: { unset: ["MY_SECRET"] } }, "global.json");
    assert.deepEqual(merged.provenance.lists["filesystem.denyRead"], { "/only/this": "global.json" });
    assert.deepEqual(merged.provenance.lists["environment.unset"], { MY_SECRET: "global.json" });
    assert.equal(merged.provenance.lists["filesystem.allowWrite"]["."], "default", "untouched lists keep default provenance");
  });

  it("tracks last-writer-wins across layered global then project merges", () => {
    const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: ["global.example"] } }, "global.json");
    assert.deepEqual(afterGlobal.provenance.lists["network.allowedDomains"], { "global.example": "global.json" });
    const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: ["project.example"] } }, "project.json");
    assert.deepEqual(afterProject.provenance.lists["network.allowedDomains"], { "project.example": "project.json" });
  });
});

describe("capabilities config", () => {
  const globalPath = globalRailConfigPath();
  const projectPath = "/repo/.pi/rail.json";

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

// The pi-guard → pi-rail compatibility seam. rail.json is the name now, but a
// user whose live config is still guard.json must keep working — and must not
// end up with half their settings in each file.
describe("rail.json / legacy guard.json resolution", () => {
  const writeJson = (dir: string, name: string, body: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
  };

  it("prefers rail.json, falls back to guard.json, and defaults to rail.json when neither exists", () => {
    const fixture = makeFixtureDir();
    try {
      assert.deepEqual(resolveConfigFile(fixture.dir), { path: path.join(fixture.dir, "rail.json"), legacy: false });

      writeJson(fixture.dir, "guard.json", {});
      assert.deepEqual(resolveConfigFile(fixture.dir), { path: path.join(fixture.dir, "guard.json"), legacy: true });

      writeJson(fixture.dir, "rail.json", {});
      assert.deepEqual(resolveConfigFile(fixture.dir), {
        path: path.join(fixture.dir, "rail.json"),
        legacy: false,
        ignoredLegacyPath: path.join(fixture.dir, "guard.json"),
      });
    } finally {
      fixture.cleanup();
    }
  });

  /** loadConfig against a throwaway agent dir and project dir; both layers start empty. */
  function withLayers(fn: (layers: { globalDir: string; projectDir: string; load: () => ReturnType<typeof loadConfig> }) => void): void {
    withTempAgentDir((agentDir) => {
      const project = makeFixtureDir();
      try {
        const ctx = { cwd: project.dir, isProjectTrusted: () => true } as unknown as ExtensionContext;
        fn({
          globalDir: path.join(agentDir, "extensions"),
          projectDir: path.join(project.dir, CONFIG_DIR_NAME),
          load: () => loadConfig(ctx),
        });
      } finally {
        project.cleanup();
      }
    });
  }

  it("loads a legacy global guard.json exactly as before, with one advisory", () => {
    withLayers(({ globalDir, load }) => {
      writeJson(globalDir, "guard.json", { backend: "none", network: { enabled: false } });
      const config = load();
      assert.equal(config.backend, "none");
      assert.equal(config.network.enabled, false);
      assert.equal(config.sources.at(-1), path.join(globalDir, "guard.json"));
      const advisory = config.diagnostics.filter((line) => line.includes("guard.json"));
      assert.equal(advisory.length, 1);
      assert.match(advisory[0]!, /Loaded legacy .*guard\.json/);
      assert.match(advisory[0]!, /rename it to rail\.json/);
    });
  });

  it("loads a global rail.json with no advisory at all", () => {
    withLayers(({ globalDir, load }) => {
      writeJson(globalDir, "rail.json", { backend: "none" });
      const config = load();
      assert.equal(config.backend, "none");
      assert.deepEqual(config.diagnostics, []);
    });
  });

  it("lets rail.json win over a guard.json beside it and says the guard.json was ignored", () => {
    withLayers(({ globalDir, load }) => {
      writeJson(globalDir, "guard.json", { backend: "none", statusLine: "never" });
      writeJson(globalDir, "rail.json", { backend: "seatbelt" });
      const config = load();
      assert.equal(config.backend, "seatbelt");
      assert.equal(config.statusLine, "always", "nothing from the shadowed guard.json leaks in");
      assert.equal(config.sources.at(-1), path.join(globalDir, "rail.json"));
      const advisory = config.diagnostics.filter((line) => line.includes("guard.json"));
      assert.equal(advisory.length, 1);
      assert.match(advisory[0]!, /Ignored .*guard\.json/);
      assert.match(advisory[0]!, /rail\.json takes precedence/);
    });
  });

  it("applies the same fallback and precedence to the project layer", () => {
    withLayers(({ projectDir, load }) => {
      writeJson(projectDir, "guard.json", { statusLine: "never" });
      const legacy = load();
      assert.equal(legacy.statusLine, "never");
      assert.match(legacy.diagnostics.join("\n"), /Loaded legacy .*guard\.json/);

      writeJson(projectDir, "rail.json", { statusLine: "auto" });
      const both = load();
      assert.equal(both.statusLine, "auto");
      assert.match(both.diagnostics.join("\n"), /Ignored .*guard\.json/);
    });
  });

  it("layers a legacy global guard.json under a project rail.json", () => {
    withLayers(({ globalDir, projectDir, load }) => {
      writeJson(globalDir, "guard.json", { backend: "none", statusLine: "never" });
      writeJson(projectDir, "rail.json", { statusLine: "auto" });
      const config = load();
      assert.equal(config.backend, "none", "the legacy global layer still applies");
      assert.equal(config.statusLine, "auto", "the project layer still wins");
      assert.deepEqual(config.sources, ["defaults", path.join(globalDir, "guard.json"), path.join(projectDir, "rail.json")]);
    });
  });

  it("resolves the global path to whichever file exists", () => {
    withTempAgentDir((agentDir) => {
      const globalDir = path.join(agentDir, "extensions");
      assert.equal(globalRailConfigPath(), path.join(globalDir, "rail.json"));
      writeJson(globalDir, "guard.json", {});
      assert.equal(globalRailConfigPath(), path.join(globalDir, "guard.json"));
      writeJson(globalDir, "rail.json", {});
      assert.equal(globalRailConfigPath(), path.join(globalDir, "rail.json"));
    });
  });

  // The list forms have to survive the JSON round trip, not just mergeConfig:
  // defaults → global → project is the layering users actually get.
  it("carries extend and replace through the real three-layer load", () => {
    withLayers(({ globalDir, projectDir, load }) => {
      writeJson(globalDir, "rail.json", {
        commands: { allow: { replace: false, values: ["cargo *"] } },
        network: { allowedDomains: { replace: false, values: ["global.example"] } },
      });
      writeJson(projectDir, "rail.json", {
        commands: { allow: { replace: false, values: ["just *"] } },
        network: { allowedDomains: ["project.example"] },
      });
      const config = load();
      assert.deepEqual(config.commands.allow, [...DEFAULT_CONFIG.commands.allow, "cargo *", "just *"]);
      assert.deepEqual(config.network.allowedDomains, ["project.example"]);
      assert.equal(config.provenance.lists["commands.allow"]["cargo *"], path.join(globalDir, "rail.json"));
      assert.equal(config.provenance.lists["commands.allow"]["just *"], path.join(projectDir, "rail.json"));
      assert.deepEqual(config.provenance.lists["network.allowedDomains"], { "project.example": path.join(projectDir, "rail.json") });
    });
  });
});
