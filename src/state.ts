import type { GuardBackend } from "./backends/types.ts";
import type { ClassifierResult, ClassifierState } from "./classifier.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import type { AccessKind } from "./policy.ts";

export interface GuardEvent {
  at: number;
  toolName: string;
  decision: "allow" | "deny" | "ask" | "block" | "error";
  risk?: string;
  reason: string;
}

export interface GuardStats {
  reviewed: number;
  allowed: number;
  denied: number;
  asked: number;
  blocked: number;
  errors: number;
  ruleHits: number;
  classifierHits: number;
  classifierDenials: number;
  /** Reads and allowlisted commands exempted from classifier review deterministically. */
  classifierSkips: number;
  classifierInputTokens: number;
  classifierOutputTokens: number;
  /** Input tokens served from the provider prompt cache (subset of total prompt tokens, not of classifierInputTokens). */
  classifierCacheReadTokens: number;
  classifierCacheWriteTokens: number;
  turnRuleHits: number;
  turnClassifierHits: number;
  turnClassifierDenials: number;
  turnBlocked: number;
}

/** "status"/"policy" are the toggleable live views; "report" is one-shot output (smoke, critique). */
export type GuardViewKind = "status" | "policy" | "report";

/**
 * An open live guard view — a TUI overlay popup or an RPC widget.
 * refresh() re-renders content from current state, close() dismisses it.
 */
export interface GuardLiveView {
  kind: GuardViewKind;
  refresh(): void;
  close(): void;
}

export interface RuntimeState {
  config: ResolvedGuardConfig | undefined;
  backend: GuardBackend | undefined;
  enabled: boolean;
  disabledForNextAgent: boolean;
  /** Session read-only mode: write/edit blocked, bash reviewed under READONLY_CLASSIFIER_RULES (blocked if the classifier is off). */
  readOnly: boolean;
  initialized: boolean;
  lastError: string | undefined;
  warnings: string[];
  classifier: ClassifierState;
  /** Open live status/policy view (TUI overlay or RPC widget), if any. */
  liveView?: GuardLiveView;
  approvals: {
    read: string[];
    write: string[];
  };
  stats: GuardStats;
  recent: GuardEvent[];
  /** provider/id specs with configured auth, cached at session start for argument completions (which get no ctx). */
  availableModelSpecs: string[];
  /** Writes a custom entry to pi's session log (pi.appendEntry). Undefined in tests without session wiring. */
  appendEntry?: (customType: string, data: unknown) => void;
}

export function createGuardStats(): GuardStats {
  return {
    reviewed: 0,
    allowed: 0,
    denied: 0,
    asked: 0,
    blocked: 0,
    errors: 0,
    ruleHits: 0,
    classifierHits: 0,
    classifierDenials: 0,
    classifierSkips: 0,
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    classifierCacheReadTokens: 0,
    classifierCacheWriteTokens: 0,
    turnRuleHits: 0,
    turnClassifierHits: 0,
    turnClassifierDenials: 0,
    turnBlocked: 0,
  };
}

export function createRuntimeState(): RuntimeState {
  return {
    config: undefined,
    backend: undefined,
    enabled: false,
    disabledForNextAgent: false,
    readOnly: false,
    initialized: false,
    lastError: undefined,
    warnings: [],
    classifier: {},
    approvals: { read: [], write: [] },
    stats: createGuardStats(),
    recent: [],
    availableModelSpecs: [],
  };
}

/** Resets per-session fields in place; the state object identity is shared by closures. */
export function resetSessionState(state: RuntimeState): void {
  state.liveView?.close();
  state.liveView = undefined;
  state.enabled = false;
  state.disabledForNextAgent = false;
  state.readOnly = false;
  state.initialized = false;
  state.lastError = undefined;
  state.warnings = [];
  state.classifier = {};
  state.approvals = { read: [], write: [] };
  state.stats = createGuardStats();
}

/** Resets the per-turn counters. A "turn" spans from one user message to the next, not each agent loop iteration. */
export function resetTurnStats(state: RuntimeState): void {
  state.stats.turnRuleHits = 0;
  state.stats.turnClassifierHits = 0;
  state.stats.turnClassifierDenials = 0;
  state.stats.turnBlocked = 0;
}

function pushRecent(state: RuntimeState, event: GuardEvent) {
  state.recent.unshift(event);
  state.recent = state.recent.slice(0, 8);
}

/** A deterministic policy rule hard-blocked the call. */
export function recordPolicyBlock(state: RuntimeState, toolName: string, reason: string): void {
  state.stats.ruleHits++;
  state.stats.turnRuleHits++;
  state.stats.blocked++;
  state.stats.turnBlocked++;
  pushRecent(state, { at: Date.now(), toolName, decision: "block", reason });
}

/** An out-of-roots path triggered an interactive approval request. */
export function recordApprovalRequested(state: RuntimeState, toolName: string, kind: AccessKind, path: string): void {
  state.stats.ruleHits++;
  state.stats.turnRuleHits++;
  state.stats.asked++;
  pushRecent(state, { at: Date.now(), toolName, decision: "ask", reason: `${kind} approval requested for ${path}` });
}

export function recordApprovalGranted(state: RuntimeState, toolName: string, kind: AccessKind, path: string): void {
  pushRecent(state, { at: Date.now(), toolName, decision: "allow", reason: `approved ${kind} path ${path}` });
}

export function recordApprovalDenied(state: RuntimeState): void {
  state.stats.blocked++;
  state.stats.turnBlocked++;
}

export function recordClassifierResult(state: RuntimeState, toolName: string, result: ClassifierResult): void {
  state.stats.reviewed++;
  state.stats.classifierHits++;
  state.stats.turnClassifierHits++;
  state.stats.classifierInputTokens += result.tokenUsage?.input ?? 0;
  state.stats.classifierOutputTokens += result.tokenUsage?.output ?? 0;
  state.stats.classifierCacheReadTokens += result.tokenUsage?.cacheRead ?? 0;
  state.stats.classifierCacheWriteTokens += result.tokenUsage?.cacheWrite ?? 0;
  if (result.decision === "allow") state.stats.allowed++;
  if (result.decision === "deny") {
    state.stats.denied++;
    state.stats.classifierDenials++;
    state.stats.turnClassifierDenials++;
  }
  if (result.decision === "ask") state.stats.asked++;
  pushRecent(state, { at: Date.now(), toolName, decision: result.decision, risk: result.risk, reason: result.reason });
}

/** A read or allowlisted command skipped classifier review deterministically. */
export function recordClassifierSkip(state: RuntimeState): void {
  state.stats.classifierSkips++;
}

export function recordClassifierError(state: RuntimeState, toolName: string, reason: string): void {
  state.stats.errors++;
  pushRecent(state, { at: Date.now(), toolName, decision: "error", reason });
}
