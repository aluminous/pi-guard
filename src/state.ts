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
  classifierInputTokens: number;
  classifierOutputTokens: number;
  turnRuleHits: number;
  turnClassifierHits: number;
  turnClassifierDenials: number;
}

export interface RuntimeState {
  config: ResolvedGuardConfig | undefined;
  backend: GuardBackend | undefined;
  enabled: boolean;
  disabledForNextAgent: boolean;
  initialized: boolean;
  lastError: string | undefined;
  warnings: string[];
  classifier: ClassifierState;
  approvals: {
    read: string[];
    write: string[];
  };
  stats: GuardStats;
  recent: GuardEvent[];
  /** provider/id specs with configured auth, cached at session start for argument completions (which get no ctx). */
  availableModelSpecs: string[];
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
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    turnRuleHits: 0,
    turnClassifierHits: 0,
    turnClassifierDenials: 0,
  };
}

export function createRuntimeState(): RuntimeState {
  return {
    config: undefined,
    backend: undefined,
    enabled: false,
    disabledForNextAgent: false,
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
  state.enabled = false;
  state.disabledForNextAgent = false;
  state.initialized = false;
  state.lastError = undefined;
  state.warnings = [];
  state.classifier = {};
  state.approvals = { read: [], write: [] };
  state.stats = createGuardStats();
}

export function resetTurnStats(state: RuntimeState): void {
  state.stats.turnRuleHits = 0;
  state.stats.turnClassifierHits = 0;
  state.stats.turnClassifierDenials = 0;
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
}

export function recordClassifierResult(state: RuntimeState, toolName: string, result: ClassifierResult): void {
  state.stats.reviewed++;
  state.stats.classifierHits++;
  state.stats.turnClassifierHits++;
  state.stats.classifierInputTokens += result.tokenUsage?.input ?? 0;
  state.stats.classifierOutputTokens += result.tokenUsage?.output ?? 0;
  if (result.decision === "allow") state.stats.allowed++;
  if (result.decision === "deny") {
    state.stats.denied++;
    state.stats.classifierDenials++;
    state.stats.turnClassifierDenials++;
  }
  if (result.decision === "ask") state.stats.asked++;
  pushRecent(state, { at: Date.now(), toolName, decision: result.decision, risk: result.risk, reason: result.reason });
}

export function recordClassifierError(state: RuntimeState, toolName: string, reason: string): void {
  state.stats.errors++;
  pushRecent(state, { at: Date.now(), toolName, decision: "error", reason });
}
