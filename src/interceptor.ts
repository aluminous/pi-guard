import path from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askGuardApproval } from "./approvals.ts";
import { addSessionGuidance, classifierEnabled, isClassifierModelUnavailable, projectToolCall, resolveClassifierModel, reviewToolCall } from "./classifier.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { describeAction, GUARDED_TOOLS, type GuardedToolSpec } from "./guarded-tools.ts";
import { decidePathAccess, isClassifierExemptRead, normalizeUserPath, type AccessKind } from "./policy.ts";
import { appendGuardTelemetry } from "./telemetry.ts";
import {
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordClassifierError,
  recordClassifierResult,
  recordClassifierSkip,
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
}): Promise<ToolCallBlock | undefined> {
  if (isApprovedPath(params.state.approvals[params.kind], params.path)) return;
  recordApprovalRequested(params.state, params.toolName, params.kind, params.path);
  if (!params.ctx.hasUI) {
    recordApprovalDenied(params.state);
    appendGuardTelemetry(params.state, { kind: "approval", tool: params.toolName, access: params.kind, path: params.path, approved: false, reason: params.reason });
    return {
      block: true,
      reason: `${params.kind} requires approval for ${params.path}: ${params.reason}. This is a headless session with no user to ask; rerun interactively or pre-approve the path in guard config.`,
    };
  }
  const answer = await askGuardApproval(
    params.ctx,
    "Guard path approval",
    `${params.toolName} wants ${params.kind} access outside the configured roots:\n\n${params.path}\n\nReason: ${params.reason}\n\nApprove this path for this session?`,
  );
  if (answer.comment) {
    addSessionGuidance(params.state.classifier, answer.approved ? "allowed" : "denied", params.toolName, `${params.kind} ${params.path}`, answer.comment);
  }
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
      if (kind === "read") allowedReadPath = decision.normalizedPath;
      continue;
    }
    if (decision.code === "outside-roots") {
      const approval = await askPathApproval({ ctx, state, kind, toolName: event.toolName, path: decision.normalizedPath, reason: decision.reason });
      if (approval) return { outcome: "block", block: approval };
      continue;
    }
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
function isExemptReadCall(spec: GuardedToolSpec, input: Record<string, unknown>, cwd: string, config: ResolvedGuardConfig, allowedReadPath: string | undefined): boolean {
  if (!spec.access.includes("read") || spec.access.includes("write")) return false;
  const target = spec.path?.(input);
  if (typeof target !== "string") return false;
  const canonicalTarget = allowedReadPath ?? normalizeUserPath(cwd, target);
  return isPiPackageDocsOrExamplePath(canonicalTarget) || isClassifierExemptRead(config, cwd, target);
}

export async function interceptToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
): Promise<ToolCallBlock | undefined> {
  const config = state.config;
  if (!config || !config.enabled || !state.enabled) return;
  if (!event.input || typeof event.input !== "object") return;
  const input = event.input as Record<string, unknown>;

  const spec = GUARDED_TOOLS[event.toolName];
  if (!spec) return;

  const path = await enforcePathPolicy(event, ctx, state, config, spec, input);
  if (path.outcome === "done") return;
  if (path.outcome === "block") return path.block;

  if (!classifierEnabled(config, state.classifier)) return;
  if (isExemptReadCall(spec, input, ctx.cwd, config, path.allowedReadPath)) {
    recordClassifierSkip(state);
    return;
  }
  return runClassifierReview(event, ctx, state, config);
}

/** Stage 3: LLM review — two-stage classify, ask-with-comment flow, fail-open/closed error handling. */
async function runClassifierReview(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedGuardConfig,
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
    const result = await reviewToolCall({ ctx, config, state: state.classifier, toolName: event.toolName, input: event.input });
    const latencyMs = Math.round(performance.now() - startedAt);
    state.classifier.lastDecision = { ...result, toolName: event.toolName, at: Date.now() };
    state.classifier.lastError = undefined;
    recordClassifierResult(state, event.toolName, result);
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
      const answer = await askGuardApproval(ctx, "Guard reviewer asks for approval", `${subject}\n\n${result.reason}\n\nAllow?`);
      if (answer.comment) {
        // addSessionGuidance already prefixes the tool name; strip it from the shared subject.
        const guidanceSubject = subject.startsWith(`${event.toolName}: `) ? subject.slice(event.toolName.length + 2) : subject;
        addSessionGuidance(state.classifier, answer.approved ? "allowed" : "denied", event.toolName, guidanceSubject, answer.comment);
      }
      appendGuardTelemetry(state, { ...telemetry, userApproved: answer.approved, userComment: answer.comment });
      if (answer.approved) return;
      const commentSuffix = answer.comment ? ` User comment: ${answer.comment}` : "";
      return { block: true, reason: `Guard reviewer asked and the user denied: ${result.reason}.${commentSuffix} Do not work around this denial; choose a safer path or ask the user.` };
    }
    appendGuardTelemetry(state, telemetry);
    if (result.decision === "ask") {
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
    if (!config.classifier.failClosed) {
      ctx.ui.notify(`Guard classifier failed open: ${reason}`, "warning");
      return;
    }
    return stopTurnForClassifierFailure(ctx, reason);
  }
}
