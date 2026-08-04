import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COMMAND_ALLOWLIST, isCommandAllowlisted } from "../src/command-allowlist.ts";

const GREP = ["grep *"];

describe("isCommandAllowlisted", () => {
  it("allows chains only when every segment matches some rule", () => {
    assert.equal(isCommandAllowlisted("grep a || grep b", GREP), true);
    assert.equal(isCommandAllowlisted("grep a; risky-other-command", GREP), false);
    assert.equal(isCommandAllowlisted("grep a && ls -la && rm x", ["grep *", "ls *"]), false);
    assert.equal(isCommandAllowlisted("grep a\ngrep b", GREP), true);
  });

  it("allows pipes when both sides match", () => {
    assert.equal(isCommandAllowlisted("grep a | head -5", ["grep *", "head *"]), true);
    assert.equal(isCommandAllowlisted("grep a | head -5", GREP), false);
  });

  it("respects quotes: quoted separators are data, unquoted ones split", () => {
    assert.equal(isCommandAllowlisted('grep "a;b"', GREP), true);
    assert.equal(isCommandAllowlisted("grep 'a && b'", GREP), true);
    assert.equal(isCommandAllowlisted("grep 'a' ; rm x", GREP), false);
    assert.equal(isCommandAllowlisted("grep a\\; rm x", GREP), true, "escaped ; is an ordinary argument");
  });

  it("rejects expansions anywhere in argv or assignments", () => {
    assert.equal(isCommandAllowlisted("grep $(whoami)", GREP), false);
    assert.equal(isCommandAllowlisted("grep `whoami`", GREP), false);
    assert.equal(isCommandAllowlisted("grep $HOME", GREP), false);
    assert.equal(isCommandAllowlisted("grep ${PATTERN} file", GREP), false);
    assert.equal(isCommandAllowlisted('grep "pre $(whoami) post"', GREP), false);
    assert.equal(isCommandAllowlisted("FOO=$(whoami) grep a", GREP), false);
  });

  it("rejects redirects, background jobs, and subshells", () => {
    assert.equal(isCommandAllowlisted("grep a > out.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a >> out.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a 2>&1", GREP), false);
    assert.equal(isCommandAllowlisted("grep a < in.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a &", GREP), false);
    assert.equal(isCommandAllowlisted("(grep a)", GREP), false);
  });

  it("rejects anything that fails to parse", () => {
    assert.equal(isCommandAllowlisted("grep 'a", GREP), false);
    assert.equal(isCommandAllowlisted("cat <<EOF\nx\nEOF", ["cat *"]), false);
    assert.equal(isCommandAllowlisted("grep a <(ls)", GREP), false);
  });

  it("compares the head verbatim without path resolution", () => {
    assert.equal(isCommandAllowlisted("/usr/bin/grep foo", GREP), false);
    assert.equal(isCommandAllowlisted("grepx foo", GREP), false);
  });

  it("matches bare-word, multi-word, and trailing-* templates", () => {
    assert.equal(isCommandAllowlisted("pwd", ["pwd"]), true);
    assert.equal(isCommandAllowlisted("pwd -P", ["pwd"]), false);
    assert.equal(isCommandAllowlisted("git status", ["git status *"]), true);
    assert.equal(isCommandAllowlisted("git status --short", ["git status *"]), true);
    assert.equal(isCommandAllowlisted("git stash", ["git status *"]), false);
    assert.equal(isCommandAllowlisted("grep", GREP), true, "* allows zero args");
  });

  it("matches quoted heads after quote removal", () => {
    assert.equal(isCommandAllowlisted("'grep' foo", GREP), true);
  });

  it("skips env-style leading assignments before the head", () => {
    assert.equal(isCommandAllowlisted("LC_ALL=C grep foo", GREP), true);
    assert.equal(isCommandAllowlisted("FOO=1", GREP), false, "bare assignment has no head to judge");
  });

  it("does not allow empty commands or match with an empty rule list", () => {
    assert.equal(isCommandAllowlisted("", GREP), false);
    assert.equal(isCommandAllowlisted("grep a", []), false);
  });

  it("keeps risky git subcommands outside the read-only defaults", () => {
    assert.equal(isCommandAllowlisted("git log --oneline -5", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git push origin main", DEFAULT_COMMAND_ALLOWLIST), false);
  });
});
