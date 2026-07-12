import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedGuardConfig } from "../config.ts";
import type { GuardBackend, WrappedCommand } from "./types.ts";

export class NoneBackend implements GuardBackend {
  name = "none";

  async supported(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async initialize(_config: ResolvedGuardConfig, _ctx: ExtensionContext): Promise<void> {
    // Explicit no-op backend, useful for disabled/development flows.
  }

  async wrapBash(command: string, cwd: string, env: Record<string, string>): Promise<WrappedCommand> {
    return { command: "bash", args: ["-c", command], cwd, env };
  }

  describeEffectivePolicy(): undefined {
    return undefined;
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
