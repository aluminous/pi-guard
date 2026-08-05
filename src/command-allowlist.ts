import type { CapabilityId } from "./capabilities.ts";
import { literalWordText, parseShellCommand, type ShellCommand, type ShellWord } from "./shell-parse.ts";

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

/** An allowlist template plus the capability class a match deterministically resolves to. */
export interface CommandAllowRule {
  template: string;
  capability: CapabilityId;
}

/**
 * Default allowlist. Inclusion bar: EVERY invocation matching a template must
 * be unable to write files, execute other programs, or reach the network —
 * the sandbox is the outer bound, but these skip the namer entirely, so the
 * templates themselves must be write-proof. That bar is why some obvious
 * candidates are deliberately absent: find (-exec/-delete), sed (-i), awk
 * (in-program `print > file`), sort (-o), uniq (positional outfile), xxd
 * (-r with outfile), tee and tree (-o) write files; env/command/xargs/
 * timeout/time run other programs; date/hostname with args can attempt to
 * set system state, so only their bare forms are listed. Mutating git
 * subcommands (remote add, tag NAME, config KEY VAL, stash push, reflog
 * expire) are excluded by pinning those subcommands to their read-only
 * spellings.
 *
 * Each template also carries the capability it resolves to, which is what
 * makes the allowlist a *cache of a label* rather than a cache of a verdict:
 * flipping `read-project` to ask in the disposition table retunes the fast
 * path too. Machine introspection (uname, whoami, printenv) is read-system;
 * toolchain probes are run-dev-tools; everything else here is read-project.
 */
export const DEFAULT_COMMAND_ALLOW_RULES: CommandAllowRule[] = [
  // File and text inspection (stdout-only)
  { template: "grep *", capability: "read-project" },
  { template: "rg *", capability: "read-project" },
  { template: "ls *", capability: "read-project" },
  { template: "cat *", capability: "read-project" },
  { template: "head *", capability: "read-project" },
  { template: "tail *", capability: "read-project" },
  { template: "wc *", capability: "read-project" },
  { template: "pwd", capability: "read-project" },
  { template: "which *", capability: "read-system" },
  { template: "type *", capability: "read-system" },
  { template: "file *", capability: "read-project" },
  { template: "stat *", capability: "read-project" },
  { template: "echo *", capability: "read-project" },
  { template: "du *", capability: "read-project" },
  { template: "df *", capability: "read-system" },
  { template: "diff *", capability: "read-project" },
  { template: "cmp *", capability: "read-project" },
  { template: "comm *", capability: "read-project" },
  { template: "basename *", capability: "read-project" },
  { template: "dirname *", capability: "read-project" },
  { template: "realpath *", capability: "read-project" },
  { template: "readlink *", capability: "read-project" },
  { template: "nl *", capability: "read-project" },
  { template: "cut *", capability: "read-project" },
  { template: "tr *", capability: "read-project" },
  { template: "column *", capability: "read-project" },
  { template: "od *", capability: "read-project" },
  { template: "hexdump *", capability: "read-project" },
  { template: "strings *", capability: "read-project" },
  { template: "jq *", capability: "read-project" },
  { template: "shasum *", capability: "read-project" },
  { template: "sha256sum *", capability: "read-project" },
  { template: "md5 *", capability: "read-project" },
  { template: "cksum *", capability: "read-project" },
  // System introspection (read-only forms)
  { template: "printenv *", capability: "read-system" },
  { template: "env", capability: "read-system" },
  { template: "ps *", capability: "read-system" },
  { template: "id", capability: "read-system" },
  { template: "whoami", capability: "read-system" },
  { template: "groups", capability: "read-system" },
  { template: "hostname", capability: "read-system" },
  { template: "date", capability: "read-system" },
  { template: "uname *", capability: "read-system" },
  { template: "sw_vers *", capability: "read-system" },
  { template: "defaults read *", capability: "read-system" },
  { template: "sleep *", capability: "read-system" },
  // Git, read-only spellings only
  { template: "git status *", capability: "read-project" },
  { template: "git log *", capability: "read-project" },
  { template: "git diff *", capability: "read-project" },
  { template: "git show *", capability: "read-project" },
  { template: "git branch *", capability: "read-project" },
  { template: "git blame *", capability: "read-project" },
  { template: "git grep *", capability: "read-project" },
  { template: "git shortlog *", capability: "read-project" },
  { template: "git describe *", capability: "read-project" },
  { template: "git rev-parse *", capability: "read-project" },
  { template: "git ls-files *", capability: "read-project" },
  { template: "git merge-base *", capability: "read-project" },
  { template: "git show-ref *", capability: "read-project" },
  { template: "git remote", capability: "read-project" },
  { template: "git remote -v", capability: "read-project" },
  { template: "git stash list", capability: "read-project" },
  { template: "git worktree list", capability: "read-project" },
  { template: "git tag", capability: "read-project" },
  { template: "git tag -l *", capability: "read-project" },
  { template: "git tag --list *", capability: "read-project" },
  { template: "git config --list", capability: "read-project" },
  { template: "git config -l", capability: "read-project" },
  { template: "git config --get *", capability: "read-project" },
  { template: "git reflog", capability: "read-project" },
  { template: "git reflog show *", capability: "read-project" },
  // Toolchain probes
  { template: "git --version", capability: "run-dev-tools" },
  { template: "node --version", capability: "run-dev-tools" },
  { template: "node -v", capability: "run-dev-tools" },
  { template: "npm --version", capability: "run-dev-tools" },
  { template: "npm ls *", capability: "run-dev-tools" },
  { template: "python3 --version", capability: "run-dev-tools" },
  { template: "python --version", capability: "run-dev-tools" },
  { template: "go version", capability: "run-dev-tools" },
  { template: "cargo --version", capability: "run-dev-tools" },
  { template: "rustc --version", capability: "run-dev-tools" },
  { template: "tsc --version", capability: "run-dev-tools" },
];

