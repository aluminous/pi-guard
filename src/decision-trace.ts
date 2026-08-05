// Decision traces: a structured record of the stages the interceptor
// consulted for each guarded tool call, kept in RuntimeState (newest first)
// for /guard explain. Standalone module — state.ts imports these types, so
// this file must not import from state.ts or status.ts.

export type TraceStageName =
  | "readonly"
  | "path-policy"
  | "read-exemption"
  | "command-allowlist"
  | "screen"
  | "namer"
  | "capabilities"
  | "judge"
  | "ask";

export interface DecisionTraceStage {
  stage: TraceStageName;
  outcome: string;
  detail: string;
}

export interface DecisionTrace {
  at: number;
  toolName: string;
  /** describeAction output — the same summary approval dialogs show. */
  action: string;
  final: "allowed" | "blocked";
  stages: DecisionTraceStage[];
}

export const TRACE_LIMIT = 20;

export function addTraceStage(trace: DecisionTrace, stage: TraceStageName, outcome: string, detail: string): void {
  trace.stages.push({ stage, outcome, detail });
}

function formatTraceAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Colored tags reuse styleRailLine's [ALLOW]/[BLOCK]/[ASK]/[ERROR] conventions. */
function stageTag(outcome: string): string {
  if (outcome === "block" || outcome === "deny" || outcome === "denied" || outcome === "unanswerable") return "BLOCK";
  if (outcome === "error") return "ERROR";
  if (outcome === "ask") return "ASK";
  if (outcome === "pass" || outcome === "exempt" || outcome === "allow" || outcome === "approved") return "ALLOW";
  return outcome.toUpperCase();
}

export function formatDecisionTrace(trace: DecisionTrace, index: number, total: number): string {
  const lines = [
    `# Rail Decision Trace (${index}/${total}, newest first)`,
    "",
    `  ${trace.action}`,
    `  ${formatTraceAge(trace.at)} · final: ${trace.final}`,
    "",
    "## Decision chain",
    ...(trace.stages.length > 0
      ? trace.stages.map((stage) => `  [${stageTag(stage.outcome)}] ${stage.stage}: ${stage.detail}`)
      : ["  (no stages consulted — the call passed through untouched)"]),
  ];
  return lines.join("\n");
}

export function formatEmptyTrace(): string {
  return ["# Rail Decision Trace", "", "  (no guarded tool calls traced yet this session)"].join("\n");
}
