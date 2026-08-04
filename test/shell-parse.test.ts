import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { literalWordText, parseShellCommand, type ShellScript, type SimpleCommand } from "../src/shell-parse.ts";

function parsed(command: string): ShellScript {
  const result = parseShellCommand(command);
  if (!result.ok) assert.fail(`expected ${JSON.stringify(command)} to parse: ${result.error}`);
  return result.script;
}

/** The single simple command of a one-chain, one-pipeline script. */
function onlyCommand(command: string): SimpleCommand {
  const script = parsed(command);
  assert.equal(script.chains.length, 1);
  assert.equal(script.chains[0]!.pipelines.length, 1);
  assert.equal(script.chains[0]!.pipelines[0]!.commands.length, 1);
  const only = script.chains[0]!.pipelines[0]!.commands[0]!;
  assert.equal(only.kind, "command");
  return only as SimpleCommand;
}

function argvText(command: SimpleCommand): (string | undefined)[] {
  return command.argv.map(literalWordText);
}

function parseError(command: string): string {
  const result = parseShellCommand(command);
  assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to fail parsing`);
  return result.ok ? "" : result.error;
}

describe("tokenization", () => {
  it("resolves single quotes, double quotes, and backslash escapes into literal words", () => {
    assert.deepEqual(argvText(onlyCommand("grep \"a b\" 'c d' e\\ f")), ["grep", "a b", "c d", "e f"]);
    assert.deepEqual(argvText(onlyCommand("grep 'a b'c")), ["grep", "a bc"]);
    assert.deepEqual(argvText(onlyCommand("grep '' x")), ["grep", "", "x"]);
    assert.deepEqual(argvText(onlyCommand("grep a\\;b")), ["grep", "a;b"]);
  });

  it("treats quoted operators as word content", () => {
    assert.deepEqual(argvText(onlyCommand('grep "a && b; c|d"')), ["grep", "a && b; c|d"]);
    assert.deepEqual(argvText(onlyCommand("grep 'x > y & z'")), ["grep", "x > y & z"]);
  });

  it("joins backslash-newline continuations without delimiting a word", () => {
    assert.deepEqual(argvText(onlyCommand("grep foo \\\n  bar")), ["grep", "foo", "bar"]);
  });

  it("drops comments at word-start position only", () => {
    assert.deepEqual(argvText(onlyCommand("grep a # && rm x")), ["grep", "a"]);
    assert.deepEqual(argvText(onlyCommand("grep a#b")), ["grep", "a#b"]);
  });
});

describe("expansions", () => {
  it("marks $VAR, ${…}, $(…), and backticks as expansion parts", () => {
    for (const command of ["grep $HOME", "grep ${HOME}", "grep $(basename x)", "grep `basename x`"]) {
      const word = onlyCommand(command).argv[1]!;
      assert.equal(word.parts[0]!.kind, "expansion", command);
      assert.equal(literalWordText(word), undefined, command);
    }
  });

  it("captures nested $() as a single expansion", () => {
    const word = onlyCommand("echo $(cat $(basename x))").argv[1]!;
    assert.deepEqual(word.parts, [{ kind: "expansion", text: "$(cat $(basename x))" }]);
  });

  it("finds expansions inside double quotes and keeps surrounding text literal", () => {
    const word = onlyCommand('grep "pre $HOME post"').argv[1]!;
    assert.deepEqual(word.parts, [
      { kind: "literal", text: "pre " },
      { kind: "expansion", text: "$HOME" },
      { kind: "literal", text: " post" },
    ]);
  });

  it("keeps a lone dollar sign literal", () => {
    assert.deepEqual(argvText(onlyCommand("grep a$ b")), ["grep", "a$", "b"]);
  });
});

describe("command structure", () => {
  it("parses chains, pipelines, and background jobs into the expected shape", () => {
    const script = parsed("FOO=1 grep -n main src | head -5 && git status; sleep 10 &");
    assert.equal(script.chains.length, 2);
    const first = script.chains[0]!;
    assert.deepEqual(first.operators, ["&&"]);
    assert.equal(first.background, false);
    assert.equal(first.pipelines[0]!.commands.length, 2);
    const grep = first.pipelines[0]!.commands[0]! as SimpleCommand;
    assert.deepEqual(grep.assignments.map((a) => [a.name, literalWordText(a.value)]), [["FOO", "1"]]);
    assert.deepEqual(argvText(grep), ["grep", "-n", "main", "src"]);
    assert.deepEqual(argvText(first.pipelines[1]!.commands[0]! as SimpleCommand), ["git", "status"]);
    const second = script.chains[1]!;
    assert.equal(second.background, true);
    assert.deepEqual(argvText(second.pipelines[0]!.commands[0]! as SimpleCommand), ["sleep", "10"]);
  });

  it("splits chains on newlines and skips blank lines", () => {
    const script = parsed("grep a\n\ngrep b\n");
    assert.equal(script.chains.length, 2);
  });

  it("parses redirect forms with fd prefixes onto the command", () => {
    const command = onlyCommand("grep a 2>&1 >>out <in");
    assert.deepEqual(argvText(command), ["grep", "a"]);
    assert.deepEqual(
      command.redirects.map((r) => [r.fd, r.op, literalWordText(r.target)]),
      [
        [2, ">&", "1"],
        [undefined, ">>", "out"],
        [undefined, "<", "in"],
      ],
    );
  });

  it("keeps quoted digits before a redirect as an argument, not an fd", () => {
    const command = onlyCommand('echo "2">x');
    assert.deepEqual(argvText(command), ["echo", "2"]);
    assert.deepEqual(command.redirects.map((r) => [r.fd, r.op]), [[undefined, ">"]]);
  });

  it("recognizes leading assignments only before the first argv word", () => {
    const command = onlyCommand('A=1 B="q x" make A=2');
    assert.deepEqual(command.assignments.map((a) => [a.name, literalWordText(a.value)]), [["A", "1"], ["B", "q x"]]);
    assert.deepEqual(argvText(command), ["make", "A=2"]);
  });

  it("does not treat a quoted name as an assignment", () => {
    const command = onlyCommand('"FOO"=bar grep x');
    assert.deepEqual(command.assignments, []);
    assert.deepEqual(argvText(command), ["FOO=bar", "grep", "x"]);
  });

  it("parses subshells recursively with their own chains and redirects", () => {
    const script = parsed("(grep a && ls) >out");
    const subshell = script.chains[0]!.pipelines[0]!.commands[0]!;
    assert.equal(subshell.kind, "subshell");
    if (subshell.kind !== "subshell") return;
    assert.equal(subshell.body.chains[0]!.pipelines.length, 2);
    assert.deepEqual(subshell.redirects.map((r) => r.op), [">"]);
  });

  it("parses an empty command line to an empty script", () => {
    assert.deepEqual(parsed("").chains, []);
    assert.deepEqual(parsed("  \n ").chains, []);
  });
});

describe("parse failures", () => {
  it("fails on unbalanced quotes and trailing backslashes", () => {
    assert.match(parseError("grep 'a"), /single quote/);
    assert.match(parseError('grep "a'), /double quote/);
    assert.match(parseError("grep a\\"), /backslash/);
  });

  it("fails on heredocs, herestrings, and process substitution", () => {
    assert.match(parseError("cat <<EOF"), /heredoc/);
    assert.match(parseError("cat <<<x"), /heredoc/);
    assert.match(parseError("diff <(ls) x"), /process substitution/);
    assert.match(parseError("grep a > >(tee log)"), /process substitution/);
  });

  it("fails on grammar it does not model", () => {
    assert.match(parseError("grep a |& head"), /\|&/);
    assert.match(parseError("grep $'a\\n'"), /quoting/);
    assert.match(parseError("foo() { :; }"), /unexpected/);
    assert.match(parseError("case x in a) ;; esac"), /unexpected|expected/);
  });

  it("fails on dangling operators and empty commands", () => {
    assert.match(parseError("grep a &&"), /expected a command/);
    assert.match(parseError("| grep a"), /expected a command/);
    assert.match(parseError("grep a ; ; grep b"), /expected a command/);
    assert.match(parseError("grep a >"), /missing its target/);
    assert.match(parseError("(grep a"), /unterminated subshell/);
    assert.match(parseError("()"), /empty subshell/);
    assert.match(parseError("grep ${x"), /unterminated/);
  });
});
