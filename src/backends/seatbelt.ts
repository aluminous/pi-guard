import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ResolvedGuardConfig } from "../config.ts";
import { existingRealPath, expandHome } from "../paths.ts";
import { asStringArray, unique } from "../util.ts";
import type { EffectivePolicy, GuardBackend, WrappedCommand } from "./types.ts";

type SandboxManagerApi = typeof import("@anthropic-ai/sandbox-runtime")["SandboxManager"];

let sandboxManagerPromise: Promise<SandboxManagerApi> | undefined;

async function getSandboxManager(): Promise<SandboxManagerApi> {
  sandboxManagerPromise ??= import("@anthropic-ai/sandbox-runtime").then((module) => module.SandboxManager);
  return sandboxManagerPromise;
}

const SYSTEM_READ_ALLOWLIST = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/System",
  "/Library",
  "/dev",
  "/etc",
  "/private/etc",
  "/opt/homebrew",
  "/usr/local",
  "/nix/store",
];

const XCODE_SELECT_READ_ALLOWLIST = [
  "/var/select",
  "/private/var/select",
  "/var/db/xcode_select_link",
  "/private/var/db/xcode_select_link",
  "/usr/share/xcode-select",
];

function gitAndGhReadAllowlist(): string[] {
  const home = os.homedir();
  return unique([
    "/etc/gitconfig",
    "/private/etc/gitconfig",
    "~/.gitconfig",
    existingRealPath(path.join(home, ".gitconfig")),
    "~/.config/git",
    existingRealPath(path.join(home, ".config", "git")),
    "~/.config/gh",
    existingRealPath(path.join(home, ".config", "gh")),
  ]);
}

function tempReadWriteAllowlist(): string[] {
  return unique(["/tmp", "/private/tmp", os.tmpdir(), existingRealPath(os.tmpdir())]);
}

function normalizeSandboxPath(filePath: string, cwd: string): string {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function normalizeSandboxPaths(filePaths: string[], cwd: string): string[] {
  return unique(filePaths.map((filePath) => normalizeSandboxPath(filePath, cwd)));
}

export function getSeatbeltRuntimeConfig(config: ResolvedGuardConfig, cwd = process.cwd()): SandboxRuntimeConfig {
  const tempPaths = tempReadWriteAllowlist();
  const allowRead = config.filesystem.allowRead.length === 0
    ? []
    : normalizeSandboxPaths([...config.filesystem.allowRead, ...SYSTEM_READ_ALLOWLIST, ...XCODE_SELECT_READ_ALLOWLIST, ...gitAndGhReadAllowlist(), ...tempPaths], cwd);
  const allowWrite = normalizeSandboxPaths([...config.filesystem.allowWrite, ...tempPaths], cwd);
  const denyRead = normalizeSandboxPaths(config.filesystem.denyRead, cwd);
  const denyWrite = normalizeSandboxPaths(config.filesystem.denyWrite, cwd);

  return {
    network: {
      allowedDomains: config.network.enabled ? config.network.allowedDomains : [],
      deniedDomains: config.network.enabled ? config.network.deniedDomains : ["*"],
    },
    filesystem: {
      allowRead,
      denyRead,
      allowWrite,
      denyWrite,
    },
    credentials: {
      files: denyRead.map((filePath) => ({ path: filePath, mode: "deny" as const })),
      envVars: config.environment.unset
        .filter((name) => !name.includes("*"))
        .map((name) => ({ name, mode: "deny" as const })),
    },
    ...(config.seatbelt as Partial<SandboxRuntimeConfig>),
  } as SandboxRuntimeConfig;
}

export class SeatbeltBackend implements GuardBackend {
  name = "seatbelt";
  private initialized = false;
  private manager: SandboxManagerApi | undefined;

  async supported(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (process.platform !== "darwin") {
      return { ok: false, reason: `Pi Guarding is only supported on macOS; current platform is ${process.platform}` };
    }
    let manager: SandboxManagerApi;
    try {
      manager = await getSandboxManager();
    } catch (error) {
      return {
        ok: false,
        reason: `Missing @anthropic-ai/sandbox-runtime. Run npm install in the Pi Guard extension directory. (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (!manager.isSupportedPlatform()) {
      return { ok: false, reason: "@anthropic-ai/sandbox-runtime reports that this platform is unsupported" };
    }
    this.manager = manager;
    return { ok: true };
  }

  async initialize(config: ResolvedGuardConfig, _ctx: ExtensionContext): Promise<void> {
    const support = await this.supported();
    if (!support.ok) throw new Error(support.reason);
    const manager = this.manager ?? (await getSandboxManager());
    await manager.initialize(getSeatbeltRuntimeConfig(config, _ctx.cwd));
    this.manager = manager;
    this.initialized = true;
  }

  async wrapBash(command: string, cwd: string, env: Record<string, string>): Promise<WrappedCommand> {
    if (!this.initialized || !this.manager) throw new Error("Seatbelt backend is not initialized");
    const wrapped = await this.manager.wrapWithSandboxArgv(command, "bash");
    const merged: Record<string, string> = { ...env };
    for (const [key, value] of Object.entries(wrapped.env ?? {})) {
      if (typeof value === "string") merged[key] = value;
    }
    return {
      command: wrapped.argv[0] ?? "bash",
      args: wrapped.argv.slice(1),
      cwd,
      env: merged,
    };
  }

  describeEffectivePolicy(config: ResolvedGuardConfig): EffectivePolicy {
    const runtime = getSeatbeltRuntimeConfig(config);
    const filesystem = (runtime.filesystem ?? {}) as Record<string, unknown>;
    const network = (runtime.network ?? {}) as Record<string, unknown>;
    return {
      filesystem: {
        allowRead: asStringArray(filesystem.allowRead, config.filesystem.allowRead),
        denyRead: asStringArray(filesystem.denyRead, config.filesystem.denyRead),
        allowWrite: asStringArray(filesystem.allowWrite, config.filesystem.allowWrite),
        denyWrite: asStringArray(filesystem.denyWrite, config.filesystem.denyWrite),
      },
      network: {
        allowedDomains: asStringArray(network.allowedDomains, config.network.enabled ? config.network.allowedDomains : []),
      },
    };
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || !this.manager) return;
    this.initialized = false;
    await this.manager.reset();
  }
}
