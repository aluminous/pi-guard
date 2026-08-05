// Sandbox violation capture for /guard why: queries the macOS unified log for
// Seatbelt denial reports in a guarded command's execution window and maps
// each denied path back to the guard rule that caused it. Kernel denial lines
// look like (validated empirically on macOS 15 via `log show`):
//
//   2026-08-05 09:20:22.869661+0900  localhost kernel[0]: (Sandbox) Sandbox: cat(8294) deny(1) file-read-data /path/to/file
//
// plus "N duplicate report for Sandbox: …" coalescing lines with the same tail.
import { execFile } from "node:child_process";
import type { ResolvedRailConfig } from "./config.ts";
import { compileFilesystemPolicy, findMatchingPattern, type CompiledFilesystemPolicy, type DegradedPattern } from "./policy.ts";

/** Validated predicate: denial reports arrive from the kernel with sender "Sandbox". */
export const SANDBOX_LOG_PREDICATE = 'sender == "Sandbox" AND eventMessage CONTAINS "deny("';

export interface SandboxDenial {
  process: string;
  pid: number;
  operation: string;
  /** The operation's target: a filesystem path for file-* operations, a service/address otherwise. */
  target?: string;
  raw: string;
}

export interface LogWindow {
  start: Date;
  end: Date;
}

/** Injectable `log show` boundary: returns the raw syslog-style output for the window. */
export type LogRunner = (window: LogWindow) => Promise<string>;

/** Local time in the "YYYY-MM-DD HH:MM:SS" form `log show --start/--end` expects. */
function formatLogTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Runs `log show` for the window. Read-only, but slow (a few seconds) — callers should notify first. */
export const defaultLogRunner: LogRunner = (window) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/log",
      ["show", "--style", "syslog", "--start", formatLogTimestamp(window.start), "--end", formatLogTimestamp(window.end), "--predicate", SANDBOX_LOG_PREDICATE],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const DENIAL_PATTERN = /Sandbox: (.+?)\((\d+)\) deny\(\d+\) ([\w-]+)(?:\s+(.+?))?\s*$/;

/** Parses denial reports out of raw `log show` output, deduplicating coalesced repeats. */
export function parseSandboxDenials(raw: string): SandboxDenial[] {
  const denials: SandboxDenial[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const match = line.match(DENIAL_PATTERN);
    if (!match) continue;
    const denial: SandboxDenial = {
      process: match[1]!,
      pid: Number(match[2]!),
      operation: match[3]!,
      target: match[4],
      raw: line.trim(),
    };
    const key = `${denial.process}|${denial.operation}|${denial.target ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    denials.push(denial);
  }
  return denials;
}

export interface DenialAttribution {
  denial: SandboxDenial;
  /** Human-readable guard-rule attribution, or undefined when no guard rule explains the denial. */
  rule?: string;
  /** Set when the attributed pattern is one the sandbox only holds as a literal path. */
  degraded?: DegradedPattern;
}

function accessKindForOperation(operation: string): "read" | "write" | undefined {
  if (operation.startsWith("file-read") || operation === "file-map-executable") return "read";
  if (operation.startsWith("file-write")) return "write";
  return undefined;
}

/** Maps one denial against the compiled filesystem policy: deny lists first, then write/read root containment. */
export function attributeDenial(compiled: CompiledFilesystemPolicy, cwd: string, denial: SandboxDenial): DenialAttribution {
  const target = denial.target;
  const access = accessKindForOperation(denial.operation);
  if (!target || !target.startsWith("/") || !access) return { denial };

  const denyList = access === "read" ? ("denyRead" as const) : ("denyWrite" as const);
  const pattern = findMatchingPattern(cwd, target, compiled.patterns[denyList]);
  if (pattern !== undefined) {
    const degraded = compiled.degraded.find((entry) => entry.list === denyList && entry.pattern === pattern);
    return { denial, rule: `${denyList} '${pattern}'`, degraded };
  }
  // A degraded pattern's literal can still cover the path even when the
  // policy-engine match missed (e.g. the literal is a directory prefix).
  const literalHit = compiled.degraded.find((entry) => entry.list === denyList && (target === entry.sandboxPath || target.startsWith(`${entry.sandboxPath}/`)));
  if (literalHit) return { denial, rule: `${denyList} '${literalHit.pattern}'`, degraded: literalHit };

  if (access === "write" && findMatchingPattern(cwd, target, compiled.patterns.allowWrite) === undefined) {
    return { denial, rule: "outside allowWrite roots (writes are default-deny)" };
  }
  if (access === "read" && compiled.patterns.allowRead.length > 0 && findMatchingPattern(cwd, target, compiled.patterns.allowRead) === undefined) {
    return { denial, rule: "outside allowRead roots (whitelist read mode)" };
  }
  return { denial };
}

export function attributeDenials(config: ResolvedRailConfig, cwd: string, denials: SandboxDenial[]): DenialAttribution[] {
  const compiled = compileFilesystemPolicy(config, cwd);
  return denials.map((denial) => attributeDenial(compiled, cwd, denial));
}

function formatCommandAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

export function formatRailWhy(params: {
  command: { command: string; startedAt: number; endedAt?: number };
  attributions: DenialAttribution[];
}): string {
  const { command, attributions } = params;
  const lines = [
    "# Rail Sandbox Denials",
    "",
    `  last guarded command: ${command.command}`,
    `  started ${formatCommandAge(command.startedAt)}${command.endedAt !== undefined ? `, ran ${command.endedAt - command.startedAt}ms` : ", still running"}`,
    "",
    "## Denials in that window",
  ];
  if (attributions.length === 0) {
    lines.push(
      "  (none found)",
      "  The unified log can lag; re-run the failing command and try /guard why again.",
      "  Non-sandbox failures (permissions, missing files) never appear here.",
    );
    return lines.join("\n");
  }
  for (const { denial, rule, degraded } of attributions) {
    const subject = `deny ${denial.operation}${denial.target ? ` ${denial.target}` : ""} (${denial.process})`;
    lines.push(`  [BLOCK] ${subject} → ${rule ?? "no matching guard rule (system profile)"}`);
    if (degraded) lines.push(`      pattern is degraded in the sandbox: Seatbelt holds the literal ${degraded.sandboxPath}`);
  }
  return lines.join("\n");
}
