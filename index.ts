import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { NoneBackend } from "./src/backends/none.ts";
import { SeatbeltBackend } from "./src/backends/seatbelt.ts";
import type { GuardBackend } from "./src/backends/types.ts";
import { createCritiqueRunner } from "./src/commands/critique.ts";
import { createGuardCommand } from "./src/commands/guard.ts";
import { createGuardSmoke } from "./src/commands/smoke.ts";
import { loadConfig, type ResolvedGuardConfig } from "./src/config.ts";
import { interceptToolCall } from "./src/interceptor.ts";
import { createRuntimeState, resetSessionState, resetTurnStats } from "./src/state.ts";
import { registerGuardMessageRenderer, updateGuardStatus } from "./src/status.ts";
import { createGuardedBashOps } from "./src/tools/bash.ts";
import { formatError } from "./src/util.ts";

function makeBackend(config: ResolvedGuardConfig): GuardBackend {
  if (config.backend === "seatbelt") return new SeatbeltBackend();
  if (config.backend === "none") return new NoneBackend();
  throw new Error("The container backend is planned but not implemented yet");
}

export default function (pi: ExtensionAPI) {
  registerGuardMessageRenderer(pi);

  pi.registerFlag("no-guard", {
    description: "Disable the Pi Guard extension and run bash unguarded",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const localBashOps = createLocalBashOperations();
  const state = createRuntimeState();

  function guardedOps() {
    if (!state.backend || !state.config) return undefined;
    return createGuardedBashOps({
      backend: state.backend,
      config: state.config,
      enabled: () => state.enabled,
      initialized: () => state.initialized,
      lastError: () => state.lastError,
    });
  }

  async function enableGuard(ctx: ExtensionContext): Promise<void> {
    const config = state.config ?? loadConfig(ctx);
    config.enabled = true;
    state.config = config;
    if (state.enabled && state.initialized) return;
    state.enabled = true;
    state.disabledForNextAgent = false;
    state.lastError = undefined;
    if (state.initialized && state.backend) {
      updateGuardStatus(ctx, state);
      return;
    }
    state.backend = makeBackend(config);
    const support = await state.backend.supported();
    if (!support.ok) throw new Error(support.reason);
    await state.backend.initialize(config, ctx);
    state.initialized = true;
    updateGuardStatus(ctx, state);
  }

  async function disableGuard(ctx: ExtensionContext, scope: "next-agent" | "session" = "next-agent"): Promise<void> {
    state.enabled = false;
    state.disabledForNextAgent = scope === "next-agent";
    updateGuardStatus(ctx, state);
  }

  pi.registerTool({
    ...localBash,
    label: "bash (Pi Guard)",
    async execute(id, params, signal, onUpdate) {
      const ops = guardedOps();
      if (!ops || !state.enabled) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(localCwd, { operations: ops });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (!state.enabled) return { operations: localBashOps };
    const ops = guardedOps();
    if (!ops) return { operations: localBashOps };
    return { operations: ops };
  });

  pi.on("tool_call", (event, ctx) => {
    return interceptToolCall(event, ctx, state);
  });

  pi.on("turn_start", (_event, ctx) => {
    resetTurnStats(state);
    updateGuardStatus(ctx, state);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateGuardStatus(ctx, state);
  });

  pi.on("session_start", async (_event, ctx) => {
    resetSessionState(state);

    const disabledByFlag = pi.getFlag("no-guard") as boolean;
    const config = loadConfig(ctx);
    state.config = config;
    state.warnings.push(...config.diagnostics);
    state.availableModelSpecs = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);

    for (const warning of state.warnings) ctx.ui.notify(warning, "warning");

    if (disabledByFlag) {
      state.enabled = false;
      state.disabledForNextAgent = false;
      state.backend = new NoneBackend();
      updateGuardStatus(ctx, state);
      ctx.ui.notify("Pi Guard disabled by --no-guard; bash will run unguarded.", "warning");
      return;
    }

    if (!config.enabled) {
      state.enabled = false;
      state.disabledForNextAgent = false;
      state.backend = new NoneBackend();
      updateGuardStatus(ctx, state);
      ctx.ui.notify("Guard disabled by config; bash will run unguarded.", "info");
      return;
    }

    try {
      await enableGuard(ctx);
      ctx.ui.notify(`Guard initialized with ${state.backend?.name ?? config.backend} backend.`, "info");
    } catch (error) {
      state.initialized = false;
      state.lastError = formatError(error);
      updateGuardStatus(ctx, state);
      ctx.ui.notify(`Guard initialization failed; bash will be blocked: ${state.lastError}`, "error");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.disabledForNextAgent) return;
    state.disabledForNextAgent = false;
    if (!state.config?.enabled) return;
    try {
      await enableGuard(ctx);
      ctx.ui.notify("Pi Guard re-enabled after one unguarded turn.", "info");
    } catch (error) {
      state.enabled = false;
      state.initialized = false;
      state.lastError = formatError(error);
      updateGuardStatus(ctx, state);
      ctx.ui.notify(`Could not re-enable Pi Guard: ${state.lastError}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.backend && state.initialized) {
      try {
        await state.backend.shutdown();
      } catch (error) {
        ctx.ui.notify(`Guard shutdown warning: ${formatError(error)}`, "warning");
      }
    }
    state.initialized = false;
    ctx.ui.setStatus("guard", undefined);
  });

  const runGuardSmoke = createGuardSmoke({ pi, state, guardedOps });
  const runCritique = createCritiqueRunner({ pi, state });
  const guardCommand = createGuardCommand({ pi, state, enableGuard, disableGuard, runGuardSmoke, runCritique });

  pi.registerCommand("guard", {
    description: "Pi Guard control panel; or: status|on|off|off session|model|smoke|critique",
    getArgumentCompletions: guardCommand.getArgumentCompletions,
    handler: guardCommand.handler,
  });
}
