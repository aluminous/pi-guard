import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FAST_SYSTEM_PROMPT,
  buildFastReviewText,
  buildFullReviewText,
  isModelUnavailableError,
  isRetryableClassifierError,
  parseFastResult,
  parseResult,
  projectToolCall,
} from "../src/classifier-protocol.ts";
import { testConfig } from "./helpers.ts";

describe("fast system prompt", () => {
  it("requires the classifier to respect configured allow and deny rules", () => {
    assert.match(FAST_SYSTEM_PROMPT, /only when an allow rule clearly covers/);
    assert.match(FAST_SYSTEM_PROMPT, /no soft_deny or hard_deny rule applies/);
  });
});

describe("parseResult", () => {
  it("parses a well-formed reviewer response", () => {
    const result = parseResult('{"decision":"deny","risk":"critical","authorization":"low","reason":"credential exfiltration"}');
    assert.equal(result.decision, "deny");
    assert.equal(result.risk, "critical");
    assert.equal(result.reason, "credential exfiltration");
  });

  it("extracts JSON embedded in surrounding prose or code fences", () => {
    const result = parseResult('Here is my analysis:\n```json\n{"decision":"allow","risk":"low","authorization":"high","reason":"routine"}\n```');
    assert.equal(result.decision, "allow");
  });

  it("rejects unknown decisions instead of guessing", () => {
    assert.throws(() => parseResult('{"decision":"maybe","risk":"low","authorization":"high","reason":"x"}'), /invalid reviewer decision/);
  });

  it("rejects missing or blank reasons", () => {
    assert.throws(() => parseResult('{"decision":"allow","risk":"low","authorization":"high","reason":"  "}'), /invalid reviewer reason/);
  });

  it("rejects non-JSON output", () => {
    assert.throws(() => parseResult("I think this is fine to allow."), /did not return JSON/);
  });
});

describe("parseFastResult", () => {
  it("parses the fast-path verdict", () => {
    assert.deepEqual(parseFastResult('{"triviallySafe":true,"reason":"read-only"}'), { triviallySafe: true, reason: "read-only" });
  });

  it("rejects a string where a boolean is required", () => {
    assert.throws(() => parseFastResult('{"triviallySafe":"true","reason":"x"}'), /invalid fast reviewer triviallySafe/);
  });
});

describe("error classification", () => {
  it("classifies transport failures as retryable", () => {
    assert.equal(isRetryableClassifierError(new Error("fetch failed: ECONNRESET")), true);
    assert.equal(isRetryableClassifierError(new Error("429 rate limit exceeded")), true);
    assert.equal(isRetryableClassifierError(new Error("request timed out")), true);
  });

  it("does not retry logic errors", () => {
    assert.equal(isRetryableClassifierError(new Error("reviewer did not return JSON")), false);
  });

  it("classifies auth/model failures as unavailable", () => {
    assert.equal(isModelUnavailableError(new Error("401 Unauthorized")), true);
    assert.equal(isModelUnavailableError(new Error("model not found: foo/bar")), true);
    assert.equal(isModelUnavailableError(new Error("ECONNRESET")), false);
  });
});

describe("projectToolCall", () => {
  it("truncates write content in the projection", () => {
    const projection = projectToolCall("write", { path: "a.txt", content: "x".repeat(1500) }, "/repo", testConfig());
    const prefix = projection.inputSummary.contentPrefix as string;
    assert.ok(prefix.includes("truncated 500 chars"));
    assert.equal(projection.inputSummary.contentLength, 1500);
  });

  it("caps projected edits at three", () => {
    const edits = Array.from({ length: 5 }, (_, i) => ({ oldText: `old ${i}`, newText: `new ${i}` }));
    const projection = projectToolCall("edit", { path: "a.txt", edits }, "/repo", testConfig());
    assert.equal(projection.inputSummary.editCount, 5);
    assert.equal((projection.inputSummary.edits as unknown[]).length, 3);
  });

  it("marks tools outside the registry as unrecognized", () => {
    const projection = projectToolCall("fetch", { url: "https://example.com" }, "/repo", testConfig());
    assert.equal(projection.inputSummary.note, "unrecognized tool");
    assert.deepEqual(projection.inputSummary.keys, ["url"]);
  });

  it("includes the policy summary for classifier context", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    assert.ok(projection.policySummary.some((line) => line.startsWith("Backend:")));
  });

  it("tells the classifier when hard restriction layers are disabled", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.network.enabled = false;
    });
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", config);
    assert.ok(projection.policySummary.includes("Filesystem restrictions: disabled (unrestricted)"));
    assert.ok(projection.policySummary.includes("Network restrictions: disabled (unrestricted)"));
  });
});

describe("review payloads", () => {
  it("keeps the fast payload low-context (no user messages)", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    const payload = JSON.parse(buildFastReviewText(projection, testConfig()));
    assert.deepEqual(Object.keys(payload).sort(), ["pendingAction", "rules"]);
  });

  it("adds recent user messages only to the full payload", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    const payload = JSON.parse(buildFullReviewText(["please run ls"], projection, testConfig()));
    assert.deepEqual(payload.recentUserMessages, ["please run ls"]);
  });
});
