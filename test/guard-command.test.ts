import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_IDS, type CapabilityId, type Disposition } from "../src/capabilities.ts";
import { createGuardCommand } from "../src/commands/guard.ts";
import { setRowDisposition } from "../src/dispositions.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { DispositionPage } from "../src/tui/disposition-page.ts";
import { testConfig } from "./helpers.ts";

function makeCommand(specs: string[] = []) {
  const state = createRuntimeState();
  state.availableModelSpecs = specs;
  return createGuardCommand({
    state,
    enableGuard: async () => {},
    disableGuard: async () => {},
    runGuardSmoke: async () => {},
    runCritique: async () => {},
  });
}

/** A command wired to a preloaded config (never reads the user's real guard.json) and a persist spy. */
function makeDispositionCommand() {
  const state = createRuntimeState();
  state.config = testConfig();
  const persisted: Array<[CapabilityId, Disposition | undefined]> = [];
  const command = createGuardCommand({
    state,
    enableGuard: async () => {},
    disableGuard: async () => {},
    runGuardSmoke: async () => {},
    runCritique: async () => {},
    persistDisposition: (id, disposition) => persisted.push([id, disposition]),
  });
  return { command, state, persisted };
}

interface FakeCtx {
  ctx: ExtensionContext;
  asked: Array<{ title: string; labels: string[] }>;
  notes: string[];
  widgets: Array<{ key: string; lines: string[] | undefined }>;
}

/** RPC-shaped context: select answers are matched against the offered labels by substring; undefined cancels. */
function rpcCtx(answers: Array<string | undefined> = []): FakeCtx {
  const asked: FakeCtx["asked"] = [];
  const notes: string[] = [];
  const widgets: FakeCtx["widgets"] = [];
  let next = 0;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: () => {},
      setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
      theme: { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const want = answers[next++];
        return want === undefined ? undefined : labels.find((label) => label.includes(want));
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, asked, notes, widgets };
}

/** TUI-shaped context that runs the custom-component factory and resolves when the panel closes. */
function tuiCtx() {
  const notes: string[] = [];
  let component: unknown;
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: () => {},
      theme: { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => unknown) =>
        new Promise<undefined>((resolve) => {
          component = factory(
            { terminal: { rows: 40 }, requestRender: () => {} },
            { fg: (_name: string, text: string) => text, bold: (text: string) => text },
            { matches: (keyData: string, keyId: string) => keyId === "tui.select.cancel" && keyData === "<esc>" },
            resolve,
          );
        }),
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, notes, panel: () => component };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

function overrides(state: RuntimeState) {
  return state.capabilities.overrides;
}

describe("guard argument completions", () => {
  it("lists all subcommands for an empty prefix", () => {
    const items = makeCommand().getArgumentCompletions("");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), ["status", "policy", "policy rules", "set", "explain", "test", "test read", "test write", "why", "on", "off", "off session", "readonly", "model", "smoke", "critique"]);
    assert.ok(items.every((i) => i.description));
  });

  it("narrows subcommands by prefix", () => {
    const items = makeCommand().getArgumentCompletions("of");
    assert.deepEqual(items?.map((i) => i.value), ["off", "off session"]);
  });

  it("completes model arguments with fixed specs first, full-args values", () => {
    const items = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]).getArgumentCompletions("model ");
    assert.ok(items);
    assert.deepEqual(items.slice(0, 4).map((i) => i.value), ["model auto", "model current", "model off", "model status"]);
    assert.ok(items.some((i) => i.value === "model openai/gpt-5-mini"));
  });

  it("filters model specs by partial text", () => {
    const items = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]).getArgumentCompletions("model haiku");
    assert.deepEqual(items?.map((i) => i.value), ["model anthropic/claude-haiku-4-5"]);
  });

  it("completes critique with model specs but no classifier keywords", () => {
    const items = makeCommand(["openai/gpt-5-mini"]).getArgumentCompletions("critique ");
    assert.deepEqual(items?.map((i) => i.value), ["critique openai/gpt-5-mini"]);
  });

  it("returns null when nothing matches", () => {
    assert.equal(makeCommand().getArgumentCompletions("bogus"), null);
    assert.equal(makeCommand([]).getArgumentCompletions("critique zzz"), null);
  });

  it("completes set with class ids, then with dispositions", () => {
    const { command } = makeDispositionCommand();
    const classes = command.getArgumentCompletions("set ");
    assert.deepEqual(classes?.map((item) => item.label), [...CAPABILITY_IDS]);
    assert.deepEqual(classes?.[0]?.value, "set read-project");
    assert.match(classes?.[0]?.description ?? "", /currently allow/);

    assert.deepEqual(command.getArgumentCompletions("set read-s")?.map((item) => item.value), ["set read-system"]);

    const dispositions = command.getArgumentCompletions("set credentials ");
    assert.deepEqual(dispositions?.map((item) => item.value), ["set credentials allow", "set credentials judge", "set credentials ask", "set credentials deny"]);
    assert.deepEqual(command.getArgumentCompletions("set credentials de")?.map((item) => item.label), ["deny"]);
    assert.equal(command.getArgumentCompletions("set credentials zz"), null);
    assert.equal(command.getArgumentCompletions("set zzz"), null);
  });
});

