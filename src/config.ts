import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CLASSIFIER_RULES } from "./classifier-rules.ts";

export type GuardBackendName = "seatbelt" | "none" | "container";

export interface ClassifierRulesConfig {
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  environment?: string[];
}

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  failClosed?: boolean;
  rules?: ClassifierRulesConfig;
}

export interface ResolvedClassifierConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  failClosed: boolean;
  rules: Required<ClassifierRulesConfig>;
}

export interface GuardConfig {
  enabled?: boolean;
  backend?: GuardBackendName;
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
  classifier?: ClassifierConfig;
  seatbelt?: Record<string, unknown>;
  container?: Record<string, unknown>;
}

export interface ResolvedGuardConfig {
  enabled: boolean;
  backend: GuardBackendName;
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
  classifier: ResolvedClassifierConfig;
  seatbelt: Record<string, unknown>;
  container: Record<string, unknown>;
  diagnostics: string[];
  sources: string[];
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

export const DEFAULT_CONFIG: ResolvedGuardConfig = {
  enabled: true,
  backend: "seatbelt",
  filesystem: {
    enabled: true,
    allowRead: [],
    denyRead: defaultDenyReadPaths(),
    allowWrite: defaultAllowWritePaths(),
    denyWrite: [".pi", ".env", ".env.*", "*.pem", "*.key", "~/.ssh", "~/.aws", "~/.azure", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc"],
  },
  environment: {
    allow: ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "CI", "TERM", "SHELL", "LANG", "LC_*"],
    unset: ["AWS_*", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "*_TOKEN", "*_SECRET", "*_KEY"],
  },
  network: {
    enabled: true,
    allowedDomains: defaultAllowedNetworkDomains(),
    deniedDomains: ["*"],
  },
  classifier: {
    enabled: false,
    model: "auto",
    timeoutMs: 8000,
    failClosed: true,
    rules: DEFAULT_CLASSIFIER_RULES,
  },
  seatbelt: {},
  container: {},
  diagnostics: [],
  sources: ["defaults"],
};

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

export function mergeConfig(base: ResolvedGuardConfig, override: Partial<GuardConfig>, source: string): ResolvedGuardConfig {
  const diagnostics = [...base.diagnostics];
  const next: ResolvedGuardConfig = {
    ...base,
    filesystem: { ...base.filesystem },
    environment: { ...base.environment },
    network: { ...base.network },
    classifier: { ...base.classifier },
    seatbelt: { ...base.seatbelt },
    container: { ...base.container },
    diagnostics,
    sources: [...base.sources, source],
  };

  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if ((override as Record<string, unknown>).mode !== undefined) diagnostics.push(`Ignoring ${source}.mode: report-only mode has been removed`);

  if (override.backend === "seatbelt" || override.backend === "none" || override.backend === "container") next.backend = override.backend;
  else if (override.backend !== undefined) diagnostics.push(`Ignoring ${source}.backend: unsupported backend`);

  if (isObject(override.filesystem)) {
    if (typeof override.filesystem.enabled === "boolean") next.filesystem.enabled = override.filesystem.enabled;
    next.filesystem.allowRead = asStringArray(override.filesystem.allowRead, `${source}.filesystem.allowRead`, diagnostics) ?? next.filesystem.allowRead;
    next.filesystem.denyRead = asStringArray(override.filesystem.denyRead, `${source}.filesystem.denyRead`, diagnostics) ?? next.filesystem.denyRead;
    next.filesystem.allowWrite = asStringArray(override.filesystem.allowWrite, `${source}.filesystem.allowWrite`, diagnostics) ?? next.filesystem.allowWrite;
    next.filesystem.denyWrite = asStringArray(override.filesystem.denyWrite, `${source}.filesystem.denyWrite`, diagnostics) ?? next.filesystem.denyWrite;
  }

  if (isObject(override.environment)) {
    next.environment.allow = asStringArray(override.environment.allow, `${source}.environment.allow`, diagnostics) ?? next.environment.allow;
    next.environment.unset = asStringArray(override.environment.unset, `${source}.environment.unset`, diagnostics) ?? next.environment.unset;
  }

  if (isObject(override.network)) {
    if (typeof override.network.enabled === "boolean") next.network.enabled = override.network.enabled;
    next.network.allowedDomains = asStringArray(override.network.allowedDomains, `${source}.network.allowedDomains`, diagnostics) ?? next.network.allowedDomains;
    next.network.deniedDomains = asStringArray(override.network.deniedDomains, `${source}.network.deniedDomains`, diagnostics) ?? next.network.deniedDomains;
  }

  if (isObject(override.classifier)) {
    if (typeof override.classifier.enabled === "boolean") next.classifier.enabled = override.classifier.enabled;
    if (typeof override.classifier.model === "string" && override.classifier.model.trim()) next.classifier.model = override.classifier.model.trim();
    if (typeof override.classifier.timeoutMs === "number" && Number.isFinite(override.classifier.timeoutMs) && override.classifier.timeoutMs > 0) {
      next.classifier.timeoutMs = Math.floor(override.classifier.timeoutMs);
    } else if (override.classifier.timeoutMs !== undefined) {
      diagnostics.push(`Ignoring ${source}.classifier.timeoutMs: expected a positive number`);
    }
    if (typeof override.classifier.failClosed === "boolean") next.classifier.failClosed = override.classifier.failClosed;
    if (isObject(override.classifier.rules)) {
      next.classifier.rules = { ...next.classifier.rules };
      next.classifier.rules.allow = asStringArray(override.classifier.rules.allow, `${source}.classifier.rules.allow`, diagnostics) ?? next.classifier.rules.allow;
      next.classifier.rules.soft_deny = asStringArray(override.classifier.rules.soft_deny, `${source}.classifier.rules.soft_deny`, diagnostics) ?? next.classifier.rules.soft_deny;
      next.classifier.rules.hard_deny = asStringArray(override.classifier.rules.hard_deny, `${source}.classifier.rules.hard_deny`, diagnostics) ?? next.classifier.rules.hard_deny;
      next.classifier.rules.environment = asStringArray(override.classifier.rules.environment, `${source}.classifier.rules.environment`, diagnostics) ?? next.classifier.rules.environment;
    }
  }

  if (isObject(override.seatbelt)) next.seatbelt = { ...next.seatbelt, ...override.seatbelt };
  if (isObject(override.container)) next.container = { ...next.container, ...override.container };

  return next;
}

export function loadConfig(ctx: ExtensionContext): ResolvedGuardConfig {
  const diagnostics: string[] = [];
  let config: ResolvedGuardConfig = structuredClone(DEFAULT_CONFIG);
  config.diagnostics = [];
  config.sources = ["defaults"];

  const globalPath = path.join(getAgentDir(), "extensions", "guard.json");
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
