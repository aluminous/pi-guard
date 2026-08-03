import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { GuardViewKind, RuntimeState } from "./state.ts";
import { styleGuardLine } from "./status.ts";
import { TextOverlayViewer } from "./tui/text-overlay.ts";

type OverlayHandleSlice = { unfocus(): void };

/**
 * TUI presentation: a floating overlay popup over the chat. Never blocks the
 * agent; refreshes live from updateGuardStatus.
 */
function openOverlay(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  let viewer: TextOverlayViewer | undefined;
  let handle: OverlayHandleSlice | undefined;
  let doneFn: ((value: undefined) => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doneFn?.(undefined);
  };
  const entry = { kind, refresh: () => viewer?.refresh(), close };
  state.liveView = entry;

  ctx.ui
    .custom<undefined>(
      (tui, theme, keybindings, done) => {
        doneFn = done;
        if (closed) {
          done(undefined);
          return new Text("", 0, 0);
        }
        viewer = new TextOverlayViewer({
          tui,
          theme,
          keybindings,
          lines,
          styleLine: styleGuardLine,
          onPin: () => handle?.unfocus(),
          done,
        });
        return viewer;
      },
      {
        overlay: true,
        overlayOptions: { anchor: "top-right", width: "55%", minWidth: 48, margin: 1 },
        onHandle: (overlayHandle) => {
          handle = overlayHandle;
        },
      },
    )
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
  const entry = {
    kind,
    refresh: () => {
      try {
        ctx.ui.setWidget(key, lines());
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
  if (ctx.mode === "tui" && ctx.hasUI) return openOverlay(ctx, state, kind, lines);
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
