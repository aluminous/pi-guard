import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ResolvedGuardConfig } from "../config.ts";
import { scrubEnvironment } from "../policy.ts";
import type { GuardBackend } from "../backends/types.ts";

export function createGuardedBashOps(params: {
  backend: GuardBackend;
  config: ResolvedGuardConfig;
  enabled: () => boolean;
  initialized: () => boolean;
  lastError: () => string | undefined;
}): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (!params.enabled()) throw new Error("Guard is disabled");
      if (!params.initialized()) throw new Error(`Guard is not initialized${params.lastError() ? `: ${params.lastError()}` : ""}`);

      const scrubbedEnv = scrubEnvironment(env, params.config);
      const wrapped = await params.backend.wrapBash(command, cwd, scrubbedEnv);

      return new Promise((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killProcessGroup = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessGroup();
          }, timeout * 1000);
        }

        const onAbort = () => killProcessGroup();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}
