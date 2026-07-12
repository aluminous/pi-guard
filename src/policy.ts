import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ResolvedGuardConfig } from "./config.ts";
import { expandHome } from "./paths.ts";

export type AccessKind = "read" | "write";

export type PolicyDenialCode = "denied-by-pattern" | "outside-roots" | "unresolvable";

export type PolicyDecision =
  | { allowed: true; normalizedPath: string }
  | { allowed: false; code: PolicyDenialCode; reason: string; normalizedPath: string };

function stripAtPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function normalizeUserPath(cwd: string, inputPath: string): string {
  const stripped = stripAtPrefix(inputPath);
  const expanded = expandHome(stripped);
  return path.resolve(cwd, expanded);
}

function canonicalizeExistingPath(normalizedPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    return { ok: true, path: realpathSync.native(normalizedPath) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function canonicalizeWritePath(normalizedPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    lstatSync(normalizedPath);
    return canonicalizeExistingPath(normalizedPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const parts: string[] = [];
  let current = normalizedPath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: `no existing parent for ${normalizedPath}` };
    parts.unshift(path.basename(current));
    current = parent;
  }

  const parent = canonicalizeExistingPath(current);
  if (!parent.ok) return parent;
  return { ok: true, path: path.join(parent.path, ...parts) };
}

function hasGlob(pattern: string): boolean {
  return /[*?\[\]{}]/.test(pattern);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join("/");
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch ?? "");
    }
  }
  return new RegExp(`^${out}$`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function patternMatches(cwd: string, candidate: string, pattern: string): boolean {
  const expanded = expandHome(pattern);
  const normalizedPattern = expanded.split(path.sep).join("/");
  const relativeCandidate = path.relative(cwd, candidate).split(path.sep).join("/");
  const basename = path.basename(candidate);

  if (hasGlob(pattern)) {
    if (path.isAbsolute(expanded) || expanded.startsWith("~")) {
      return globToRegex(path.resolve(cwd, expanded).split(path.sep).join("/")).test(candidate.split(path.sep).join("/"));
    }
    if (normalizedPattern.includes("/")) return globToRegex(normalizedPattern).test(relativeCandidate);
    return globToRegex(normalizedPattern).test(basename);
  }

  const absolute = path.resolve(cwd, expanded);
  const checkedAbsolute = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  if (pattern.includes("/") || path.isAbsolute(expanded) || expanded.startsWith("~") || pattern === ".") {
    return isInside(checkedAbsolute, candidate);
  }
  return basename === pattern || relativeCandidate === pattern || relativeCandidate.startsWith(`${pattern}/`);
}

function isAllowedByRoots(cwd: string, candidate: string, roots: string[]): boolean {
  return roots.some((root) => patternMatches(cwd, candidate, root));
}

function isDenied(cwd: string, candidate: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => patternMatches(cwd, candidate, pattern));
}

export function decidePathAccess(config: ResolvedGuardConfig, cwd: string, inputPath: string, kind: AccessKind): PolicyDecision {
  const normalizedPath = normalizeUserPath(cwd, inputPath);
  const canonical = kind === "write" ? canonicalizeWritePath(normalizedPath) : canonicalizeExistingPath(normalizedPath);
  if (!canonical.ok) {
    return { allowed: false, code: "unresolvable", normalizedPath, reason: `${kind} path could not be resolved: ${canonical.reason}` };
  }

  const canonicalCwd = canonicalizeExistingPath(cwd);
  if (!canonicalCwd.ok) {
    return { allowed: false, code: "unresolvable", normalizedPath, reason: `cwd could not be resolved: ${canonicalCwd.reason}` };
  }

  const checkedPath = canonical.path;
  const checkedCwd = canonicalCwd.path;
  const denyPatterns = kind === "read" ? config.filesystem.denyRead : config.filesystem.denyWrite;
  const allowRoots = kind === "read" ? config.filesystem.allowRead : config.filesystem.allowWrite;
  const deniedBy = isDenied(checkedCwd, checkedPath, denyPatterns);
  if (deniedBy) {
    return { allowed: false, code: "denied-by-pattern", normalizedPath: checkedPath, reason: `${kind} denied by pattern ${deniedBy}` };
  }
  if (kind === "write" || allowRoots.length > 0) {
    if (!isAllowedByRoots(checkedCwd, checkedPath, allowRoots)) {
      return { allowed: false, code: "outside-roots", normalizedPath: checkedPath, reason: `${kind} outside allowed roots` };
    }
  }
  return { allowed: true, normalizedPath: checkedPath };
}

function wildcardMatches(value: string, pattern: string): boolean {
  return globToRegex(pattern).test(value);
}

export function scrubEnvironment(env: NodeJS.ProcessEnv | undefined, config: ResolvedGuardConfig): Record<string, string> {
  const source = env ?? process.env;
  const result: Record<string, string> = {};
  const allow = config.environment.allow;
  const unset = config.environment.unset;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (unset.some((pattern) => wildcardMatches(key, pattern))) continue;
    if (allow.length > 0 && !allow.some((pattern) => wildcardMatches(key, pattern))) continue;
    result[key] = value;
  }
  return result;
}

export function summarizePolicy(config: ResolvedGuardConfig): string[] {
  return [
    `Backend: ${config.backend}`,
    `Network: ${config.network.enabled ? "enabled" : "disabled"}`,
    `Read mode: ${config.filesystem.allowRead.length === 0 ? "blacklist (all paths except denyRead)" : `whitelist (${config.filesystem.allowRead.join(", ")})`}`,
    `Write roots: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
    `Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
    `Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
  ];
}
