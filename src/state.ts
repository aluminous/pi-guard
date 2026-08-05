import type { RailBackend } from "./backends/types.ts";
import { applyReadOnlyPreset, clearPreset, createCapabilityState, recordCapabilityHits, type CapabilityId, type CapabilityState, type Disposition } from "./capabilities.ts";
import type { ClassifierState } from "./classifier.ts";
import type { ResolvedRailConfig } from "./config.ts";
import { TRACE_LIMIT, type DecisionTrace } from "./decision-trace.ts";
import type { AccessKind } from "./policy.ts";

export interface RailEvent {
  at: number;
  toolName: string;
  decision: "allow" | "deny" | "ask" | "block" | "error";
  /** Capability labels behind the decision, when it came from the table. */
  capabilities?: CapabilityId[];
  reason: string;
}

export interface RailStats {
  reviewed: number;
  allowed: number;
  denied: number;
  asked: number;
  blocked: number;
  errors: number;
  /** Classifier failures bucketed by cause ("timeout", "server error", "connection", …); only kinds actually seen appear. */
  errorsByKind: Record<string, number>;
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
export type RailViewKind = "status" | "policy" | "report";

/**
 * An open live rail view — a TUI overlay popup or an RPC widget.
 * refresh() re-renders content from current state, close() dismisses it.
 */
export interface RailLiveView {
  kind: RailViewKind;
  refresh(): void;
  close(): void;
  /**
   * Tabbed panels only (the policy page): retarget the open panel instead of
   * closing it, so `/rail policy rules` with the dispositions tab up switches
   * tabs rather than toggling the whole panel away.
   */
  selectTab?(tab: string): void;
  activeTab?(): string;
}

export interface RuntimeState {
  config: ResolvedRailConfig | undefined;
  backend: RailBackend | undefined;
  enabled: boolean;
  disabledForNextAgent: boolean;
  /** Session read-only mode: write/edit blocked, bash named-and-judged under the read-only disposition preset (blocked if the classifier is off). */
  readOnly: boolean;
  initialized: boolean;
  lastError: string | undefined;
  warnings: string[];
  classifier: ClassifierState;
  /** Session disposition overrides, the read-only preset, and per-class stats. */
  capabilities: CapabilityState;
  /** Open live status/policy view (TUI overlay or RPC widget), if any. */
  liveView?: RailLiveView;
  approvals: {
    read: string[];
    write: string[];
  };
  stats: RailStats;
  recent: RailEvent[];
  /** Per-call decision traces for /rail explain, newest first (last TRACE_LIMIT). */
  traces: DecisionTrace[];
  /** Most recent sandboxed bash execution, for the /rail why sandbox-denial window. */
  lastBashCommand?: { command: string; startedAt: number; endedAt?: number };
  /** provider/id specs with configured auth, cached at session start for argument completions (which get no ctx). */
  availableModelSpecs: string[];
  /** Child identities (session file/transcript) already warned about running without rail acknowledgement. */
  subagentAckWarned: Set<string>;
  /** Writes a custom entry to pi's session log (pi.appendEntry). Undefined in tests without session wiring. */
  appendEntry?: (customType: string, data: unknown) => void;
}

export function createRailStats(): RailStats {
  return {
    reviewed: 0,
    allowed: 0,
    denied: 0,
    asked: 0,
    blocked: 0,
    errors: 0,
    errorsByKind: {},
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
    capabilities: createCapabilityState(),
    approvals: { read: [], write: [] },
    stats: createRailStats(),
    recent: [],
    traces: [],
    availableModelSpecs: [],
    subagentAckWarned: new Set(),
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
  state.capabilities = createCapabilityState();
  state.approvals = { read: [], write: [] };
  state.stats = createRailStats();
  state.traces = [];
  state.lastBashCommand = undefined;
  state.subagentAckWarned = new Set();
}

/**
 * Keeps the session disposition preset in sync with read-only mode. Derived
 * rather than set by the toggle, so anything that flips state.readOnly (the
 * command, a shortcut, a test) gets the preset without having to remember it.
 */
export function syncCapabilityPreset(state: RuntimeState): void {
  if (state.readOnly) applyReadOnlyPreset(state.capabilities);
  else clearPreset(state.capabilities);
}

/** Resets the per-turn counters. A "turn" spans from one user message to the next, not each agent loop iteration. */
export function resetTurnStats(state: RuntimeState): void {
  state.stats.turnRuleHits = 0;
  state.stats.turnClassifierHits = 0;
  state.stats.turnClassifierDenials = 0;
  state.stats.turnBlocked = 0;
}

function pushRecent(state: RuntimeState, event: RailEvent) {
  state.recent.unshift(event);
  state.recent = state.recent.slice(0, 8);
}

export function recordDecisionTrace(state: RuntimeState, trace: DecisionTrace): void {
  state.traces.unshift(trace);
  state.traces = state.traces.slice(0, TRACE_LIMIT);
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

export interface CapabilityDecisionRecord {
  labels: CapabilityId[];
  decision: "allow" | "deny" | "ask";
  /** The resolved table disposition that produced this decision. */
  disposition: Disposition;
  reason: string;
  /** True when a model call (namer and/or judge) was involved; deterministic table hits count as rule hits instead. */
  reviewed: boolean;
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** One resolved capability decision: statusline counters, per-class stats, and the recent-decisions ring. */
export function recordCapabilityDecision(state: RuntimeState, toolName: string, record: CapabilityDecisionRecord): void {
  if (record.reviewed) {
    state.stats.reviewed++;
    state.stats.classifierHits++;
    state.stats.turnClassifierHits++;
  } else {
    state.stats.ruleHits++;
    state.stats.turnRuleHits++;
  }
  state.stats.classifierInputTokens += record.tokenUsage?.input ?? 0;
  state.stats.classifierOutputTokens += record.tokenUsage?.output ?? 0;
  state.stats.classifierCacheReadTokens += record.tokenUsage?.cacheRead ?? 0;
  state.stats.classifierCacheWriteTokens += record.tokenUsage?.cacheWrite ?? 0;
  if (record.decision === "allow") state.stats.allowed++;
  if (record.decision === "deny") {
    state.stats.denied++;
    state.stats.classifierDenials++;
    state.stats.turnClassifierDenials++;
  }
  if (record.decision === "ask") state.stats.asked++;
  recordCapabilityHits(state.capabilities, record.labels);
  pushRecent(state, { at: Date.now(), toolName, decision: record.decision, capabilities: record.labels, reason: record.reason });
}

/** A read or allowlisted command skipped classifier review deterministically. */
export function recordClassifierSkip(state: RuntimeState): void {
  state.stats.classifierSkips++;
}

/**
 * One classifier failure — namer or judge. `kind` is the coarse cause bucket
 * from classifyClassifierFailure, so a session can say whether its five errors
 * were one provider incident or five different problems.
 */
export function recordClassifierError(state: RuntimeState, toolName: string, reason: string, kind: string): void {
  state.stats.errors++;
  state.stats.errorsByKind[kind] = (state.stats.errorsByKind[kind] ?? 0) + 1;
  pushRecent(state, { at: Date.now(), toolName, decision: "error", reason });
}
