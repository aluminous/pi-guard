import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeState, resetTurnStats } from "../src/state.ts";
import { formatGuardStatus, statusLineVisible } from "../src/status.ts";
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

describe("statusLineVisible", () => {
  function enforcingState() {
    const state = createRuntimeState();
    state.enabled = true;
    state.initialized = true;
    return state;
  }

  it("always and never modes ignore state", () => {
    const state = enforcingState();
    assert.equal(statusLineVisible("always", state), true);
    assert.equal(statusLineVisible("never", state), false);
    state.enabled = false;
    state.lastError = "boom";
    assert.equal(statusLineVisible("always", state), true);
    assert.equal(statusLineVisible("never", state), false);
  });

  it("auto mode hides a healthy quiet guard", () => {
    assert.equal(statusLineVisible("auto", enforcingState()), false);
  });

  it("auto mode shows when the guard is disabled or erroring", () => {
    const disabled = enforcingState();
    disabled.enabled = false;
    assert.equal(statusLineVisible("auto", disabled), true);

    const erroring = enforcingState();
    erroring.lastError = "backend init failed";
    assert.equal(statusLineVisible("auto", erroring), true);
  });

  it("auto mode shows on a denial this turn and hides after the turn reset", () => {
    const state = enforcingState();
    state.stats.turnClassifierDenials = 1;
    assert.equal(statusLineVisible("auto", state), true);
    resetTurnStats(state);
    assert.equal(statusLineVisible("auto", state), false);

    state.stats.turnBlocked = 1;
    assert.equal(statusLineVisible("auto", state), true);
    resetTurnStats(state);
    assert.equal(statusLineVisible("auto", state), false);
  });
});
