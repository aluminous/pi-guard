import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeConfig, type RailConfig } from "../src/config.ts";
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
