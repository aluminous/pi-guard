import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stopTurnForClassifierFailure } from "../src/interceptor.ts";

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
