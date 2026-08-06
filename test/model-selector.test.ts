// The two-tab reviewer model dialog: Tab cycles namer ⇄ judge, each tab picks
// for its own target, and the RPC degradation turns the other tab into a
// "Switch to …" row because there is no Tab key over the wire. Driven through
// the structural Theme/Keybindings seams, like the disposition-page tests.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { selectClassifierModel, type ClassifierModelChoice } from "../src/model-selector.ts";
import { SearchableSelectList, type CustomUiHost, type Keybindings, type Theme } from "../src/tui/select-list.ts";

/** The selector only reads provider/id/name, so the registry entries are structural. */
const model = (provider: string, id: string, name?: string) => ({ provider, id, name }) as unknown as Model<Api>;

const sessionModel = model("anthropic", "claude-opus-4-5", "Claude Opus 4.5");
const codexMini = model("openai-codex", "gpt-5.4-mini");
const strong = model("openai", "gpt-5.4");
const models = [codexMini, strong];

/** Accent is the only styling the tests read, so it is the only one marked. */
const theme: Theme = { fg: (name, text) => (name === "accent" ? `«${text}»` : text) };

const TAB = "\t";
const ENTER = "\r";
const DOWN = "<down>";

const keybindings: Keybindings = {
  matches: (data, id) =>
    (id === "tui.input.tab" && data === TAB) ||
    (id === "tui.select.confirm" && data === ENTER) ||
    (id === "tui.select.down" && data === DOWN) ||
    (id === "tui.select.cancel" && data === "\x1b"),
};

type Panel = SearchableSelectList<ClassifierModelChoice>;

function tuiHost() {
  let panel: Panel | undefined;
  const host = {
    mode: "tui",
    ui: {
      custom: (factory: (tui: unknown, theme: Theme, keybindings: Keybindings, done: (value: unknown) => void) => unknown) =>
        new Promise<unknown>((resolve) => {
          panel = factory(null, theme, keybindings, resolve) as Panel;
        }),
      select: async () => undefined,
    },
  } as unknown as CustomUiHost;
  return { host, panel: () => panel! };
}

/** RPC host: answers are matched against the offered labels by substring; undefined cancels. */
function rpcHost(answers: Array<string | undefined>) {
  const asked: Array<{ title: string; labels: string[] }> = [];
  let next = 0;
  const host = {
    mode: "rpc",
    ui: {
      custom: async () => undefined,
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const want = answers[next++];
        return want === undefined ? undefined : labels.find((label) => label.includes(want));
      },
    },
  } as unknown as CustomUiHost;
  return { host, asked };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Opens the dialog with the defaults the command passes: namer auto, judge current. */
function open(host: CustomUiHost) {
  return selectClassifierModel({
    ctx: host,
    models,
    currentModel: sessionModel,
    autoModel: codexMini,
    namer: { spec: "auto", resolved: codexMini },
    judge: { spec: "current", resolved: sessionModel },
  });
}

/** Rendered rows, trimmed — list entries are the ones that trim to just a label. */
function lines(panel: Panel): string[] {
  return panel.render(200).map((line) => line.trim());
}

