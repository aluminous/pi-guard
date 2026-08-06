import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitColumnWidths, layoutTable, renderTable, type TableColumn } from "../src/tui/table.ts";

/** Tags every styled segment so assertions can see which colour a line got. */
const theme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  bold: (text: string) => text,
};

const COLUMNS: TableColumn[] = [
  { header: "class" },
  { header: "hits", align: "right" },
  { header: "decided", align: "right" },
];

const ROWS = [
  ["read-project", "12", "3"],
  ["off-machine-effects", "4", "4"],
];

describe("column fitting", () => {
  it("sizes each column to the widest of its header and cells", () => {
    assert.deepEqual(fitColumnWidths(COLUMNS, ROWS, 80), ["off-machine-effects".length, 4, 7]);
  });

  it("takes width from the widest column first", () => {
    // Natural widths are 19/4/7 plus two gaps = 34; at 30 only the class column
    // is above its floor by enough to give back four columns.
    assert.deepEqual(fitColumnWidths(COLUMNS, ROWS, 30), [15, 4, 7]);
  });

  it("stops at the per-column floor rather than collapsing a table to nothing", () => {
    const widths = fitColumnWidths(COLUMNS, ROWS, 4);
    assert.deepEqual(widths, [3, 3, 3], "every column lands on the default floor");
  });

  it("never pads a naturally narrow column up to its declared minimum", () => {
    assert.deepEqual(fitColumnWidths([{ header: "ms", align: "right", min: 6 }], [["12"]], 80), [2]);
  });
});

describe("table layout", () => {
  it("left-justifies text and right-justifies numbers on an exact grid", () => {
    const { header, lines } = layoutTable(COLUMNS, ROWS, 80);
    assert.equal(header, "class                hits  decided");
    assert.deepEqual(lines, [
      "read-project           12        3",
      "off-machine-effects     4        4",
    ]);
    // The column starts line up: same offsets in the header and in every row.
    for (const line of [header, ...lines]) {
      assert.equal(line.indexOf("  ") >= 0 || line.length === header.length, true);
    }
    assert.equal(lines[0]!.indexOf("12"), header.indexOf("hits") + 2);
  });

  it("truncates an overlong cell with an ellipsis instead of breaking the grid", () => {
    const { header, lines } = layoutTable(COLUMNS, ROWS, 30);
    assert.equal(lines[1], "off-machine-ef…     4        4");
    assert.equal(lines[1]!.length, 30);
    assert.equal(header.indexOf("decided"), lines[1]!.lastIndexOf("4") - 6, "the last column still lines up under its header");
  });

  it("drops trailing padding so lines carry no invisible tail", () => {
    const { lines } = layoutTable([{ header: "a" }, { header: "b" }], [["x", "yyy"], ["x", "y"]], 40);
    assert.deepEqual(lines, ["x  yyy", "x  y"]);
  });
});

describe("rendered tables", () => {
  it("mutes the header, indents the block, and leaves rows unstyled", () => {
    const lines = renderTable(theme, COLUMNS, ROWS, 80);
    assert.equal(lines[0], "  <muted>class                hits  decided</muted>");
    assert.equal(lines[1], "  read-project           12        3");
  });

  it("takes the indent out of the render width", () => {
    const wide = renderTable(theme, COLUMNS, ROWS, 40, { indent: "" });
    const indented = renderTable(theme, COLUMNS, ROWS, 40, { indent: "        " });
    assert.ok(!wide[2]!.includes("…"), "34 columns of table fit in 40");
    assert.ok(indented[2]!.includes("…"), "the same table indented by 8 does not");
  });

  it("styles a row through styleRow without disturbing alignment", () => {
    const lines = renderTable(theme, COLUMNS, ROWS, 80, {
      styleRow: (line, row) => (row[0] === "off-machine-effects" ? `<error>${line}</error>` : line),
    });
    assert.equal(lines[2], "  <error>off-machine-effects     4        4</error>");
  });

  it("wraps a row note under its row", () => {
    const lines = renderTable(theme, [{ header: "tool" }], [["bash"]], 30, {
      rowNote: () => "the reason this action was escalated to the judge",
    });
    assert.deepEqual(lines.slice(1), [
      "  bash",
      "    <muted>the reason this action was</muted>",
      "    <muted>escalated to the judge</muted>",
    ]);
  });

  it("says so when there is nothing to show", () => {
    assert.deepEqual(renderTable(theme, COLUMNS, [], 80, { empty: "(none yet)" }), ["  <muted>(none yet)</muted>"]);
  });
});
