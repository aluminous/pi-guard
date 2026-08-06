import path from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askRailApproval } from "./approvals.ts";
import {
  capabilityName,
  capabilityRegistry,
  recordCapabilityHits,
  recordCapabilityOutcome,
  recordScreenVerdict,
  resolveCapabilities,
  type CapabilityClass,
  type CapabilityId,
  type CapabilityOutcome,
  type CapabilityResolution,
} from "./capabilities.ts";
import { classifierFailureContext, classifyClassifierFailure, describeClassifierFailure } from "./classifier-protocol.ts";
import {
  addSessionGuidance,
  classifierEnabled,
  isClassifierModelUnavailable,
  judgeToolCall,
  nameToolCall,
  projectToolCall,
  resolveClassifierModel,
  resolveJudgeModel,
  type CompleteFn,
  type RailDecision,
  type JudgeResult,
  type NamerResult,
} from "./classifier.ts";
import { allowlistCapabilities, explainCommandAllowlist } from "./command-allowlist.ts";
import { configSourceLabel, type ResolvedRailConfig } from "./config.ts";
import { screenToolCall, type ContentScreenVerdict } from "./content-screen.ts";
import { addTraceStage, type DecisionTrace } from "./decision-trace.ts";
import { describeAction, INTERCEPTED_TOOLS, type InterceptedToolSpec } from "./intercepted-tools.ts";
import { classifierExemptReadReason, decidePathAccess, denyReadMatch, normalizeUserPath, type AccessKind } from "./policy.ts";
import { appendRailTelemetry, type RailJudgeTelemetry } from "./telemetry.ts";
import {
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordCapabilityDecision,
  recordClassifierError,
  recordClassifierSkip,
  recordDecisionTrace,
  recordPolicyBlock,
  syncCapabilityPreset,
  type RuntimeState,
} from "./state.ts";
import { textPrefix } from "./util.ts";

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
  ctx.ui.notify(`Rail classifier failed closed: ${reason}. Stopping this turn for user intervention.`, "error");
  ctx.abort();
  return { block: true, reason: `Rail classifier failed closed: ${reason}. This turn was stopped for user intervention.` };
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
    appendRailTelemetry(params.state, { kind: "approval", tool: params.toolName, access: params.kind, path: params.path, approved: false, reason: params.reason });
    return {
      block: true,
      reason: `${params.kind} requires approval for ${params.path}: ${params.reason}. This is a headless session with no user to ask; rerun interactively or pre-approve the path in rail config.`,
    };
  }
  const answer = await askRailApproval(
    params.ctx,
    params.state,
    "Rail path approval",
    `${params.toolName} wants ${params.kind} access outside the configured roots:\n\n${params.path}\n\nReason: ${params.reason}\n\nApprove this path for this session?`,
  );
  if (answer.comment) {
    addSessionGuidance(params.state.classifier, answer.approved ? "allowed" : "denied", params.toolName, `${params.kind} ${params.path}`, answer.comment);
  }
  addTraceStage(params.trace, "ask", answer.approved ? "approved" : "denied", `user ${answer.approved ? "approved" : "denied"} ${params.kind} ${params.path}${answer.comment ? " with a comment" : ""}`);
  appendRailTelemetry(params.state, {
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
  return { block: true, reason: `${params.kind} approval denied for ${params.path}.${commentSuffix} Do not work around the rail; ask the user.` };
}

/** An out-of-roots write: the label goes to the table, and an `ask` reuses the path dialog and its session memory. */
interface PathApprovalContext {
  kind: AccessKind;
  path: string;
  reason: string;
}

type PathStageResult =
  | { outcome: "continue"; allowedReadPath?: string; labels: CapabilityId[]; pathApproval?: PathApprovalContext }
  | { outcome: "done" }
  | { outcome: "block"; block: ToolCallBlock };

/**
 * Stage 1: deterministic path policy. Two asymmetries are deliberate.
 *
 * denyWrite stays a hard block: it is the containment mirror of the sandbox,
 * and loosening writes to secret or config paths would make the deny list
 * mean something different for file tools than it does for bash.
 *
 * denyRead no longer blocks — reading a possible secret is a judgment call
 * (a test-fixture key is fine, an exfil-adjacent read is not), so the match
 * becomes a deterministic `credentials` label and the table decides. That
 * label is attached in classifyRead, which runs whether or not enforcement is
 * on, so the calibration does not change with filesystem.enabled.
 *
 * Out-of-roots writes become a `modify-system` label plus the path-approval
 * context; at the default `ask` this is exactly today's approval UX.
 */
async function enforcePathPolicy(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedRailConfig,
  spec: InterceptedToolSpec,
  input: Record<string, unknown>,
  trace: DecisionTrace,
): Promise<PathStageResult> {
  if (!config.filesystem.enabled || spec.access.length === 0) return { outcome: "continue", labels: [] };
  const target = spec.path?.(input);
  if (typeof target !== "string") return { outcome: "done" };

  const block = (reason: string): ToolCallBlock => {
    recordPolicyBlock(state, event.toolName, reason);
    appendRailTelemetry(state, { kind: "block", tool: event.toolName, reason });
    return { block: true, reason: `${reason}. Do not work around the rail; choose an allowed path or ask the user.` };
  };

  let allowedReadPath: string | undefined;
  const labels: CapabilityId[] = [];
  let pathApproval: PathApprovalContext | undefined;
  for (const kind of spec.access) {
    const decision = decidePathAccess(config, ctx.cwd, target, kind);
    if (decision.allowed) {
      addTraceStage(trace, "path-policy", "pass", decision.matchedRoot !== undefined ? `${kind} allowed by root '${decision.matchedRoot}'` : `${kind} allowed: no deny pattern matches (blacklist mode)`);
      if (kind === "read") allowedReadPath = decision.normalizedPath;
      continue;
    }
    if (decision.code === "denied-by-pattern" && kind === "read") {
      // Handled as a credentials label in classifyRead; do not block here.
      addTraceStage(trace, "path-policy", "label", `${decision.reason} → credentials label instead of a block`);
      continue;
    }
    if (decision.code === "outside-roots") {
      if (kind === "write") {
        addTraceStage(trace, "path-policy", "label", `${decision.reason} → modify-system`);
        labels.push("modify-system");
        pathApproval = { kind, path: decision.normalizedPath, reason: decision.reason };
        continue;
      }
      // Whitelist read mode is an explicit narrowing by the user; keep the
      // existing per-path approval rather than routing it through read-system.
      addTraceStage(trace, "path-policy", "ask", `${decision.reason} → approval`);
      const approval = await askPathApproval({ ctx, state, kind, toolName: event.toolName, path: decision.normalizedPath, reason: decision.reason, trace });
      if (approval) return { outcome: "block", block: approval };
      continue;
    }
    addTraceStage(trace, "path-policy", "block", decision.reason);
    return { outcome: "block", block: block(`${event.toolName} blocked for ${target}: ${decision.reason}`) };
  }
  return { outcome: "continue", allowedReadPath, labels, pathApproval };
}

/**
 * Stage 2: deterministic classifier exemption for reads. A trusted path is
 * the whole action for a read (its projection carries no content), so in-cwd
 * and allowlisted reads skip review entirely — whether or not filesystem
 * enforcement is on; enabled:false only disables blocking, not trust.
 */
export function exemptReadCallReason(spec: InterceptedToolSpec, input: Record<string, unknown>, cwd: string, config: ResolvedRailConfig, allowedReadPath: string | undefined): string | undefined {
  if (!spec.access.includes("read") || spec.access.includes("write")) return undefined;
  const target = spec.path?.(input);
  if (typeof target !== "string") return undefined;
  const canonicalTarget = allowedReadPath ?? normalizeUserPath(cwd, target);
  if (isPiPackageDocsOrExamplePath(canonicalTarget)) return "pi package docs/examples";
  return classifierExemptReadReason(config, cwd, target);
}

interface LabelStage {
  labels: CapabilityId[];
  /** True when the deterministic mappers could not label the action and the namer must. */
  needsNaming: boolean;
}

/** Reads map deterministically: denyRead → credentials, exempt → read-project/read-system, otherwise the namer. */
function classifyRead(
  spec: InterceptedToolSpec,
  input: Record<string, unknown>,
  cwd: string,
  config: ResolvedRailConfig,
  allowedReadPath: string | undefined,
  trace: DecisionTrace,
): LabelStage {
  const target = spec.path?.(input);
  if (typeof target === "string") {
    const denied = denyReadMatch(config, cwd, target);
    if (denied) {
      addTraceStage(trace, "read-exemption", "label", `matches denyRead '${denied}' → credentials`);
      return { labels: ["credentials"], needsNaming: false };
    }
  }
  const reason = exemptReadCallReason(spec, input, cwd, config, allowedReadPath);
  if (reason === undefined) {
    addTraceStage(trace, "read-exemption", "not exempt", "not in cwd, allowRead, or pi docs — naming required");
    return { labels: [], needsNaming: true };
  }
  const label: CapabilityId = reason.startsWith("matches allowRead") ? "read-system" : "read-project";
  addTraceStage(trace, "read-exemption", "exempt", `${reason} → ${label}`);
  return { labels: [label], needsNaming: false };
}

/**
 * Allowlisted commands carry their templates' capability tags. As before this
 * only applies while the sandbox is actually enforcing: "grep *" is safe
 * because Seatbelt bounds what grep can read and write, and without that an
 * allowlisted head could still reach credentials.
 */
function classifyCommand(input: Record<string, unknown>, state: RuntimeState, config: ResolvedRailConfig, trace: DecisionTrace): LabelStage {
  if (typeof input.command !== "string") return { labels: [], needsNaming: true };
  if (!config.filesystem.enabled || !state.initialized || state.backend?.name !== "seatbelt") {
    addTraceStage(trace, "command-allowlist", "skipped", "allowlist labels need an enforcing Seatbelt sandbox — naming required");
    return { labels: [], needsNaming: true };
  }
  const explanation = explainCommandAllowlist(input.command, config.commands.allow);
  if (!explanation.allowlisted) {
    addTraceStage(trace, "command-allowlist", "not exempt", explanation.reason);
    return { labels: [], needsNaming: true };
  }
  const labels = allowlistCapabilities(explanation);
  addTraceStage(
    trace,
    "command-allowlist",
    "exempt",
    `${explanation.segments.map((segment) => `\`${segment.command}\` → rule \`${segment.rule}\` (${segment.capability})`).join("; ")}`,
  );
  return { labels, needsNaming: false };
}

/**
 * Session read-only mode (/rail readonly): write and edit are blocked
 * deterministically; bash must be reviewed and is blocked outright when the
 * classifier is disabled — the sandbox still permits writes inside the
 * configured roots, so letting bash run unreviewed would silently break the
 * read-only promise. Exception: deterministically allowlisted commands
 * (grep/ls/git status …) need no review — they are read-only by construction
 * and sandbox-bounded — so read-only mode stays usable without a classifier.
 * On top of that the read-only disposition preset denies the writing classes,
 * which is what constrains a named bash command.
 */
function enforceReadOnlyMode(toolName: string, input: Record<string, unknown>, state: RuntimeState, config: ResolvedRailConfig, spec: InterceptedToolSpec, trace: DecisionTrace): ToolCallBlock | undefined {
  const block = (reason: string): ToolCallBlock => {
    recordPolicyBlock(state, toolName, reason);
    addTraceStage(trace, "readonly", "block", reason);
    appendRailTelemetry(state, { kind: "block", tool: toolName, reason });
    return { block: true, reason: `${reason}. Do not work around the rail; ask the user to toggle read-only mode off (/rail readonly) if changes are wanted.` };
  };
  if (spec.access.includes("write")) return block(`${toolName} blocked: rail is in read-only mode`);
  // Scratch trace: the real allowlist stage is recorded once, in the main flow.
  const scratch: DecisionTrace = { at: 0, toolName, action: "", final: "allowed", stages: [] };
  if (toolName === "bash" && !classifierEnabled(config, state.classifier) && classifyCommand(input, state, config, scratch).needsNaming) {
    return block("bash blocked: rail is in read-only mode and the classifier is off, so commands cannot be reviewed for writes");
  }
  addTraceStage(trace, "readonly", "pass", toolName === "bash" ? "bash permitted pending capability review" : `${toolName} permitted in read-only mode`);
  return undefined;
}

export async function interceptToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: RuntimeState,
  /** Test seam: replaces the model-call function used by the namer and judge (production always uses the default). */
  completeFn?: CompleteFn,
): Promise<ToolCallBlock | undefined> {
  const config = state.config;
  if (!config || !config.enabled || !state.enabled) return;
  if (!event.input || typeof event.input !== "object") return;
  const input = event.input as Record<string, unknown>;

  const spec = INTERCEPTED_TOOLS[event.toolName];
  if (!spec) return;
  syncCapabilityPreset(state);

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
  config: ResolvedRailConfig,
  spec: InterceptedToolSpec,
  input: Record<string, unknown>,
  trace: DecisionTrace,
  completeFn: CompleteFn | undefined,
): Promise<ToolCallBlock | undefined> {
  if (state.readOnly) {
    const denied = enforceReadOnlyMode(event.toolName, input, state, config, spec, trace);
    if (denied) return denied;
  }

  const pathStage = await enforcePathPolicy(event, ctx, state, config, spec, input, trace);
  if (pathStage.outcome === "done") return;
  if (pathStage.outcome === "block") return pathStage.block;

  const deterministic: CapabilityId[] = [...pathStage.labels];
  let needsNaming = false;
  let screen: ContentScreenVerdict | undefined;

  if (spec.access.includes("read") && !spec.access.includes("write")) {
    const read = classifyRead(spec, input, ctx.cwd, config, pathStage.allowedReadPath, trace);
    deterministic.push(...read.labels);
    needsNaming = read.needsNaming;
  } else if (event.toolName === "bash") {
    const command = classifyCommand(input, state, config, trace);
    deterministic.push(...command.labels);
    needsNaming = command.needsNaming;
  } else if (spec.access.includes("write")) {
    screen = screenToolCall(event.toolName, input, ctx.cwd);
    addTraceStage(trace, "screen", screen.tripped ? "tripped" : "clean", screen.summary);
    if (screen.tripped) needsNaming = true;
    else if (screen.label) deterministic.push(screen.label);
  }

  const classifierOn = classifierEnabled(config, state.classifier);
  if (needsNaming && !classifierOn && deterministic.length === 0) {
    // Classifier off: capability mode reduces to the deterministic mappers and
    // screens, exactly like today's classifier-off behavior.
    addTraceStage(trace, "namer", "skipped", "classifier disabled and no deterministic label — call passes through");
    return;
  }

  let named: NamerResult | undefined;
  let namerLatencyMs: number | undefined;
  let namerModel: string | undefined;
  if (needsNaming && classifierOn) {
    const startedAt = performance.now();
    namerModel = describeModel(() => resolveClassifierModel(ctx, config, state.classifier));
    try {
      named = await nameToolCall({ ctx, config, state: state.classifier, toolName: event.toolName, input: event.input, completeFn, capabilities: state.capabilities });
      namerLatencyMs = Math.round(performance.now() - startedAt);
      state.classifier.lastError = undefined;
      addTraceStage(
        trace,
        "namer",
        named.labels.join(", "),
        `named ${named.labels.join(", ")}${named.authorizationEvidence ? ` · evidence "${textPrefix(named.authorizationEvidence, 80)}"` : ""} (model ${namerModel ?? "unknown"}, ${namerLatencyMs}ms)`,
      );
    } catch (error) {
      return handleNamerFailure(error, event, ctx, state, config, trace, namerModel, Math.round(performance.now() - startedAt));
    }
  } else if (needsNaming && !classifierOn) {
    addTraceStage(trace, "namer", "skipped", "classifier disabled — deterministic labels only");
  }

  const labels = [...new Set([...deterministic, ...(named?.labels ?? [])])];
  if (labels.length === 0) return;
  if (screen) recordScreenVerdict(state.capabilities, labels, screen.tripped);

  return enforceCapabilities({
    event,
    ctx,
    state,
    config,
    trace,
    completeFn,
    labels,
    named,
    namerLatencyMs,
    namerModel,
    screen,
    pathApproval: pathStage.pathApproval,
    reviewed: named !== undefined,
  });
}

function describeModel(resolve: () => { provider: string; id: string } | undefined): string | undefined {
  try {
    const model = resolve();
    return model ? `${model.provider}/${model.id}` : undefined;
  } catch {
    return undefined;
  }
}

function handleNamerFailure(
  error: unknown,
  event: { toolName: string },
  ctx: ExtensionContext,
  state: RuntimeState,
  config: ResolvedRailConfig,
  trace: DecisionTrace,
  model: string | undefined,
  latencyMs: number,
): ToolCallBlock | undefined {
  // "timeout after 15000ms on openrouter/anthropic/claude-haiku-4.5 after 5
  // attempts: …" — every terminal surface says which failure, how many calls it
  // cost, and which model, because "Rail classifier failed closed: fetch
  // failed" is exactly the report nobody can act on.
  const reason = describeClassifierFailure(error, { model });
  const failure = classifyClassifierFailure(error);
  const attempted = classifierFailureContext(error);
  state.classifier.lastError = reason;
  recordClassifierError(state, event.toolName, reason, failure.category);
  addTraceStage(trace, "namer", "error", `naming failed: ${reason}`);
  appendRailTelemetry(state, {
    kind: "error",
    tool: event.toolName,
    reason,
    failureKind: failure.category,
    attempts: attempted?.attempts,
    latencyMs,
    model: attempted?.model ?? model,
  });
  if (isClassifierModelUnavailable(error)) {
    ctx.ui.notify(`Rail classifier unavailable: ${reason}. Stopping this turn for user intervention.`, "error");
    ctx.abort();
    return { block: true, reason: `Rail classifier unavailable: ${reason}. This turn was stopped for user intervention.` };
  }
  // Read-only mode never fails open for bash: an unreviewed command could
  // still perform sandbox-allowed writes, silently breaking the read-only
  // promise, so a naming failure must block even with failClosed disabled.
  if (!config.classifier.failClosed && !(state.readOnly && event.toolName === "bash")) {
    ctx.ui.notify(`Rail classifier failed open: ${reason}`, "warning");
    return;
  }
  return stopTurnForClassifierFailure(ctx, reason);
}

function describeResolution(resolution: CapabilityResolution): string {
  const rows = resolution.effective.map((entry) => {
    const scope = entry.scope === "config" ? configSourceLabel(entry.source ?? "config") : entry.scope === "preset" ? `${entry.source} preset` : entry.scope;
    return `${entry.id}→${entry.disposition} (${scope})`;
  });
  return `${rows.join(", ")} ⇒ ${resolution.disposition}`;
}

/** "off-machine-effects, which you have set to ask (default)" — the attribution line every block and prompt carries. */
function attribution(resolution: CapabilityResolution, registry: CapabilityClass[]): string {
  const decided = resolution.decidedBy;
  const scope =
    decided.scope === "config" ? configSourceLabel(decided.source ?? "config")
    : decided.scope === "preset" ? `${decided.source} preset`
    : decided.scope === "session" ? "this session"
    : "default";
  return `${decided.id} (${capabilityName(decided.id, registry)}), which is set to ${decided.disposition} (${scope})`;
}

interface EnforceParams {
  event: { toolName: string; input: unknown };
  ctx: ExtensionContext;
  state: RuntimeState;
  config: ResolvedRailConfig;
  trace: DecisionTrace;
  completeFn: CompleteFn | undefined;
  labels: CapabilityId[];
  named: NamerResult | undefined;
  namerLatencyMs: number | undefined;
  namerModel: string | undefined;
  screen: ContentScreenVerdict | undefined;
  pathApproval: PathApprovalContext | undefined;
  reviewed: boolean;
}

/** Stage 3: the disposition table decides, with the judge as the delegated reviewer for `judge` classes. */
async function enforceCapabilities(params: EnforceParams): Promise<ToolCallBlock | undefined> {
  const { ctx, state, config, trace, event } = params;
  const resolution = resolveCapabilities(config, state.capabilities, params.labels);
  addTraceStage(trace, "capabilities", resolution.disposition, describeResolution(resolution));

  const projection = projectToolCall(event.toolName, event.input, ctx.cwd, config);
  const subject = describeAction(event.toolName, projection.inputSummary);
  const registry = capabilityRegistry(config, state.capabilities);
  let disposition = resolution.disposition;
  let judge: JudgeResult | undefined;
  let judgeTelemetry: RailJudgeTelemetry | undefined;
  let reason = `${subject} is ${attribution(resolution, registry)}`;

  if (disposition === "judge") {
    const outcome = await runJudgeStage(params, resolution);
    disposition = outcome.disposition;
    judge = outcome.judge;
    judgeTelemetry = outcome.telemetry;
    if (outcome.judge) reason = outcome.judge.reason;
    else reason = `${outcome.fallbackReason} — asking instead`;
  }

  const finish = (decision: RailDecision, outcome: CapabilityOutcome, block?: ToolCallBlock, userApproved?: boolean, userComment?: string): ToolCallBlock | undefined => {
    // "Exempt" means the action resolved to allow with no model consulted; a
    // deterministic label that escalated or prompted is not an exemption.
    if (!params.reviewed && resolution.disposition === "allow") recordClassifierSkip(state);
    recordCapabilityDecision(state, event.toolName, {
      labels: resolution.labels,
      decision,
      disposition: resolution.disposition,
      reason,
      reviewed: params.reviewed || judge !== undefined,
      tokenUsage: totalUsage(params.named, judge),
    });
    recordCapabilityOutcome(state.capabilities, resolution.labels, outcome);
    state.classifier.lastDecision = { toolName: event.toolName, at: Date.now(), labels: resolution.labels, decision, reason };
    appendRailTelemetry(state, {
      kind: "review",
      tool: event.toolName,
      decision,
      labels: resolution.labels,
      resolvedDisposition: resolution.disposition,
      decidedBy: resolution.decidedBy.id,
      screenTripped: params.screen?.tripped,
      authorizationEvidence: params.named?.authorizationEvidence,
      attempts: params.named?.attempts,
      latencyMs: params.namerLatencyMs ?? 0,
      model: params.namerModel,
      judge: judgeTelemetry,
      reason,
      userApproved,
      userComment,
      usage: totalUsage(params.named, judge),
      projection,
    });
    return block;
  };

  if (disposition === "allow") return finish("allow", judge ? "judge-allow" : "allow");

  if (disposition === "deny") {
    const denyReason = judge ? `Rail judge denied: ${reason}` : `Rail denied: ${subject} is ${attribution(resolution, registry)}`;
    return finish("deny", judge ? "judge-deny" : "deny", {
      block: true,
      reason: `${denyReason}. Do not work around this denial; choose a safer path or ask the user.`,
    });
  }

  // ask — the path-approval dialog when the label came from an out-of-roots
  // write, so the session path memory keeps working; otherwise a capability ask.
  if (params.pathApproval && !judge) {
    const approval = await askPathApproval({
      ctx,
      state,
      kind: params.pathApproval.kind,
      toolName: event.toolName,
      path: params.pathApproval.path,
      reason: params.pathApproval.reason,
      trace,
    });
    // askPathApproval owns the counters, telemetry, and recent event for this
    // dialog; only the per-class stats are still ours to record.
    recordCapabilityHits(state.capabilities, resolution.labels);
    recordCapabilityOutcome(state.capabilities, resolution.labels, approval ? "ask-denied" : "ask-approved");
    return approval;
  }

  if (!ctx.hasUI) {
    addTraceStage(trace, "ask", "unanswerable", "approval needed but the session is headless");
    return finish("deny", "ask-denied", {
      block: true,
      reason: `Rail needs approval, but this headless session has no user to ask: ${reason}. Rerun interactively, or set ${resolution.decidedBy.id} to allow in rail config.`,
    });
  }

  const evidence = params.named?.authorizationEvidence;
  const evidenceLine = evidence ? `\n\nReviewer notes: user said "${textPrefix(evidence, 200)}"` : "";
  const capabilityLine = `Capabilities: ${resolution.labels.join(", ")}`;
  const answer = await askRailApproval(
    ctx,
    state,
    judge ? "Rail judge asks for approval" : "Rail asks for approval",
    `${subject}\n\n${capabilityLine}\n\n${reason}${evidenceLine}\n\nAllow?`,
  );
  if (answer.comment) {
    const guidanceSubject = subject.startsWith(`${event.toolName}: `) ? subject.slice(event.toolName.length + 2) : subject;
    addSessionGuidance(state.classifier, answer.approved ? "allowed" : "denied", event.toolName, guidanceSubject, answer.comment);
  }
  addTraceStage(trace, "ask", answer.approved ? "approved" : "denied", `user ${answer.approved ? "approved" : "denied"}${answer.comment ? " with a comment" : ""}`);
  if (answer.approved) return finish("allow", judge ? "judge-ask" : "ask-approved", undefined, true, answer.comment);
  const commentSuffix = answer.comment ? ` User comment: ${answer.comment}` : "";
  return finish(
    "deny",
    judge ? "judge-ask" : "ask-denied",
    { block: true, reason: `Rail asked and the user denied: ${reason}.${commentSuffix} Do not work around this denial; choose a safer path or ask the user.` },
    false,
    answer.comment,
  );
}

function totalUsage(named: NamerResult | undefined, judge: JudgeResult | undefined) {
  if (!named && !judge) return undefined;
  return {
    input: (named?.tokenUsage?.input ?? 0) + (judge?.tokenUsage?.input ?? 0),
    output: (named?.tokenUsage?.output ?? 0) + (judge?.tokenUsage?.output ?? 0),
    cacheRead: (named?.tokenUsage?.cacheRead ?? 0) + (judge?.tokenUsage?.cacheRead ?? 0),
    cacheWrite: (named?.tokenUsage?.cacheWrite ?? 0) + (judge?.tokenUsage?.cacheWrite ?? 0),
  };
}

/** The last few rail decisions, as the judge sees them: a retry after a denial is signal. */
function recentDecisionsForJudge(state: RuntimeState): string[] {
  return state.recent
    .slice(0, 8)
    .map((event) => `${event.decision} ${event.toolName}${event.capabilities?.length ? ` (${event.capabilities.join(", ")})` : ""}: ${textPrefix(event.reason, 160)}`);
}

/**
 * A judge failure degrades to `ask` rather than to allow or to a stopped turn:
 * the table already established that this class needs a human or a careful
 * reviewer, and the judge's own decision rules resolve ambiguity to ask.
 */
async function runJudgeStage(
  params: EnforceParams,
  resolution: CapabilityResolution,
): Promise<{ disposition: RailDecision; judge?: JudgeResult; telemetry?: RailJudgeTelemetry; fallbackReason: string }> {
  const { ctx, state, config, trace, event } = params;
  if (!classifierEnabled(config, state.classifier)) {
    addTraceStage(trace, "judge", "skipped", "classifier is off, so the judge cannot run");
    return { disposition: "ask", fallbackReason: `${resolution.decidedBy.id} is set to judge but the classifier is off` };
  }
  const model = describeModel(() => resolveJudgeModel(ctx, config, state.classifier));
  const startedAt = performance.now();
  try {
    const judge = await judgeToolCall({
      ctx,
      config,
      state: state.classifier,
      toolName: event.toolName,
      input: event.input,
      labels: resolution.labels,
      authorizationEvidence: params.named?.authorizationEvidence,
      recentGuardDecisions: recentDecisionsForJudge(state),
      completeFn: params.completeFn,
      capabilities: state.capabilities,
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    addTraceStage(trace, "judge", judge.decision, `${judge.decision} · ${judge.reason} (model ${model ?? "unknown"}, ${latencyMs}ms)`);
    return {
      disposition: judge.decision,
      judge,
      telemetry: {
        model,
        verdict: judge.decision,
        latencyMs,
        attempts: judge.attempts,
        usage: judge.tokenUsage ? { input: judge.tokenUsage.input, output: judge.tokenUsage.output, cacheRead: judge.tokenUsage.cacheRead, cacheWrite: judge.tokenUsage.cacheWrite } : undefined,
      },
      fallbackReason: "",
    };
  } catch (error) {
    // Same enrichment and the same by-kind counters as a namer failure: the
    // judge runs on the same completeText machinery, so a provider incident
    // that shows up here is the same incident, and used to be invisible to
    // stats.errors entirely.
    const reason = describeClassifierFailure(error, { model });
    const failure = classifyClassifierFailure(error);
    const attempted = classifierFailureContext(error);
    state.classifier.lastError = reason;
    recordClassifierError(state, event.toolName, `judge: ${reason}`, failure.category);
    addTraceStage(trace, "judge", "error", `judge failed: ${reason} — falling back to ask`);
    appendRailTelemetry(state, {
      kind: "error",
      tool: event.toolName,
      reason: `judge: ${reason}`,
      failureKind: failure.category,
      attempts: attempted?.attempts,
      latencyMs: Math.round(performance.now() - startedAt),
      model: attempted?.model ?? model,
    });
    return { disposition: "ask", fallbackReason: `the escalation reviewer could not run (${reason})` };
  }
}
