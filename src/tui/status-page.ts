import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey } from "@earendil-works/pi-tui";
import { STATUS_TABS, statusTabLines, type StatusTab, type StatusView } from "../status-tabs.ts";
import type { PanelTheme, PanelTui } from "./report-panel.ts";
import type { Keybindings } from "./select-list.ts";

const PAGE_STEP = 10;

/** Structural slice of pi-tui's Component, so the panel does not depend on the full type. */
interface Component {
  invalidate(): void;
  render(width: number): string[];
}

export interface StatusPageParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  /** Which tab to open on: `/rail status` lands on session, `/rail policy rules` on policy. */
  initialTab?: StatusTab;
  /**
   * The current view for a given render width, re-read on every render so the
   * page shows live state (and so the tables fit the actual terminal).
   */
  view(width: number, theme: PanelTheme): StatusView;
  done(value: undefined): void;
}

/**
 * The body is one width-aware component rather than a Text per line: the tables
 * only know how to fit themselves once the render width is known, and the
 * scroll window depends on how many lines that produced.
 */
class StatusBody implements Component {
  private page: StatusPage;

  constructor(page: StatusPage) {
    this.page = page;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.page.renderLines(width);
  }
}

/**
 * The rail status page: six tabs over one session's evidence — what the rail
 * decided, what the reviewers cost, what they said, how the engine is
 * configured, and the resolved mechanism policy. Docked in the editor area like
 * the other rail views (DynamicBorder chrome, non-overlay custom UI, agent
 * streaming above), refreshed live from updateRailStatus.
 *
 * Tab cycles tabs and ↑↓ scrolls the active one, matching the idiom the
 * disposition page established. Nothing here is ever posted into the
 * conversation.
 */
export class StatusPage extends Container {
  /** Focusable: set by the TUI when focus changes. */
  focused = false;

  private params: StatusPageParams;
  private tab: StatusTab;
  private scroll = 0;
  /** Age labels ("12s ago") only move with the clock, so the page ticks itself. */
  private timer: ReturnType<typeof setInterval>;

  constructor(params: StatusPageParams) {
    super();
    this.params = params;
    this.tab = params.initialTab ?? "session";
    // jiti caveat: pi's DynamicBorder default color reads a global theme that
    // extensions may not share — always pass the explicit color function.
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(new StatusBody(this));
    this.addChild(border());
    this.timer = setInterval(() => this.refresh(), 1000);
    // A page nobody closed must not be what keeps the process alive — pi owns
    // the event loop, and a test that opens the panel should still exit.
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  activeTab(): StatusTab {
    return this.tab;
  }

  /** Switches tabs from outside (`/rail policy rules` while the session tab is up). */
  selectTab(tab: StatusTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.scroll = 0;
    this.refresh();
  }

  refresh(): void {
    this.params.tui.requestRender();
  }

  /** `Tab: session | models | …` with the active word accent-coloured, like pi's model selector scope line. */
  private tabHeader(): string {
    const theme = this.params.theme;
    const names = STATUS_TABS.map((tab) => (tab === this.tab ? theme.fg("accent", tab) : theme.fg("muted", tab)));
    return `  ${theme.fg("muted", "Tab:")} ${names.join(theme.fg("muted", " | "))}`;
  }

  /** Title, tab header, the scrolled slice of the active tab, and the footer. */
  renderLines(width: number): string[] {
    const theme = this.params.theme;
    const content = statusTabLines(this.params.view(width, theme), this.tab);
    const maxVisible = Math.max(8, this.params.tui.terminal.rows - 13);
    const maxScroll = Math.max(0, content.length - maxVisible);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const footer: string[] = [];
    if (maxScroll > 0) footer.push(`${this.scroll + 1}-${Math.min(content.length, this.scroll + maxVisible)}/${content.length} · ↑↓ scroll`);
    footer.push("Tab switches tab");
    footer.push("Esc closes");
    return [
      theme.fg("accent", theme.bold("Rail status")),
      this.tabHeader(),
      ...content.slice(this.scroll, this.scroll + maxVisible),
      `  ${theme.fg("muted", footer.join(" · "))}`,
    ];
  }

  private step(direction: 1 | -1): void {
    const index = STATUS_TABS.indexOf(this.tab);
    this.tab = STATUS_TABS[(index + direction + STATUS_TABS.length) % STATUS_TABS.length]!;
    this.scroll = 0;
    this.refresh();
  }

  handleInput(data: string): void {
    const keybindings = this.params.keybindings;
    if (keybindings.matches(data, "tui.input.tab")) return this.step(1);
    if (matchesKey(data, "right")) return this.step(1);
    if (matchesKey(data, "left")) return this.step(-1);
    if (keybindings.matches(data, "tui.select.up")) {
      this.scroll = Math.max(0, this.scroll - 1);
      this.refresh();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
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
    if (keybindings.matches(data, "tui.select.cancel")) {
      // Stop ticking on the way out; pi calls dispose() too, and clearing an
      // already-cleared interval is a no-op.
      this.dispose();
      this.params.done(undefined);
    }
  }
}
