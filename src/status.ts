import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { EffectivePolicy } from "./backends/types.ts";
import { classifierEnabled, resolveClassifierModel } from "./classifier.ts";
import type { ResolvedGuardConfig, StatusLineMode } from "./config.ts";
import { getPersistentConfigPath } from "./persistent-settings.ts";
import type { GuardEvent, GuardStats, RuntimeState } from "./state.ts";

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

/**
 * "12.3k in (61% cached) / 800 out" — hit rate over total prompt tokens
 * (input is normalized to exclude cache activity). Providers that never
 * report cache fields normalize to 0, which is indistinguishable from a real
 * 0% hit rate — so a plain zero only reads "0% cached" while the cache is
 * demonstrably warming (writes but no reads yet); with reviews done and no
 * cache activity at all it reads "cache activity not reported", and before
 * any review the parenthetical is omitted.
 */
function formatTokensWithCache(stats: GuardStats): string {
  const totalPrompt = stats.classifierInputTokens + stats.classifierCacheReadTokens + stats.classifierCacheWriteTokens;
  const cachePart =
    stats.classifierCacheReadTokens > 0
      ? ` (${Math.round((stats.classifierCacheReadTokens / totalPrompt) * 100)}% cached)`
      : stats.classifierCacheWriteTokens > 0
        ? " (0% cached, cache warming)"
        : stats.classifierHits > 0
          ? " (cache activity not reported)"
          : "";
  return `${totalPrompt} in${cachePart} / ${stats.classifierOutputTokens} out`;
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

/** Lines naming the patterns the backend's sandbox cannot express, from the compiled policy's degraded list. */
function sandboxFidelityLines(effective: EffectivePolicy | undefined, max: number): string[] {
  const degraded = effective?.filesystem.degraded ?? [];
  if (degraded.length === 0) return [];
  return [
    "  Enforced for file tools only (bash sandbox sees literal paths):",
    ...bulletList(degraded.map((entry) => `${entry.pattern} (${entry.list})`), max),
  ];
}

export function networkPolicyLabel(config: ResolvedGuardConfig): string {
  if (!config.network.enabled) return "network unrestricted";
  return config.network.allowedDomains.length > 0 ? `${config.network.allowedDomains.length} domains` : "network blocked";
}

/** Compact classifier label: "classifier off", "auto (provider/id)", "provider/id", or "model unavailable (spec)". */
export function classifierModelLabel(ctx: ExtensionContext, config: ResolvedGuardConfig | undefined, state: RuntimeState): string {
  if (!config || !classifierEnabled(config, state.classifier)) return "classifier off";
  const spec = state.classifier.modelOverride ?? config.classifier.model;
  const model = resolveClassifierModel(ctx, config, state.classifier);
  if (!model) return `model unavailable (${spec})`;
  return spec === "auto" ? `auto (${model.provider}/${model.id})` : `${model.provider}/${model.id}`;
}

/** In "auto" mode the statusline appears only when something needs attention: the guard is off or erroring, or a call was denied/blocked since the last user message. */
export function statusLineVisible(mode: StatusLineMode, state: RuntimeState): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return !state.enabled || state.lastError !== undefined || state.stats.turnClassifierDenials > 0 || state.stats.turnBlocked > 0;
}

