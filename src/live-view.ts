import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { GuardViewKind, RuntimeState } from "./state.ts";
import { styleGuardLine } from "./status.ts";
import { TextOverlayViewer } from "./tui/text-overlay.ts";

type OverlayHandleSlice = { unfocus(): void };

/**
 * Toggles the guard overlay popup for the given view. A second call with the
 * same kind closes it; a different kind replaces the content source. The
 * overlay never blocks the agent — it floats over the chat and refreshes
 * live from updateGuardStatus. TUI only; RPC uses toggleGuardWidget.
 */
export function toggleGuardOverlay(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  if (state.liveView?.kind === kind) {
    state.liveView.close();
    return;
  }
  state.liveView?.close();

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
 * RPC analog of toggleGuardOverlay: renders the same report as a live widget
 * above the editor via the fire-and-forget setWidget extension-UI request.
 * Re-setting the key updates it in place (updateGuardStatus drives refreshes,
 * so decisions stream in live; age labels only tick on events since there is
 * no client-side timer); clearing the key closes it. Toggle semantics match
 * the overlay: same kind closes, different kind replaces.
 */
export function toggleGuardWidget(ctx: ExtensionContext, state: RuntimeState, kind: GuardViewKind, lines: () => string[]): void {
  if (state.liveView?.kind === kind) {
    state.liveView.close();
    return;
  }
  state.liveView?.close();

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
