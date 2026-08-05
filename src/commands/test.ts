// /guard test: dry-runs a shell command or file read/write through the guard
// stack — readonly gate, path policy, allowlist, and a REAL classifier review
// when enabled — without executing anything and without touching stats,
// telemetry, recent decisions, traces, or lastDecision. Reuses the same stage
// functions the interceptor consults, so verdicts cannot drift.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, resolveClassifierModel, reviewToolCall, type CompleteFn } from "../classifier.ts";
import { READONLY_CLASSIFIER_RULES } from "../classifier-rules.ts";
import { explainCommandAllowlist } from "../command-allowlist.ts";
import { loadConfig, type ResolvedGuardConfig } from "../config.ts";
import { GUARDED_TOOLS } from "../guarded-tools.ts";
import { exemptReadCallReason } from "../interceptor.ts";
import { showGuardView } from "../live-view.ts";
import { decidePathAccess, type AccessKind } from "../policy.ts";
import type { RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

export interface GuardTestDeps {
  state: RuntimeState;
  /** Test seam for the classifier review (production uses the default model-call function). */
  completeFn?: CompleteFn;
}

type TestSubject =
  | { kind: "command"; command: string }
  | { kind: "read" | "write"; path: string };

function parseSubject(args: string): TestSubject | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const fileOp = trimmed.match(/^(read|write)\s+(.+)$/);
  if (fileOp) return { kind: fileOp[1] as "read" | "write", path: fileOp[2]!.trim() };
  return { kind: "command", command: trimmed };
}

function isSessionApproved(state: RuntimeState, kind: AccessKind, target: string): boolean {
  return state.approvals[kind].some((root) => target === root || target.startsWith(`${root}/`));
}

interface ClassifierPlan {
  /** undefined = review would actually run; otherwise the line explaining why not. */
  skip?: string;
  toolName: string;
  input: unknown;
}

