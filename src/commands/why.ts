// /guard why: map Seatbelt denials from the most recent guarded bash command
// back to the guard rules that caused them, via the unified log (see
// sandbox-log.ts for the validated predicate and parsing).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.ts";
import { showGuardView } from "../live-view.ts";
import { attributeDenials, defaultLogRunner, formatGuardWhy, parseSandboxDenials, type LogRunner } from "../sandbox-log.ts";
import type { RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

/** Margin around the command's execution window: the kernel timestamps can straddle the recorded bounds. */
const WINDOW_MARGIN_MS = 2_000;

export interface GuardWhyDeps {
  state: RuntimeState;
  logRunner?: LogRunner;
}

export function createGuardWhy(deps: GuardWhyDeps) {
  const { state } = deps;
  const runner = deps.logRunner ?? defaultLogRunner;

  return async function runGuardWhy(ctx: ExtensionContext): Promise<void> {
    const command = state.lastBashCommand;
    if (!command) {
      const message = "No guarded bash command has run this session; run the failing command first, then /guard why.";
      if (!ctx.hasUI) console.log(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    if (state.backend && state.backend.name !== "seatbelt") {
      ctx.ui.notify(`/guard why reads macOS Seatbelt denials; the active backend is ${state.backend.name}.`, "warning");
      return;
    }
    ctx.ui.notify("Querying the unified log for sandbox denials (this can take a few seconds)...", "info");
    let raw: string;
    try {
      raw = await runner({
        start: new Date(command.startedAt - WINDOW_MARGIN_MS),
        end: new Date((command.endedAt ?? Date.now()) + WINDOW_MARGIN_MS),
      });
    } catch (error) {
      ctx.ui.notify(`Unified log query failed: ${formatError(error)}`, "error");
      return;
    }
    const config = state.config ?? loadConfig(ctx);
    const attributions = attributeDenials(config, ctx.cwd, parseSandboxDenials(raw));
    const report = formatGuardWhy({ command, attributions });
    showGuardView(ctx, state, "report", () => report.split("\n"));
  };
}
