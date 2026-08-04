import { literalWordText, parseShellCommand, type ShellCommand } from "./shell-parse.ts";

/**
 * Deterministic shell-command allowlist over the parsed AST: a command is
 * allowlisted only when it parses under the minimal shell grammar and EVERY
 * simple command in every chain and pipeline matches a rule template, so
 * "grep a || grep b" passes "grep *" but "grep a; rm x" does not. Anything
 * the grammar cannot model (heredocs, process substitution, unbalanced
 * quotes) is a parse error and never allowlisted; anything it can model but
 * this layer cannot judge — expansions, redirects, subshells, background
 * jobs — parses fine and is conservatively not allowlisted.
 */

/** Default allowlist: modest read-only commands whose reach is bounded by the sandbox. */
export const DEFAULT_COMMAND_ALLOWLIST: string[] = [
  "grep *",
  "rg *",
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "pwd",
  "which *",
  "file *",
  "stat *",
  "echo *",
  "git status *",
  "git log *",
  "git diff *",
  "git show *",
  "git branch *",
  "git blame *",
];

/**
 * A rule is whitespace-separated words plus an optional trailing `*`:
 * "pwd" matches exactly that word with no args, "git status *" matches the
 * two-word head with any (or no) further args. Head words compare verbatim —
 * "/usr/bin/grep" does not match "grep".
 */
function matchesRule(argv: string[], ruleTokens: string[]): boolean {
  const anyArgs = ruleTokens.at(-1) === "*";
  const literals = anyArgs ? ruleTokens.slice(0, -1) : ruleTokens;
  if (anyArgs ? argv.length < literals.length : argv.length !== literals.length) return false;
  return literals.every((token, index) => argv[index] === token);
}

function commandAllowed(command: ShellCommand, ruleTokens: string[][]): boolean {
  if (command.kind === "subshell") return false; // parses fine, but grouping is never allowlisted
  if (command.redirects.length > 0) return false;
  if (command.assignments.some((assignment) => literalWordText(assignment.value) === undefined)) return false;
  const argv: string[] = [];
  for (const word of command.argv) {
    const text = literalWordText(word);
    if (text === undefined) return false; // $VAR, $(…), `…` — expansions are never judged safe
    argv.push(text);
  }
  if (argv.length === 0) return false; // bare assignments have no command head to judge
  return ruleTokens.some((tokens) => matchesRule(argv, tokens));
}

/** True when the command parses and every simple command in it matches some rule. */
export function isCommandAllowlisted(command: string, rules: string[]): boolean {
  const ruleTokens = rules.map((rule) => rule.trim().split(/\s+/)).filter((tokens) => tokens.length > 0 && tokens[0] !== "");
  if (ruleTokens.length === 0) return false;
  const parsed = parseShellCommand(command);
  if (!parsed.ok || parsed.script.chains.length === 0) return false;
  return parsed.script.chains.every(
    (chain) => !chain.background && chain.pipelines.every((pipeline) => pipeline.commands.every((cmd) => commandAllowed(cmd, ruleTokens))),
  );
}
