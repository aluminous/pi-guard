import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTO_CLASSIFIER_PREFERENCES, resolveAutoClassifierModel } from "../src/classifier-models.ts";
import { resolveClassifierModel } from "../src/classifier.ts";
import { testConfig } from "./helpers.ts";

const codexMini = { provider: "openai-codex", id: "gpt-5.4-mini" };
const copilotMini = { provider: "github-copilot", id: "gpt-5-mini" };
const openrouterMini = { provider: "openrouter", id: "openai/gpt-5-mini" };
const openrouterDeepseek = { provider: "openrouter", id: "deepseek/deepseek-v4-flash" };
const unknownModel = { provider: "ollama", id: "llama3" };

function fakeCtx(available: Array<{ provider: string; id: string }>, current?: { provider: string; id: string }): ExtensionContext {
  return {
    model: current,
    modelRegistry: {
      getAvailable: () => available,
      find: () => undefined,
    },
  } as unknown as ExtensionContext;
}

describe("resolveAutoClassifierModel", () => {
  it("prefers subscription providers over openrouter", () => {
    const picked = resolveAutoClassifierModel([openrouterMini, codexMini, openrouterDeepseek]);
    assert.deepEqual(picked, codexMini);
  });

  it("prefers copilot over openrouter when codex is absent", () => {
    const picked = resolveAutoClassifierModel([openrouterDeepseek, copilotMini]);
    assert.deepEqual(picked, copilotMini);
  });

  it("follows within-provider eval ordering on openrouter", () => {
    const picked = resolveAutoClassifierModel([openrouterDeepseek, openrouterMini]);
    assert.deepEqual(picked, openrouterMini);
  });

  it("returns undefined when nothing known-good is available", () => {
    assert.equal(resolveAutoClassifierModel([unknownModel]), undefined);
    assert.equal(resolveAutoClassifierModel([]), undefined);
  });

  it("keeps subscription providers at the top of the preference list", () => {
    const providers = AUTO_CLASSIFIER_PREFERENCES.map((p) => p.provider);
    const firstMetered = providers.findIndex((p) => p !== "openai-codex" && p !== "github-copilot");
    assert.ok(firstMetered > 0, "subscription entries must come first");
    assert.ok(!providers.slice(0, firstMetered).some((p) => p === "openrouter"));
  });
});

describe("resolveClassifierModel auto spec", () => {
  it("resolves auto through the preference list", () => {
    const model = resolveClassifierModel(fakeCtx([openrouterDeepseek, codexMini]), testConfig(), {});
    assert.deepEqual(model, codexMini);
  });

  it("is the default: config resolves auto without overrides", () => {
    const config = testConfig();
    assert.equal(config.classifier.model, "auto");
    const model = resolveClassifierModel(fakeCtx([openrouterMini]), config, {});
    assert.deepEqual(model, openrouterMini);
  });

  it("falls back to the current session model when no preference matches", () => {
    const current = { provider: "ollama", id: "llama3" };
    const model = resolveClassifierModel(fakeCtx([unknownModel], current), testConfig(), {});
    assert.deepEqual(model, current);
  });

  it("returns undefined when nothing matches and no current model exists", () => {
    assert.equal(resolveClassifierModel(fakeCtx([]), testConfig(), {}), undefined);
  });

  it("still honors an explicit model override ahead of auto", () => {
    const ctx = fakeCtx([codexMini]);
    (ctx.modelRegistry as unknown as { find: (p: string, i: string) => unknown }).find = (p: string, i: string) =>
      p === "openrouter" && i === "openai/gpt-5.4-mini" ? openrouterMini : undefined;
    const model = resolveClassifierModel(ctx, testConfig(), { modelOverride: "openrouter/openai/gpt-5.4-mini" });
    assert.deepEqual(model, openrouterMini);
  });
});
