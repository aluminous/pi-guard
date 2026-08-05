import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ResolvedRailConfig } from "../config.ts";
import { existingRealPath } from "../paths.ts";
import { compileFilesystemPolicy, resolveConfigPath } from "../policy.ts";
import { asStringArray, formatError, unique } from "../util.ts";
import type { EffectivePolicy, RailBackend, WrappedCommand } from "./types.ts";

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

export function getSeatbeltRuntimeConfig(config: ResolvedRailConfig, cwd = process.cwd()): SandboxRuntimeConfig {
  // Config pattern lists arrive pre-resolved through the shared compiler; only
  // the seatbelt-specific system allowlists are resolved here.
  const compiled = compileFilesystemPolicy(config, cwd);
  const resolveAll = (filePaths: string[]) => filePaths.map((filePath) => resolveConfigPath(cwd, filePath));
  const tempPaths = resolveAll(tempReadWriteAllowlist());
  const allowRead = compiled.patterns.allowRead.length === 0
    ? []
    : unique([...compiled.sandboxPaths.allowRead, ...resolveAll([...SYSTEM_READ_ALLOWLIST, ...XCODE_SELECT_READ_ALLOWLIST, ...gitAndGhReadAllowlist()]), ...tempPaths]);
  const allowWrite = unique([...compiled.sandboxPaths.allowWrite, ...tempPaths]);
  const denyRead = compiled.sandboxPaths.denyRead;
  const denyWrite = compiled.sandboxPaths.denyWrite;

  const seatbelt = config.seatbelt as Partial<SandboxRuntimeConfig>;
  const network = {
    allowedDomains: config.network.allowedDomains,
    deniedDomains: config.network.deniedDomains,
    ...((seatbelt.network ?? {}) as Record<string, unknown>),
  } as Record<string, unknown>;
  if (!config.network.enabled) {
    // sandbox-runtime enables domain filtering by the presence of
    // allowedDomains. Omitting it leaves networking unrestricted, while an
    // explicitly empty array means deny all. Strip every other proxy-engaging
    // field as well so a seatbelt.network override cannot re-arm the proxy
    // while network sandboxing is disabled.
    delete network.allowedDomains;
    delete network.mitmProxy;
    delete network.tlsTerminate;
    delete network.filterRequest;
    delete network.parentProxy;
    network.deniedDomains = [];
    network.strictAllowlist = false;
    // sandbox-runtime starts its local proxy listeners at initialize() unless
    // both ports are declared external. Point them at the discard port so the
    // proxy is never set up at all. These ports never reach sandboxed
    // commands (proxy env injection is keyed off allowedDomains, which is
    // absent), and if a future version routes through them anyway the
    // connection fails fast instead of silently proxying.
    network.httpProxyPort = 9;
    network.socksProxyPort = 9;
  }

  const filesystem = {
    allowRead,
    denyRead,
    allowWrite,
    denyWrite,
    ...((seatbelt.filesystem ?? {}) as Record<string, unknown>),
    disabled: config.filesystem.enabled
      ? Boolean((seatbelt.filesystem as { disabled?: boolean } | undefined)?.disabled)
      : true,
  };

  const credentials = {
    files: denyRead.map((filePath) => ({ path: filePath, mode: "deny" as const })),
    envVars: config.environment.unset
      .filter((name) => !name.includes("*"))
      .map((name) => ({ name, mode: "deny" as const })),
    ...((seatbelt.credentials ?? {}) as Record<string, unknown>),
  };
  if (!config.filesystem.enabled) credentials.files = [];

  return {
    ...seatbelt,
    network,
    filesystem,
    credentials,
  } as SandboxRuntimeConfig;
}

export class SeatbeltBackend implements RailBackend {
  name = "seatbelt";
  private initialized = false;
  private manager: SandboxManagerApi | undefined;

  async supported(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (process.platform !== "darwin") {
      return { ok: false, reason: `Pi Rail is only supported on macOS; current platform is ${process.platform}` };
    }
    let manager: SandboxManagerApi;
    try {
      manager = await getSandboxManager();
    } catch (error) {
      return {
        ok: false,
        reason: `Missing @anthropic-ai/sandbox-runtime. Run npm install in the Pi Rail extension directory. (${formatError(error)})`,
      };
    }
    if (!manager.isSupportedPlatform()) {
      return { ok: false, reason: "@anthropic-ai/sandbox-runtime reports that this platform is unsupported" };
    }
    this.manager = manager;
    return { ok: true };
  }

  async initialize(config: ResolvedRailConfig, _ctx: ExtensionContext): Promise<void> {
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

  describeEffectivePolicy(config: ResolvedRailConfig): EffectivePolicy {
    const cwd = process.cwd();
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const filesystem = (runtime.filesystem ?? {}) as Record<string, unknown>;
    const network = (runtime.network ?? {}) as Record<string, unknown>;
    return {
      filesystem: {
        allowRead: config.filesystem.enabled ? asStringArray(filesystem.allowRead, config.filesystem.allowRead) : [],
        denyRead: config.filesystem.enabled ? asStringArray(filesystem.denyRead, config.filesystem.denyRead) : [],
        allowWrite: config.filesystem.enabled ? asStringArray(filesystem.allowWrite, config.filesystem.allowWrite) : [],
        denyWrite: config.filesystem.enabled ? asStringArray(filesystem.denyWrite, config.filesystem.denyWrite) : [],
        degraded: config.filesystem.enabled ? compileFilesystemPolicy(config, cwd).degraded : [],
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
