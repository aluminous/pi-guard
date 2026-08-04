import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Keybindings } from "./select-list.ts";

/** Minimal structural slice of pi-tui's TUI needed by the panel. */
export interface PanelTui {
  terminal: { rows: number };
  requestRender(): void;
}

/** Structural theme slice: fg for chrome and borders, bold for the line styler. */
export interface PanelTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

const PAGE_STEP = 10;

interface ReportPanelParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  /** Produces the current content lines; re-invoked on every refresh. */
  lines(): string[];
  /** Styles a single content line for display. */
  styleLine(line: string, theme: PanelTheme): string;
  done(value: undefined): void;
}

/**
 * Bordered read-only report panel for the guard status and policy views,
 * docked in the editor area like pi's model chooser (non-overlay custom UI):
 * DynamicBorder rules top and bottom to match the native dialog style. The
 * agent keeps streaming above it; content refreshes live via refresh()
 * (updateGuardStatus plus a 1s timer for age labels). Esc closes; arrows and
 * page keys scroll.
 */
export class GuardReportPanel extends Container {
  /** Focusable: set by the TUI when focus changes. */
  focused = false;

  private params: ReportPanelParams;
  private body = new Container();
  private scroll = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(params: ReportPanelParams) {
    super();
    this.params = params;
    // jiti caveat: pi's DynamicBorder default color reads a global theme that
    // extensions may not share — always pass the explicit color function.
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.body);
    this.addChild(border());
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  refresh(): void {
    const theme = this.params.theme;
    const lines = this.params.lines();
    const maxVisible = Math.max(8, this.params.tui.terminal.rows - 12);
    const maxScroll = Math.max(0, lines.length - maxVisible);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    this.body.clear();
    for (const line of lines.slice(this.scroll, this.scroll + maxVisible)) {
      this.body.addChild(new Text(this.params.styleLine(line, theme), 0, 0));
    }
    const footer: string[] = [];
    if (maxScroll > 0) footer.push(`${this.scroll + 1}-${Math.min(lines.length, this.scroll + maxVisible)}/${lines.length} · ↑↓ scroll`);
    footer.push("Esc closes");
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
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
    }
  }
}
