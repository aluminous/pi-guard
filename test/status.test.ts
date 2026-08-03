import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntimeState, resetTurnStats } from "../src/state.ts";
import { formatGuardPolicy, formatGuardStatus, statusLineVisible, toggleGuardWidget } from "../src/status.ts";
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

describe("guard status session sections", () => {
  it("shows session guidance entries and the exempt-read counter", () => {
    const state = createRuntimeState();
    state.classifier.sessionGuidance = ["User allowed bash (npm run deploy) with comment: staging deploys are fine"];
    state.stats.classifierSkips = 3;
    const status = formatGuardStatus(state, testConfig());
    assert.match(status, /Session guidance/);
    assert.match(status, /staging deploys are fine/);
    assert.match(status, /Exempt reads: 3/);
  });
});

describe("formatGuardPolicy", () => {
  it("includes deterministic policy and every classifier rule list", () => {
    const config = testConfig();
    const policy = formatGuardPolicy(createRuntimeState(), config);
    assert.match(policy, /# Pi Guard Policy/);
    assert.match(policy, /Classifier allow rules \(\d+\)/);
    assert.match(policy, /soft-deny rules \(ask without authorization\)/);
    assert.match(policy, /hard-deny rules \(never allowed\)/);
    assert.match(policy, /Local Validation/);
    assert.match(policy, /Safety-Check Bypass/);
    assert.match(policy, /Config sources/);
  });

  it("notes that lists still route classifier exemptions when enforcement is off", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    const policy = formatGuardPolicy(createRuntimeState(), config);
    assert.match(policy, /disabled \(lists still route classifier exemptions\)/);
  });
});

describe("toggleGuardWidget", () => {
  function widgetCtx() {
    const calls: Array<{ key: string; lines: string[] | undefined }> = [];
    const ctx = { ui: { setWidget: (key: string, lines: string[] | undefined) => calls.push({ key, lines }) } };
    return { ctx: ctx as unknown as ExtensionContext, calls };
  }

  it("opens, refreshes in place, and toggles closed", () => {
    const { ctx, calls } = widgetCtx();
    const state = createRuntimeState();
    let content = ["line one"];
    toggleGuardWidget(ctx, state, "status", () => content);
    assert.deepEqual(calls, [{ key: "guard-status", lines: ["line one"] }]);
    assert.equal(state.liveView?.kind, "status");

    content = ["line two"];
    state.liveView?.refresh();
    assert.deepEqual(calls.at(-1), { key: "guard-status", lines: ["line two"] });

    toggleGuardWidget(ctx, state, "status", () => content);
    assert.deepEqual(calls.at(-1), { key: "guard-status", lines: undefined });
    assert.equal(state.liveView, undefined);
  });

  it("replaces a different-kind view instead of stacking", () => {
    const { ctx, calls } = widgetCtx();
    const state = createRuntimeState();
    toggleGuardWidget(ctx, state, "status", () => ["status"]);
    toggleGuardWidget(ctx, state, "policy", () => ["policy"]);
    assert.deepEqual(
      calls.map((c) => `${c.key}:${c.lines ? "set" : "clear"}`),
      ["guard-status:set", "guard-status:clear", "guard-policy:set"],
    );
    assert.equal(state.liveView?.kind, "policy");
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
