import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeAction, INTERCEPTED_TOOLS } from "../src/intercepted-tools.ts";

describe("describeAction", () => {
  it("describes bash by its command", () => {
    assert.equal(describeAction("bash", { command: "npm run deploy --prod" }), "bash: npm run deploy --prod");
  });

  it("truncates long commands at 300 chars", () => {
    const description = describeAction("bash", { command: "x".repeat(400) });
    assert.equal(description, `bash: ${"x".repeat(300)}…[truncated 100 chars]`);
  });

  it("describes file tools by their path", () => {
    assert.equal(describeAction("read", { path: "/repo/src/app.ts" }), "read: /repo/src/app.ts");
    assert.equal(describeAction("edit", { path: "/repo/src/app.ts", editCount: 2 }), "edit: /repo/src/app.ts");
  });

  it("adds the write size when contentLength is present", () => {
    const summary = INTERCEPTED_TOOLS.write!.project({ path: "/repo/a.txt", content: "x".repeat(1500) });
    assert.equal(describeAction("write", summary), "write: /repo/a.txt (writes 1500 chars)");
  });

  it("falls back to the tool name when the summary has no command or path", () => {
    assert.equal(describeAction("bash", { command: "" }), "bash");
    assert.equal(describeAction("fetch", { note: "unrecognized tool", keys: ["url"] }), "fetch");
    assert.equal(describeAction("read", {}), "read");
  });
});
