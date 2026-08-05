import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { CapabilityId } from "../capabilities.ts";
import { dispositionCell, type DispositionRow } from "../dispositions.ts";
import type { PanelTheme, PanelTui } from "./report-panel.ts";
import type { Keybindings } from "./select-list.ts";

// Two clear columns: the longest class id is 20 wide, so 22 keeps a gutter.
const ID_WIDTH = 22;
const DISPOSITION_WIDTH = 16;

export interface DispositionPageParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  /** Current rows, re-read on every refresh so live stats and preset changes land. */
  rows(): DispositionRow[];
  /** Cycles one row's disposition at session scope; the page re-reads rows() after. */
  cycle(id: CapabilityId, step: 1 | -1): void;
  /** Ctrl+S: persists the session overrides and notifies. */
  save(): void;
  /** One-line note about an active session preset, when there is one. */
  banner(): string | undefined;
  done(value: undefined): void;
}

/**
 * The disposition settings page: THE policy surface. One row per capability
 * class with its disposition and this session's hit stats, docked in the
 * editor area like the other guard views (DynamicBorder chrome, non-overlay
 * custom UI, agent streaming above).
 *
 * Every edit applies immediately at session scope — that is the point of the
 * page, since classes like local-destructive are meant to be re-scoped per
 * session. Rows moved off their persisted value are coloured; Ctrl+S persists
 * them (and the colour clears), Esc just closes and leaves the session
 * overrides in force.
 */
export class DispositionPage extends Container {
  /** Focusable: set by the TUI when focus changes. */
  focused = false;

  private params: DispositionPageParams;
  private body = new Container();
  private selected = 0;

  constructor(params: DispositionPageParams) {
    super();
    this.params = params;
    // jiti caveat: pi's DynamicBorder default color reads a global theme that
    // extensions may not share — always pass the explicit color function.
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.body);
    this.addChild(border());
    this.refresh();
  }

  /** The highlighted class, for callers driving the page (tests, key handling). */
  selectedId(): CapabilityId | undefined {
    return this.params.rows()[this.selected]?.id;
  }

  refresh(): void {
    const theme = this.params.theme;
    const rows = this.params.rows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    this.body.clear();
    this.body.addChild(new Text(theme.fg("accent", theme.bold("Capability dispositions")), 0, 0));
    const banner = this.params.banner();
    if (banner) this.body.addChild(new Text(theme.fg("warning", `  ${banner}`), 0, 0));

    const maxVisible = Math.max(4, this.params.tui.terminal.rows - 12);
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), rows.length - maxVisible));
    const end = Math.min(start + maxVisible, rows.length);
    for (let i = start; i < end; i++) {
      const row = rows[i];
      if (!row) continue;
      this.body.addChild(new Text(this.renderRow(row, i === this.selected), 0, 0));
    }
    if (start > 0 || end < rows.length) {
      this.body.addChild(new Text(theme.fg("muted", `  (${this.selected + 1}/${rows.length})`), 0, 0));
    }

    const current = rows[this.selected];
    if (current) this.body.addChild(new Text(theme.fg("muted", `  ${current.definition}`), 0, 0));
    this.body.addChild(new Text(theme.fg("muted", "  ↑↓ row · ←→/Enter cycle (applies to this session) · Ctrl+S saves · Esc closes"), 0, 0));
    this.params.tui.requestRender();
  }

  /**
   * Selection colours the class id, modification colours the disposition cell:
   * two different segments, so a modified row stays visibly modified while it
   * is highlighted.
   */
  private renderRow(row: DispositionRow, selected: boolean): string {
    const theme = this.params.theme;
    const prefix = selected ? theme.fg("accent", "→ ") : "  ";
    const id = row.id.padEnd(ID_WIDTH);
    const cell = dispositionCell(row).padEnd(DISPOSITION_WIDTH);
    return [
      prefix,
      selected ? theme.fg("accent", id) : id,
      row.modified ? theme.fg("warning", cell) : cell,
      row.statsLabel ? theme.fg("muted", row.statsLabel) : "",
    ].join("");
  }

  handleInput(data: string): void {
    const rows = this.params.rows();
    if (this.params.keybindings.matches(data, "tui.select.up")) {
      if (rows.length === 0) return;
      this.selected = this.selected === 0 ? rows.length - 1 : this.selected - 1;
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.down")) {
      if (rows.length === 0) return;
      this.selected = this.selected === rows.length - 1 ? 0 : this.selected + 1;
      this.refresh();
      return;
    }
    if (matchesKey(data, "left")) return this.cycle(-1);
    if (matchesKey(data, "right")) return this.cycle(1);
    if (this.params.keybindings.matches(data, "tui.select.confirm")) return this.cycle(1);
    if (matchesKey(data, "ctrl+s")) {
      this.params.save();
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
    }
  }

  private cycle(step: 1 | -1): void {
    const row = this.params.rows()[this.selected];
    if (!row) return;
    this.params.cycle(row.id, step);
    this.refresh();
  }
}