describe("/guard set", () => {
  it("applies a disposition at session scope", async () => {
    const { command, state, persisted } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set off-machine-effects deny", ctx);
    assert.deepEqual(overrides(state), { "off-machine-effects": "deny" });
    assert.deepEqual(persisted, [], "session scope writes nothing to disk");
    assert.match(notes.at(-1)!, /off-machine-effects → deny for this session\. \/guard policy then Ctrl\+S persists it\./);
  });

  it("reports the current value and its source when no disposition is given", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set credentials", ctx);
    assert.match(notes.at(-1)!, /^credentials: judge — built-in default$/);

    setRowDisposition(state.config, state, "credentials", "ask");
    await command.handler("set credentials", ctx);
    assert.match(notes.at(-1)!, /^credentials: ask — this session$/);

    state.readOnly = true;
    await command.handler("set modify-project", ctx);
    assert.match(notes.at(-1)!, /^modify-project: deny — read-only preset \(row says allow\)$/);
  });

  it("explains the preset when an edit cannot take effect yet", async () => {
    const { command } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("readonly", ctx);
    await command.handler("set modify-project allow", ctx);
    assert.match(notes.at(-1)!, /read-only preset still forces deny/);
  });

  it("rejects unknown classes, unknown dispositions, and extra words", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set nonsense deny", ctx);
    assert.match(notes.at(-1)!, /Unknown capability class: nonsense/);
    await command.handler("set credentials maybe", ctx);
    assert.match(notes.at(-1)!, /Unknown disposition: maybe/);
    await command.handler("set", ctx);
    assert.match(notes.at(-1)!, /Usage: \/guard set <class>/);
    await command.handler("set credentials deny please", ctx);
    assert.match(notes.at(-1)!, /Usage: \/guard set <class>/);
    assert.deepEqual(overrides(state), {});
  });
});

describe("/guard policy routing", () => {
  it("opens the interactive page in the TUI and toggles it closed", async () => {
    const { command, state } = makeDispositionCommand();
    const tui = tuiCtx();
    await command.handler("policy", tui.ctx);
    assert.equal(state.liveView?.kind, "policy", "the page registers as the live view so stats refresh");
    const page = tui.panel();
    assert.ok(page instanceof DispositionPage);
    page.handleInput("\x1b[C");
    assert.deepEqual(overrides(state), { "read-project": "judge" }, "the page edits the live session state");

    await command.handler("policy", tui.ctx);
    await settled();
    assert.equal(state.liveView, undefined, "a second /guard policy closes the page");
  });

  it("routes /guard policy rules to the mechanism report", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, widgets } = rpcCtx();
    await command.handler("policy rules", ctx);
    assert.equal(state.liveView?.kind, "policy");
    assert.equal(widgets.at(-1)?.key, "guard-policy");
    assert.match(widgets.at(-1)?.lines?.join("\n") ?? "", /# Pi Guard Policy Rules/);
    assert.doesNotMatch(widgets.at(-1)?.lines?.join("\n") ?? "", /## Capability dispositions/);
  });

  it("warns on an unknown policy argument", async () => {
    const { command } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("policy nonsense", ctx);
    assert.match(notes.at(-1)!, /Usage: \/guard policy \[rules\]/);
  });

  it("degrades to a select flow over RPC: pick a class, pick a disposition, repeat, save", async () => {
    const { command, state, persisted } = makeDispositionCommand();
    const { ctx, asked, notes } = rpcCtx(["off-machine-effects", "deny", "Save persistently", undefined]);
    await command.handler("policy", ctx);

    assert.equal(asked.length, 4);
    assert.match(asked[0]!.title, /Capability dispositions \(changes apply to this session\)/);
    assert.equal(asked[0]!.labels.length, 13, "twelve classes plus Save persistently");
    assert.match(asked[0]!.labels[0]!, /^read-project\s+allow$/);
    assert.equal(asked[0]!.labels.at(-1), "Save persistently");
    assert.match(asked[1]!.title, /off-machine-effects — currently ask/);
    assert.deepEqual(asked[1]!.labels, ["allow", "judge", "ask (current)", "deny"]);
    assert.match(asked[2]!.labels.find((label) => label.startsWith("off-machine-effects"))!, /off-machine-effects\s+deny\s+\(modified\)/);

    assert.deepEqual(persisted, [["off-machine-effects", "deny"]]);
    assert.deepEqual(overrides(state), {}, "saving clears the session overrides");
    assert.match(notes.join("\n"), /off-machine-effects → deny for this session\./);
    assert.match(notes.at(-1)!, /Dispositions saved: 1 row\./);
    assert.equal(state.liveView, undefined, "the select flow is not a live view");
  });

  it("is a stderr error when headless", async () => {
    const { command } = makeDispositionCommand();
    const ctx = { mode: "print", hasUI: false, isIdle: () => true, ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_n: string, t: string) => t } } } as unknown as ExtensionContext;
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      await command.handler("policy", ctx);
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /requires an interactive session/);
  });
});
