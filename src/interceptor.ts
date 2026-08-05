import path from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askGuardApproval } from "./approvals.ts";
import { addSessionGuidance, classifierEnabled, isClassifierModelUnavailable, projectToolCall, resolveClassifierModel, reviewToolCall, type CompleteFn } from "./classifier.ts";
import { READONLY_CLASSIFIER_RULES } from "./classifier-rules.ts";
import { explainCommandAllowlist, isCommandAllowlisted } from "./command-allowlist.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { addTraceStage, type DecisionTrace } from "./decision-trace.ts";
import { describeAction, GUARDED_TOOLS, type GuardedToolSpec } from "./guarded-tools.ts";
import { classifierExemptReadReason, decidePathAccess, normalizeUserPath, type AccessKind } from "./policy.ts";
import { appendGuardTelemetry } from "./telemetry.ts";
import {
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordClassifierError,
  recordClassifierResult,
  recordClassifierSkip,
  recordDecisionTrace,
  recordPolicyBlock,
  type RuntimeState,
} from "./state.ts";
import { formatError } from "./util.ts";

export interface ToolCallBlock {
  block: true;
  reason: string;
}

interface TurnAbortContext {
  abort(): void;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export function stopTurnForClassifierFailure(ctx: TurnAbortContext, reason: string): ToolCallBlock {
  ctx.ui.notify(`Guard classifier failed closed: ${reason}. Stopping this turn for user intervention.`, "error");
  ctx.abort();
  return { block: true, reason: `Guard classifier failed closed: ${reason}. This turn was stopped for user intervention.` };
}

function isApprovedPath(approvedRoots: string[], target: string): boolean {
  return approvedRoots.some((root) => target === root || target.startsWith(`${root}/`));
}

function isPiPackageDocsOrExamplePath(target: string): boolean {
  const packageDir = path.resolve(getPackageDir());
  const relative = path.relative(packageDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative === "README.md" || relative.startsWith("docs/") || relative.startsWith("examples/");
}

async function askPathApproval(params: {
  ctx: ExtensionContext;
  state: RuntimeState;
  kind: AccessKind;
  toolName: string;
  path: string;
  reason: string;
  trace: DecisionTrace;
}): Promise<ToolCallBlock | undefined> {
  if (isApprovedPath(params.state.approvals[params.kind], params.path)) {
    addTraceStage(params.trace, "ask", "approved", `${params.kind} ${params.path} already approved this session`);
    return;
  }
  recordApprovalRequested(params.state, params.toolName, params.kind, params.path);
  if (!params.ctx.hasUI) {
    recordApprovalDenied(params.state);
    addTraceStage(params.trace, "ask", "unanswerable", `${params.kind} ${params.path} needs approval but the session is headless`);
    appendGuardTelemetry(params.state, { kind: "approval", tool: params.toolName, access: params.kind, path: params.path, approved: false, reason: params.reason });
    return {
      block: true,
      reason: `${params.kind} requires approval for ${params.path}: ${params.reason}. This is a headless session with no user to ask; rerun interactively or pre-approve the path in guard config.`,
    };
  }
  const answer = await askGuardApproval(
    params.ctx,
    params.state,
    "Guard path approval",
    `${params.toolName} wants ${params.kind} access outside the configured roots:\n\n${params.path}\n\nReason: ${params.reason}\n\nApprove this path for this session?`,
  );
  if (answer.comment) {
    addSessionGuidance(params.state.classifier, answer.approved ? "allowed" : "denied", params.toolName, `${params.kind} ${params.path}`, answer.comment);
  }
  addTraceStage(params.trace, "ask", answer.approved ? "approved" : "denied", `user ${answer.approved ? "approved" : "denied"} ${params.kind} ${params.path}${answer.comment ? " with a comment" : ""}`);
  appendGuardTelemetry(params.state, {
    kind: "approval",
    tool: params.toolName,
    access: params.kind,
    path: params.path,
    approved: answer.approved,
    reason: params.reason,
    userComment: answer.comment,
  });
  if (answer.approved) {
    params.state.approvals[params.kind].push(params.path);
    recordApprovalGranted(params.state, params.toolName, params.kind, params.path);
    return;
  }
  recordApprovalDenied(params.state);
  const commentSuffix = answer.comment ? ` User comment: ${answer.comment}` : "";
  return { block: true, reason: `${params.kind} approval denied for ${params.path}.${commentSuffix} Do not work around the guard; ask the user.` };
}

type PathStageResult =
  | { outcome: "continue"; allowedReadPath?: string }
  | { outcome: "done" }
  | { outcome: "block"; block: ToolCallBlock };

/** Stage 1: deterministic path policy — hard blocks and out-of-roots approval prompts. */
async function enforcePathPolicy(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedGuardConfig,
  spec: GuardedToolSpec,
  input: Record<string, unknown>,
  trace: DecisionTrace,
): Promise<PathStageResult> {
  if (!config.filesystem.enabled || spec.access.length === 0) return { outcome: "continue" };
  const target = spec.path?.(input);
  if (typeof target !== "string") return { outcome: "done" };

  const block = (reason: string): ToolCallBlock => {
    recordPolicyBlock(state, event.toolName, reason);
    appendGuardTelemetry(state, { kind: "block", tool: event.toolName, reason });
    return { block: true, reason: `${reason}. Do not work around the guard; choose an allowed path or ask the user.` };
  };

  let allowedReadPath: string | undefined;
  for (const kind of spec.access) {
    const decision = decidePathAccess(config, ctx.cwd, target, kind);
    if (decision.allowed) {
      addTraceStage(trace, "path-policy", "pass", decision.matchedRoot !== undefined ? `${kind} allowed by root '${decision.matchedRoot}'` : `${kind} allowed: no deny pattern matches (blacklist mode)`);
      if (kind === "read") allowedReadPath = decision.normalizedPath;
      continue;
    }
    if (decision.code === "outside-roots") {
      addTraceStage(trace, "path-policy", "ask", `${decision.reason} → approval`);
      const approval = await askPathApproval({ ctx, state, kind, toolName: event.toolName, path: decision.normalizedPath, reason: decision.reason, trace });
      if (approval) return { outcome: "block", block: approval };
      continue;
    }
    addTraceStage(trace, "path-policy", "block", decision.reason);
    return { outcome: "block", block: block(`${event.toolName} blocked for ${target}: ${decision.reason}`) };
  }
  return { outcome: "continue", allowedReadPath };
}

/**
 * Stage 2: deterministic classifier exemption for reads. A trusted path is
 * the whole action for a read (its projection carries no content), so in-cwd
 * and allowlisted reads skip review entirely — whether or not filesystem
 * enforcement is on; enabled:false only disables blocking, not trust.
 */
export function exemptReadCallReason(spec: GuardedToolSpec, input: Record<string, unknown>, cwd: string, config: ResolvedGuardConfig, allowedReadPath: string | undefined): string | undefined {
  if (!spec.access.includes("read") || spec.access.includes("write")) return undefined;
  const target = spec.path?.(input);
  if (typeof target !== "string") return undefined;
  const canonicalTarget = allowedReadPath ?? normalizeUserPath(cwd, target);
  if (isPiPackageDocsOrExamplePath(canonicalTarget)) return "pi package docs/examples";
  return classifierExemptReadReason(config, cwd, target);
}

/**
 * Stage 2 for bash: deterministic classifier exemption for allowlisted
 * commands. Unlike the read exemption this applies only while the sandbox is
 * actually enforcing (filesystem restrictions on, backend initialized, and it
 * is Seatbelt): "grep *" is only safe because Seatbelt bounds what grep can
 * read and write. Without that containment an allowlisted head could still
 * reach credentials (grep over ~/.ssh), so review stays on.
 */
function isExemptCommandCall(toolName: string, input: Record<string, unknown>, state: RuntimeState, config: ResolvedGuardConfig): boolean {
  if (toolName !== "bash") return false;
  if (!config.filesystem.enabled || !state.initialized || state.backend?.name !== "seatbelt") return false;
  return typeof input.command === "string" && isCommandAllowlisted(input.command, config.commands.allow);
}

/**
 * Session read-only mode (/guard readonly): write and edit are blocked
 * deterministically; bash must be classifier-reviewed (under
 * READONLY_CLASSIFIER_RULES) and is blocked outright when the classifier is
 * disabled — the sandbox still permits writes inside the configured roots, so
 * letting bash run unreviewed would silently break the read-only promise.
 * Exception: deterministically allowlisted commands (grep/ls/git status …)
 * need no review — they are read-only by construction and sandbox-bounded —
 * so read-only mode stays usable even without a classifier.
 */
function enforceReadOnlyMode(toolName: string, input: Record<string, unknown>, state: RuntimeState, config: ResolvedGuardConfig, spec: GuardedToolSpec, trace: DecisionTrace): ToolCallBlock | undefined {
  const block = (reason: string): ToolCallBlock => {
    recordPolicyBlock(state, toolName, reason);
    addTraceStage(trace, "readonly", "block", reason);
    appendGuardTelemetry(state, { kind: "block", tool: toolName, reason });
    return { block: true, reason: `${reason}. Do not work around the guard; ask the user to toggle read-only mode off (/guard readonly) if changes are wanted.` };
  };
  if (spec.access.includes("write")) return block(`${toolName} blocked: guard is in read-only mode`);
  if (toolName === "bash" && !classifierEnabled(config, state.classifier) && !isExemptCommandCall(toolName, input, state, config)) {
    return block("bash blocked: guard is in read-only mode and the classifier is off, so commands cannot be reviewed for writes");
  }
  addTraceStage(trace, "readonly", "pass", toolName === "bash" ? "bash permitted pending review under read-only rules" : `${toolName} permitted in read-only mode`);
  return undefined;
}

export async function interceptToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  /** Test seam: replaces the classifier's model-call function (production always uses the default). */
  completeFn?: CompleteFn,
): Promise<ToolCallBlock | undefined> {
  const config = state.config;
  if (!config || !config.enabled || !state.enabled) return;
  if (!event.input || typeof event.input !== "object") return;
  const input = event.input as Record<string, unknown>;

  const spec = GUARDED_TOOLS[event.toolName];
  if (!spec) return;

  const trace: DecisionTrace = { at: Date.now(), toolName: event.toolName, action: describeAction(event.toolName, spec.project(input)), final: "allowed", stages: [] };
  try {
    const result = await runInterceptStages(event, ctx, state, config, spec, input, trace, completeFn);
    if (result) trace.final = "blocked";
    return result;
  } finally {
    recordDecisionTrace(state, trace);
  }
}

async function runInterceptStages(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedGuardConfig,
  spec: GuardedToolSpec,
  input: Record<string, unknown>,
  trace: DecisionTrace,
  completeFn: CompleteFn | undefined,
): Promise<ToolCallBlock | undefined> {
  if (state.readOnly) {
    const denied = enforceReadOnlyMode(event.toolName, input, state, config, spec, trace);
    if (denied) return denied;
  }

  const path = await enforcePathPolicy(event, ctx, state, config, spec, input, trace);
  if (path.outcome === "done") return;
  if (path.outcome === "block") return path.block;

  if (!classifierEnabled(config, state.classifier)) return;
  const readExemption = exemptReadCallReason(spec, input, ctx.cwd, config, path.allowedReadPath);
  if (spec.access.includes("read") && !spec.access.includes("write")) {
    addTraceStage(trace, "read-exemption", readExemption ? "exempt" : "not exempt", readExemption ?? "not in cwd, allowRead, or pi docs — classifier review required");
  }
  if (readExemption !== undefined) {
    recordClassifierSkip(state);
    return;
  }
  if (event.toolName === "bash" && typeof input.command === "string") {
    if (!config.filesystem.enabled || !state.initialized || state.backend?.name !== "seatbelt") {
      addTraceStage(trace, "command-allowlist", "skipped", "allowlist exemption needs an enforcing Seatbelt sandbox — classifier review required");
    } else {
      const explanation = explainCommandAllowlist(input.command, config.commands.allow);
      if (explanation.allowlisted) {
        addTraceStage(trace, "command-allowlist", "exempt", explanation.segments.map((segment) => `\`${segment.command}\` → rule \`${segment.rule}\``).join("; "));
        recordClassifierSkip(state);
        return;
      }
      addTraceStage(trace, "command-allowlist", "not exempt", explanation.reason);
    }
  }
  return runClassifierReview(event, ctx, state, config, trace, completeFn);
}

/** Stage 3: LLM review — two-stage classify, ask-with-comment flow, fail-open/closed error handling. */
async function runClassifierReview(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedGuardConfig,
  trace: DecisionTrace,
  completeFn: CompleteFn | undefined,
): Promise<ToolCallBlock | undefined> {
  const startedAt = performance.now();
  let telemetryModel: string | undefined;
  try {
    const model = resolveClassifierModel(ctx, config, state.classifier);
    telemetryModel = model ? `${model.provider}/${model.id}` : undefined;
  } catch {
    telemetryModel = undefined;
  }
  try {
    const result = await reviewToolCall({
      ctx,
      config,
      state: state.classifier,
      toolName: event.toolName,
      input: event.input,
      rulesOverride: state.readOnly ? READONLY_CLASSIFIER_RULES : undefined,
      completeFn,
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    state.classifier.lastDecision = { ...result, toolName: event.toolName, at: Date.now() };
    state.classifier.lastError = undefined;
    recordClassifierResult(state, event.toolName, result);
    addTraceStage(
      trace,
      "classifier",
      result.decision,
      `${result.decision} · risk ${result.risk} · ${result.reason} (model ${telemetryModel ?? "unknown"}${result.fastPath ? ", fast path" : ""}, ${latencyMs}ms)`,
    );
    const telemetry = {
      kind: "review" as const,
      tool: event.toolName,
      decision: result.decision,
      risk: result.risk,
      authorization: result.authorization,
      fastPath: result.fastPath,
      attempts: result.attempts,
      latencyMs,
      model: telemetryModel,
      reason: result.reason,
      usage: result.tokenUsage
        ? { input: result.tokenUsage.input, output: result.tokenUsage.output, cacheRead: result.tokenUsage.cacheRead, cacheWrite: result.tokenUsage.cacheWrite }
        : undefined,
      projection: projectToolCall(event.toolName, event.input, ctx.cwd, config),
    };
    if (result.decision === "allow") {
      appendGuardTelemetry(state, telemetry);
      return;
    }
    if (result.decision === "ask" && ctx.hasUI) {
      // Action first: the classifier's reason alone can be too vague to approve on.
      const subject = describeAction(event.toolName, telemetry.projection.inputSummary);
      const answer = await askGuardApproval(ctx, state, "Guard reviewer asks for approval", `${subject}\n\n${result.reason}\n\nAllow?`);
      if (answer.comment) {
        // addSessionGuidance already prefixes the tool name; strip it from the shared subject.
        const guidanceSubject = subject.startsWith(`${event.toolName}: `) ? subject.slice(event.toolName.length + 2) : subject;
        addSessionGuidance(state.classifier, answer.approved ? "allowed" : "denied", event.toolName, guidanceSubject, answer.comment);
      }
      addTraceStage(trace, "ask", answer.approved ? "approved" : "denied", `user ${answer.approved ? "approved" : "denied"}${answer.comment ? " with a comment" : ""}`);
      appendGuardTelemetry(state, { ...telemetry, userApproved: answer.approved, userComment: answer.comment });
      if (answer.approved) return;
      const commentSuffix = answer.comment ? ` User comment: ${answer.comment}` : "";
      return { block: true, reason: `Guard reviewer asked and the user denied: ${result.reason}.${commentSuffix} Do not work around this denial; choose a safer path or ask the user.` };
    }
    appendGuardTelemetry(state, telemetry);
    if (result.decision === "ask") {
      addTraceStage(trace, "ask", "unanswerable", "reviewer asked for approval but the session is headless");
      return {
        block: true,
        reason: `Guard reviewer asks for approval, but this headless session has no user to ask: ${result.reason}. Rerun interactively or adjust guard config to authorize this action.`,
      };
    }
    return { block: true, reason: `Guard reviewer ${result.decision}: ${result.reason}. Do not work around this denial; choose a safer path or ask the user.` };
  } catch (error) {
    const reason = formatError(error);
    state.classifier.lastError = reason;
    recordClassifierError(state, event.toolName, reason);
    addTraceStage(trace, "classifier", "error", `review failed: ${reason}`);
    appendGuardTelemetry(state, {
      kind: "error",
      tool: event.toolName,
      reason,
      latencyMs: Math.round(performance.now() - startedAt),
      model: telemetryModel,
    });
    if (isClassifierModelUnavailable(error)) {
      ctx.ui.notify(`Guard classifier unavailable: ${reason}. Stopping this turn for user intervention.`, "error");
      ctx.abort();
      return { block: true, reason: `Guard classifier unavailable: ${reason}. This turn was stopped for user intervention.` };
    }
    // Read-only mode never fails open for bash: an unreviewed command could
    // still perform sandbox-allowed writes, silently breaking the read-only
    // promise, so a review failure must block even with failClosed disabled.
    if (!config.classifier.failClosed && !(state.readOnly && event.toolName === "bash")) {
      ctx.ui.notify(`Guard classifier failed open: ${reason}`, "warning");
      return;
    }
    return stopTurnForClassifierFailure(ctx, reason);
  }
}
