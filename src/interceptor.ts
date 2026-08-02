import path from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, isClassifierModelUnavailable, projectToolCall, resolveClassifierModel, reviewToolCall } from "./classifier.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { GUARDED_TOOLS } from "./guarded-tools.ts";
import { decidePathAccess, type AccessKind } from "./policy.ts";
import { appendGuardTelemetry } from "./telemetry.ts";
import {
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordClassifierError,
  recordClassifierResult,
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
    return { block: true, reason: `${params.kind} requires approval for ${params.path}: ${params.reason}` };
  }
  const ok = await params.ctx.ui.confirm(
    "Guard path approval",
    `${params.toolName} wants ${params.kind} access outside the configured roots:\n\n${params.path}\n\nReason: ${params.reason}\n\nApprove this path for this session?`,
  );
  if (ok) {
    params.state.approvals[params.kind].push(params.path);
    recordApprovalGranted(params.state, params.toolName, params.kind, params.path);
    appendGuardTelemetry(params.state, { kind: "approval", tool: params.toolName, access: params.kind, path: params.path, approved: true, reason: params.reason });
    return;
  }
  recordApprovalDenied(params.state);
  appendGuardTelemetry(params.state, { kind: "approval", tool: params.toolName, access: params.kind, path: params.path, approved: false, reason: params.reason });
  return { block: true, reason: `${params.kind} approval denied for ${params.path}. Do not work around the guard; ask the user.` };
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

  const block = (reason: string): ToolCallBlock => {
    recordPolicyBlock(state, event.toolName, reason);
    appendGuardTelemetry(state, { kind: "block", tool: event.toolName, reason });
    return { block: true, reason: `${reason}. Do not work around the guard; choose an allowed path or ask the user.` };
  };

  let allowedReadPath: string | undefined;

  if (config.filesystem.enabled && spec.access.length > 0) {
    const target = spec.path?.(input);
    if (typeof target !== "string") return;
    for (const kind of spec.access) {
      const decision = decidePathAccess(config, ctx.cwd, target, kind);
      if (decision.allowed) {
        if (kind === "read") allowedReadPath = decision.normalizedPath;
        continue;
      }
      if (decision.code === "outside-roots") {
        const approval = await askPathApproval({ ctx, state, kind, toolName: event.toolName, path: decision.normalizedPath, reason: decision.reason });
        if (approval) return approval;
        continue;
      }
      return block(`${event.toolName} blocked for ${target}: ${decision.reason}`);
    }
  }

  if (config.filesystem.enabled && event.toolName === "read" && allowedReadPath && isPiPackageDocsOrExamplePath(allowedReadPath)) return;

  if (!classifierEnabled(config, state.classifier)) return;

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
      usage: result.tokenUsage ? { input: result.tokenUsage.input, output: result.tokenUsage.output } : undefined,
      projection: projectToolCall(event.toolName, event.input, ctx.cwd, config),
    };
    if (result.decision === "allow") {
      appendGuardTelemetry(state, telemetry);
      return;
    }
    if (result.decision === "ask" && ctx.hasUI) {
      const ok = await ctx.ui.confirm("Guard reviewer asks for approval", `${result.reason}\n\nAllow ${event.toolName}?`);
      appendGuardTelemetry(state, { ...telemetry, userApproved: ok });
      if (ok) {
        return;
      }
      return { block: true, reason: `Guard reviewer ${result.decision}: ${result.reason}. Do not work around this denial; choose a safer path or ask the user.` };
    }
    appendGuardTelemetry(state, telemetry);
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
