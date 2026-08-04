import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { GuardViewKind, RuntimeState } from "./state.ts";
import { styleGuardLine } from "./status.ts";
import { GuardReportPanel } from "./tui/report-panel.ts";

/**
 * TUI presentation: a bordered panel docked in the editor area, exactly like
 * pi's model chooser (non-overlay custom UI). The agent keeps streaming above
 * it and content refreshes live from updateGuardStatus; typing resumes when
 * it closes.
 */
function openPanel(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  let panel: GuardReportPanel | undefined;
  let doneFn: ((value: undefined) => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doneFn?.(undefined);
  };
  const entry = { kind, refresh: () => panel?.refresh(), close };
  state.liveView = entry;

  ctx.ui
    .custom<undefined>((tui, theme, keybindings, done) => {
      doneFn = done;
      if (closed) {
        done(undefined);
        return new Text("", 0, 0);
      }
      panel = new GuardReportPanel({ tui, theme, keybindings, lines, styleLine: styleGuardLine, done });
      return panel;
    })
    .finally(() => {
      closed = true;
      if (state.liveView === entry) state.liveView = undefined;
    })
    .catch(() => undefined);
}

/**
 * RPC presentation: the same report as a live widget above the editor via the
 * fire-and-forget setWidget extension-UI request. Re-setting the key updates
 * it in place (updateGuardStatus drives refreshes; age labels only tick on
 * events since there is no client-side timer); clearing the key closes it.
 */
function openWidget(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  const key = `guard-${kind}`;
  // refresh() fires on every guard event while the view is open; skip the
  // protocol round-trip when content is unchanged (also collapses the
  // open-then-updateGuardStatus double send into one setWidget).
  let lastSent: string | undefined;
  const entry = {
    kind,
    refresh: () => {
      try {
        const next = lines();
        const joined = next.join("\n");
        if (joined === lastSent) return;
        lastSent = joined;
        ctx.ui.setWidget(key, next);
      } catch {
        // Widget updates are cosmetic; never let a stale UI context break a guard event.
      }
    },
    close: () => {
      try {
        ctx.ui.setWidget(key, undefined);
      } catch {
        // Same: closing a widget after the session UI is gone is a no-op.
      }
      if (state.liveView === entry) state.liveView = undefined;
    },
  };
  state.liveView = entry;
  entry.refresh();
}

/**
 * Shows a guard report, replacing any open view: an overlay popup in the TUI,
 * a live widget over RPC. This is the ONLY output path for guard reports —
 * they are never posted into the conversation, because pi delivers custom
 * messages to the LLM as user messages and guard reports map the guard's
 * rules, approvals, and guidance for a possibly compromised agent. The agent
 * only ever sees tool-call block reasons. Headless modes have no user to
 * show a view to (or to invoke these commands); that is an error, not a
 * fallback path.
 */
export function showGuardView(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  state.liveView?.close();
  if (ctx.mode === "tui" && ctx.hasUI) return openPanel(ctx, state, kind, lines);
  if (ctx.hasUI) return openWidget(ctx, state, kind, lines);
  console.error("Guard views require an interactive session (TUI or RPC).");
}

/** Toggle variant for the recurring status/policy views: the same kind closes, anything else shows. */
export function toggleGuardView(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  if (state.liveView?.kind === kind) {
    state.liveView.close();
    return;
  }
  showGuardView(ctx, state, kind, lines);
}
