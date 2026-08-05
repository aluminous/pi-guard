import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_IDS, DEFAULT_DISPOSITIONS, isCapabilityId, isDisposition, type CapabilityId, type Disposition } from "./capabilities.ts";
import { DEFAULT_CLASSIFIER_RULES } from "./classifier-rules.ts";
import { DEFAULT_COMMAND_ALLOWLIST } from "./command-allowlist.ts";

export type GuardBackendName = "seatbelt" | "none" | "container";

/** When the guard statusline is visible: always, never, or auto (only when the guard is off/erroring or something was denied since the last user message). */
export type StatusLineMode = "always" | "never" | "auto";

export interface ClassifierRulesConfig {
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  environment?: string[];
  /**
   * When true, provided lists replace the merged base wholesale (profile
   * semantics). Default is name-based merging: rules are "Name: text", a
   * same-name entry overrides the base rule in place, "Name:" with an empty
   * body deletes it, and new names append.
   */
  replace?: boolean;
}

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string;
  /** Model for the `judge` disposition's escalation review; "current" uses the session model. */
  judgeModel?: string;
  timeoutMs?: number;
  failClosed?: boolean;
  /** Decision telemetry written to pi's session log: off, minimal (truncated), or full. */
  telemetry?: "off" | "minimal" | "full";
  /** Legacy prose rule tiers. Parsed for compatibility; inert in capability mode. */
  rules?: ClassifierRulesConfig;
}

export interface ResolvedClassifierConfig {
  enabled: boolean;
  model: string;
  judgeModel: string;
  timeoutMs: number;
  failClosed: boolean;
  telemetry: "off" | "minimal" | "full";
  rules: Required<Omit<ClassifierRulesConfig, "replace">>;
}

export interface GuardConfig {
  enabled?: boolean;
  backend?: GuardBackendName;
  statusLine?: StatusLineMode;
  filesystem?: {
    enabled?: boolean;
    allowRead?: string[];
    denyRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
  };
  environment?: {
    allow?: string[];
    unset?: string[];
  };
  network?: {
    enabled?: boolean;
    allowedDomains?: string[];
    deniedDomains?: string[];
  };
  commands?: {
    allow?: string[];
  };
  /** Capability disposition table: class id → allow | judge | ask | deny. Omitted classes keep their default. */
  dispositions?: Record<string, string>;
  classifier?: ClassifierConfig;
  seatbelt?: Record<string, unknown>;
  container?: Record<string, unknown>;
}

export type ProvenanceListKey =
  | "filesystem.allowRead"
  | "filesystem.denyRead"
  | "filesystem.allowWrite"
  | "filesystem.denyWrite"
  | "environment.allow"
  | "environment.unset"
  | "network.allowedDomains"
  | "network.deniedDomains"
  | "commands.allow";

export type ClassifierRuleListKey = "allow" | "soft_deny" | "hard_deny" | "environment";

export interface RuleProvenance {
  /** "default" or the config file path that last set this rule. */
  source: string;
  /** For name-merged overrides: the source of the entry this one replaced. */
  overrides?: string;
}

/** Where each effective config value came from ("default" or a config file path); last writer wins. */
export interface ConfigProvenance {
  /** Entry text → source, per wholesale-replaced list. */
  lists: Record<ProvenanceListKey, Record<string, string>>;
  /** Rule name (lowercased; full text for nameless rules) → provenance, per classifier rule list. */
  rules: Record<ClassifierRuleListKey, Record<string, RuleProvenance>>;
  /** Rules deleted by a "Name:" empty-body entry: original name → deleting source. */
  deletedRules: Record<ClassifierRuleListKey, Record<string, string>>;
  /** Capability class id → source; "default" until a config file sets the row. */
  dispositions: Record<CapabilityId, string>;
}

