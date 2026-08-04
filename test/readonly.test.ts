// Read-only mode tests: deterministic write/edit blocks, bash fail-closed
// behavior when the classifier cannot review, the restrictive ruleset
// threaded into classifier review, and the /guard readonly toggle.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { READONLY_CLASSIFIER_RULES } from "../src/classifier-rules.ts";
import { reviewToolCall, type CompleteFn } from "../src/classifier.ts";
import { createGuardCommand } from "../src/commands/guard.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import { createRuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());

const DEFAULT_DENY_RULE = "deny every action not explicitly described by an allow rule";

/** Minimal fake ExtensionContext: deterministic interceptor paths plus optional classifier model/auth wiring. */
function fakeCtx(cwd: string, options?: { model?: { provider: string; id: string }; authError?: Error }) {
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    aborted: false,
    notifications: [] as string[],
    abort() {
      ctx.aborted = true;
    },
    ui: {
      notify(message: string) {
        ctx.notifications.push(message);
      },
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () => options?.model,
      getApiKeyAndHeaders: async () => {
        if (options?.authError) throw options.authError;
        return { ok: true, apiKey: "test-key" };
      },
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return ctx as unknown as ExtensionContext & { aborted: boolean; notifications: string[] };
}

function readOnlyState(config: ReturnType<typeof testConfig>) {
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  state.readOnly = true;
  return state;
}

describe("read-only mode interception", () => {
  mkdirSync(path.join(fixture.dir, "project", "src"), { recursive: true });
  writeFileSync(path.join(fixture.dir, "project", "src", "app.ts"), "ok");
  const cwd = path.join(fixture.dir, "project");

  it("blocks write deterministically", async () => {
    const state = readOnlyState(testConfig());
    const result = await interceptToolCall({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
    assert.equal(state.stats.blocked, 1);
  });

  it("blocks edit deterministically", async () => {
    const state = readOnlyState(testConfig());
    const result = await interceptToolCall({ toolName: "edit", input: { path: "src/app.ts", edits: [] } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
  });

  it("leaves reads unaffected: exempt in-cwd reads still skip review", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = true;
    }));
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.classifierSkips, 1);
  });

  it("leaves reads unaffected with the classifier off", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
    }));
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.blocked, 0);
  });

  it("blocks bash outright when the classifier is disabled", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
    }));
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
    assert.match(result.reason, /classifier/);
    assert.equal(state.stats.blocked, 1);
  });

  it("sends bash to review when the classifier is on, failing closed when it is unavailable", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = true;
    }));
    const ctx = fakeCtx(cwd);
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, ctx, state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /classifier unavailable/i);
    assert.equal(ctx.aborted, true);
  });

  it("fails closed for bash review errors even when failClosed is off", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
      c.classifier.failClosed = false;
    });
    const options = { model: { provider: "test", id: "fake-model" }, authError: new Error("boom") };

    // Without read-only mode this configuration fails open.
    const openState = readOnlyState(structuredClone(config));
    openState.readOnly = false;
    const openResult = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, fakeCtx(cwd, options), openState);
    assert.equal(openResult, undefined);

    const state = readOnlyState(config);
    const ctx = fakeCtx(cwd, options);
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, ctx, state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /failed closed/);
    assert.equal(ctx.aborted, true);
  });
});

describe("read-only classifier rules threading", () => {
  const model = { provider: "test", id: "fake-model" } as Model<Api>;

  function makeCompleteFn(script: string[]) {
    const calls: Array<{ text: string }> = [];
    const complete: CompleteFn = (async (_model: unknown, context: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
      const text = context.messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
      calls.push({ text });
      const step = script.shift();
      if (step === undefined) throw new Error("fake complete script exhausted");
      return {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: step }],
        usage: { input: 1, output: 1 },
        timestamp: Date.now(),
      } as unknown as Awaited<ReturnType<CompleteFn>>;
    }) as CompleteFn;
    return { complete, calls };
  }

  function reviewConfig() {
    return testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
    });
  }

  it("replaces the config rules with the read-only ruleset when overridden", async () => {
    const { complete, calls } = makeCompleteFn(['{"triviallySafe":true,"reason":"read-only"}']);
    const result = await reviewToolCall({
      ctx: fakeCtx("/repo", { model }),
      config: reviewConfig(),
      state: {},
      toolName: "bash",
      input: { command: "git status" },
      rulesOverride: READONLY_CLASSIFIER_RULES,
      completeFn: complete,
    });
    assert.equal(result.decision, "allow");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.text.includes(DEFAULT_DENY_RULE), "review payload must carry the read-only default-deny rule");
    assert.ok(!calls[0]!.text.includes("Toolchain Bootstrap"), "config rules must be replaced, not merged");
  });

  it("keeps the config rules without an override", async () => {
    const { complete, calls } = makeCompleteFn(['{"triviallySafe":true,"reason":"routine"}']);
    await reviewToolCall({
      ctx: fakeCtx("/repo", { model }),
      config: reviewConfig(),
      state: {},
      toolName: "bash",
      input: { command: "git status" },
      completeFn: complete,
    });
    assert.ok(!calls[0]!.text.includes(DEFAULT_DENY_RULE));
    assert.ok(calls[0]!.text.includes("Toolchain Bootstrap"));
  });
});

describe("/guard readonly toggle", () => {
  function makeCommand() {
    const state = createRuntimeState();
    const command = createGuardCommand({
      state,
      enableGuard: async () => {},
      disableGuard: async () => {},
      runGuardSmoke: async () => {},
      runCritique: async () => {},
    });
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      notifications: [] as string[],
      ui: {
        notify(message: string) {
          ctx.notifications.push(message);
        },
        setStatus() {},
        theme: { fg: (_name: string, text: string) => text },
      },
    };
    return { state, command, ctx: ctx as unknown as ExtensionContext & { notifications: string[] } };
  }

  it("toggles read-only mode on and off, including the ro alias", async () => {
    const { state, command, ctx } = makeCommand();
    await command.handler("readonly", ctx);
    assert.equal(state.readOnly, true);
    assert.match(ctx.notifications[0] ?? "", /read-only mode on/);
    await command.handler("ro", ctx);
    assert.equal(state.readOnly, false);
    assert.match(ctx.notifications[1] ?? "", /read-only mode off/);
  });
});
