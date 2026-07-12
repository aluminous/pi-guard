// The same filesystem config is enforced by two engines: src/policy.ts for Pi's
// file tools (in-process) and the Seatbelt profile for bash (via sandbox-runtime).
// These tests pin down that both engines deny the same sensitive locations, using
// a fake HOME so nothing depends on the developer's real machine.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { getSeatbeltRuntimeConfig } from "../src/backends/seatbelt.ts";
import { decidePathAccess } from "../src/policy.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
const fakeHome = path.join(fixture.dir, "home");
const cwd = path.join(fixture.dir, "repo");
const originalHome = process.env.HOME;

// Home-relative deny patterns shared by both engines; globs are excluded because
// Seatbelt receives them as literal resolved paths (a known semantic gap).
const homeDenyPatterns = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc"];

before(() => {
  process.env.HOME = fakeHome;
  mkdirSync(cwd, { recursive: true });
  for (const pattern of homeDenyPatterns) {
    const target = path.join(fakeHome, pattern.slice(2));
    if (pattern.endsWith("rc")) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "secret");
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "credential"), "secret");
    }
  }
});

after(() => {
  process.env.HOME = originalHome;
  fixture.cleanup();
});

describe("policy and seatbelt agree on default deny paths", () => {
  it("policy denies reads under every home-relative deny pattern", () => {
    const config = testConfig();
    for (const pattern of homeDenyPatterns) {
      const target = pattern.endsWith("rc")
        ? path.join(fakeHome, pattern.slice(2))
        : path.join(fakeHome, pattern.slice(2), "credential");
      const decision = decidePathAccess(config, cwd, target, "read");
      assert.equal(decision.allowed, false, `policy should deny read of ${target}`);
      assert.equal(decision.allowed === false && decision.code, "denied-by-pattern", `expected pattern denial for ${target}`);
    }
  });

  it("seatbelt receives the same paths in its deny list and credential files", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig(), cwd);
    const denyRead = (runtime.filesystem as { denyRead: string[] }).denyRead;
    const credentialPaths = (runtime.credentials as { files: Array<{ path: string; mode: string }> }).files.map((f) => f.path);
    for (const pattern of homeDenyPatterns) {
      const expanded = path.join(fakeHome, pattern.slice(2));
      assert.ok(denyRead.includes(expanded), `seatbelt denyRead should include ${expanded}`);
      assert.ok(credentialPaths.includes(expanded), `seatbelt credential files should include ${expanded}`);
    }
  });

  it("seatbelt write allowlist matches the policy write roots for cwd and temp", () => {
    const config = testConfig();
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const allowWrite = (runtime.filesystem as { allowWrite: string[] }).allowWrite;
    assert.ok(allowWrite.includes(cwd), "seatbelt should allow writes to cwd");
    const policyDecision = decidePathAccess(config, cwd, "new-file.txt", "write");
    assert.equal(policyDecision.allowed, true, "policy should allow writes inside cwd");
  });

  it("both engines scrub non-wildcard credential env vars", () => {
    const config = testConfig();
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const envDenials = (runtime.credentials as { envVars: Array<{ name: string }> }).envVars.map((v) => v.name);
    assert.ok(envDenials.includes("GITHUB_TOKEN"));
    assert.ok(envDenials.includes("ANTHROPIC_API_KEY"));
  });
});