describe("reviewer model dialog tabs", () => {
  it("opens on the namer tab with the namer specials", async () => {
    const tui = tuiHost();
    void open(tui.host);
    await settled();
    const panel = tui.panel();

    assert.equal(panel.activeTab(), "namer");
    const rendered = lines(panel);
    assert.ok(rendered.includes("Tab: «namer» | judge"), "the active tab is accented");
    assert.ok(rendered.includes("off"), "the namer can be turned off");
    assert.ok(rendered.some((line) => line.includes("«auto»")), "auto leads the namer list and starts selected");
  });

  it("shows both targets' configured spec and resolved model in the header", async () => {
    const tui = tuiHost();
    void open(tui.host);
    await settled();
    const rendered = lines(tui.panel());

    assert.ok(rendered.includes("namer: auto → openai-codex/gpt-5.4-mini"));
    assert.ok(rendered.includes("judge: current → anthropic/claude-opus-4-5"));
  });

  it("cycles to the judge tab on Tab, and back again", async () => {
    const tui = tuiHost();
    void open(tui.host);
    await settled();
    const panel = tui.panel();

    panel.handleInput(TAB);
    assert.equal(panel.activeTab(), "judge");
    const judge = lines(panel);
    assert.ok(judge.includes("Tab: namer | «judge»"));
    assert.ok(judge.some((line) => line.includes("The judge cannot be turned off")));
    assert.ok(!judge.includes("off"), "no off row: the judge cannot be disabled");
    assert.ok(!judge.includes("auto"), "no auto row: that is the namer's cheap-model list");

    panel.handleInput(TAB);
    assert.equal(panel.activeTab(), "namer");
    assert.ok(lines(panel).includes("off"));
  });

  it("marks each tab's current choice against its own spec", async () => {
    const tui = tuiHost();
    void selectClassifierModel({
      ctx: tui.host,
      models,
      currentModel: sessionModel,
      autoModel: codexMini,
      namer: { spec: "openai-codex/gpt-5.4-mini", resolved: codexMini },
      judge: { spec: "openai/gpt-5.4", resolved: strong },
    });
    await settled();
    const panel = tui.panel();

    const namerChecked = lines(panel).find((line) => line.endsWith("✓"));
    assert.match(namerChecked ?? "", /openai-codex\/gpt-5\.4-mini/);

    panel.handleInput(TAB);
    const judgeChecked = lines(panel).find((line) => line.endsWith("✓"));
    assert.match(judgeChecked ?? "", /openai\/gpt-5\.4/);
    assert.doesNotMatch(judgeChecked ?? "", /mini/, "the namer's choice is not marked on the judge tab");
  });

  it("drops the search query when the tab changes", async () => {
    const tui = tuiHost();
    void open(tui.host);
    await settled();
    const panel = tui.panel();

    panel.handleInput("mini");
    assert.ok(!lines(panel).includes("off"), "the query narrowed the namer list");

    // Round-trip to the judge tab and back: the namer list is whole again.
    panel.handleInput(TAB);
    panel.handleInput(TAB);
    assert.ok(lines(panel).includes("off"), "the query is dropped when the tab changes");
  });
});

describe("reviewer model dialog selection", () => {
  it("returns a namer choice from the namer tab", async () => {
    const tui = tuiHost();
    const picked = open(tui.host);
    await settled();
    tui.panel().handleInput(ENTER);

    assert.deepEqual(await picked, { target: "namer", value: "auto" });
  });

  it("returns a judge choice from the judge tab", async () => {
    const tui = tuiHost();
    const picked = open(tui.host);
    await settled();
    const panel = tui.panel();
    panel.handleInput(TAB);
    panel.handleInput(ENTER);

    assert.deepEqual(await picked, { target: "judge", value: "current", model: sessionModel });
  });

  it("returns an explicit model tagged with the tab it was picked on", async () => {
    const tui = tuiHost();
    const picked = open(tui.host);
    await settled();
    const panel = tui.panel();
    panel.handleInput(TAB);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);

    assert.deepEqual(await picked, { target: "judge", value: "model", model: codexMini });
  });

  it("cancels to undefined", async () => {
    const tui = tuiHost();
    const picked = open(tui.host);
    await settled();
    tui.panel().handleInput("\x1b");

    assert.equal(await picked, undefined);
  });
});

describe("reviewer model dialog over RPC", () => {
  it("offers the other tab as a switch row and re-opens on it", async () => {
    const rpc = rpcHost(["Switch to judge", "openai/gpt-5.4"]);
    const picked = await open(rpc.host);

    assert.equal(rpc.asked.length, 2);
    assert.equal(rpc.asked[0]!.labels.at(-1), "Switch to judge…");
    assert.ok(rpc.asked[0]!.labels.includes("off"), "the namer tab still offers off");
    assert.equal(rpc.asked[1]!.labels.at(-1), "Switch to namer…");
    assert.ok(!rpc.asked[1]!.labels.includes("off"));
    assert.match(rpc.asked[1]!.title, /The judge cannot be turned off/);
    assert.deepEqual(picked, { target: "judge", value: "model", model: strong });
  });

  it("tags the current choice per tab, since check marks are TUI-only", async () => {
    const rpc = rpcHost(["Switch to judge", undefined]);
    await open(rpc.host);

    assert.ok(rpc.asked[0]!.labels.includes("auto (current)"), "namer spec is auto");
    assert.ok(rpc.asked[1]!.labels.some((label) => label.startsWith("current (anthropic/claude-opus-4-5) (current)")));
  });

  it("carries both header summaries into the dialog title", async () => {
    const rpc = rpcHost([undefined]);
    await open(rpc.host);

    assert.match(rpc.asked[0]!.title, /namer: auto → openai-codex\/gpt-5\.4-mini/);
    assert.match(rpc.asked[0]!.title, /judge: current → anthropic\/claude-opus-4-5/);
  });

  it("cancels to undefined without asking again", async () => {
    const rpc = rpcHost([undefined]);
    assert.equal(await open(rpc.host), undefined);
    assert.equal(rpc.asked.length, 1);
  });
});
