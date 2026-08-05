import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordCapabilityHits, recordCapabilityOutcome, type CapabilityId, type Disposition } from "../src/capabilities.ts";
import { globalGuardConfigPath, mergeConfig, type ResolvedGuardConfig } from "../src/config.ts";
import {
  cycleDisposition,
  describeDispositionSource,
  dispositionRow,
  dispositionRows,
  dispositionSummary,
  presetBanner,
  saveDispositions,
  setRowDisposition,
} from "../src/dispositions.ts";
import { createRuntimeState, syncCapabilityPreset, type RuntimeState } from "../src/state.ts";
import { DispositionPage } from "../src/tui/disposition-page.ts";
import { testConfig } from "./helpers.ts";

/** Tags every styled segment so assertions can see which colour a row segment got. */
const theme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  bold: (text: string) => text,
};

const tui = { terminal: { rows: 40 }, requestRender: () => {} };

/** Sentinel strings for the select keybinding ids; arrows and ctrl+s go through the real matchesKey. */
const keybindings = {
  matches(keyData: string, keyId: string): boolean {
    return (
      (keyId === "tui.select.up" && keyData === "<up>") ||
      (keyId === "tui.select.down" && keyData === "<down>") ||
      (keyId === "tui.select.confirm" && keyData === "<enter>") ||
      (keyId === "tui.select.cancel" && keyData === "<esc>")
    );
  },
};

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_S = "\x13";

function openPage(state: RuntimeState, config: ResolvedGuardConfig) {
  const persisted: Array<[CapabilityId, Disposition | undefined]> = [];
  const closes: undefined[] = [];
  const page = new DispositionPage({
    tui,
    theme,
    keybindings,
    rows: () => dispositionRows(config, state),
    cycle: (id, step) => setRowDisposition(config, state, id, cycleDisposition(dispositionRow(config, state, id).value, step)),
    save: () => void saveDispositions(config, state, (id, disposition) => persisted.push([id, disposition])),
    banner: () => presetBanner(state),
    done: (value) => closes.push(value),
  });
  page.focused = true;
  const line = (id: string) => page.render(120).find((text) => text.includes(id)) ?? "";
  return { page, persisted, closes, line };
}

describe("disposition rows", () => {
  it("resolves value, persisted, and modified against the config", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "install-dependencies": "ask" } }, globalGuardConfigPath());
    const state = createRuntimeState();
    const before = dispositionRows(config, state);
    assert.equal(before.length, 12);
    assert.deepEqual(before.map((row) => row.id).slice(0, 3), ["read-project", "read-system", "run-dev-tools"]);
    assert.equal(before.find((row) => row.id === "install-dependencies")?.value, "ask");
    assert.equal(before.every((row) => !row.modified), true);

    setRowDisposition(config, state, "modify-project", "deny");
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "deny");
    assert.equal(row.persisted, "allow");
    assert.equal(row.modified, true);
    assert.equal(row.effective.scope, "session");
  });

  it("drops the override when a row lands back on its persisted value", () => {
    const config = testConfig();
    const state = createRuntimeState();
    setRowDisposition(config, state, "credentials", "deny");
    assert.deepEqual(state.capabilities.overrides, { credentials: "deny" });
    setRowDisposition(config, state, "credentials", "judge");
    assert.deepEqual(state.capabilities.overrides, {});
    assert.equal(dispositionRow(config, state, "credentials").modified, false);
  });

  it("cycles allow → judge → ask → deny and back around", () => {
    assert.equal(cycleDisposition("allow", 1), "judge");
    assert.equal(cycleDisposition("judge", 1), "ask");
    assert.equal(cycleDisposition("ask", 1), "deny");
    assert.equal(cycleDisposition("deny", 1), "allow");
    assert.equal(cycleDisposition("allow", -1), "deny");
  });

  it("summarizes this session's stats, omitting zero buckets", () => {
    const state = createRuntimeState();
    recordCapabilityHits(state.capabilities, ["off-machine-effects", "off-machine-effects", "off-machine-effects"]);
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "allow");
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "ask-approved");
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "judge-deny");
    const rows = dispositionRows(testConfig(), state);
    assert.equal(rows.find((row) => row.id === "off-machine-effects")?.statsLabel, "3 hits · 1 allowed · 1 asked · 1 denied");
    assert.equal(rows.find((row) => row.id === "read-project")?.statsLabel, "", "unseen classes show no stats");
  });

  it("marks preset-tightened rows without touching the row the user edits", () => {
    const config = testConfig();
    const state = createRuntimeState();
    state.readOnly = true;
    syncCapabilityPreset(state);
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "allow", "cycling still edits the underlying row");
    assert.equal(row.effective.disposition, "deny");
    assert.equal(row.presetTightened, true);
    assert.equal(dispositionSummary(row), "modify-project  allow → deny*");
    assert.match(presetBanner(state) ?? "", /^read-only preset active: modify\/destructive rows tightened to deny/);
    assert.equal(dispositionRow(config, state, "read-project").presetTightened, false);
  });

  it("names where a row came from", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "install-dependencies": "ask" } }, globalGuardConfigPath());
    const state = createRuntimeState();
    assert.equal(describeDispositionSource(dispositionRow(config, state, "read-project").effective), "built-in default");
    assert.equal(describeDispositionSource(dispositionRow(config, state, "install-dependencies").effective), "global config");
    setRowDisposition(config, state, "read-project", "deny");
    assert.equal(describeDispositionSource(dispositionRow(config, state, "read-project").effective), "this session");
    state.readOnly = true;
    syncCapabilityPreset(state);
    assert.equal(describeDispositionSource(dispositionRow(config, state, "modify-project").effective), "read-only preset");
  });
});

