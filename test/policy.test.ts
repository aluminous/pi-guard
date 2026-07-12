import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { decidePathAccess, normalizeUserPath, scrubEnvironment } from "../src/policy.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
const cwd = fixture.dir;
after(() => fixture.cleanup());

function setup() {
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "app.ts"), "ok");
  writeFileSync(path.join(cwd, ".env"), "SECRET=1");
  writeFileSync(path.join(cwd, ".env.local"), "SECRET=1");
  writeFileSync(path.join(cwd, "cert.pem"), "---");
  mkdirSync(path.join(cwd, "outside"), { recursive: true });
}
setup();

describe("normalizeUserPath", () => {
  it("resolves relative paths against cwd", () => {
    assert.equal(normalizeUserPath(cwd, "src/app.ts"), path.join(cwd, "src", "app.ts"));
  });

  it("strips a leading @ prefix", () => {
    assert.equal(normalizeUserPath(cwd, "@src/app.ts"), path.join(cwd, "src", "app.ts"));
  });
});

describe("decidePathAccess read", () => {
  it("allows normal project files in blacklist mode", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/app.ts", "read");
    assert.equal(decision.allowed, true);
  });

  it("denies .env by exact pattern", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("denies .env.local via the .env.* glob", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env.local", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("denies *.pem by basename glob anywhere under cwd", () => {
    const decision = decidePathAccess(testConfig(), cwd, "cert.pem", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("reports unresolvable for nonexistent read targets", () => {
    const decision = decidePathAccess(testConfig(), cwd, "no-such-file.txt", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "unresolvable");
  });

  it("enforces whitelist mode when allowRead is non-empty", () => {
    const config = testConfig((c) => {
      c.filesystem.allowRead = [path.join(cwd, "src")];
    });
    assert.equal(decidePathAccess(config, cwd, "src/app.ts", "read").allowed, true);
    const outside = decidePathAccess(config, cwd, "cert.txt", "read");
    assert.equal(outside.allowed, false);
  });
});

describe("decidePathAccess write", () => {
  it("allows writes inside cwd via the '.' root", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/new-file.ts", "write");
    assert.equal(decision.allowed, true);
  });

  it("allows writes to nonexistent paths under an existing allowed parent", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/deep/nested/file.ts", "write");
    assert.equal(decision.allowed, true);
  });

  it("returns outside-roots for writes outside allowed roots", () => {
    const decision = decidePathAccess(testConfig(), cwd, "/usr/local/pwned.txt", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "outside-roots");
  });

  it("denies write to configured deny patterns even inside cwd", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("canonicalizes symlinks so they cannot escape allowed roots", () => {
    const escapeTarget = path.join(cwd, "..", `pi-guard-escape-${process.pid}`);
    mkdirSync(escapeTarget, { recursive: true });
    symlinkSync(escapeTarget, path.join(cwd, "sneaky"));
    // Only cwd is writable, so the sibling dir the symlink points at is out of
    // roots — but the un-canonicalized path cwd/sneaky/out.txt looks inside cwd.
    const config = testConfig((c) => {
      c.filesystem.allowWrite = ["."];
    });
    const decision = decidePathAccess(config, cwd, "sneaky/out.txt", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "outside-roots");
  });

  it("denies reads through symlinks that resolve into denied paths", () => {
    const secretDir = path.join(cwd, "secrets");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, "token.txt"), "s3cr3t");
    symlinkSync(path.join(secretDir, "token.txt"), path.join(cwd, "innocent.txt"));
    const config = testConfig((c) => {
      c.filesystem.denyRead = [secretDir];
    });
    const decision = decidePathAccess(config, cwd, "innocent.txt", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });
});

describe("scrubEnvironment", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/tester",
    LC_ALL: "en_US.UTF-8",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-token",
    MY_APP_TOKEN: "app-token",
    RANDOM_VAR: "not-allowed",
  };

  it("removes unset patterns and applies the allow list", () => {
    const scrubbed = scrubEnvironment(env, testConfig());
    assert.equal(scrubbed.PATH, "/usr/bin");
    assert.equal(scrubbed.HOME, "/Users/tester");
    assert.equal(scrubbed.LC_ALL, "en_US.UTF-8");
    assert.equal(scrubbed.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(scrubbed.GITHUB_TOKEN, undefined);
    assert.equal(scrubbed.MY_APP_TOKEN, undefined);
    assert.equal(scrubbed.RANDOM_VAR, undefined);
  });

  it("passes everything not unset when the allow list is empty", () => {
    const config = testConfig((c) => {
      c.environment.allow = [];
    });
    const scrubbed = scrubEnvironment(env, config);
    assert.equal(scrubbed.RANDOM_VAR, "not-allowed");
    assert.equal(scrubbed.GITHUB_TOKEN, undefined);
  });
});
