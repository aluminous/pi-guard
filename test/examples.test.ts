import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeConfig, type GuardConfig } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

function readExample(name: string): GuardConfig {
  const filePath = fileURLToPath(new URL(`../examples/configs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(filePath, "utf8")) as GuardConfig;
}

describe("classifier-only example configurations", () => {
  it("provides a strict allowlist-only profile", () => {
    const config = mergeConfig(testConfig(), readExample("classifier-allowlist-only.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.deepEqual(config.environment.allow, []);
    assert.deepEqual(config.environment.unset, []);
    assert.deepEqual(config.classifier.rules.soft_deny, []);
    assert.match(config.classifier.rules.hard_deny[0] ?? "", /Default deny/);
  });

  it("provides a concrete denylist-only profile", () => {
    const config = mergeConfig(testConfig(), readExample("classifier-denylist-only.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.deepEqual(config.classifier.rules.soft_deny, []);
    assert.match(config.classifier.rules.allow[0] ?? "", /Default allow/);
    assert.ok(config.classifier.rules.hard_deny.length > 0);
  });
});
