/**
 * The status page's one table renderer. Every tab is a stack of tables, so the
 * column fitting lives here and nowhere else: natural widths from the content,
 * then the widest column gives columns back one at a time until the table fits
 * the terminal, with an ellipsis where a cell had to be cut.
 *
 * Deliberately dumb: cells arrive as finished strings, the renderer only
 * measures, pads, and mutes the header. Colour beyond that is the caller's, via
 * styleRow, which runs on the assembled line so padding is already settled.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PanelTheme } from "./report-panel.ts";

export interface TableColumn {
  header: string;
  /** Numbers read right-justified; everything else left. */
  align?: "left" | "right";
  /** Floor for shrinking. Clamped to the column's natural width, so a narrow column is never padded up to it. */
  min?: number;
}

/** Two spaces between columns: one reads as a word break, three as separate tables. */
const GAP = "  ";
const ELLIPSIS = "…";
const DEFAULT_MIN = 3;

function naturalWidths(columns: TableColumn[], rows: string[][]): number[] {
  return columns.map((column, index) => {
    let widest = visibleWidth(column.header);
    for (const row of rows) widest = Math.max(widest, visibleWidth(row[index] ?? ""));
    return widest;
  });
}

/**
 * Column widths that fit `width` terminal columns. Shrinking always takes from
 * the currently widest column, so a long labels cell loses room before a tokens
 * cell does, and a table only becomes unreadable when every column is at its
 * floor (at which point it overflows and the terminal wraps, which beats
 * silently dropping columns).
 */
export function fitColumnWidths(columns: TableColumn[], rows: string[][], width: number): number[] {
  const widths = naturalWidths(columns, rows);
  const floors = widths.map((natural, index) => Math.min(natural, columns[index]?.min ?? DEFAULT_MIN));
  const gaps = GAP.length * Math.max(0, columns.length - 1);
  let total = widths.reduce((sum, value) => sum + value, gaps);
  while (total > width) {
    let target = -1;
    for (let index = 0; index < widths.length; index++) {
      if (widths[index]! <= floors[index]!) continue;
      if (target < 0 || widths[index]! > widths[target]!) target = index;
    }
    if (target < 0) break;
    widths[target]!--;
    total--;
  }
  return widths;
}

/**
 * Cells are plain data, so this cuts them itself rather than borrowing pi-tui's
 * ANSI-aware truncateToWidth — that one wraps its ellipsis in reset codes, and
 * these lines also go out as plain text over RPC.
 */
function truncateCell(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, width);
  let kept = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width - 1) break;
    kept += char;
    used += charWidth;
  }
  return kept + ELLIPSIS;
}

function padCell(text: string, width: number, align: TableColumn["align"]): string {
  const cell = truncateCell(text, width);
  const filler = " ".repeat(Math.max(0, width - visibleWidth(cell)));
  return align === "right" ? filler + cell : cell + filler;
}

function joinCells(cells: string[], widths: number[], columns: TableColumn[]): string {
  return columns
    .map((column, index) => padCell(cells[index] ?? "", widths[index] ?? 0, column.align))
    .join(GAP)
    .trimEnd();
}

/** The plain-text table: a header line and one line per row, both already padded. */
export function layoutTable(columns: TableColumn[], rows: string[][], width: number): { header: string; lines: string[] } {
  const widths = fitColumnWidths(columns, rows, width);
  return {
    header: joinCells(columns.map((column) => column.header), widths, columns),
    lines: rows.map((row) => joinCells(row, widths, columns)),
  };
}

export interface TableOptions {
  /** Left margin for the whole table, headers included. Defaults to the two-space body indent the panels use. */
  indent?: string;
  /** What to show instead of a table when there are no rows. */
  empty?: string;
  /** Styles one assembled row line; padding is already applied, so alignment survives. */
  styleRow?(line: string, row: string[], index: number): string;
  /** Prose belonging to a row (a judge's reason) — wrapped and muted on its own line underneath. */
  rowNote?(row: string[], index: number): string | undefined;
}

/**
 * The table as display lines: muted header, plain rows, optional per-row note
 * wrapped under its row. `width` is the full render width; the indent comes out
 * of it, so callers pass what the panel gave them.
 */
export function renderTable(theme: PanelTheme, columns: TableColumn[], rows: string[][], width: number, options?: TableOptions): string[] {
  const indent = options?.indent ?? "  ";
  const available = Math.max(8, width - indent.length);
  if (rows.length === 0) return [`${indent}${theme.fg("muted", options?.empty ?? "(none)")}`];
  const table = layoutTable(columns, rows, available);
  const noteIndent = `${indent}  `;
  const out = [`${indent}${theme.fg("muted", table.header)}`];
  table.lines.forEach((line, index) => {
    const row = rows[index]!;
    const styled = options?.styleRow?.(line, row, index) ?? line;
    out.push(`${indent}${styled}`);
    const note = options?.rowNote?.(row, index);
    if (!note) return;
    for (const wrapped of wrapTextWithAnsi(note, Math.max(8, width - noteIndent.length))) {
      out.push(`${noteIndent}${theme.fg("muted", wrapped)}`);
    }
  });
  return out;
}
