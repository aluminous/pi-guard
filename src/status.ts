import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { classifierEnabled, resolveClassifierModel } from "./classifier.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { getPersistentConfigPath } from "./persistent-settings.ts";
import type { GuardEvent, RuntimeState } from "./state.ts";

function decisionLabel(decision: GuardEvent["decision"]): string {
  if (decision === "allow") return "ALLOW";
  if (decision === "deny") return "DENY";
  if (decision === "block") return "BLOCK";
  if (decision === "ask") return "ASK";
  return "ERROR";
}

function formatAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatCompactCount(label: string, total: number, turn: number): string {
  return turn > 0 ? `${label}${total}(+${turn})` : `${label}${total}`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

function bulletList(items: string[], max = 3): string[] {
  if (items.length === 0) return ["  (none)"];
  const shown = items.slice(0, max).map((item) => `  • ${item}`);
  if (items.length > max) shown.push(`  • … ${items.length - max} more`);
  return shown;
}

function formatArray(value: string[]): string {
  return value.length > 0 ? value.join(", ") : "(none)";
}

function networkPolicyLabel(config: ResolvedGuardConfig): string {
  if (!config.network.enabled) return "network unrestricted";
  return config.network.allowedDomains.length > 0 ? `${config.network.allowedDomains.length} domains` : "network blocked";
}

function classifierModelLabel(ctx: ExtensionContext, config: ResolvedGuardConfig | undefined, state: RuntimeState): string {
  if (!config || !classifierEnabled(config, state.classifier)) return "classifier off";
  const spec = state.classifier.modelOverride ?? config.classifier.model;
  const model = resolveClassifierModel(ctx, config, state.classifier);
  if (!model) return `model unavailable (${spec})`;
  return spec === "auto" ? `auto (${model.provider}/${model.id})` : `${model.provider}/${model.id}`;
}

export function updateGuardStatus(ctx: ExtensionContext, state: RuntimeState): void {
  const theme = ctx.ui.theme;
  const muted = (text: string) => theme.fg("muted", text);
  const warning = (text: string) => theme.fg("warning", text);
  const error = (text: string) => theme.fg("error", text);
  const config = state.config;
  const stats = state.stats;
  const compact = [
    formatCompactCount("R", stats.ruleHits, stats.turnRuleHits),
    formatCompactCount("C", stats.classifierHits, stats.turnClassifierHits),
    formatCompactCount("D", stats.classifierDenials, stats.turnClassifierDenials),
    `↑${formatCompactTokens(stats.classifierInputTokens)}`,
    `↓${formatCompactTokens(stats.classifierOutputTokens)}`,
  ].join(" ");
  if (state.lastError) {
    ctx.ui.setStatus("guard", error(`Guard: error ${compact}`));
    return;
  }
  if (!state.enabled) {
    const label = state.disabledForNextAgent && !ctx.isIdle() ? "off this turn" : state.disabledForNextAgent ? "off next turn" : "disabled";
    ctx.ui.setStatus("guard", warning(`Guard: ${label} ${compact}`));
    return;
  }
  const backend = state.backend?.name ?? config?.backend ?? "unknown";
  const network = config ? networkPolicyLabel(config) : "network unknown";
  const hasImportantStats = stats.classifierDenials > 0 || stats.blocked > 0 || stats.errors > 0;
  ctx.ui.setStatus("guard", `${muted(`Guard: ${backend}, ${network}, ${classifierModelLabel(ctx, config, state)} `)}${hasImportantStats ? warning(compact) : muted(compact)}`);
}

export function formatGuardStatus(state: RuntimeState, config: ResolvedGuardConfig): string {
  const classifierOn = classifierEnabled(config, state.classifier);
  const health = state.enabled && state.initialized ? "enforcing" : state.enabled ? "enabled but not initialized" : state.disabledForNextAgent ? "disabled for next agent turn" : "disabled";
  const effective = state.backend?.describeEffectivePolicy(config);
  const allowedDomains = config.network.enabled ? (effective?.network.allowedDomains ?? config.network.allowedDomains) : [];
  const network = !config.network.enabled
    ? "Network: restrictions disabled (unrestricted)"
    : allowedDomains.length > 0
      ? `Network: ${allowedDomains.length} allowed domain(s)`
      : "Network: blocked (deny all)";
  const filesystemPolicy = config.filesystem.enabled
    ? [
        "  Filesystem restrictions: enabled",
        `  Read mode: ${config.filesystem.allowRead.length === 0 ? "blacklist (all paths except denyRead)" : "whitelist"}`,
        `  Read roots: ${config.filesystem.allowRead.length === 0 ? "(all)" : formatArray(effective?.filesystem.allowRead ?? config.filesystem.allowRead)}`,
        `  Write roots: ${formatArray(effective?.filesystem.allowWrite ?? config.filesystem.allowWrite)}`,
        "  Deny read:",
        ...bulletList(effective?.filesystem.denyRead ?? config.filesystem.denyRead),
        "  Deny write:",
        ...bulletList(effective?.filesystem.denyWrite ?? config.filesystem.denyWrite),
      ]
    : ["  Filesystem restrictions: disabled (unrestricted)"];
  const lines = [
    "# Pi Guard",
    "",
    "## Status",
    `  ${health}`,
    `  Backend: ${state.backend?.name ?? config.backend}`,
    `  ${network}`,
    state.lastError ? `  Last error: ${state.lastError}` : undefined,
    "",
    "## Classifier",
    `  ${classifierOn ? "enabled" : "disabled"}`,
    `  Model: ${state.classifier.modelOverride ?? config.classifier.model}`,
    `  Fail closed: ${config.classifier.failClosed ? "yes" : "no"}`,
    state.classifier.lastError ? `  Last error: ${state.classifier.lastError}` : undefined,
    "",
    "## Decisions this session",
    `  Reviewed: ${state.stats.reviewed}  Allowed: ${state.stats.allowed}  Denied: ${state.stats.denied}  Asked: ${state.stats.asked}`,
    `  Policy blocks: ${state.stats.blocked}  Errors: ${state.stats.errors}`,
    "",
    "## Session approvals",
    `  Read paths: ${state.approvals.read.length > 0 ? state.approvals.read.join(", ") : "(none)"}`,
    `  Write paths: ${state.approvals.write.length > 0 ? state.approvals.write.join(", ") : "(none)"}`,
    "",
    "## Recent decisions",
    ...(state.recent.length > 0
      ? state.recent.map((event) => `  [${decisionLabel(event.decision)}] ${event.toolName}${event.risk ? `/${event.risk}` : ""} - ${event.reason} (${formatAge(event.at)})`)
      : ["  (none yet)"]),
    "",
    "## Policy summary",
    `  ${network}`,
    ...filesystemPolicy,
    "",
    "## Config",
    `  Persistent config: ${getPersistentConfigPath()}`,
    `  Sources: ${config.sources.join(" → ")}`,
  ].filter((line): line is string => typeof line === "string");

  if (state.warnings.length > 0) lines.push("", "## Warnings", ...state.warnings.map((warning) => `  ! ${warning}`));
  return lines.join("\n");
}

export function registerGuardMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("pi-guard", (message, _options, theme) => {
    const raw = String(message.content ?? "");
    const rendered = raw
      .split("\n")
      .map((line) => {
        if (line.startsWith("# ")) return theme.fg("accent", theme.bold(line.slice(2)));
        if (line.startsWith("## ")) return theme.fg("toolTitle", theme.bold(`─ ${line.slice(3)} `));
        if (line.includes("[ALLOW]")) return theme.fg("success", line);
        if (line.includes("[DENY]") || line.includes("[BLOCK]")) return theme.fg("error", line);
        if (line.includes("[ASK]") || line.includes("[ERROR]") || line.trimStart().startsWith("! ")) return theme.fg("warning", line);
        if (/^[-\w ]+  [-\w ]+  [-\w ]+/.test(line) || /^-+  -+/.test(line)) return theme.fg("muted", line);
        if (line.trimStart().startsWith("•") || line.trimStart().startsWith("…")) return theme.fg("dim", line);
        return line;
      })
      .join("\n");
    return new Text(theme.fg("accent", theme.bold("[guard]")) + "\n" + rendered, 0, 0);
  });
}