describe("saveDispositions", () => {
  it("persists every override, folds it into the config, and clears the session rows", () => {
    const config = testConfig();
    const state = createRuntimeState();
    setRowDisposition(config, state, "modify-project", "ask");
    setRowDisposition(config, state, "credentials", "deny");
    const written: Array<[CapabilityId, Disposition | undefined]> = [];
    const result = saveDispositions(config, state, (id, disposition) => written.push([id, disposition]));

    assert.deepEqual(written, [["modify-project", "ask"], ["credentials", "deny"]]);
    assert.deepEqual(result.saved, ["modify-project", "credentials"]);
    assert.deepEqual(result.shadowed, []);
    assert.deepEqual(state.capabilities.overrides, {}, "saved rows are no longer session overrides");
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "ask", "the effective value does not move on save");
    assert.equal(row.persisted, "ask");
    assert.equal(row.modified, false, "highlights clear once the value is persisted");
    assert.equal(config.provenance.dispositions["modify-project"], globalGuardConfigPath());
  });

  it("reports rows a project config will win back", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "network-fetch": "allow" } }, "/repo/.pi/guard.json");
    const state = createRuntimeState();
    setRowDisposition(config, state, "network-fetch", "deny");
    const result = saveDispositions(config, state, () => {});
    assert.deepEqual(result.saved, ["network-fetch"]);
    assert.deepEqual(result.shadowed, ["network-fetch"]);
  });

  it("is a no-op without session changes", () => {
    const config = testConfig();
    const state = createRuntimeState();
    const written: CapabilityId[] = [];
    const result = saveDispositions(config, state, (id) => written.push(id));
    assert.deepEqual(written, []);
    assert.deepEqual(result.saved, []);
  });
});