export function updateGuardStatus(ctx: ExtensionContext, state: RuntimeState): void {
  state.liveView?.refresh();
  if (!statusLineVisible(state.config?.statusLine ?? "always", state)) {
    ctx.ui.setStatus("guard", undefined);
    return;
  }
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
  const backend = `${state.backend?.name ?? config?.backend ?? "unknown"}${state.readOnly ? " RO" : ""}`;
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
        ...sandboxFidelityLines(effective, 3),
      ]
    : ["  Filesystem restrictions: disabled (unrestricted)"];
  const lines = [
    "# Pi Guard",
    "",
    "## Status",
    `  ${health}`,
    `  Read-only mode: ${state.readOnly ? "on" : "off"}`,
    `  Backend: ${state.backend?.name ?? config.backend}`,
    `  ${network}`,
    state.lastError ? `  Last error: ${state.lastError}` : undefined,
    "",
    "## Classifier",
    `  ${classifierOn ? "enabled" : "disabled"}`,
    `  Model: ${state.classifier.modelOverride ?? config.classifier.model}`,
    `  Fail closed: ${config.classifier.failClosed ? "yes" : "no"}`,
    `  Telemetry: ${config.classifier.telemetry}`,
    state.classifier.lastError ? `  Last error: ${state.classifier.lastError}` : undefined,
    "",
    "## Decisions this session",
    `  Reviewed: ${state.stats.reviewed}  Allowed: ${state.stats.allowed}  Denied: ${state.stats.denied}  Asked: ${state.stats.asked}`,
    `  Policy blocks: ${state.stats.blocked}  Exempt reads: ${state.stats.classifierSkips}  Errors: ${state.stats.errors}`,
    `  Tokens: ${formatTokensWithCache(state.stats)}`,
    "",
    "## Session approvals",
    `  Read paths: ${state.approvals.read.length > 0 ? state.approvals.read.join(", ") : "(none)"}`,
    `  Write paths: ${state.approvals.write.length > 0 ? state.approvals.write.join(", ") : "(none)"}`,
    "",
    "## Session guidance",
    ...(state.classifier.sessionGuidance && state.classifier.sessionGuidance.length > 0
      ? state.classifier.sessionGuidance.map((entry) => `  • ${entry}`)
      : ["  (none — approval comments land here)"]),
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

interface GuardLineTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

/** Styles one line of a guard report (status or policy) for terminal display. */
export function styleGuardLine(line: string, theme: GuardLineTheme): string {
  if (line.startsWith("# ")) return theme.fg("accent", theme.bold(line.slice(2)));
  if (line.startsWith("## ")) return theme.fg("toolTitle", theme.bold(`─ ${line.slice(3)} `));
  if (line.includes("[ALLOW]")) return theme.fg("success", line);
  if (line.includes("[DENY]") || line.includes("[BLOCK]")) return theme.fg("error", line);
  if (line.includes("[ASK]") || line.includes("[ERROR]") || line.trimStart().startsWith("! ")) return theme.fg("warning", line);
  if (/^[-\w ]+  [-\w ]+  [-\w ]+/.test(line) || /^-+  -+/.test(line)) return theme.fg("muted", line);
  if (line.trimStart().startsWith("•") || line.trimStart().startsWith("…")) return theme.fg("dim", line);
  return line;
}

/**
 * Renders pi-guard custom messages in the transcript. Nothing posts new
 * guard messages anymore (reports were dropped from the conversation because
 * custom messages enter agent context); this stays registered so sessions
 * recorded before that change still render their guard reports.
 */
export function registerGuardMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("pi-guard", (message, _options, theme) => {
    const raw = String(message.content ?? "");
    const rendered = raw
      .split("\n")
      .map((line) => styleGuardLine(line, theme))
      .join("\n");
    return new Text(theme.fg("accent", theme.bold("[guard]")) + "\n" + rendered, 0, 0);
  });
}

/** The resolved policy view for /guard policy: deterministic rules plus classifier rules. */
export function formatGuardPolicy(state: RuntimeState, config: ResolvedGuardConfig): string {
  const effective = state.backend?.describeEffectivePolicy(config);
  const rules = config.classifier.rules;
  const ruleSection = (title: string, entries: string[]) => [
    `## ${title} (${entries.length})`,
    ...(entries.length > 0 ? entries.map((rule) => `  • ${rule}`) : ["  (none)"]),
    "",
  ];
  const lines = [
    "# Pi Guard Policy",
    "",
    "## Filesystem",
    `  Restrictions: ${config.filesystem.enabled ? "enabled" : "disabled (lists still route classifier exemptions)"}`,
    `  Read mode: ${config.filesystem.allowRead.length === 0 ? "blacklist (all paths except deny read)" : "whitelist"}`,
    ...(config.filesystem.allowRead.length > 0
      ? ["  Allow read:", ...bulletList(effective?.filesystem.allowRead ?? config.filesystem.allowRead, Number.POSITIVE_INFINITY)]
      : ["  Allow read: (all)"]),
    "  Allow write:",
    ...bulletList(effective?.filesystem.allowWrite ?? config.filesystem.allowWrite, Number.POSITIVE_INFINITY),
    "  Deny read:",
    ...bulletList(effective?.filesystem.denyRead ?? config.filesystem.denyRead, Number.POSITIVE_INFINITY),
    "  Deny write:",
    ...bulletList(effective?.filesystem.denyWrite ?? config.filesystem.denyWrite, Number.POSITIVE_INFINITY),
    ...sandboxFidelityLines(effective, Number.POSITIVE_INFINITY),
    "",
    "## Network",
    `  Restrictions: ${config.network.enabled ? "enabled" : "disabled (unrestricted)"}`,
    "  Allowed domains:",
    ...bulletList(config.network.enabled ? (effective?.network.allowedDomains ?? config.network.allowedDomains) : [], Number.POSITIVE_INFINITY),
    `  Denied domains: ${formatArray(config.network.deniedDomains)}`,
    "",
    "## Environment scrubbing",
    `  Allow: ${formatArray(config.environment.allow)}`,
    `  Unset: ${formatArray(config.environment.unset)}`,
    "",
    "## Classifier",
    `  ${classifierEnabled(config, state.classifier) ? "enabled" : "disabled"} · model ${state.classifier.modelOverride ?? config.classifier.model} · fail ${config.classifier.failClosed ? "closed" : "open"}`,
    "",
    ...ruleSection("Classifier allow rules", rules.allow),
    ...ruleSection("Classifier soft-deny rules (ask without authorization)", rules.soft_deny),
    ...ruleSection("Classifier hard-deny rules (never allowed)", rules.hard_deny),
    ...ruleSection("Classifier environment assumptions", rules.environment),
    "## Config sources",
    ...config.sources.map((source) => `  • ${source}`),
  ];
  return lines.join("\n");
}
