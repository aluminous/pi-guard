// /rail why tests: unified-log fixture parsing, denied-path → rail-rule
// mapping (including a degraded pattern), empty-result handling, and the
// command flow with an injectable log runner. No live `log show` anywhere.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RailBackend } from "../src/backends/types.ts";
import { createRailWhy } from "../src/commands/why.ts";
import { compileFilesystemPolicy } from "../src/policy.ts";
import { attributeDenial, formatRailWhy, parseSandboxDenials, type LogWindow } from "../src/sandbox-log.ts";
import { createRuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());
mkdirSync(path.join(fixture.dir, "project"), { recursive: true });
const cwd = path.join(fixture.dir, "project");

const SSH_KEY = path.join(os.homedir(), ".ssh", "id_rsa");

/** Real `log show --style syslog` shapes captured on this machine, with fixture paths substituted. */
const FIXTURE_LOG = [
  "Timestamp                       (process)[PID]",
  `2026-08-05 09:20:22.869661+0900  localhost kernel[0]: (Sandbox) Sandbox: cat(8294) deny(1) file-read-data ${SSH_KEY}`,
  `2026-08-05 09:20:22.901234+0900  localhost kernel[0]: (Sandbox) 2 duplicate reports for Sandbox: cat(8294) deny(1) file-read-data ${SSH_KEY}`,
  `2026-08-05 09:20:23.000001+0900  localhost kernel[0]: (Sandbox) Sandbox: openssl(8301) deny(1) file-read-data ${path.join(cwd, "server.pem")}`,
  `2026-08-05 09:20:23.100001+0900  localhost kernel[0]: (Sandbox) Sandbox: tee(8305) deny(1) file-write-create /usr/local/oops.txt`,
  "2026-08-05 09:20:23.200001+0900  localhost kernel[0]: (Sandbox) Sandbox: contactsd(8250) deny(1) mach-lookup com.apple.tccd.system",
  "some unrelated log line without a denial",
].join("\n");

describe("parseSandboxDenials", () => {
  it("parses process, pid, operation, and target, deduplicating coalesced repeats", () => {
    const denials = parseSandboxDenials(FIXTURE_LOG);
    assert.deepEqual(
      denials.map((d) => `${d.process}/${d.operation}/${d.target ?? "-"}`),
      [
        `cat/file-read-data/${SSH_KEY}`,
        `openssl/file-read-data/${path.join(cwd, "server.pem")}`,
        "tee/file-write-create//usr/local/oops.txt",
        "contactsd/mach-lookup/com.apple.tccd.system",
      ],
    );
    assert.equal(denials[0]!.pid, 8294);
  });

  it("returns nothing for empty or denial-free output", () => {
    assert.deepEqual(parseSandboxDenials(""), []);
    assert.deepEqual(parseSandboxDenials("plain noise\nmore noise"), []);
  });
});

describe("attributeDenial", () => {
  const config = testConfig((c) => {
    c.filesystem.denyRead = ["~/.ssh", "*.pem"];
    c.filesystem.allowWrite = ["."];
  });
  const compiled = compileFilesystemPolicy(config, cwd);
  const [sshDenial, pemDenial, writeDenial, machDenial] = parseSandboxDenials(FIXTURE_LOG);

  it("maps a denied read to the denyRead pattern that covers it", () => {
    const attribution = attributeDenial(compiled, cwd, sshDenial!);
    assert.equal(attribution.rule, "denyRead '~/.ssh'");
    assert.equal(attribution.degraded, undefined);
  });

  it("maps a glob hit and flags the pattern as sandbox-degraded", () => {
    const attribution = attributeDenial(compiled, cwd, pemDenial!);
    assert.equal(attribution.rule, "denyRead '*.pem'");
    assert.equal(attribution.degraded?.cause, "glob");
    assert.equal(attribution.degraded?.pattern, "*.pem");
  });

  it("attributes out-of-roots writes to the default-deny write policy", () => {
    const attribution = attributeDenial(compiled, cwd, writeDenial!);
    assert.equal(attribution.rule, "outside allowWrite roots (writes are default-deny)");
  });

  it("leaves non-filesystem operations unattributed (system profile)", () => {
    const attribution = attributeDenial(compiled, cwd, machDenial!);
    assert.equal(attribution.rule, undefined);
  });
});

describe("formatRailWhy", () => {
  it("renders rule attributions with degraded notes", () => {
    const config = testConfig((c) => {
      c.filesystem.denyRead = ["*.pem"];
    });
    const compiled = compileFilesystemPolicy(config, cwd);
    const denial = parseSandboxDenials(FIXTURE_LOG)[1]!;
    const report = formatRailWhy({
      command: { command: "cat server.pem", startedAt: Date.now() - 5000, endedAt: Date.now() - 4000 },
      attributions: [attributeDenial(compiled, cwd, denial)],
    });
    assert.match(report, /last sandboxed command: cat server\.pem/);
    assert.match(report, /ran 1000ms/);
    assert.match(report, /\[BLOCK\] deny file-read-data .*server\.pem \(openssl\) → denyRead '\*\.pem'/);
    assert.match(report, /degraded in the sandbox: Seatbelt holds the literal/);
  });

  it("says so and suggests re-running when the window has no denials", () => {
    const report = formatRailWhy({
      command: { command: "ls", startedAt: Date.now(), endedAt: Date.now() },
      attributions: [],
    });
    assert.match(report, /\(none found\)/);
    assert.match(report, /re-run the failing command/i);
  });
});

describe("/rail why command flow", () => {
  function makeCtx() {
    const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
    const notifications: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      mode: "rpc",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus() {},
        setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
        theme: { fg: (_name: string, text: string) => text },
      },
    };
    return { ctx: ctx as unknown as ExtensionContext, widgets, notifications };
  }

  it("warns when no sandboxed command has run yet", async () => {
    const state = createRuntimeState();
    const { ctx, widgets, notifications } = makeCtx();
    await createRailWhy({ state, logRunner: async () => "" })(ctx);
    assert.equal(widgets.length, 0);
    assert.match(notifications.at(-1) ?? "", /run the failing command first/);
  });

  it("queries the command window with margin and renders the attribution report", async () => {
    const state = createRuntimeState();
    state.config = testConfig();
    state.backend = { name: "seatbelt" } as RailBackend;
    state.lastBashCommand = { command: "cat ~/.ssh/id_rsa", startedAt: 1_000_000, endedAt: 1_000_500 };
    const windows: LogWindow[] = [];
    const { ctx, widgets, notifications } = makeCtx();
    await createRailWhy({
      state,
      logRunner: async (window) => {
        windows.push(window);
        return FIXTURE_LOG;
      },
    })(ctx);
    assert.equal(windows[0]!.start.getTime(), 1_000_000 - 2_000);
    assert.equal(windows[0]!.end.getTime(), 1_000_500 + 2_000);
    assert.ok(notifications.some((n) => n.includes("can take a few seconds")));
    const report = (widgets.at(-1)?.lines ?? []).join("\n");
    assert.match(report, /deny file-read-data .*id_rsa \(cat\) → denyRead '~\/\.ssh'/);
    assert.match(report, /mach-lookup.* → no matching rail rule \(system profile\)/);
  });

  it("reports an empty window instead of failing", async () => {
    const state = createRuntimeState();
    state.config = testConfig();
    state.lastBashCommand = { command: "ls", startedAt: 1, endedAt: 2 };
    const { ctx, widgets } = makeCtx();
    await createRailWhy({ state, logRunner: async () => "" })(ctx);
    assert.match((widgets.at(-1)?.lines ?? []).join("\n"), /\(none found\)/);
  });
});
