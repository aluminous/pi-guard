import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityStats } from "../src/capabilities.ts";
import {
  createRuntimeState,
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordCapabilityDecision,
  recordClassifierError,
  recordPolicyBlock,
  resetSessionState,
  resetTurnStats,
} from "../src/state.ts";

describe("decision recording", () => {
  it("counts policy blocks as rule hits", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "read denied by pattern .env");
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.turnRuleHits, 1);
    assert.equal(state.stats.blocked, 1);
    assert.equal(state.recent[0]?.decision, "block");
  });

  it("tracks the approval ask/deny flow", () => {
    const state = createRuntimeState();
    recordApprovalRequested(state, "write", "write", "/tmp/x");
    assert.equal(state.stats.asked, 1);
    assert.equal(state.stats.ruleHits, 1);
    recordApprovalDenied(state);
    assert.equal(state.stats.blocked, 1);
  });

  it("records approval grants as allow events without counter changes", () => {
    const state = createRuntimeState();
    recordApprovalGranted(state, "read", "read", "/tmp/x");
    assert.equal(state.recent[0]?.decision, "allow");
    assert.equal(state.stats.ruleHits, 0);
    assert.equal(state.stats.allowed, 0);
  });

  it("derives review counters from capability decisions", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "bash", { labels: ["run-dev-tools"], decision: "allow", disposition: "allow", reason: "ok", reviewed: true, tokenUsage: { input: 100, output: 20 } });
    recordCapabilityDecision(state, "bash", { labels: ["credentials"], decision: "deny", disposition: "judge", reason: "no", reviewed: true, tokenUsage: { input: 50, output: 10 } });
    recordCapabilityDecision(state, "bash", { labels: ["off-machine-effects"], decision: "ask", disposition: "ask", reason: "confirm", reviewed: true });
    assert.equal(state.stats.reviewed, 3);
    assert.equal(state.stats.classifierHits, 3);
    assert.equal(state.stats.turnClassifierHits, 3);
    assert.equal(state.stats.allowed, 1);
    assert.equal(state.stats.denied, 1);
    assert.equal(state.stats.classifierDenials, 1);
    assert.equal(state.stats.turnClassifierDenials, 1);
    assert.equal(state.stats.asked, 1);
    assert.equal(state.stats.classifierInputTokens, 150);
    assert.equal(state.stats.classifierOutputTokens, 30);
    assert.equal(capabilityStats(state.capabilities, "credentials").hits, 1);
    assert.equal(state.recent[0]?.capabilities?.[0], "off-machine-effects");
  });

  it("counts a deterministic table hit as a rule hit, not a review", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "read", { labels: ["read-project"], decision: "allow", disposition: "allow", reason: "in cwd", reviewed: false });
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.turnRuleHits, 1);
    assert.equal(state.stats.classifierHits, 0);
    assert.equal(state.stats.reviewed, 0);
    assert.equal(state.stats.allowed, 1);
  });

  it("records classifier errors", () => {
    const state = createRuntimeState();
    recordClassifierError(state, "bash", "boom");
    assert.equal(state.stats.errors, 1);
    assert.equal(state.recent[0]?.decision, "error");
  });

  it("caps recent events at 8", () => {
    const state = createRuntimeState();
    for (let i = 0; i < 12; i++) recordPolicyBlock(state, "read", `block ${i}`);
    assert.equal(state.recent.length, 8);
    assert.equal(state.recent[0]?.reason, "block 11");
  });

  it("resets turn counters without touching session totals", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    resetTurnStats(state);
    assert.equal(state.stats.turnRuleHits, 0);
    assert.equal(state.stats.turnBlocked, 0);
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.blocked, 1);
  });

  it("counts blocks and denied approvals in the per-turn blocked counter", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    recordApprovalDenied(state);
    assert.equal(state.stats.turnBlocked, 2);
    assert.equal(state.stats.blocked, 2);
  });

  it("resets session state in place, preserving object identity", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    state.approvals.read.push("/tmp/x");
    const identity = state;
    resetSessionState(state);
    assert.equal(state, identity);
    assert.equal(state.stats.ruleHits, 0);
    assert.deepEqual(state.approvals, { read: [], write: [] });
  });
});
