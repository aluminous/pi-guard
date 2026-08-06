/**
 * macOS keychain reachability through the real Seatbelt backend.
 *
 * Regression cover for the default profile's keychain read allowance: with
 * ~/Library/Keychains read-denied, the login keychain silently drops out of the
 * search list and every lookup reports "could not be found" — so a CLI that
 * keeps its token there (`gl`, and anything else built on SecKeychain) reports
 * a missing token rather than a sandbox error. `security list-keychains` is the
 * probe that distinguishes the two.
 *
 * Deliberately excluded from `npm test` (which only globs test/*.test.ts): it
 * spawns sandbox-exec and starts sandbox-runtime's proxy listeners. Run via
 * `npm run test:keychain`.
 *
 * Safe to run on any Mac: strictly read-only, never unlocks anything, and the
 * only item it looks up is a name that does not exist. Skips off macOS.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SeatbeltBackend } from "../src/backends/seatbelt.ts";
import { DEFAULT_CONFIG, type ResolvedRailConfig } from "../src/config.ts";
import { scrubEnvironment } from "../src/policy.ts";

/** An item name no keychain has, so the lookup can only ever miss. */
const ABSENT_ITEM = "pi-rail-probe-nonexistent";
const PROBE_TIMEOUT_MS = 30_000;

interface ProbeResult {
  exitCode: number | null;
  output: string;
}

function runSandboxed(backend: SeatbeltBackend, command: string, cwd: string, env: Record<string, string>): Promise<ProbeResult> {
  return backend.wrapBash(command, cwd, env).then(
    (wrapped) =>
      new Promise<ProbeResult>((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, { cwd: wrapped.cwd, env: wrapped.env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
        child.stdout.on("data", (chunk) => (output += String(chunk)));
        child.stderr.on("data", (chunk) => (output += String(chunk)));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          resolve({ exitCode, output });
        });
      }),
  );
}

test("the default profile keeps the macOS keychain reachable", async (t) => {
  if (process.platform !== "darwin") {
    t.skip(`Seatbelt is macOS-only; current platform is ${process.platform}`);
    return;
  }

  const cwd = process.cwd();
  const config: ResolvedRailConfig = structuredClone(DEFAULT_CONFIG);
  const backend = new SeatbeltBackend();
  const support = await backend.supported();
  if (!support.ok) {
    t.skip(support.reason);
    return;
  }

  await backend.initialize(config, { cwd } as unknown as ExtensionContext);
  const env = scrubEnvironment(process.env, config);
  try {
    const loginKeychain = path.join(os.homedir(), "Library", "Keychains");

    // The load-bearing assertion. A denied keychain does not fail this
    // command — it just returns a shorter list, which is exactly why the
    // breakage was invisible.
    const list = await runSandboxed(backend, "/usr/bin/security list-keychains", cwd, env);
    assert.equal(list.exitCode, 0, `list-keychains failed: ${list.output}`);
    assert.ok(
      list.output.includes(loginKeychain),
      `the login keychain under ${loginKeychain} is missing from the sandboxed search list:\n${list.output}`,
    );

    // Exit 44 with "could not be found" means the search ran and missed;
    // a sandbox denial surfaces as "Operation not permitted" instead.
    const lookup = await runSandboxed(backend, `/usr/bin/security find-generic-password -s ${ABSENT_ITEM}`, cwd, env);
    assert.equal(lookup.exitCode, 44, `expected a clean miss, got exit ${lookup.exitCode}:\n${lookup.output}`);
    assert.ok(lookup.output.includes("could not be found"), `expected an item-not-found miss, got:\n${lookup.output}`);
    assert.ok(!lookup.output.includes("Operation not permitted"), `the keychain was denied by the sandbox:\n${lookup.output}`);
  } finally {
    await backend.shutdown();
  }
});
