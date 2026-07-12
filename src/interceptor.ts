import path from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, isClassifierModelUnavailable, reviewToolCall } from "./classifier.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { GUARDED_TOOLS } from "./guarded-tools.ts";
import { decidePathAccess, type AccessKind } from "./policy.ts";
import {
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordClassifierError,
  recordClassifierResult,
  recordPolicyBlock,
  type RuntimeState,
} from "./state.ts";
import { updateGuardStatus } from "./status.ts";
import { formatError } from "./util.ts";

export interface ToolCallBlock {
  block: true;
  reason: string;
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
    updateGuardStatus(params.ctx, params.state);
    return { block: true, reason: `${params.kind} requires approval for ${params.path}: ${params.reason}` };
  }
  const ok = await params.ctx.ui.confirm(
    "Guard path approval",
    `${params.toolName} wants ${params.kind} access outside the configured roots:\n\n${params.path}\n\nReason: ${params.reason}\n\nApprove this path for this session?`,
  );
  if (ok) {
    params.state.approvals[params.kind].push(params.path);
    recordApprovalGranted(params.state, params.toolName, params.kind, params.path);
    updateGuardStatus(params.ctx, params.state);
    return;
  }
  recordApprovalDenied(params.state);
  updateGuardStatus(params.ctx, params.state);
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
    updateGuardStatus(ctx, state);
    return { block: true, reason: `${reason}. Do not work around the guard; choose an allowed path or ask the user.` };
  };

  let allowedReadPath: string | undefined;

  if (spec.access.length > 0) {
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

  if (event.toolName === "read" && allowedReadPath && isPiPackageDocsOrExamplePath(allowedReadPath)) return;

  if (!classifierEnabled(config, state.classifier)) return;

  try {
    const result = await reviewToolCall({ ctx, config, state: state.classifier, toolName: event.toolName, input: event.input });
    state.classifier.lastDecision = { ...result, toolName: event.toolName, at: Date.now() };
    state.classifier.lastError = undefined;
    recordClassifierResult(state, event.toolName, result);
    updateGuardStatus(ctx, state);
    if (result.decision === "allow") return;
    if (result.decision === "ask" && ctx.hasUI) {
      const ok = await ctx.ui.confirm("Guard reviewer asks for approval", `${result.reason}\n\nAllow ${event.toolName}?`);
      if (ok) {
        updateGuardStatus(ctx, state);
        return;
      }
    }
    updateGuardStatus(ctx, state);
    return { block: true, reason: `Guard reviewer ${result.decision}: ${result.reason}. Do not work around this denial; choose a safer path or ask the user.` };
  } catch (error) {
    const reason = formatError(error);
    state.classifier.lastError = reason;
    recordClassifierError(state, event.toolName, reason);
    updateGuardStatus(ctx, state);
    if (isClassifierModelUnavailable(error)) {
      ctx.ui.notify(`Guard classifier unavailable: ${reason}. Stopping this turn for user intervention.`, "error");
      ctx.abort();
      return { block: true, reason: `Guard classifier unavailable: ${reason}. This turn was stopped for user intervention.` };
    }
    if (!config.classifier.failClosed) {
      ctx.ui.notify(`Guard classifier failed open: ${reason}`, "warning");
      return;
    }
    updateGuardStatus(ctx, state);
    ctx.ui.notify(`Guard classifier failed closed: ${reason}. Stopping the session for user intervention.`, "error");
    ctx.abort();
    ctx.shutdown();
    return { block: true, reason: `Guard classifier failed closed: ${reason}. Pi Guard is stopping the session for user intervention.` };
  }
}
