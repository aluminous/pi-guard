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
  // Decision telemetry lands in pi's own session log as custom entries
  // (user-approved feature: guard decision records via pi.appendEntry).
  state.appendEntry = (customType, data) => pi.appendEntry(customType, data);

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

  // Statusline convention: the statusline is a pure projection of RuntimeState.
  // Mutators (enableGuard, record* helpers, commands) never refresh it themselves;
  // instead every entry point — each event handler below and the /guard command
  // dispatch — ends with a single updateGuardStatus call, usually in a finally.
  async function enableGuard(ctx: ExtensionContext): Promise<void> {
    const config = state.config ?? loadConfig(ctx);
    config.enabled = true;
    state.config = config;
    if (state.enabled && state.initialized) return;
    state.enabled = true;
    state.disabledForNextAgent = false;
    state.lastError = undefined;
    if (state.initialized && state.backend) return;
    state.backend = makeBackend(config);
    const support = await state.backend.supported();
    if (!support.ok) throw new Error(support.reason);
    await state.backend.initialize(config, ctx);
    state.initialized = true;
  }

  async function disableGuard(_ctx: ExtensionContext, scope: "next-agent" | "session" = "next-agent"): Promise<void> {
    state.enabled = false;
    state.disabledForNextAgent = scope === "next-agent";
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

  pi.on("tool_call", async (event, ctx) => {
    try {
      return await interceptToolCall(event, ctx, state);
    } finally {
      updateGuardStatus(ctx, state);
    }
  });

  // turn_start/turn_end fire on every agent-loop iteration; per-turn stats span a whole user prompt, so reset on agent_start.
  pi.on("agent_start", (_event, ctx) => {
    resetTurnStats(state);
    updateGuardStatus(ctx, state);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateGuardStatus(ctx, state);
  });

  // The classifier label can show "current"/"auto", which resolve against the session model.
  pi.on("model_select", (_event, ctx) => {
    updateGuardStatus(ctx, state);
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
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
        ctx.ui.notify("Pi Guard disabled by --no-guard; bash will run unguarded.", "warning");
        return;
      }

      if (!config.enabled) {
        state.enabled = false;
        state.disabledForNextAgent = false;
        state.backend = new NoneBackend();
        ctx.ui.notify("Guard disabled by config; bash will run unguarded.", "info");
        return;
      }

      try {
        await enableGuard(ctx);
        ctx.ui.notify(`Guard initialized with ${state.backend?.name ?? config.backend} backend.`, "info");
      } catch (error) {
        state.initialized = false;
        state.lastError = formatError(error);
        ctx.ui.notify(`Guard initialization failed; bash will be blocked: ${state.lastError}`, "error");
      }
    } finally {
      updateGuardStatus(ctx, state);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
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
        ctx.ui.notify(`Could not re-enable Pi Guard: ${state.lastError}`, "error");
      }
    } finally {
      updateGuardStatus(ctx, state);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.liveView?.close();
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

  const runGuardSmoke = createGuardSmoke({ state, guardedOps });
  const runCritique = createCritiqueRunner({ state });
  const guardCommand = createGuardCommand({ state, enableGuard, disableGuard, runGuardSmoke, runCritique });

  pi.registerCommand("guard", {
    description: "Pi Guard control panel; or: status|on|off|off session|model|smoke|critique",
    getArgumentCompletions: guardCommand.getArgumentCompletions,
    handler: guardCommand.handler,
  });
}