/** Capability a user-configured template gets: plain strings in `commands.allow` are inspection by convention. */
export const CONFIGURED_TEMPLATE_CAPABILITY: CapabilityId = "read-project";

const DEFAULT_TEMPLATE_CAPABILITIES = new Map<string, CapabilityId>(
  DEFAULT_COMMAND_ALLOW_RULES.map((rule) => [rule.template, rule.capability]),
);

export const DEFAULT_COMMAND_ALLOWLIST: string[] = DEFAULT_COMMAND_ALLOW_RULES.map((rule) => rule.template);

/**
 * The capability a matched template resolves to. Config keeps `commands.allow`
 * as plain strings (one grammar, no migration); a string that is still one of
 * the built-in templates keeps that template's tag, and anything the user
 * added defaults to read-project.
 */
export function capabilityForTemplate(template: string): CapabilityId {
  return DEFAULT_TEMPLATE_CAPABILITIES.get(template.trim()) ?? CONFIGURED_TEMPLATE_CAPABILITY;
}

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

/** One simple command's allowlist verdict: the matched rule text, or why it can never match. */
export interface CommandSegmentVerdict {
  command: string;
  rule?: string;
  /** Capability the matched rule tags this segment with. */
  capability?: CapabilityId;
  refusal?: string;
}

export type CommandAllowlistExplanation =
  | { allowlisted: true; segments: CommandSegmentVerdict[] }
  | { allowlisted: false; reason: string; segments?: CommandSegmentVerdict[] };

/** Display form of a parsed segment: quote removal already applied, expansions kept verbatim. */
function describeSegment(command: ShellCommand): string {
  if (command.kind === "subshell") return "(…)";
  const words = [
    ...command.assignments.map((assignment) => `${assignment.name}=${wordText(assignment.value)}`),
    ...command.argv.map(wordText),
  ];
  return words.join(" ");
}

function wordText(word: ShellWord): string {
  return word.parts.map((part) => part.text).join("");
}

function segmentVerdict(command: ShellCommand, rules: Array<{ text: string; tokens: string[] }>): CommandSegmentVerdict {
  const text = describeSegment(command);
  if (command.kind === "subshell") return { command: text, refusal: "subshell grouping is never allowlisted" };
  if (command.redirects.length > 0) return { command: text, refusal: "redirects are never allowlisted" };
  if (command.assignments.some((assignment) => literalWordText(assignment.value) === undefined)) {
    return { command: text, refusal: "expansions in assignments are never allowlisted" };
  }
  const argv: string[] = [];
  for (const word of command.argv) {
    const literal = literalWordText(word);
    if (literal === undefined) return { command: text, refusal: "expansions ($VAR, $(…), `…`) are never allowlisted" };
    argv.push(literal);
  }
  if (argv.length === 0) return { command: text, refusal: "bare assignments have no command head to judge" };
  const matched = rules.find((rule) => matchesRule(argv, rule.tokens));
  if (!matched) return { command: text, refusal: "no allowlist rule matches" };
  return { command: text, rule: matched.text, capability: capabilityForTemplate(matched.text) };
}

/** Full allowlist verdict with per-segment detail, for decision traces and /guard test. */
export function explainCommandAllowlist(command: string, rules: string[]): CommandAllowlistExplanation {
  const parsedRules = rules
    .map((rule) => ({ text: rule.trim(), tokens: rule.trim().split(/\s+/) }))
    .filter((rule) => rule.tokens.length > 0 && rule.tokens[0] !== "");
  if (parsedRules.length === 0) return { allowlisted: false, reason: "the command allowlist is empty" };
  const parsed = parseShellCommand(command);
  if (!parsed.ok) return { allowlisted: false, reason: `does not parse under the allowlist grammar: ${parsed.error}` };
  if (parsed.script.chains.length === 0) return { allowlisted: false, reason: "empty command" };
  const segments: CommandSegmentVerdict[] = [];
  let background = false;
  for (const chain of parsed.script.chains) {
    if (chain.background) background = true;
    for (const pipeline of chain.pipelines) {
      for (const cmd of pipeline.commands) segments.push(segmentVerdict(cmd, parsedRules));
    }
  }
  if (background) return { allowlisted: false, reason: "background jobs (&) are never allowlisted", segments };
  const refused = segments.filter((segment) => segment.refusal);
  if (refused.length > 0) {
    return { allowlisted: false, reason: refused.map((segment) => `\`${segment.command}\`: ${segment.refusal}`).join("; "), segments };
  }
  return { allowlisted: true, segments };
}

/** True when the command parses and every simple command in it matches some rule. */
export function isCommandAllowlisted(command: string, rules: string[]): boolean {
  return explainCommandAllowlist(command, rules).allowlisted;
}

/**
 * Deterministic capability labels for an allowlisted command: the union over
 * its segments, so `grep x && git log` is one read-project label and
 * `ls && node --version` carries read-project plus run-dev-tools.
 */
export function allowlistCapabilities(explanation: CommandAllowlistExplanation): CapabilityId[] {
  if (!explanation.allowlisted) return [];
  const seen: CapabilityId[] = [];
  for (const segment of explanation.segments) {
    if (segment.capability && !seen.includes(segment.capability)) seen.push(segment.capability);
  }
  return seen;
}
