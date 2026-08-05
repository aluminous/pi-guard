import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordCapabilityOutcome, recordScreenVerdict } from "../src/capabilities.ts";
import { globalRailConfigPath, mergeConfig } from "../src/config.ts";
import { createRuntimeState, recordCapabilityDecision, recordClassifierError, resetTurnStats } from "../src/state.ts";
import { formatRailPolicy, formatRailStatus, statusLineVisible } from "../src/status.ts";
import { showRailView, toggleRailView } from "../src/live-view.ts";
import { testConfig } from "./helpers.ts";

describe("rail status restriction labels", () => {
  it("distinguishes unrestricted policies from disabled networking", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.network.enabled = false;
    });
    const status = formatRailStatus(createRuntimeState(), config);
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
    const status = formatRailStatus(createRuntimeState(), config);
    assert.match(status, /Network: blocked \(deny all\)/);
  });
});

describe("rail status session sections", () => {
  it("shows session guidance entries and the exempt counter", () => {
    const state = createRuntimeState();
    state.classifier.sessionGuidance = ["User allowed bash (npm run deploy) with comment: staging deploys are fine"];
    state.stats.classifierSkips = 3;
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Session guidance/);
    assert.match(status, /staging deploys are fine/);
    assert.match(status, /Exempt \(no model consulted\): 3/);
  });

  it("breaks the error count down by cause, busiest first", () => {
    const state = createRuntimeState();
    recordClassifierError(state, "bash", "a", "timeout");
    recordClassifierError(state, "bash", "b", "server error");
    recordClassifierError(state, "write", "c", "timeout");
    recordClassifierError(state, "bash", "d", "server error");
    recordClassifierError(state, "bash", "e", "timeout");
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Errors: 5 \(timeout 3 · server error 2\)/);
  });

  it("omits the breakdown when nothing has failed", () => {
    const status = formatRailStatus(createRuntimeState(), testConfig());
    assert.match(status, /Errors: 0$/m);
  });

  it("does not truncate the enriched last error", () => {
    const state = createRuntimeState();
    const lastError = "timeout after 15000ms on openrouter/anthropic/claude-haiku-4.5 after 5 attempts: fetch failed ← read ECONNRESET [errno -54]";
    state.classifier.lastError = lastError;
    const status = formatRailStatus(state, testConfig());
    assert.ok(status.includes(`Last error: ${lastError}`), status);
  });

  it("summarizes per-class capability stats for classes seen this session", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "bash", { labels: ["off-machine-effects"], decision: "deny", disposition: "ask", reason: "denied", reviewed: true });
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "ask-denied");
    recordScreenVerdict(state.capabilities, ["off-machine-effects"], true);
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Capabilities seen this session/);
    assert.match(status, /off-machine-effects\s+1 hit\(s\)\s+ask-denied 1\s+screen 1 tripped \/ 0 clean/);
    assert.doesNotMatch(status, /read-project/, "classes never seen stay out of the session view");
  });
});

describe("rail status token cache reporting", () => {
  it("shows the hit rate when cache reads were reported", () => {
    const state = createRuntimeState();
    state.stats.classifierHits = 5;
    state.stats.classifierInputTokens = 500;
    state.stats.classifierCacheReadTokens = 400;
    state.stats.classifierCacheWriteTokens = 100;
    state.stats.classifierOutputTokens = 80;
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Tokens: 1000 in \(40% cached\) \/ 80 out/);
  });

  it("labels writes without reads as cache warming", () => {
    const state = createRuntimeState();
    state.stats.classifierHits = 1;
    state.stats.classifierInputTokens = 200;
    state.stats.classifierCacheWriteTokens = 800;
    state.stats.classifierOutputTokens = 40;
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Tokens: 1000 in \(0% cached, cache warming\) \/ 40 out/);
  });

  it("does not claim 0% cached when the provider reported no cache activity", () => {
    const state = createRuntimeState();
    state.stats.classifierHits = 4;
    state.stats.classifierInputTokens = 1200;
    state.stats.classifierOutputTokens = 90;
    const status = formatRailStatus(state, testConfig());
    assert.match(status, /Tokens: 1200 in \(cache activity not reported\) \/ 90 out/);
    assert.doesNotMatch(status, /% cached/);
  });

  it("omits the cache parenthetical before any review has happened", () => {
    const status = formatRailStatus(createRuntimeState(), testConfig());
    assert.match(status, /Tokens: 0 in \/ 0 out/);
    assert.doesNotMatch(status, /cached|cache warming|cache activity/);
  });
});

