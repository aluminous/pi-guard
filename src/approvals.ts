import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./state.ts";
import { RailApprovalDialog, type RailApprovalAnswer } from "./tui/approval-dialog.ts";

export type { RailApprovalAnswer } from "./tui/approval-dialog.ts";

const OPTION_LABELS = ["Allow", "Allow with comment", "Deny", "Deny with comment"] as const;

/**
 * Asks the user to approve a rail-gated action, with optional comment.
 * In the TUI this is a single dialog with an inline comment input; over RPC it
 * degrades to a select (and an input when a comment option is chosen), which
 * the driving client answers via the extension-UI sub-protocol. Callers must
 * check ctx.hasUI first — without a UI this resolves to a plain deny.
 */
export async function askRailApproval(ctx: ExtensionContext, state: RuntimeState, title: string, message: string): Promise<RailApprovalAnswer> {
  if (ctx.mode === "tui" && ctx.hasUI) {
    // The status/policy panel and this dialog share the editor area; close the
    // panel first so the two non-overlay customs never fight over it.
    state.liveView?.close();
    const answer = await ctx.ui.custom<RailApprovalAnswer | undefined>(
      (_tui, theme, keybindings, done) => new RailApprovalDialog({ title, message, theme, keybindings, done }),
    );
    return answer ?? { approved: false };
  }
  const picked = await ctx.ui.select(`${title}\n\n${message}`, [...OPTION_LABELS]);
  if (picked === "Allow") return { approved: true };
  if (picked === "Allow with comment" || picked === "Deny with comment") {
    const comment = (await ctx.ui.input("Comment for the rail (kept as session guidance)"))?.trim();
    return { approved: picked === "Allow with comment", comment: comment || undefined };
  }
  return { approved: false };
}