describe("DispositionPage", () => {
  it("renders one row per class with disposition and stats columns", () => {
    const state = createRuntimeState();
    recordCapabilityHits(state.capabilities, ["off-machine-effects"]);
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "ask-denied");
    const { page, line } = openPage(state, testConfig());
    const rendered = page.render(120);
    assert.equal(rendered.filter((text) => /(read-project|off-machine-effects|unclassified)/.test(text)).length, 3);
    assert.match(line("off-machine-effects"), /off-machine-effects\s+ask\s+<muted>1 hit · 1 asked<\/muted>/);
    assert.match(rendered.join("\n"), /↑↓ row · ←→\/Enter cycle/);
    assert.match(rendered.join("\n"), /Reading, listing, or searching files/, "the highlighted row's definition sits in the footer area");
  });

  it("moves the highlight with up and down, wrapping at the ends", () => {
    const { page, line } = openPage(createRuntimeState(), testConfig());
    assert.match(line("read-project"), /<accent>→ <\/accent>/);
    page.handleInput("<down>");
    assert.equal(page.selectedId(), "read-system");
    assert.match(line("read-system"), /<accent>→ <\/accent>/);
    assert.doesNotMatch(line("read-project"), /→/);
    page.handleInput("<up>");
    page.handleInput("<up>");
    assert.equal(page.selectedId(), "unclassified", "up from the first row wraps to the last");
  });

  it("cycles the highlighted row and applies it at session scope immediately", () => {
    const state = createRuntimeState();
    const config = testConfig();
    const { page } = openPage(state, config);
    page.handleInput(RIGHT);
    assert.deepEqual(state.capabilities.overrides, { "read-project": "judge" });
    page.handleInput("<enter>");
    assert.deepEqual(state.capabilities.overrides, { "read-project": "ask" });
    page.handleInput(LEFT);
    page.handleInput(LEFT);
    assert.deepEqual(state.capabilities.overrides, {}, "back on the persisted value the override is dropped");

    page.handleInput("<down>");
    page.handleInput(LEFT);
    assert.deepEqual(state.capabilities.overrides, { "read-system": "deny" });
  });

  it("colours modified rows and keeps that visible while the row is highlighted", () => {
    const state = createRuntimeState();
    const { page, line } = openPage(state, testConfig());
    assert.doesNotMatch(line("read-project"), /<warning>/);
    page.handleInput(RIGHT);
    const modified = line("read-project");
    assert.match(modified, /<warning>judge\s*<\/warning>/, "the disposition cell carries the modified colour");
    assert.match(modified, /<accent>read-project\s*<\/accent>/, "selection colours the id, so both stay visible");
    page.handleInput("<down>");
    assert.match(line("read-project"), /<warning>judge\s*<\/warning>/, "still modified once the highlight moves away");
  });

  it("Ctrl+S persists the overrides, clears them, and drops the highlight", () => {
    const state = createRuntimeState();
    const { page, persisted, line } = openPage(state, testConfig());
    page.handleInput(RIGHT);
    page.handleInput("<down>");
    page.handleInput(RIGHT);
    assert.deepEqual(state.capabilities.overrides, { "read-project": "judge", "read-system": "judge" });

    page.handleInput(CTRL_S);
    assert.deepEqual(persisted, [["read-project", "judge"], ["read-system", "judge"]]);
    assert.deepEqual(state.capabilities.overrides, {});
    assert.doesNotMatch(line("read-project"), /<warning>/);
    assert.match(line("read-project"), /read-project\s+judge/, "the saved value stays in effect");
  });

  it("Esc closes and leaves the session overrides in force", () => {
    const state = createRuntimeState();
    const { page, closes, persisted } = openPage(state, testConfig());
    page.handleInput(RIGHT);
    page.handleInput("<esc>");
    assert.deepEqual(closes, [undefined]);
    assert.deepEqual(persisted, [], "Esc is not a save");
    assert.deepEqual(state.capabilities.overrides, { "read-project": "judge" });
  });

  it("banners the read-only preset and marks the rows it tightens", () => {
    const state = createRuntimeState();
    state.readOnly = true;
    const { page, line } = openPage(state, testConfig());
    assert.match(page.render(120).join("\n"), /<warning>\s+read-only preset active: modify\/destructive rows tightened to deny \(marked \*\)<\/warning>/);
    assert.match(line("modify-project"), /allow → deny\*/);
    assert.doesNotMatch(line("read-project"), /\*/);

    // Cycling still edits the underlying row; the preset keeps winning.
    page.handleInput("<down>");
    page.handleInput("<down>");
    page.handleInput("<down>");
    assert.equal(page.selectedId(), "modify-project");
    page.handleInput(RIGHT);
    assert.match(line("modify-project"), /judge → deny\*/);
    assert.deepEqual(state.capabilities.overrides, { "modify-project": "judge" });
  });
});