export interface ResolvedGuardConfig {
  enabled: boolean;
  backend: GuardBackendName;
  statusLine: StatusLineMode;
  filesystem: {
    enabled: boolean;
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  environment: {
    allow: string[];
    unset: string[];
  };
  network: {
    enabled: boolean;
    allowedDomains: string[];
    deniedDomains: string[];
  };
  commands: {
    allow: string[];
  };
  /** Fully resolved disposition table: every capability class has a row. */
  dispositions: Record<CapabilityId, Disposition>;
  classifier: ResolvedClassifierConfig;
  seatbelt: Record<string, unknown>;
  container: Record<string, unknown>;
  diagnostics: string[];
  sources: string[];
  provenance: ConfigProvenance;
}

function defaultDenyReadPaths(): string[] {
  return [
    "~/.ssh",
    "~/.aws",
    "~/.azure",
    "~/.config/gcloud",
    "~/.gnupg",
    "~/.kube",
    "~/.docker",
    "~/.netrc",
    "~/.npmrc",
    "~/.pypirc",
    "~/.gem/credentials",
    "~/.password-store",
    "~/.local/share/keyrings",
    "~/.mozilla/firefox",
    "~/.config/google-chrome",
    "~/.config/chromium",
    "~/.config/BraveSoftware",
    "~/Library/Keychains",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Chromium",
    "~/Library/Application Support/BraveSoftware",
    "~/Library/Application Support/Firefox",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
  ];
}

function defaultAllowedNetworkDomains(): string[] {
  return [
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "gitlab.com",
    "*.gitlab.com",
    "bitbucket.org",
    "*.bitbucket.org",
    "codeberg.org",
    "*.codeberg.org",
    "sr.ht",
    "*.sr.ht",
    "ghcr.io",
    "*.ghcr.io",
    "docker.io",
    "*.docker.io",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "quay.io",
    "*.quay.io",
    "gcr.io",
    "*.gcr.io",
    "*.pkg.dev",
    "registry.k8s.io",
    "mcr.microsoft.com",
    "public.ecr.aws",
  ];
}

function defaultAllowWritePaths(): string[] {
  return [
    ".",
    "/tmp",
    "/private/tmp",
    os.tmpdir(),
    "~/.cache",
    "~/Library/Caches",
    "~/.npm",
    "~/.pnpm-store",
    "~/.yarn",
    "~/.cache/yarn",
    "~/.cache/pnpm",
    "~/.cargo/registry",
    "~/.cargo/git",
    "~/.gradle/caches",
    "~/.gradle/wrapper",
    "~/.m2/repository",
    "~/go/pkg/mod",
    "~/.cache/go-build",
    "~/.cache/pip",
    "~/Library/Caches/pip",
    "~/.nuget/packages",
    "~/.ivy2/cache",
    "~/.cache/coursier",
    "~/.cache/bazel",
    "~/.cache/uv",
    "~/.cache/ruff",
    "~/.cache/pre-commit",
  ];
}

function listProvenance(entries: string[], source: string): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry, source]));
}

/** Provenance map key for a classifier rule: its lowercased name, or the full text for nameless rules. */
export function ruleProvenanceKey(rule: string): string {
  return parseRuleName(rule)?.name.toLowerCase() ?? rule;
}

function ruleListProvenance(rules: string[], source: string): Record<string, RuleProvenance> {
  return Object.fromEntries(rules.map((rule) => [ruleProvenanceKey(rule), { source }]));
}

function defaultProvenance(config: Omit<ResolvedGuardConfig, "provenance">): ConfigProvenance {
  return {
    lists: {
      "filesystem.allowRead": listProvenance(config.filesystem.allowRead, "default"),
      "filesystem.denyRead": listProvenance(config.filesystem.denyRead, "default"),
      "filesystem.allowWrite": listProvenance(config.filesystem.allowWrite, "default"),
      "filesystem.denyWrite": listProvenance(config.filesystem.denyWrite, "default"),
      "environment.allow": listProvenance(config.environment.allow, "default"),
      "environment.unset": listProvenance(config.environment.unset, "default"),
      "network.allowedDomains": listProvenance(config.network.allowedDomains, "default"),
      "network.deniedDomains": listProvenance(config.network.deniedDomains, "default"),
      "commands.allow": listProvenance(config.commands.allow, "default"),
    },
    rules: {
      allow: ruleListProvenance(config.classifier.rules.allow, "default"),
      soft_deny: ruleListProvenance(config.classifier.rules.soft_deny, "default"),
      hard_deny: ruleListProvenance(config.classifier.rules.hard_deny, "default"),
      environment: ruleListProvenance(config.classifier.rules.environment, "default"),
    },
    deletedRules: { allow: {}, soft_deny: {}, hard_deny: {}, environment: {} },
    dispositions: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, "default"])) as Record<CapabilityId, string>,
  };
}

