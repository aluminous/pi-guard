// Guard decision telemetry. Records every guard decision as a `custom` entry
// in pi's own session log (customType "guard") so real sessions become a
// corpus for analyzing and improving the classifier. Entries sit next to the
// tool call they judged, do not participate in LLM context, and are written
// best-effort: telemetry must never block, delay, or break a tool call.
//
// Privacy: the session file already contains the full tool call input and its
// result, so a minimized projection adds little exposure — but sessions can be
// shared (`pi share` uploads the whole file), so the default "minimal" tier
// truncates projected values. "full" keeps complete projections and policy
// summaries for eval-case extraction; "off" writes nothing.
import type { ClassifierResult, ReviewProjection } from "./classifier-protocol.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import type { RuntimeState } from "./state.ts";
import { textPrefix } from "./util.ts";

export const GUARD_TELEMETRY_TYPE = "guard";
const MINIMAL_VALUE_LIMIT = 200;

export type GuardTelemetryMode = "off" | "minimal" | "full";

export interface GuardTelemetryBase {
  kind: "review" | "block" | "approval" | "error";
  tool: string;
}

export interface GuardReviewTelemetry extends GuardTelemetryBase {
  kind: "review";
  decision: ClassifierResult["decision"];
  risk: ClassifierResult["risk"];
  authorization: ClassifierResult["authorization"];
  fastPath?: boolean;
  attempts?: number;
  latencyMs: number;
  model?: string;
  reason: string;
  /** Set for "ask" decisions: whether the user approved execution. */
  userApproved?: boolean;
  /** User comment attached to an allow/deny answer, if any. */
  userComment?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  projection?: ReviewProjection;
}

export interface GuardBlockTelemetry extends GuardTelemetryBase {
  kind: "block";
  reason: string;
}

export interface GuardApprovalTelemetry extends GuardTelemetryBase {
  kind: "approval";
  access: string;
  path: string;
  approved: boolean;
  reason: string;
  /** User comment attached to an allow/deny answer, if any. */
  userComment?: string;
}

export interface GuardErrorTelemetry extends GuardTelemetryBase {
  kind: "error";
  reason: string;
  latencyMs: number;
  model?: string;
}

export type GuardTelemetryRecord =
  | GuardReviewTelemetry
  | GuardBlockTelemetry
  | GuardApprovalTelemetry
  | GuardErrorTelemetry;

export function telemetryMode(config: ResolvedGuardConfig): GuardTelemetryMode {
  return config.classifier.telemetry;
}

function truncateStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return textPrefix(value, limit);
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, limit));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = truncateStrings(item, limit);
    return out;
  }
  return value;
}

/** Applies the configured privacy tier to a record about to be persisted. */
export function redactTelemetryRecord(record: GuardTelemetryRecord, mode: GuardTelemetryMode): GuardTelemetryRecord {
  if (mode === "full" || record.kind !== "review" || !record.projection) return record;
  return {
    ...record,
    projection: {
      ...record.projection,
      inputSummary: truncateStrings(record.projection.inputSummary, MINIMAL_VALUE_LIMIT) as Record<string, unknown>,
      policySummary: [],
    },
  };
}

/**
 * Persists a guard decision record to the session log via pi.appendEntry.
 * Never throws: session logging is observability, not enforcement, and
 * ephemeral sessions silently skip persistence inside SessionManager.
 */
export function appendGuardTelemetry(state: RuntimeState, record: GuardTelemetryRecord): void {
  const config = state.config;
  if (!config || telemetryMode(config) === "off" || !state.appendEntry) return;
  try {
    state.appendEntry(GUARD_TELEMETRY_TYPE, redactTelemetryRecord(record, telemetryMode(config)));
  } catch {
    // Best-effort: a session that cannot persist entries must not affect the tool call.
  }
}
