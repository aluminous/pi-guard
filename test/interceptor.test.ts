import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { interceptToolCall, stopTurnForClassifierFailure } from "../src/interceptor.ts";
import { createRuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());

/** Minimal fake ExtensionContext: enough for the deterministic paths of interceptToolCall. */
function fakeCtx(cwd: string): ExtensionContext & { aborted: boolean; notifications: string[] } {
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
      find: () => undefined,
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return ctx as unknown as ExtensionContext & { aborted: boolean; notifications: string[] };
}

function guardedState(config: ReturnType<typeof testConfig>) {
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  return state;
}

describe("classifier read exemption", () => {
  mkdirSync(path.join(fixture.dir, "project", "src"), { recursive: true });
  writeFileSync(path.join(fixture.dir, "project", "src", "app.ts"), "ok");
  writeFileSync(path.join(fixture.dir, "outside.txt"), "ok");
  const cwd = path.join(fixture.dir, "project");

  it("skips classifier review for in-cwd reads even with filesystem enforcement off", async () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.classifier.enabled = true;
    });
    const state = guardedState(config);
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.classifierSkips, 1);
    assert.equal(state.stats.classifierHits, 0);
  });

  it("still reviews reads outside cwd (classifier unavailable here, so the call blocks)", async () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.classifier.enabled = true;
    });
    const state = guardedState(config);
    const result = await interceptToolCall({ toolName: "read", input: { path: path.join(fixture.dir, "outside.txt") } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.equal(state.stats.classifierSkips, 0);
  });

  it("never exempts deny-matching reads from review", async () => {
    writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.classifier.enabled = true;
    });
    const state = guardedState(config);
    const result = await interceptToolCall({ toolName: "read", input: { path: ".env" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.equal(state.stats.classifierSkips, 0);
  });

  it("does not exempt write content review via allowlisted paths", async () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.classifier.enabled = true;
    });
    const state = guardedState(config);
    const result = await interceptToolCall({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.equal(state.stats.classifierSkips, 0);
  });
});

describe("classifier failure handling", () => {
  it("stops only the current turn after fail-closed retries are exhausted", () => {
    let abortCalls = 0;
    let shutdownCalls = 0;
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const ctx = {
      abort() {
        abortCalls++;
      },
      shutdown() {
        shutdownCalls++;
      },
      ui: {
        notify(message: string, type?: "info" | "warning" | "error") {
          notifications.push({ message, type });
        },
      },
    };

    const result = stopTurnForClassifierFailure(ctx, "all attempts timed out");

    assert.equal(abortCalls, 1);
    assert.equal(shutdownCalls, 0);
    assert.deepEqual(notifications, [
      {
        message: "Guard classifier failed closed: all attempts timed out. Stopping this turn for user intervention.",
        type: "error",
      },
    ]);
    assert.deepEqual(result, {
      block: true,
      reason: "Guard classifier failed closed: all attempts timed out. This turn was stopped for user intervention.",
    });
  });
});
