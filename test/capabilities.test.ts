// Capability taxonomy and disposition table: the shape of the twelve classes,
// scope layering (default < config < session, preset tightening on top), and
// severity-max resolution across an action's labels.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_CAPABILITY_CLASSES,
  BUILTIN_CAPABILITY_IDS,
  capabilityRegistry,
  applyReadOnlyPreset,
  capabilityStats,
  clearSessionDisposition,
  createCapabilityState,
  getEffectiveDisposition,
  recordCapabilityOutcome,
  recordScreenVerdict,
  resolveCapabilities,
  setSessionDisposition,
  strictestDisposition,
  usedCapabilityStats,
} from "../src/capabilities.ts";
import { globalGuardConfigPath, mergeConfig } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

describe("taxonomy", () => {
  it("has exactly twelve classes with unique ids and prose definitions", () => {
    assert.equal(BUILTIN_CAPABILITY_CLASSES.length, 12);
    assert.equal(new Set(BUILTIN_CAPABILITY_IDS).size, 12);
    for (const entry of BUILTIN_CAPABILITY_CLASSES) {
      assert.ok(entry.definition.length > 80, `${entry.id} needs a real definition (it is prompt text)`);
      assert.ok(entry.name.trim().length > 0);
    }
  });

  it("keeps the maintainer's calibration: broad reads allow, machine boundary asks, secrets judge", () => {
    const byId = Object.fromEntries(BUILTIN_CAPABILITY_CLASSES.map((entry) => [entry.id, entry.default]));
    assert.deepEqual(byId, {
      "read-project": "allow",
      "read-system": "allow",
      "run-dev-tools": "allow",
      "modify-project": "allow",
      "install-dependencies": "allow",
      "off-machine-effects": "ask",
      "modify-system": "ask",
      credentials: "judge",
      "local-destructive": "judge",
      persistence: "judge",
      "network-fetch": "judge",
      unclassified: "judge",
    });
  });

  it("defines off-machine-effects by the machine boundary, with the local-cluster carve-out", () => {
    const definition = BUILTIN_CAPABILITY_CLASSES.find((entry) => entry.id === "off-machine-effects")!.definition;
    assert.match(definition, /MACHINE BOUNDARY/);
    assert.match(definition, /minikube/);
    assert.match(definition, /NOT off-machine-effects/);
  });

  it("puts local commits in local-destructive", () => {
    const definition = BUILTIN_CAPABILITY_CLASSES.find((entry) => entry.id === "local-destructive")!.definition;
    assert.match(definition, /local git commit/i);
  });
});

describe("severity-max", () => {
  it("orders deny > ask > judge > allow", () => {
    assert.equal(strictestDisposition(["allow", "judge"]), "judge");
    assert.equal(strictestDisposition(["judge", "ask"]), "ask");
    assert.equal(strictestDisposition(["ask", "deny"]), "deny");
    assert.equal(strictestDisposition([]), "allow");
  });

  it("cannot be diluted by extra benign labels", () => {
    const resolution = resolveCapabilities(testConfig(), createCapabilityState(), ["read-project", "off-machine-effects", "read-system"]);
    assert.equal(resolution.disposition, "ask");
    assert.equal(resolution.decidedBy.id, "off-machine-effects");
  });

  it("treats an empty label set as unclassified", () => {
    const resolution = resolveCapabilities(testConfig(), createCapabilityState(), []);
    assert.deepEqual(resolution.labels, ["unclassified"]);
    assert.equal(resolution.disposition, "judge");
  });
});

describe("disposition scopes", () => {
  it("layers default < config < session", () => {
    const state = createCapabilityState();
    const base = testConfig();
    assert.deepEqual(getEffectiveDisposition(base, state, "install-dependencies"), {
      id: "install-dependencies",
      disposition: "allow",
      scope: "default",
    });

    const configured = mergeConfig(base, { dispositions: { "install-dependencies": "ask" } }, globalGuardConfigPath());
    const fromConfig = getEffectiveDisposition(configured, state, "install-dependencies");
    assert.equal(fromConfig.disposition, "ask");
    assert.equal(fromConfig.scope, "config");
    assert.equal(fromConfig.source, globalGuardConfigPath());

    setSessionDisposition(state, "install-dependencies", "allow");
    assert.equal(getEffectiveDisposition(configured, state, "install-dependencies").scope, "session");
    assert.equal(getEffectiveDisposition(configured, state, "install-dependencies").disposition, "allow");

    clearSessionDisposition(state, "install-dependencies");
    assert.equal(getEffectiveDisposition(configured, state, "install-dependencies").disposition, "ask");
  });

  it("merges the table per row, keeping untouched classes on their defaults", () => {
    const merged = mergeConfig(testConfig(), { dispositions: { credentials: "deny" } }, globalGuardConfigPath());
    assert.equal(merged.dispositions.credentials, "deny");
    assert.equal(merged.dispositions["local-destructive"], "judge");
    assert.equal(merged.provenance.dispositions["local-destructive"], "default");
  });

  it("rejects unknown classes and unknown dispositions with a diagnostic", () => {
    const merged = mergeConfig(testConfig(), { dispositions: { "prod-deploy": "deny", credentials: "maybe" } }, "/cfg.json");
    assert.ok(merged.diagnostics.some((line) => /prod-deploy: unknown capability class/.test(line)));
    assert.ok(merged.diagnostics.some((line) => /credentials: expected "allow", "judge", "ask", or "deny"/.test(line)));
    assert.equal(merged.dispositions.credentials, "judge");
  });

  it("lets the read-only preset tighten but never loosen", () => {
    const state = createCapabilityState();
    const config = mergeConfig(testConfig(), { dispositions: { "modify-project": "allow", credentials: "deny" } }, "/cfg.json");
    applyReadOnlyPreset(state);
    const write = getEffectiveDisposition(config, state, "modify-project");
    assert.equal(write.disposition, "deny");
    assert.equal(write.scope, "preset");
    // A session override cannot re-open a class the preset denies.
    setSessionDisposition(state, "modify-project", "allow");
    assert.equal(getEffectiveDisposition(config, state, "modify-project").disposition, "deny");
    // Classes outside the preset are untouched; reads stay allowed.
    assert.equal(getEffectiveDisposition(config, state, "read-project").disposition, "allow");
    assert.equal(getEffectiveDisposition(config, state, "credentials").disposition, "deny");
  });
});

describe("per-class stats", () => {
  it("counts hits, outcomes, and screen verdicts per class", () => {
    const state = createCapabilityState();
    recordCapabilityOutcome(state, ["modify-project", "persistence"], "ask-denied");
    recordScreenVerdict(state, ["modify-project"], true);
    recordScreenVerdict(state, ["modify-project"], false);
    assert.equal(capabilityStats(state, "modify-project").outcomes["ask-denied"], 1);
    assert.equal(capabilityStats(state, "persistence").outcomes["ask-denied"], 1);
    assert.equal(capabilityStats(state, "modify-project").screenTripped, 1);
    assert.equal(capabilityStats(state, "modify-project").screenClean, 1);
    assert.deepEqual(usedCapabilityStats(state, capabilityRegistry(undefined, state)).map((entry) => entry.id), ["modify-project", "persistence"]);
  });
});
