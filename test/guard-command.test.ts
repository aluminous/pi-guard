import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGuardCommand } from "../src/commands/guard.ts";
import { createRuntimeState } from "../src/state.ts";

function makeCommand(specs: string[] = []) {
  const state = createRuntimeState();
  state.availableModelSpecs = specs;
  return createGuardCommand({
    pi: {} as ExtensionAPI,
    state,
    enableGuard: async () => {},
    disableGuard: async () => {},
    runGuardSmoke: async () => {},
    runCritique: async () => {},
  });
}

describe("guard argument completions", () => {
  it("lists all subcommands for an empty prefix", () => {
    const items = makeCommand().getArgumentCompletions("");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), ["status", "on", "off", "off session", "model", "smoke", "critique"]);
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
});
