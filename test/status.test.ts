import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeState } from "../src/state.ts";
import { formatGuardStatus } from "../src/status.ts";
import { testConfig } from "./helpers.ts";

describe("guard status restriction labels", () => {
  it("distinguishes unrestricted policies from disabled networking", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.network.enabled = false;
    });
    const status = formatGuardStatus(createRuntimeState(), config);
    assert.match(status, /Network: restrictions disabled \(unrestricted\)/);
    assert.match(status, /Filesystem restrictions: disabled \(unrestricted\)/);
    assert.doesNotMatch(status, /network off/i);
  });

  it("labels an enabled empty network allowlist as deny-all", () => {
    const config = testConfig((c) => {
      c.network.enabled = true;
      c.network.allowedDomains = [];
      c.network.deniedDomains = ["*"];
    });
    const status = formatGuardStatus(createRuntimeState(), config);
    assert.match(status, /Network: blocked \(deny all\)/);
  });
});
