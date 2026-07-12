import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedGuardConfig } from "../config.ts";

export interface WrappedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  diagnostics?: string[];
}

/** The policy a backend actually enforces after it expands and augments the configured one. */
export interface EffectivePolicy {
  filesystem: {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
  };
}

export interface GuardBackend {
  name: string;
  supported(): Promise<{ ok: true } | { ok: false; reason: string }>;
  initialize(config: ResolvedGuardConfig, ctx: ExtensionContext): Promise<void>;
  wrapBash(command: string, cwd: string, env: Record<string, string>): Promise<WrappedCommand>;
  /** Returns the expanded policy this backend enforces, or undefined if it enforces nothing beyond the config. */
  describeEffectivePolicy(config: ResolvedGuardConfig): EffectivePolicy | undefined;
  shutdown(): Promise<void>;
}