export function createGuardTest(deps: GuardTestDeps) {
  const { state } = deps;

  async function classifierLines(ctx: ExtensionContext, config: ResolvedGuardConfig, plan: ClassifierPlan): Promise<string[]> {
    if (!classifierEnabled(config, state.classifier)) return ["  classifier: disabled — would not review"];
    if (plan.skip) return [`  classifier: ${plan.skip}`];
    const model = resolveClassifierModel(ctx, config, state.classifier);
    const modelLabel = model ? `${model.provider}/${model.id}` : `unavailable (${state.classifier.modelOverride ?? config.classifier.model})`;
    ctx.ui.notify(`Guard test: running a real classifier review (${modelLabel})...`, "info");
    try {
      const result = await reviewToolCall({
        ctx,
        config,
        state: state.classifier,
        toolName: plan.toolName,
        input: plan.input,
        rulesOverride: state.readOnly ? READONLY_CLASSIFIER_RULES : undefined,
        completeFn: deps.completeFn,
      });
      const usage = result.tokenUsage;
      const cost = usage ? `${usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)} in / ${usage.output} out tokens` : "token usage not reported";
      return [
        `  classifier: would ${result.decision} · risk ${result.risk} · authorization ${result.authorization}${result.fastPath ? " · fast path" : ""}`,
        `  reason: ${result.reason}`,
        `  real review by ${modelLabel} · ${cost}${state.readOnly ? " · read-only ruleset" : ""}`,
      ];
    } catch (error) {
      return [
        `  classifier: review failed — ${formatError(error)}`,
        `  a real call would ${config.classifier.failClosed ? "stop the turn (fail closed)" : "fail open and proceed"}`,
      ];
    }
  }

  async function testFileOp(ctx: ExtensionContext, config: ResolvedGuardConfig, kind: "read" | "write", target: string): Promise<string[]> {
    const lines: string[] = [];
    let verdict = "would allow";
    let blocked = false;

    if (state.readOnly && kind === "write") {
      lines.push("## Read-only gate", "  [BLOCK] on — write/edit are blocked deterministically", "");
      verdict = "would block (read-only mode)";
      blocked = true;
    } else if (state.readOnly) {
      lines.push("## Read-only gate", "  [ALLOW] on — reads are unaffected", "");
    }

    lines.push("## Path policy");
    if (!config.filesystem.enabled) {
      lines.push("  filesystem restrictions disabled — no path verdict");
    } else {
      const decision = decidePathAccess(config, ctx.cwd, target, kind);
      if (decision.allowed) {
        lines.push(`  [ALLOW] ${kind} ${decision.matchedRoot !== undefined ? `allowed by root '${decision.matchedRoot}'` : "allowed: no deny pattern matches (blacklist mode)"}`);
      } else if (decision.code === "outside-roots") {
        if (isSessionApproved(state, kind, decision.normalizedPath)) {
          lines.push(`  [ALLOW] ${decision.reason} — but already approved this session`);
        } else {
          lines.push(`  [ASK] ${decision.reason} → would ask for session approval`);
          if (!blocked) verdict = "would ask for path approval";
        }
      } else {
        lines.push(`  [BLOCK] ${decision.reason}`);
        if (!blocked) verdict = "would block (path policy)";
        blocked = true;
      }
    }
    lines.push("");

    const plan: ClassifierPlan = { toolName: kind, input: { path: target } };
    if (blocked) {
      plan.skip = "not reached — the call is blocked deterministically";
    } else if (kind === "read") {
      const exemption = exemptReadCallReason(GUARDED_TOOLS.read!, { path: target }, ctx.cwd, config, undefined);
      lines.push("## Read exemption", exemption ? `  [ALLOW] exempt: ${exemption} — review skipped` : "  not exempt — classifier review required", "");
      if (exemption) plan.skip = `skipped — deterministically exempt (${exemption})`;
    }
    lines.push("## Classifier", ...(await classifierLines(ctx, config, plan)));
    if (kind === "write" && !plan.skip && classifierEnabled(config, state.classifier)) {
      lines.push("  note: content not simulated — a real write call also reviews the content");
    }
    return [verdictLine(verdict, lines), ...lines];
  }

  async function testCommand(ctx: ExtensionContext, config: ResolvedGuardConfig, command: string): Promise<string[]> {
    const lines: string[] = [];
    const explanation = explainCommandAllowlist(command, config.commands.allow);
    const enforcing = config.filesystem.enabled && state.initialized && state.backend?.name === "seatbelt";
    const exempt = explanation.allowlisted && enforcing;
    const classifierOn = classifierEnabled(config, state.classifier);
    let verdict = "would allow";

    if (state.readOnly) {
      lines.push("## Read-only gate");
      if (classifierOn) lines.push("  [ALLOW] on — bash is reviewed under the read-only ruleset");
      else if (exempt) lines.push("  [ALLOW] on — deterministically allowlisted commands stay allowed");
      else {
        lines.push("  [BLOCK] on — classifier is off, so commands cannot be reviewed for writes");
        verdict = "would block (read-only mode)";
      }
      lines.push("");
    }

    lines.push("## Command allowlist");
    if (explanation.allowlisted) {
      lines.push(...explanation.segments.map((segment) => `  [ALLOW] \`${segment.command}\` → rule \`${segment.rule}\``));
      lines.push(
        enforcing
          ? "  allowlisted — exempt from classifier review while the Seatbelt sandbox enforces"
          : "  allowlisted, but the sandbox is not enforcing (Seatbelt required) — review still applies",
      );
    } else {
      lines.push(`  not allowlisted: ${explanation.reason}`);
      for (const segment of explanation.segments ?? []) {
        lines.push(segment.rule !== undefined ? `  [ALLOW] \`${segment.command}\` → rule \`${segment.rule}\`` : `  [BLOCK] \`${segment.command}\`: ${segment.refusal}`);
      }
    }
    lines.push("");

    const plan: ClassifierPlan = { toolName: "bash", input: { command } };
    if (verdict.startsWith("would block")) plan.skip = "not reached — the call is blocked deterministically";
    else if (exempt) {
      plan.skip = "skipped — deterministically exempt (allowlisted while the sandbox enforces)";
      verdict = "would allow (allowlist exempt)";
    }
    lines.push("## Classifier", ...(await classifierLines(ctx, config, plan)));
    return [verdictLine(verdict, lines), ...lines];
  }

  function verdictLine(current: string, lines: string[]): string {
    // The classifier lines are appended last; lift a real review's decision into the verdict.
    const reviewed = lines.find((line) => line.includes("classifier: would "));
    if (reviewed && current === "would allow") {
      const decision = reviewed.match(/classifier: would (\w+)/)?.[1];
      if (decision === "deny") return "  verdict: would deny (classifier)";
      if (decision === "ask") return "  verdict: would ask the user (classifier)";
    }
    if (lines.some((line) => line.includes("classifier: review failed")) && current === "would allow") {
      return "  verdict: review failed — see classifier section";
    }
    return `  verdict: ${current}`;
  }

  return async function runGuardTest(args: string, ctx: ExtensionContext): Promise<void> {
    const subject = parseSubject(args);
    if (!subject) {
      const message = "Usage: /guard test <shell command> | test read <path> | test write <path>";
      if (!ctx.hasUI) console.log(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    const config = state.config ?? loadConfig(ctx);
    const subjectLabel = subject.kind === "command" ? `bash: ${subject.command}` : `${subject.kind}: ${subject.path}`;
    const body =
      subject.kind === "command"
        ? await testCommand(ctx, config, subject.command)
        : await testFileOp(ctx, config, subject.kind, subject.path);
    const report = ["# Guard Test (dry run — nothing executed)", "", `  ${subjectLabel}`, ...body.slice(0, 1), "", ...body.slice(1)];
    showGuardView(ctx, state, "report", () => report);
  };
}
