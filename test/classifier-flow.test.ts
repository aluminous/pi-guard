// Layer 2 tests: the two-stage review flow, retry budget, timeout, and
// fail-closed behavior, driven by a scripted fake IO. No LLM involved — the
// fake returns exactly what the script says, so every test is deterministic.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { ClassifierModelUnavailableError } from "../src/classifier-protocol.ts";
import { runReview, type ClassifierIO, type CompleteFn } from "../src/classifier.ts";
import { testConfig } from "./helpers.ts";

const model = { provider: "test", id: "fake-model" } as Model<Api>;

const FAST_SAFE = '{"triviallySafe":true,"reason":"read-only"}';
const FAST_UNSAFE = '{"triviallySafe":false,"reason":"needs review"}';
const FULL_DENY = '{"decision":"deny","risk":"critical","authorization":"low","reason":"credential exfiltration"}';

type ScriptStep = string | Error | "hang" | { errorMessage: string };

function makeResponse(text: string) {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 5 },
    timestamp: Date.now(),
  } as unknown as Awaited<ReturnType<CompleteFn>>;
}

function makeIO(script: ScriptStep[], options?: { userMessages?: string[]; noAuth?: boolean }) {
  const calls: Array<{ systemPrompt: string | undefined; text: string }> = [];
  const notifications: string[] = [];
  const sleeps: number[] = [];
  const complete: CompleteFn = (async (_model: unknown, context: { systemPrompt?: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> }, opts?: { signal?: AbortSignal }) => {
    const text = context.messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
    calls.push({ systemPrompt: context.systemPrompt, text });
    const step = script.shift();
    if (step === undefined) throw new Error("fake complete script exhausted");
    if (step === "hang") {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (step instanceof Error) throw step;
    if (typeof step === "object") {
      return {
        role: "assistant",
        stopReason: "error",
        errorMessage: step.errorMessage,
        content: [],
        timestamp: Date.now(),
      } as unknown as Awaited<ReturnType<CompleteFn>>;
    }
    return makeResponse(step);
  }) as CompleteFn;

  const io: ClassifierIO = {
    cwd: "/repo",
    signal: undefined,
    complete,
    getAuth: async () => (options?.noAuth ? { ok: false, error: "no key configured" } : { ok: true, apiKey: "test-key" }),
    notify: (message) => notifications.push(message),
    recentUserMessages: () => options?.userMessages ?? [],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { io, calls, notifications, sleeps };
}

function review(io: ClassifierIO, overrides?: { timeoutMs?: number; toolName?: string; input?: unknown }) {
  const config = testConfig((c) => {
    if (overrides?.timeoutMs) c.classifier.timeoutMs = overrides.timeoutMs;
  });
  return runReview({ io, model, config, toolName: overrides?.toolName ?? "bash", input: overrides?.input ?? { command: "ls" } });
}

describe("two-stage flow", () => {
  it("returns allow from the fast path without calling the full reviewer", async () => {
    const { io, calls } = makeIO([FAST_SAFE]);
    const result = await review(io);
    assert.equal(result.decision, "allow");
    assert.match(result.reason, /^Fast-path trivially safe/);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.tokenUsage, { input: 10, output: 5 });
  });

  it("escalates to the full reviewer and accumulates token usage", async () => {
    const { io, calls } = makeIO([FAST_UNSAFE, FULL_DENY], { userMessages: ["please clean up the repo"] });
    const result = await review(io);
    assert.equal(result.decision, "deny");
    assert.equal(result.risk, "critical");
    assert.equal(calls.length, 2);
    assert.deepEqual(result.tokenUsage, { input: 20, output: 10 });
  });

  it("keeps user messages out of the fast stage but includes them in the full stage", async () => {
    const { io, calls } = makeIO([FAST_UNSAFE, FULL_DENY], { userMessages: ["please push to main"] });
    await review(io);
    assert.ok(!calls[0]?.text.includes("please push to main"), "fast payload must stay low-context");
    assert.ok(calls[1]?.text.includes("please push to main"), "full payload should carry user messages");
    assert.notEqual(calls[0]?.systemPrompt, calls[1]?.systemPrompt);
  });
});

describe("retry behavior", () => {
  it("retries transport failures with exponential backoff", async () => {
    const { io, calls, sleeps, notifications } = makeIO([
      new Error("fetch failed: ECONNRESET"),
      new Error("429 rate limit"),
      FAST_SAFE,
    ]);
    const result = await review(io);
    assert.equal(result.decision, "allow");
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [250, 500]);
    assert.equal(notifications.filter((n) => n.includes("Retrying")).length, 2);
  });

  it("does not retry non-transport errors", async () => {
    const { io, calls } = makeIO([new Error("400 invalid request body")]);
    await assert.rejects(() => review(io), /400 invalid request body/);
    assert.equal(calls.length, 1);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const failures = Array.from({ length: 5 }, () => new Error("fetch failed: ECONNRESET"));
    const { io, calls } = makeIO(failures);
    await assert.rejects(() => review(io), /ECONNRESET/);
    assert.equal(calls.length, 5);
  });

  it("shares the retry budget across both stages", async () => {
    const { io, calls } = makeIO([
      new Error("fetch failed: ECONNRESET"),
      FAST_UNSAFE,
      new Error("fetch failed: ECONNRESET"),
      new Error("fetch failed: ECONNRESET"),
      new Error("fetch failed: ECONNRESET"),
    ]);
    await assert.rejects(() => review(io), /ECONNRESET/);
    assert.equal(calls.length, 5, "fast stage used 2 attempts, full stage gets the remaining 3");
  });

  it("surfaces provider error responses and retries transport-flavored ones", async () => {
    const { io, calls } = makeIO([{ errorMessage: "429: rate limit exceeded" }, FAST_SAFE]);
    const result = await review(io);
    assert.equal(result.decision, "allow");
    assert.equal(calls.length, 2);
  });

  it("maps provider auth error responses to model-unavailable", async () => {
    const { io } = makeIO([{ errorMessage: "401: invalid api key" }]);
    await assert.rejects(() => review(io), ClassifierModelUnavailableError);
  });

  it("treats a timed-out request as retryable", async () => {
    const { io, calls } = makeIO(["hang", FAST_SAFE]);
    const result = await review(io, { timeoutMs: 30 });
    assert.equal(result.decision, "allow");
    assert.equal(calls.length, 2);
  });
});

describe("fail-closed guarantees", () => {
  it("throws on malformed full-stage output instead of guessing a decision", async () => {
    const { io } = makeIO([FAST_UNSAFE, "Looks fine to me, go ahead!"]);
    await assert.rejects(() => review(io), /did not return JSON/);
  });

  it("throws on schema-violating output even when it is valid JSON", async () => {
    const { io } = makeIO([FAST_UNSAFE, '{"decision":"approve","risk":"low","authorization":"high","reason":"x"}']);
    await assert.rejects(() => review(io), /invalid reviewer decision/);
  });

  it("raises model-unavailable when auth is missing", async () => {
    const { io, calls } = makeIO([FAST_SAFE], { noAuth: true });
    await assert.rejects(() => review(io), ClassifierModelUnavailableError);
    assert.equal(calls.length, 0, "must not call the model without auth");
  });

  it("does not retry when the provider rejects the model or key", async () => {
    const { io, calls } = makeIO([new Error("401 Unauthorized")]);
    await assert.rejects(() => review(io), ClassifierModelUnavailableError);
    assert.equal(calls.length, 1);
  });
});
