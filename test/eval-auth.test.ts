// Tests the eval runner's key resolution against a fixture auth store. The
// store shape matches pi's schema (pi-ai auth/types.d.ts); PI_CODING_AGENT_DIR
// redirects pi's agent dir so no real credentials are ever touched.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveEvalApiKey } from "../eval/auth.ts";
import { makeFixtureDir } from "./helpers.ts";

const fixture = makeFixtureDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

before(() => {
  process.env.PI_CODING_AGENT_DIR = fixture.dir;
  writeFileSync(
    path.join(fixture.dir, "auth.json"),
    JSON.stringify({
      openrouter: { type: "api_key", key: "sk-or-fixture-key" },
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      cerebras: { type: "api_key" },
    }),
  );
});

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  fixture.cleanup();
});

describe("resolveEvalApiKey", () => {
  it("prefers the provider env var over the auth store", () => {
    const lookup = resolveEvalApiKey("openrouter", { OPENROUTER_API_KEY: "sk-or-from-env" });
    assert.ok(lookup.ok);
    assert.equal(lookup.apiKey, "sk-or-from-env");
    assert.equal(lookup.source, "environment");
  });

  it("falls back to an api_key credential in pi's auth store", () => {
    const lookup = resolveEvalApiKey("openrouter", {});
    assert.ok(lookup.ok);
    assert.equal(lookup.apiKey, "sk-or-fixture-key");
    assert.ok(lookup.source.includes("auth.json"));
  });

  it("explains that OAuth credentials are not usable", () => {
    const lookup = resolveEvalApiKey("anthropic", {});
    assert.ok(!lookup.ok);
    assert.match(lookup.reason, /OAuth/);
  });

  it("explains an api_key credential without a key", () => {
    const lookup = resolveEvalApiKey("cerebras", {});
    assert.ok(!lookup.ok);
    assert.match(lookup.reason, /no usable API key/);
  });

  it("explains a provider that is absent everywhere", () => {
    const lookup = resolveEvalApiKey("groq", {});
    assert.ok(!lookup.ok);
    assert.match(lookup.reason, /not logged in via pi/);
  });

  it("handles a missing auth store file", () => {
    process.env.PI_CODING_AGENT_DIR = path.join(fixture.dir, "does-not-exist");
    try {
      const lookup = resolveEvalApiKey("openrouter", {});
      assert.ok(!lookup.ok);
      assert.match(lookup.reason, /does not exist/);
    } finally {
      process.env.PI_CODING_AGENT_DIR = fixture.dir;
    }
  });
});
