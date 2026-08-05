import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JUDGE_SYSTEM_PROMPT,
  NAMER_SYSTEM_PROMPT,
  buildJudgeText,
  buildNamerText,
  isModelUnavailableError,
  isRetryableClassifierError,
  parseJudgeResult,
  parseNamerResult,
  projectToolCall,
} from "../src/classifier-protocol.ts";
import { testConfig } from "./helpers.ts";

describe("namer system prompt", () => {
  it("keeps the namer out of the decision business", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /You decide nothing/);
    assert.match(NAMER_SYSTEM_PROMPT, /No prose, no decisions, no risk scores/);
  });

  it("states that write content is part of the action", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /the CONTENT is part of the action/);
  });

  it("bounds authorization evidence to decoration", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /never removes one/);
  });
});

describe("judge system prompt", () => {
  it("is ask-preferred and reserves deny for what confirmation cannot fix", () => {
    assert.match(JUDGE_SYSTEM_PROMPT, /Prefer ask/);
    assert.match(JUDGE_SYSTEM_PROMPT, /stay unsafe even after the user confirms them/);
  });

  it("is explicitly per-action", () => {
    assert.match(JUDGE_SYSTEM_PROMPT, /never a standing approval/);
  });
});

describe("parseNamerResult", () => {
  it("parses labels and optional authorization evidence", () => {
    const result = parseNamerResult('{"labels":["network-fetch","modify-project"],"authorizationEvidence":"download the schema"}');
    assert.deepEqual(result.labels, ["network-fetch", "modify-project"]);
    assert.equal(result.authorizationEvidence, "download the schema");
  });

  it("extracts JSON embedded in prose or code fences", () => {
    assert.deepEqual(parseNamerResult('Here you go:\n```json\n{"labels":["read-project"]}\n```').labels, ["read-project"]);
  });

  it("drops unknown class ids rather than failing the protocol", () => {
    assert.deepEqual(parseNamerResult('{"labels":["read-project","prod-deploy"]}').labels, ["read-project"]);
  });

  it("falls back to unclassified when nothing valid is left", () => {
    assert.deepEqual(parseNamerResult('{"labels":[]}').labels, ["unclassified"]);
    assert.deepEqual(parseNamerResult('{"labels":["nonsense"]}').labels, ["unclassified"]);
  });

  it("deduplicates repeated labels", () => {
    assert.deepEqual(parseNamerResult('{"labels":["credentials","credentials"]}').labels, ["credentials"]);
  });

  it("fails closed on schema violations", () => {
    assert.throws(() => parseNamerResult('{"labels":"read-project"}'), /invalid namer labels/);
    assert.throws(() => parseNamerResult('{"labels":[1,2]}'), /invalid namer labels/);
    assert.throws(() => parseNamerResult('{"labels":["read-project"],"authorizationEvidence":42}'), /invalid namer authorizationEvidence/);
    assert.throws(() => parseNamerResult("looks safe to me"), /did not return JSON/);
  });
});

describe("parseJudgeResult", () => {
  it("parses a well-formed verdict", () => {
    const result = parseJudgeResult('{"decision":"ask","reason":"push to a remote you did not name"}');
    assert.equal(result.decision, "ask");
    assert.equal(result.reason, "push to a remote you did not name");
  });

  it("rejects unknown decisions and blank reasons instead of guessing", () => {
    assert.throws(() => parseJudgeResult('{"decision":"maybe","reason":"x"}'), /invalid judge decision/);
    assert.throws(() => parseJudgeResult('{"decision":"allow","reason":"  "}'), /invalid judge reason/);
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

  it("includes the policy summary for reviewer context", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    assert.ok(projection.policySummary.some((line) => line.startsWith("Backend:")));
  });

  it("tells the reviewer when hard restriction layers are disabled", () => {
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
  it("leads the namer payload with the static class definitions and ends with pendingAction", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    const payload = JSON.parse(buildNamerText(["please run ls"], projection));
    assert.deepEqual(Object.keys(payload), ["capabilityClasses", "activePolicy", "cwd", "recentUserMessages", "pendingAction"]);
    assert.equal(payload.capabilityClasses.length, 12);
    assert.deepEqual(payload.recentUserMessages, ["please run ls"]);
  });

  it("injects session guidance only when present", () => {
    const projection = projectToolCall("bash", { command: "npm run deploy" }, "/repo", testConfig());
    const guidance = ["User allowed bash (npm run deploy) with comment: staging deploys are fine"];
    const withGuidance = JSON.parse(buildNamerText([], projection, guidance));
    assert.deepEqual(withGuidance.userSessionGuidance, guidance);
    assert.equal("userSessionGuidance" in JSON.parse(buildNamerText([], projection)), false);
  });

  it("gives the judge the guard's recent decisions and the namer's labels", () => {
    const projection = projectToolCall("bash", { command: "git push --force origin main" }, "/repo", testConfig());
    const payload = JSON.parse(
      buildJudgeText({
        recentUserMessages: ["tidy up the history"],
        projection,
        recentGuardDecisions: ["deny bash (off-machine-effects): user denied a force push"],
        labels: ["off-machine-effects", "local-destructive"],
        authorizationEvidence: "tidy up the history",
      }),
    );
    assert.deepEqual(Object.keys(payload), ["capabilityClasses", "activePolicy", "cwd", "recentUserMessages", "recentGuardDecisions", "pendingAction"]);
    assert.deepEqual(payload.pendingAction.capabilityLabels, ["off-machine-effects", "local-destructive"]);
    assert.equal(payload.pendingAction.authorizationEvidence, "tidy up the history");
    assert.equal(payload.recentGuardDecisions.length, 1);
  });

  it("keeps the payload prefix byte-stable across calls so provider prompt caches can hit", () => {
    const config = testConfig();
    const guidance = ["User allowed bash (npm test) with comment: fine"];
    const a = buildNamerText(["same turn message"], projectToolCall("bash", { command: "npm test" }, "/repo", config), guidance);
    const b = buildNamerText(["same turn message"], projectToolCall("write", { path: "src/x.ts", content: "export {}" }, "/repo", config), guidance);
    const divergence = a.indexOf('"pendingAction"');
    assert.ok(divergence > 0);
    assert.equal(a.slice(0, divergence), b.slice(0, divergence));
  });
});
