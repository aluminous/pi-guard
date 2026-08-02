import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { interceptToolCall } from "../src/interceptor.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { appendGuardTelemetry, redactTelemetryRecord, type GuardTelemetryRecord } from "../src/telemetry.ts";
import { testConfig } from "./helpers.ts";

function fakeCtx(): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: {
      notify() {},
      confirm: async () => false,
    },
  } as unknown as ExtensionContext;
}

function readyState(captured: GuardTelemetryRecord[], overrides?: Parameters<typeof testConfig>[0]): { state: RuntimeState; config: ReturnType<typeof testConfig> } {
  const config = testConfig(overrides);
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  state.appendEntry = (customType, data) => {
    assert.equal(customType, "guard");
    captured.push(data as GuardTelemetryRecord);
  };
  return { state, config };
}

describe("redactTelemetryRecord", () => {
  const record: GuardTelemetryRecord = {
    kind: "review",
    tool: "bash",
    decision: "allow",
    risk: "low",
    authorization: "medium",
    latencyMs: 10,
    reason: "ok",
    projection: {
      toolName: "bash",
      cwd: "/repo",
      inputSummary: { command: `curl ${"x".repeat(500)}` },
      policySummary: ["network: allowed 5 domains"],
    },
  };

  it("truncates projected values and drops policy summary in minimal mode", () => {
    const redacted = redactTelemetryRecord(record, "minimal") as typeof record;
    const command = redacted.projection!.inputSummary.command as string;
    assert.ok(command.startsWith("curl "), "keeps the command prefix");
    assert.match(command, /\u2026\[truncated \d+ chars\]$/, "marks truncation");
    assert.ok(command.length < (record.projection!.inputSummary.command as string).length, "shortens the value");
    assert.deepEqual(redacted.projection!.policySummary, []);
  });

  it("keeps the full projection in full mode", () => {
    const redacted = redactTelemetryRecord(record, "full") as typeof record;
    assert.equal((redacted.projection!.inputSummary.command as string).length, (record.projection!.inputSummary.command as string).length);
    assert.deepEqual(redacted.projection!.policySummary, ["network: allowed 5 domains"]);
  });

  it("leaves non-review records untouched in minimal mode", () => {
    const block: GuardTelemetryRecord = { kind: "block", tool: "write", reason: "outside roots" };
    assert.deepEqual(redactTelemetryRecord(block, "minimal"), block);
  });
});

describe("appendGuardTelemetry", () => {
  it("writes records as guard custom entries", () => {
    const captured: GuardTelemetryRecord[] = [];
    const { state } = readyState(captured);
    appendGuardTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.kind, "block");
  });

  it("writes nothing when telemetry is off", () => {
    const captured: GuardTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => { c.classifier.telemetry = "off"; });
    appendGuardTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
    assert.equal(captured.length, 0);
  });

  it("writes nothing when no session appender is wired", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    appendGuardTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
  });

  it("never throws when the session appender fails", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    state.appendEntry = () => {
      throw new Error("no session file");
    };
    appendGuardTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
  });
});

describe("interceptor telemetry wiring", () => {
  it("records policy blocks", async () => {
    const captured: GuardTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => { c.classifier.enabled = false; });
    const result = await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/.env`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(result?.block, true);
    const block = captured.find((r) => r.kind === "block");
    assert.ok(block, "expected a block record");
    assert.equal(block.tool, "write");
  });

  it("records denied path approvals", async () => {
    const captured: GuardTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => {
      c.classifier.enabled = false;
      c.filesystem.allowWrite = [];
    });
    const result = await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/some-file.txt`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(result?.block, true);
    const approval = captured.find((r) => r.kind === "approval");
    assert.ok(approval, "expected an approval record");
    assert.equal(approval.kind === "approval" && approval.approved, false);
  });

  it("records nothing when telemetry is off", async () => {
    const captured: GuardTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => {
      c.classifier.enabled = false;
      c.classifier.telemetry = "off";
    });
    await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/.env`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(captured.length, 0);
  });
});