const DEFAULTS_SANS_PROVENANCE: Omit<ResolvedGuardConfig, "provenance"> = {
  enabled: true,
  backend: "seatbelt",
  statusLine: "always",
  filesystem: {
    enabled: true,
    allowRead: [],
    denyRead: defaultDenyReadPaths(),
    allowWrite: defaultAllowWritePaths(),
    denyWrite: [".pi", ".env", ".env.*", "*.pem", "*.key", "~/.ssh", "~/.aws", "~/.azure", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc"],
  },
  environment: {
    allow: [
      "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "CI", "TERM", "SHELL", "LANG", "LC_*",
      // CA-certificate configuration, so a private CA reaches curl/python/node/aws/git/npm/cargo/deno
      // tooling inside the sandbox (JAVA_TOOL_OPTIONS is how java picks up a custom trust store).
      "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
      "AWS_CA_BUNDLE", "PIP_CERT", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "NPM_CONFIG_CAFILE",
      "CARGO_HTTP_CAINFO", "DENO_CERT", "JAVA_TOOL_OPTIONS",
    ],
    unset: [
      // Explicit AWS credential vars rather than a broad AWS_* glob, so AWS_CA_BUNDLE in the
      // allow list is not scrubbed (unset is applied before allow). Tradeoff: future unknown
      // AWS_* secrets are no longer auto-unset; the *_TOKEN/*_SECRET/*_KEY globs are the backstop.
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "*_TOKEN", "*_SECRET", "*_KEY",
    ],
  },
  network: {
    enabled: true,
    allowedDomains: defaultAllowedNetworkDomains(),
    deniedDomains: ["*"],
  },
  commands: {
    allow: [...DEFAULT_COMMAND_ALLOWLIST],
  },
  dispositions: { ...DEFAULT_DISPOSITIONS },
  classifier: {
    enabled: false,
    model: "auto",
    judgeModel: "current",
    timeoutMs: 8000,
    failClosed: true,
    telemetry: "minimal",
    rules: DEFAULT_CLASSIFIER_RULES,
  },
  seatbelt: {},
  container: {},
  diagnostics: [],
  sources: ["defaults"],
};

export const DEFAULT_CONFIG: ResolvedGuardConfig = { ...DEFAULTS_SANS_PROVENANCE, provenance: defaultProvenance(DEFAULTS_SANS_PROVENANCE) };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, name: string, diagnostics: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push(`Ignoring ${name}: expected an array of strings`);
    return undefined;
  }
  return value;
}

