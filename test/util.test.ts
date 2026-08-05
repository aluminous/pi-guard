import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorChain, formatError } from "../src/util.ts";

/** The shape node's fetch actually throws: a bare outer message wrapping the real code. */
function fetchFailure(inner: { message: string; code?: string; errno?: number; syscall?: string }): Error {
  const cause = new Error(inner.message);
  Object.assign(cause, { code: inner.code, errno: inner.errno, syscall: inner.syscall });
  return new TypeError("fetch failed", { cause });
}

describe("errorChain", () => {
  it("flattens cause links with their diagnostic fields", () => {
    const chain = errorChain(fetchFailure({ message: "read ECONNRESET", code: "ECONNRESET", errno: -54, syscall: "read" }));
    assert.equal(chain.length, 2);
    assert.equal(chain[0]?.message, "fetch failed");
    assert.equal(chain[0]?.name, "TypeError");
    assert.equal(chain[1]?.code, "ECONNRESET");
    assert.equal(chain[1]?.errno, -54);
    assert.equal(chain[1]?.syscall, "read");
  });

  it("follows an AggregateError's first entry when there is no cause", () => {
    const aggregate = new AggregateError([Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" })], "fetch failed");
    const chain = errorChain(aggregate);
    assert.equal(chain.length, 2);
    assert.equal(chain[1]?.code, "ECONNREFUSED");
  });

  it("reads HTTP status off provider error objects", () => {
    const chain = errorChain(Object.assign(new Error("upstream rejected"), { status: 503 }));
    assert.equal(chain[0]?.status, 503);
  });

  it("stops on a cause cycle instead of hanging", () => {
    const a = new Error("a");
    const b = new Error("b");
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    assert.equal(errorChain(a).length, 2);
  });

  it("caps chain depth", () => {
    let error = new Error("deepest");
    for (let i = 0; i < 12; i++) error = new Error(`level ${i}`, { cause: error });
    assert.equal(errorChain(error).length, 6);
  });
});

describe("formatError", () => {
  it("surfaces the buried cause instead of the useless outer message", () => {
    const text = formatError(fetchFailure({ message: "read ECONNRESET", code: "ECONNRESET", errno: -54, syscall: "read" }));
    assert.match(text, /^fetch failed ← read ECONNRESET/);
    assert.match(text, /errno -54/);
  });

  it("annotates a code the message does not already spell out", () => {
    const text = formatError(new TypeError("fetch failed", { cause: Object.assign(new Error("Client network socket disconnected"), { code: "ECONNRESET" }) }));
    assert.match(text, /code ECONNRESET/);
  });

  it("does not repeat a code the message already contains", () => {
    const text = formatError(Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), { code: "ENOTFOUND" }));
    assert.equal(text, "getaddrinfo ENOTFOUND api.test");
  });

  it("deduplicates a cause that restates its wrapper", () => {
    assert.equal(formatError(new Error("upstream timed out", { cause: new Error("upstream timed out") })), "upstream timed out");
  });

  it("caps the total length", () => {
    const text = formatError(new Error("x".repeat(200), { cause: new Error("y".repeat(400)) }));
    assert.ok(text.length < 340, `expected a capped string, got ${text.length} chars`);
    assert.match(text, /truncated \d+ chars/);
  });

  it("keeps the old behavior for plain errors and non-errors", () => {
    assert.equal(formatError(new Error("boom")), "boom");
    assert.equal(formatError("boom"), "boom");
    assert.equal(formatError(undefined), "undefined");
    assert.equal(formatError({ nothing: true }), "[object Object]");
  });
});
