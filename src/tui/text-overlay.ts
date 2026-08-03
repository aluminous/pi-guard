import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Keybindings } from "./select-list.ts";

/** Minimal structural slice of pi-tui's TUI needed by the viewer. */
export interface OverlayTui {
  terminal: { rows: number };
  requestRender(): void;
}

/** Structural theme slice: fg for chrome, bold for the line styler. */
export interface OverlayTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

const PAGE_STEP = 10;

interface TextOverlayParams {
  tui: OverlayTui;
  theme: OverlayTheme;
  keybindings: Keybindings;
  /** Produces the current content lines; re-invoked on every refresh. */
  lines(): string[];
  /** Styles a single content line for display. */
  styleLine(line: string, theme: OverlayTheme): string;
  /** Pin request (Tab): the opener should unfocus the overlay so typing reaches the editor again. */
  onPin(): void;
  done(value: undefined): void;
}

/**
 * Scrollable read-only text overlay used by the guard status and policy
 * popups. Stays open while the agent works; content refreshes live via
 * refresh() (called by updateGuardStatus and a 1s timer for age labels).
 * Esc closes, Tab pins (unfocuses so the editor gets input back), arrows and
 * page keys scroll.
 */
export class TextOverlayViewer extends Container {
  /** Focusable: set by the TUI when overlay focus changes. */
  focused = false;

  private params: TextOverlayParams;
  private body = new Container();
  private scroll = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(params: TextOverlayParams) {
    super();
    this.params = params;
    this.addChild(this.body);
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  refresh(): void {
    const theme = this.params.theme;
    const lines = this.params.lines();
    // Headroom accounts for the overlay's margin/anchor chrome; too little and
    // the footer line renders off-screen on tall content (seen at 40 rows with
    // the policy view during TUI integration testing).
    const maxVisible = Math.max(8, this.params.tui.terminal.rows - 12);
    const maxScroll = Math.max(0, lines.length - maxVisible);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    this.body.clear();
    for (const line of lines.slice(this.scroll, this.scroll + maxVisible)) {
      this.body.addChild(new Text(this.params.styleLine(line, theme), 0, 0));
    }
    const footer: string[] = [];
    if (maxScroll > 0) footer.push(`${this.scroll + 1}-${Math.min(lines.length, this.scroll + maxVisible)}/${lines.length} · ↑↓ scroll`);
    footer.push(this.focused ? "Esc closes · Tab pins" : "pinned · reopen the command to close");
    this.body.addChild(new Text(theme.fg("muted", footer.join(" · ")), 0, 0));
    this.params.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.params.keybindings.matches(data, "tui.select.up")) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.down")) {
      this.scroll += 1;
      this.refresh();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - PAGE_STEP);
      this.refresh();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scroll += PAGE_STEP;
      this.refresh();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.params.onPin();
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
    }
  }
}
