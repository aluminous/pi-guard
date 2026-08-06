import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { explainCommandMatch, matchedCapabilities } from "../src/command-allowlist.ts";
import { mergeConfig, type RailConfig } from "../src/config.ts";
import { getEffectiveDisposition } from "../src/capabilities.ts";
import { testConfig } from "./helpers.ts";

function readExample(name: string): RailConfig {
  const filePath = fileURLToPath(new URL(`../examples/configs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(filePath, "utf8")) as RailConfig;
}

describe("disposition-only example configurations", () => {
  it("provides a strict deny-by-default profile", () => {
    const config = mergeConfig(testConfig(), readExample("dispositions-deny-by-default.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.deepEqual(config.environment.allow, []);
    assert.deepEqual(config.environment.unset, []);
    assert.equal(config.dispositions["read-project"], "allow");
    assert.equal(config.dispositions["run-dev-tools"], "allow");
    assert.equal(config.dispositions["unclassified"], "deny");
    assert.equal(config.dispositions["modify-project"], "deny");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
  });

  it("provides a concrete allow-by-default profile", () => {
    const config = mergeConfig(testConfig(), readExample("dispositions-allow-by-default.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.equal(config.dispositions["modify-project"], "allow");
    assert.equal(config.dispositions["credentials"], "deny");
    assert.equal(config.dispositions["off-machine-effects"], "deny");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
  });
});

describe("command classification example configuration", () => {
  it("routes its commands into the classes it declares, end to end", () => {
    const config = mergeConfig(testConfig(), readExample("commands-classify.json"), "example");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
    assert.deepEqual(config.capabilities.classes.map((entry) => entry.id), ["k8s-ops", "infra-plan"]);

    const labels = (command: string) => matchedCapabilities(explainCommandMatch(command, { classify: config.commands.classify, allow: config.commands.allow }));
    const disposition = (command: string) => {
      const ids = labels(command);
      assert.ok(ids.length > 0, `expected ${command} to be classified`);
      return ids.map((id) => getEffectiveDisposition(config, undefined, id).disposition);
    };

    assert.deepEqual(labels("kubectl get pods -n prod"), ["k8s-ops"]);
    assert.deepEqual(disposition("kubectl get pods -n prod"), ["ask"]);
    assert.deepEqual(disposition("helm upgrade api ./chart"), ["ask"]);
    assert.deepEqual(disposition("terraform plan -out plan.bin"), ["allow"]);
    assert.deepEqual(disposition("terraform apply plan.bin"), ["ask"], "the built-in off-machine-effects row still decides");
    assert.deepEqual(labels("terraform destroy"), [], "an unmapped subcommand is left to the namer");
  });
});