function readJson(filePath: string, diagnostics: string[]): Partial<GuardConfig> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isObject(parsed)) {
      diagnostics.push(`Ignoring ${filePath}: expected a JSON object`);
      return undefined;
    }
    return parsed as Partial<GuardConfig>;
  } catch (error) {
    diagnostics.push(`Ignoring ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseRuleName(entry: string): { name: string; body: string } | undefined {
  const colon = entry.indexOf(":");
  if (colon <= 0) return undefined;
  return { name: entry.slice(0, colon).trim(), body: entry.slice(colon + 1).trim() };
}

/**
 * Merges a user rule list into the base by rule name ("Name: text"): a
 * same-name entry overrides the base rule in place (keeping its position, so
 * the classifier prompt prefix stays stable), "Name:" with an empty body
 * deletes it, and new or nameless entries append.
 */
interface RuleMergeEvent {
  kind: "append" | "override" | "delete";
  /** Provenance-map key (ruleProvenanceKey form). */
  key: string;
  /** Original-case rule name (or full text for nameless entries), for the deletions note. */
  name: string;
}

function mergeRuleList(base: string[], incoming: string[], listName: string, diagnostics: string[], onEvent?: (event: RuleMergeEvent) => void): string[] {
  const result = [...base];
  const indexOfName = (name: string) => result.findIndex((rule) => parseRuleName(rule)?.name.toLowerCase() === name.toLowerCase());
  for (const entry of incoming) {
    const parsed = parseRuleName(entry);
    if (!parsed) {
      result.push(entry);
      onEvent?.({ kind: "append", key: entry, name: entry });
      continue;
    }
    const at = indexOfName(parsed.name);
    if (!parsed.body) {
      if (at === -1) diagnostics.push(`${listName}: cannot delete unknown rule "${parsed.name}"`);
      else {
        result.splice(at, 1);
        onEvent?.({ kind: "delete", key: parsed.name.toLowerCase(), name: parsed.name });
      }
      continue;
    }
    if (at === -1) {
      result.push(entry);
      onEvent?.({ kind: "append", key: parsed.name.toLowerCase(), name: parsed.name });
    } else {
      result[at] = entry;
      onEvent?.({ kind: "override", key: parsed.name.toLowerCase(), name: parsed.name });
    }
  }
  return result;
}

export function mergeConfig(base: ResolvedGuardConfig, override: Partial<GuardConfig>, source: string): ResolvedGuardConfig {
  const diagnostics = [...base.diagnostics];
  const next: ResolvedGuardConfig = {
    ...base,
    filesystem: { ...base.filesystem },
    environment: { ...base.environment },
    network: { ...base.network },
    commands: { ...base.commands },
    dispositions: { ...base.dispositions },
    classifier: { ...base.classifier },
    seatbelt: { ...base.seatbelt },
    container: { ...base.container },
    diagnostics,
    sources: [...base.sources, source],
    provenance: structuredClone(base.provenance),
  };

  /** Applies a wholesale list replacement and re-labels every entry's provenance with this source. */
  const setList = (listKey: ProvenanceListKey, incoming: string[] | undefined, current: string[]): string[] => {
    if (!incoming) return current;
    next.provenance.lists[listKey] = listProvenance(incoming, source);
    return incoming;
  };

  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if ((override as Record<string, unknown>).mode !== undefined) diagnostics.push(`Ignoring ${source}.mode: report-only mode has been removed`);

  if (override.backend === "seatbelt" || override.backend === "none" || override.backend === "container") next.backend = override.backend;
  else if (override.backend !== undefined) diagnostics.push(`Ignoring ${source}.backend: unsupported backend`);

  if (override.statusLine === "always" || override.statusLine === "never" || override.statusLine === "auto") next.statusLine = override.statusLine;
  else if (override.statusLine !== undefined) diagnostics.push(`Ignoring ${source}.statusLine: expected "always", "never", or "auto"`);

  if (isObject(override.filesystem)) {
    if (typeof override.filesystem.enabled === "boolean") next.filesystem.enabled = override.filesystem.enabled;
    next.filesystem.allowRead = setList("filesystem.allowRead", asStringArray(override.filesystem.allowRead, `${source}.filesystem.allowRead`, diagnostics), next.filesystem.allowRead);
    next.filesystem.denyRead = setList("filesystem.denyRead", asStringArray(override.filesystem.denyRead, `${source}.filesystem.denyRead`, diagnostics), next.filesystem.denyRead);
    next.filesystem.allowWrite = setList("filesystem.allowWrite", asStringArray(override.filesystem.allowWrite, `${source}.filesystem.allowWrite`, diagnostics), next.filesystem.allowWrite);
    next.filesystem.denyWrite = setList("filesystem.denyWrite", asStringArray(override.filesystem.denyWrite, `${source}.filesystem.denyWrite`, diagnostics), next.filesystem.denyWrite);
  }

  if (isObject(override.environment)) {
    next.environment.allow = setList("environment.allow", asStringArray(override.environment.allow, `${source}.environment.allow`, diagnostics), next.environment.allow);
    next.environment.unset = setList("environment.unset", asStringArray(override.environment.unset, `${source}.environment.unset`, diagnostics), next.environment.unset);
  }

  if (isObject(override.network)) {
    if (typeof override.network.enabled === "boolean") next.network.enabled = override.network.enabled;
    next.network.allowedDomains = setList("network.allowedDomains", asStringArray(override.network.allowedDomains, `${source}.network.allowedDomains`, diagnostics), next.network.allowedDomains);
    next.network.deniedDomains = setList("network.deniedDomains", asStringArray(override.network.deniedDomains, `${source}.network.deniedDomains`, diagnostics), next.network.deniedDomains);
  }

  if (isObject(override.commands)) {
    next.commands.allow = setList("commands.allow", asStringArray(override.commands.allow, `${source}.commands.allow`, diagnostics), next.commands.allow);
  }

  // Per-row merge, unlike the wholesale lists: the disposition table is the
  // user-facing policy surface, so a project config that sets one row must not
  // silently reset the eleven it did not mention.
  if (isObject(override.dispositions)) {
    for (const [key, value] of Object.entries(override.dispositions)) {
      if (!isCapabilityId(key)) {
        diagnostics.push(`Ignoring ${source}.dispositions.${key}: unknown capability class`);
        continue;
      }
      if (!isDisposition(value)) {
        diagnostics.push(`Ignoring ${source}.dispositions.${key}: expected "allow", "judge", "ask", or "deny"`);
        continue;
      }
      next.dispositions[key] = value;
      next.provenance.dispositions[key] = source;
    }
  } else if (override.dispositions !== undefined) {
    diagnostics.push(`Ignoring ${source}.dispositions: expected an object of class → disposition`);
  }

  if (isObject(override.classifier)) {
    if (typeof override.classifier.enabled === "boolean") next.classifier.enabled = override.classifier.enabled;
    if (typeof override.classifier.model === "string" && override.classifier.model.trim()) next.classifier.model = override.classifier.model.trim();
    if (typeof override.classifier.judgeModel === "string" && override.classifier.judgeModel.trim()) next.classifier.judgeModel = override.classifier.judgeModel.trim();
    if (typeof override.classifier.timeoutMs === "number" && Number.isFinite(override.classifier.timeoutMs) && override.classifier.timeoutMs > 0) {
      next.classifier.timeoutMs = Math.floor(override.classifier.timeoutMs);
    } else if (override.classifier.timeoutMs !== undefined) {
      diagnostics.push(`Ignoring ${source}.classifier.timeoutMs: expected a positive number`);
    }
    if (typeof override.classifier.failClosed === "boolean") next.classifier.failClosed = override.classifier.failClosed;
    if (override.classifier.telemetry !== undefined) {
      if (override.classifier.telemetry === "off" || override.classifier.telemetry === "minimal" || override.classifier.telemetry === "full") {
        next.classifier.telemetry = override.classifier.telemetry;
      } else {
        diagnostics.push(`Ignoring ${source}.classifier.telemetry: expected "off", "minimal", or "full"`);
      }
    }
    if (isObject(override.classifier.rules)) {
      diagnostics.push(
        `${source}.classifier.rules is legacy: capability mode names actions from the class taxonomy and decides via the disposition table, so prose rule tiers no longer affect decisions. Use "dispositions" instead.`,
      );
      const rulesOverride = override.classifier.rules;
      const replace = rulesOverride.replace === true;
      if (rulesOverride.replace !== undefined && typeof rulesOverride.replace !== "boolean") {
        diagnostics.push(`Ignoring ${source}.classifier.rules.replace: expected a boolean`);
      }
      next.classifier.rules = { ...next.classifier.rules };
      const lists = ["allow", "soft_deny", "hard_deny", "environment"] as const;
      for (const list of lists) {
        const incoming = asStringArray(rulesOverride[list], `${source}.classifier.rules.${list}`, diagnostics);
        if (!incoming) continue;
        if (replace) {
          next.classifier.rules[list] = incoming;
          next.provenance.rules[list] = ruleListProvenance(incoming, source);
          next.provenance.deletedRules[list] = {};
          continue;
        }
        const provRules = next.provenance.rules[list];
        const provDeleted = next.provenance.deletedRules[list];
        next.classifier.rules[list] = mergeRuleList(next.classifier.rules[list], incoming, `${source}.classifier.rules.${list}`, diagnostics, (event) => {
          if (event.kind === "delete") {
            delete provRules[event.key];
            provDeleted[event.name] = source;
            return;
          }
          delete provDeleted[event.name];
          const previous = event.kind === "override" ? provRules[event.key] : undefined;
          provRules[event.key] = previous ? { source, overrides: previous.source } : { source };
        });
      }
    }
  }

  if (isObject(override.seatbelt)) next.seatbelt = { ...next.seatbelt, ...override.seatbelt };
  if (isObject(override.container)) next.container = { ...next.container, ...override.container };

  return next;
}

export function globalGuardConfigPath(): string {
  return path.join(getAgentDir(), "extensions", "guard.json");
}

/** Short display label for a provenance source: "default", "global", "project", or the raw path when unrecognized. */
export function configSourceLabel(source: string): string {
  if (source === "default") return "default";
  if (source === globalGuardConfigPath()) return "global";
  if (source.endsWith(path.join(CONFIG_DIR_NAME, "guard.json"))) return "project";
  return source;
}

export function loadConfig(ctx: ExtensionContext): ResolvedGuardConfig {
  const diagnostics: string[] = [];
  let config: ResolvedGuardConfig = structuredClone(DEFAULT_CONFIG);
  config.diagnostics = [];
  config.sources = ["defaults"];

  const globalPath = globalGuardConfigPath();
  const projectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "guard.json");

  const globalConfig = readJson(globalPath, diagnostics);
  if (globalConfig) config = mergeConfig(config, globalConfig, globalPath);

  if (ctx.isProjectTrusted()) {
    const projectConfig = readJson(projectPath, diagnostics);
    if (projectConfig) config = mergeConfig(config, projectConfig, projectPath);
  } else if (existsSync(projectPath)) {
    diagnostics.push(`Ignoring untrusted project config: ${projectPath}`);
  }

  config.diagnostics.push(...diagnostics);
  return config;
}