describe("formatRailPolicy", () => {
  it("is the mechanism report: rules, not the disposition table", () => {
    const config = testConfig();
    const policy = formatRailPolicy(createRuntimeState(), config);
    assert.match(policy, /# Pi Rail Policy Rules/);
    assert.match(policy, /\/rail policy opens it/);
    assert.doesNotMatch(policy, /## Capability dispositions/, "the table lives on the interactive page now");
    assert.match(policy, /## Filesystem/);
    assert.match(policy, /## Network/);
    assert.match(policy, /## Environment scrubbing/);
    assert.match(policy, /Config sources/);
    assert.ok(policy.indexOf("## Filesystem") < policy.indexOf("## Config sources"));
  });

  it("notes that lists still route classifier exemptions when enforcement is off", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    const policy = formatRailPolicy(createRuntimeState(), config);
    assert.match(policy, /disabled \(lists still route classifier exemptions\)/);
  });

  it("annotates provenance: legend and per-entry list sources", () => {
    const projectPath = path.join("/repo", CONFIG_DIR_NAME, "rail.json");
    const afterGlobal = mergeConfig(testConfig(), { filesystem: { denyRead: ["/secret/global"] } }, globalRailConfigPath());
    const config = mergeConfig(afterGlobal, { environment: { allow: ["PATH", "HOME"] } }, projectPath);
    const policy = formatRailPolicy(createRuntimeState(), config);
    assert.match(policy, /unmarked entries are built-in defaults/);
    assert.match(policy, /• \/secret\/global \[global\]/);
    assert.match(policy, /Allow: PATH, HOME \[project\]/);
    assert.doesNotMatch(policy, /\[default\]/, "default entries stay unmarked");
  });

  it("no longer reports legacy classifier rule tiers", () => {
    const policy = formatRailPolicy(createRuntimeState(), testConfig());
    assert.doesNotMatch(policy, /Legacy/i);
    assert.doesNotMatch(policy, /soft-deny|hard-deny/i);
  });
});

describe("rail live views over RPC", () => {
  function widgetCtx() {
    const calls: Array<{ key: string; lines: string[] | undefined }> = [];
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { setWidget: (key: string, lines: string[] | undefined) => calls.push({ key, lines }) },
    };
    return { ctx: ctx as unknown as ExtensionContext, calls };
  }

  it("opens, refreshes in place, and toggles closed", () => {
    const { ctx, calls } = widgetCtx();
    const state = createRuntimeState();
    let content = ["line one"];
    toggleRailView(ctx, state, "status", () => content);
    assert.deepEqual(calls, [{ key: "rail-status", lines: ["line one"] }]);
    assert.equal(state.liveView?.kind, "status");

    state.liveView?.refresh();
    assert.equal(calls.length, 1, "unchanged content must not re-send the widget");

    content = ["line two"];
    state.liveView?.refresh();
    assert.deepEqual(calls.at(-1), { key: "rail-status", lines: ["line two"] });
    assert.equal(calls.length, 2);

    toggleRailView(ctx, state, "status", () => content);
    assert.deepEqual(calls.at(-1), { key: "rail-status", lines: undefined });
    assert.equal(state.liveView, undefined);
  });

  it("replaces a different-kind view instead of stacking", () => {
    const { ctx, calls } = widgetCtx();
    const state = createRuntimeState();
    toggleRailView(ctx, state, "status", () => ["status"]);
    toggleRailView(ctx, state, "policy", () => ["policy"]);
    assert.deepEqual(
      calls.map((c) => `${c.key}:${c.lines ? "set" : "clear"}`),
      ["rail-status:set", "rail-status:clear", "rail-policy:set"],
    );
    assert.equal(state.liveView?.kind, "policy");
  });

  it("showRailView replaces a same-kind report instead of toggling it closed", () => {
    const { ctx, calls } = widgetCtx();
    const state = createRuntimeState();
    showRailView(ctx, state, "report", () => ["first critique"]);
    showRailView(ctx, state, "report", () => ["second critique"]);
    assert.deepEqual(calls.at(-1), { key: "rail-report", lines: ["second critique"] });
    assert.equal(state.liveView?.kind, "report");
  });

  it("is a stderr error, not a view, when headless", () => {
    const state = createRuntimeState();
    const ctx = { mode: "print", hasUI: false, ui: {} } as unknown as ExtensionContext;
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      showRailView(ctx, state, "report", () => ["secret rules"]);
    } finally {
      console.error = original;
    }
    assert.equal(state.liveView, undefined);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0]!, /secret rules/);
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

  it("auto mode hides a healthy quiet rail", () => {
    assert.equal(statusLineVisible("auto", enforcingState()), false);
  });

  it("auto mode shows when the rail is disabled or erroring", () => {
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
