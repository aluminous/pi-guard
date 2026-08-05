import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import {
  acknowledgeRailInSubagentChild,
  findUnacknowledgedSubagents,
  RAIL_ACK_ID,
  SUBAGENT_ACK_EVENT,
  SUBAGENT_CHILD_ENV,
  warnUnacknowledgedSubagents,
} from "../src/subagents-interop.ts";
import { testConfig } from "./helpers.ts";

function fakePi(): ExtensionAPI & { emitted: Array<{ channel: string; data: unknown }> } {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    emitted,
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
      on: () => () => {},
    },
  };
  return pi as unknown as ExtensionAPI & { emitted: Array<{ channel: string; data: unknown }> };
}

function enforcingState(): RuntimeState {
  const state = createRuntimeState();
  state.config = testConfig();
  state.enabled = true;
  state.initialized = true;
  return state;
}

describe("acknowledgeRailInSubagentChild", () => {
  it("emits the acknowledgement when running as an enforcing pi-subagents child", () => {
    const pi = fakePi();
    assert.equal(acknowledgeRailInSubagentChild(pi, enforcingState(), { [SUBAGENT_CHILD_ENV]: "1" }), true);
    assert.deepEqual(pi.emitted, [{ channel: SUBAGENT_ACK_EVENT, data: { id: RAIL_ACK_ID } }]);
  });

  it("does not emit outside a pi-subagents child session", () => {
    const pi = fakePi();
    assert.equal(acknowledgeRailInSubagentChild(pi, enforcingState(), {}), false);
    assert.equal(pi.emitted.length, 0);
  });

  it("does not emit when the rail is disabled or uninitialized", () => {
    const env = { [SUBAGENT_CHILD_ENV]: "1" };
    const disabled = enforcingState();
    disabled.enabled = false;
    const uninitialized = enforcingState();
    uninitialized.initialized = false;
    const pi = fakePi();
    assert.equal(acknowledgeRailInSubagentChild(pi, disabled, env), false);
    assert.equal(acknowledgeRailInSubagentChild(pi, uninitialized, env), false);
    assert.equal(pi.emitted.length, 0);
  });

  it("swallows event bus failures", () => {
    const pi = { events: { emit: () => { throw new Error("no bus"); } } } as unknown as ExtensionAPI;
    assert.equal(acknowledgeRailInSubagentChild(pi, enforcingState(), { [SUBAGENT_CHILD_ENV]: "1" }), false);
  });
});

describe("findUnacknowledgedSubagents", () => {
  const finished = (extra: Record<string, unknown> = {}) => ({ agent: "worker", exitCode: 0, sessionFile: "/tmp/child.jsonl", ...extra });

  it("ignores tools other than subagent/subagent_wait and malformed details", () => {
    assert.deepEqual(findUnacknowledgedSubagents("bash", { results: [finished()] }), []);
    assert.deepEqual(findUnacknowledgedSubagents("subagent", undefined), []);
    assert.deepEqual(findUnacknowledgedSubagents("subagent", "text"), []);
    assert.deepEqual(findUnacknowledgedSubagents("subagent", { results: "nope" }), []);
    assert.deepEqual(findUnacknowledgedSubagents("subagent", { results: [null, 4, "x"] }), []);
  });

  it("accepts plain and versioned acknowledgement ids", () => {
    for (const id of [RAIL_ACK_ID, `${RAIL_ACK_ID}@0.2.0`]) {
      const details = { results: [finished({ runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["other-ext", id] } })] };
      assert.deepEqual(findUnacknowledgedSubagents("subagent", details), []);
    }
  });

  it("reports finished children without the rail id, including from subagent_wait", () => {
    const details = { results: [finished({ runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["other-ext"] } })] };
    for (const tool of ["subagent", "subagent_wait"]) {
      assert.deepEqual(findUnacknowledgedSubagents(tool, details), [
        { agent: "worker", key: "/tmp/child.jsonl", extensionsRestricted: false },
      ]);
    }
  });

  it("flags children launched with ambient extensions disabled and errored children", () => {
    const details = {
      results: [
        finished({ launchResolvedExtensions: { version: 1, source: "launch-resolved", disableAmbientExtensions: true } }),
        { agent: "reviewer", error: "boom" },
      ],
    };
    assert.deepEqual(findUnacknowledgedSubagents("subagent", details), [
      { agent: "worker", key: "/tmp/child.jsonl", extensionsRestricted: true },
      { agent: "reviewer", key: undefined, extensionsRestricted: false },
    ]);
  });

  it("skips running, detached, and non-terminal entries", () => {
    const details = {
      results: [
        finished({ exitCode: undefined, progress: { status: "running" } }),
        finished({ exitCode: undefined, error: undefined, detached: true }),
        { agent: "scout" },
      ],
    };
    assert.deepEqual(findUnacknowledgedSubagents("subagent", details), []);
  });
});

describe("warnUnacknowledgedSubagents", () => {
  function fakeCtx() {
    const notifications: Array<{ message: string; type?: string }> = [];
    return { notifications, ui: { notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }) } };
  }
  const eventFor = (results: unknown[]) => ({ toolName: "subagent", details: { mode: "single", results } });

  it("warns once per child and dedupes on repeated results", () => {
    const ctx = fakeCtx();
    const state = enforcingState();
    const event = eventFor([{ agent: "worker", exitCode: 0, sessionFile: "/tmp/a.jsonl" }]);
    warnUnacknowledgedSubagents(event, ctx, state);
    warnUnacknowledgedSubagents(event, ctx, state);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0]?.type, "warning");
    assert.match(ctx.notifications[0]?.message ?? "", /worker/);
    assert.match(ctx.notifications[0]?.message ?? "", /ran without the rail/);
  });

  it("names the --no-extensions cause when the launch restricted extensions", () => {
    const ctx = fakeCtx();
    warnUnacknowledgedSubagents(
      eventFor([{ agent: "worker", exitCode: 0, launchResolvedExtensions: { disableAmbientExtensions: true } }]),
      ctx,
      enforcingState(),
    );
    assert.match(ctx.notifications[0]?.message ?? "", /ambient extensions disabled/);
  });

  it("stays quiet when the rail is disabled or children acknowledged", () => {
    const ctx = fakeCtx();
    const disabled = enforcingState();
    disabled.enabled = false;
    warnUnacknowledgedSubagents(eventFor([{ agent: "worker", exitCode: 0 }]), ctx, disabled);
    warnUnacknowledgedSubagents(
      eventFor([{ agent: "worker", exitCode: 0, runtimeAcknowledgedExtensions: { ids: [RAIL_ACK_ID] } }]),
      ctx,
      enforcingState(),
    );
    assert.equal(ctx.notifications.length, 0);
  });
});
