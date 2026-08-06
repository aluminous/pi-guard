# Pi Rail Extension

> **Formerly pi-guard.** The project was renamed to Pi Rail to avoid a clash
> with an unrelated `pi-guard` package. The slash command is `/rail`, the
> config file is `rail.json`, and the flag is `--no-rail`. An existing
> `guard.json` is still loaded (with a one-line advisory asking you to rename
> it) and is still written back to, so nothing breaks before you get to it —
> see [Configuration](#configuration).

Defense-in-depth command and file-tool guardrails for Pi. Today Pi Rail uses macOS Seatbelt for contained shell execution, deterministic path policy for Pi file tools, environment scrubbing, and an optional LLM reviewer that names actions against a small capability taxonomy which your own [disposition table](#capability-mode) then decides on. The extension is structured around a backend interface so a container backend can be added later.

## Relationship to pi-sandbox

Pi Rail is inspired by Chris Arderne's [`pi-sandbox`](https://github.com/carderne/pi-sandbox), which provides OS-level sandboxing for Pi with interactive permission prompts. Both extensions wrap shell execution in an OS sandbox and intercept Pi's direct `read`, `write`, and `edit` tools because those file operations do not run inside subprocess containment.

The main differences are:

- Pi Rail adds an optional AI reviewer that names `bash`, `read`, `write`, and `edit` calls with capability classes after deterministic policy checks; a user-owned disposition table then decides.
- Pi Rail currently targets macOS Seatbelt via `@anthropic-ai/sandbox-runtime`; `pi-sandbox` supports macOS `sandbox-exec` and Linux `bubblewrap` through `@carderne/sandbox-runtime`.
- Pi Rail treats configured deny-write paths as hard blocks and keeps path approvals session-local; `pi-sandbox` emphasizes interactive prompts that can persist allowances to project or global config.
- Pi Rail includes environment scrubbing and capability critique/model selection commands in addition to sandbox status controls.

If you do not need semantic review and want the mature prompt-oriented sandbox, especially on Linux, start with `pi-sandbox`.

## Scope

- Supported now: macOS Seatbelt containment for `bash` and user `!` / `!!` commands.
- Supported now: policy checks for built-in `read`, `write`, and `edit` tools.
- Optional: capability naming and judge review of `bash`, `read`, `write`, and `edit` actions.
- Planned later: container backend.
- Not goals now: Windows, non-container Linux.

## Install

Pi extensions execute with the same system permissions as Pi. Review the source
and security limitations before installing third-party extensions.

Install Pi Rail directly from GitHub:

```bash
pi install git:github.com/aluminous/pi-rail
```

To try it for one run without adding it to your settings:

```bash
pi -ne -e git:github.com/aluminous/pi-rail
```

To remove it later:

```bash
pi remove git:github.com/aluminous/pi-rail
```

For local development, clone the repository and install dependencies:

```bash
git clone https://github.com/aluminous/pi-rail.git
cd pi-rail
npm install
pi -ne -e .
```

After installation, start Pi normally from any project:

```bash
pi
```

The extension uses `@anthropic-ai/sandbox-runtime` for Seatbelt profile generation and command wrapping.

## Usage

```bash
pi
# or for quick testing without other extensions
pi -ne -e .
```

Flags:

- `--no-rail`: explicitly disable Pi Rail and run bash without the rail.

Commands — everything lives under `/rail`, with argument autocomplete:

- `/rail`: open the control panel (searchable actions with a live status header; a plain select dialog over RPC).
- `/rail status`: toggle the live status view — a bordered panel docked where the editor sits (like the model chooser), updating while the agent streams above it (decisions, approvals, session guidance). Esc closes it, arrows/page keys scroll. Over RPC it toggles a live widget.
- `/rail policy`: open the **capability policy page** — a two-tab panel whose first tab is the editable capability table with live per-class stats (see [Dispositions](#dispositions)). Over RPC it degrades to select dialogs; invoking the tab you are already on closes it.
- `/rail policy rules`: open the same page on its **rules** tab — the resolved mechanism policy (filesystem, network, environment scrubbing, and the command allowlist, provenance-annotated). **Tab** cycles between the two tabs; invoking the other tab while the panel is open switches rather than closing. Outside the TUI this stays a standalone live widget, as before.
- `/rail set <class> [allow|judge|ask|deny]`: set one class for this session from the command line (completions offer class ids — including custom ones — then dispositions). Without a disposition it prints the current effective value and where it came from.
- `/rail guide <text>`: add classifier guidance for this session without waiting to be asked (see [Session guidance](#session-guidance)). Bare `/rail guide` prompts for the text; `/rail guide clear` drops every entry.
- `/rail on`: enable Pi Rail.
- `/rail off`: disable for the next agent turn, then re-enable automatically.
- `/rail off session`: disable until the session ends.
- `/rail readonly` (or `ro`, or ctrl+alt+r): toggle session read-only mode — `write`/`edit` are blocked, `bash` must be reviewed (and is blocked outright if the classifier is off), and a session disposition preset denies the writing capability classes.
- `/rail model`: choose the reviewer models interactively. The dialog has two tabs — Tab switches between `namer` and `judge` — and the header shows what each one currently resolves to.
- `/rail model auto|current|off|provider/model-id`: set the namer model directly and save it globally. `auto` (the default) picks the best available known-good model, preferring subscription providers.
- `/rail model judge current|provider/model-id`: set the judge model directly and save it globally. Bare `/rail model judge` (or `judge status`) prints the configured and resolved judge model. Neither `off` nor `auto` is accepted: the judge cannot be disabled, and `auto` is the namer's cheap-model list.
- `/rail model status`: print reviewer status, both resolved models, and available models.
- `/rail smoke`: run the command-containment and namer smoke tests.
- `/rail critique [provider/model-id]`: critique the capability class definitions, the disposition table, and the content screen with Pi's current model or a specific one.

Rail reports are **never placed into the conversation**: pi delivers custom
messages to the LLM as user messages, and a status or policy report is a map
of the rail's rules, approvals, and session guidance — exactly what a
compromised agent would want to read. All rail output goes through
user-only channels (popups, widgets, notifications); the agent only ever
sees the block reason attached to a denied tool call. Rail commands are
user-facing: in headless modes (json/print) there is no one to invoke or see
them, so views are a stderr error and pickers resolve as cancelled.

Statusline legend — the rail statusline is deliberately terse:

```
Rail: seatbelt, 26 domains, auto (openai-codex/gpt-5.4-mini) R2(+1) C4 D1 ↑12k ↓800
```

`R` = deterministic decisions (no model consulted), `C` = model reviews (namer
and/or judge), `D` = denials, `(+n)` = added since your last message, `↑`/`↓` =
reviewer input/output tokens this session. The counters turn yellow when there are denials, blocks, or
errors.

The top-level `statusLine` config field controls when the statusline is shown
(also settable from the `/rail` panel, which saves it globally):

- `"always"` (default): always visible.
- `"never"`: never shown.
- `"auto"`: shown only when something needs attention — the rail is disabled
  or erroring, or a call was denied or blocked since your last message.

## Configuration

Config is merged in this order:

1. Built-in defaults.
2. `~/.pi/agent/extensions/rail.json`
3. `<cwd>/.pi/rail.json` when the project is trusted.

`/rail model` persists reviewer-model choices by updating the global extension config at `~/.pi/agent/extensions/rail.json`. It does not write extension-specific fields into Pi's main `settings.json`. A trusted project config can still override the global settings, including individual `dispositions` rows.

### Migrating from `guard.json`

Both layers were called `guard.json` before the rename, and both still accept
that name:

- If only `guard.json` is present, it is loaded exactly as before and one
  advisory asks you to rename it to `rail.json`.
- If both are present, `rail.json` wins and the advisory says the `guard.json`
  was ignored — merge anything you still want out of it, then delete it.
- Persistent writes (Ctrl+S on the policy page, `/rail model`, statusline
  visibility) go back to whichever file was loaded, so saving from a session
  running on `guard.json` will not scatter your settings across two files.

Renaming the file is the whole migration; its contents are unchanged.

Example `.pi/rail.json`:

```json
{
  "enabled": true,
  "backend": "seatbelt",
  "statusLine": "always",
  "filesystem": {
    "enabled": true,
    "allowRead": [],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc", ".env", ".env.*", "*.pem", "*.key"],
    "allowWrite": [".", "/tmp", "~/.cache", "~/Library/Caches", "~/.npm", "~/.cargo/registry", "~/.cargo/git", "~/.gradle/caches", "~/.m2/repository", "~/go/pkg/mod"],
    "denyWrite": [".pi", ".env", ".env.*", "*.pem", "*.key", "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker"]
  },
  "environment": {
    "allow": ["PATH", "HOME", "TMPDIR", "CI", "TERM"],
    "unset": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
  },
  "network": {
    "enabled": true,
    "allowedDomains": ["github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "*.ghcr.io", "docker.io", "*.docker.io", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "quay.io", "*.quay.io", "gcr.io", "*.gcr.io", "*.pkg.dev", "registry.k8s.io", "mcr.microsoft.com", "public.ecr.aws"],
    "deniedDomains": ["*"]
  },
  "dispositions": {
    "off-machine-effects": "ask",
    "local-destructive": "judge"
  },
  "classifier": {
    "enabled": false,
    "model": "auto",
    "judgeModel": "current",
    "timeoutMs": 8000,
    "failClosed": true,
    "telemetry": "minimal"
  }
}
```

The `filesystem.enabled` and `network.enabled` fields control whether those
restriction layers are enforced; they do not turn Pi Rail or the reviewers
on and off. Both default to `true`.

Ready-to-copy profiles are available under [`examples/configs`](examples/configs):

- [`classifier-focused.json`](examples/configs/classifier-focused.json): unrestricted files and network, with semantic review enabled.
- [`balanced.json`](examples/configs/balanced.json): the default filesystem and network restrictions plus semantic review.
- [`offline-restricted.json`](examples/configs/offline-restricted.json): narrower write access, no networking, and semantic review.
- [`network-allowlist.json`](examples/configs/network-allowlist.json): unrestricted files with an allowlist-only network policy.
- [`filesystem-denylist.json`](examples/configs/filesystem-denylist.json): unrestricted networking with a denylist-driven filesystem policy.
- [`dispositions-deny-by-default.json`](examples/configs/dispositions-deny-by-default.json) and [`dispositions-allow-by-default.json`](examples/configs/dispositions-allow-by-default.json): disposition-table profiles that drop the deterministic file/network boundaries and let the capability table carry the policy — strict deny-by-default, and permissive with a concrete deny set.

Config files are layered over the built-in defaults, so omitted arrays retain
their defaults rather than becoming empty.

## Capability mode

The whole decision policy is one table of **capability dispositions**. Every
intercepted action is *named* with one or more of twelve capability classes, and
the table says what happens to each class — nothing else decides.

| class | default | class | default |
|---|---|---|---|
| `read-project` | allow | `off-machine-effects` | ask |
| `read-system` | allow | `modify-system` | ask |
| `run-dev-tools` | allow | `credentials` | judge |
| `modify-project` | allow | `local-destructive` | judge |
| `install-dependencies` | allow | `persistence` | judge |
| `network-fetch` | judge | `unclassified` | judge |

The four dispositions are **allow**, **ask** (bring me in), **deny**, and
**judge** (let a strong model think about this one). An action that spans
classes takes the strictest disposition among them, which is why extra benign
labels cannot dilute a strict one. `off-machine-effects` is defined by the
**machine boundary**, not by tool name: `kubectl`/`docker` against a local
cluster (kind, minikube, k3d, docker-desktop, colima) stays local, the same
command against a remote context does not. `local-destructive` covers deletes
and overwrites *and* local commits — it is the class most expected to be
re-scoped per session. `unclassified` is the completeness valve: an
unanticipated intent resolving to a thoughtful second look is correct by
construction.

Set rows in `dispositions` (global or project config). Omitted classes keep
their defaults — the table merges **per row**, so setting one class never
resets the others.

### Dispositions

`/rail policy` opens the table as an interactive page (docked panel, agent
still streaming above it): one row per class with its disposition and this
session's stats — `off-machine-effects  ask  3 hits · 1 allowed · 1 asked · 1
denied`. The highlighted row's definition shows underneath.

| key | effect |
|---|---|
| ↑ / ↓ | move the highlight |
| ← / → / Enter | cycle the row: allow → judge → ask → deny |
| `a` | add a custom class (also Enter on the trailing `＋ Add class…` row) |
| `e` | edit the highlighted class's definition |
| `d` | delete the highlighted class (custom classes only) |
| Tab | switch between the **dispositions** and **rules** tabs |
| Ctrl+S | save every session change to the global config |
| Esc | close (session changes stay in effect) |

Every edit applies **immediately, for this session** — that is the point of
the page: `local-destructive` and friends are meant to be re-scoped per
session, and closing the page does not undo anything. Rows that differ from
the persisted value are coloured; **Ctrl+S** persists them to
`~/.pi/agent/extensions/rail.json` and the colouring clears. Stats update
live while the agent works.

In read-only mode a banner names the active preset and its rows render as
`allow → deny*`: the preset tightens the effective value, cycling still edits
the row underneath it. Over RPC the page degrades to select dialogs (pick a
class, then a disposition, "Edit definition…", or "Delete class"; "Add new
class…" and "Save persistently" close the list), and `/rail set <class>
<disposition>` does the same thing in one line.

### Custom capability classes

The taxonomy is editable. You can add classes of your own, rewrite what any
class means to the namer, and delete classes you added — the twelve built-ins
can be **edited but not deleted**, since deterministic mappers and the
read-only preset name them directly. Set a built-in to `deny`, or rewrite its
definition, instead.

On the page: `a` opens the add form (id, then definition), `e` edits the
highlighted class's definition, `d` removes a custom class. Inside a form,
**Tab** moves between fields, **Enter** or **Ctrl+S** commits, **Esc**
cancels; validation errors keep you in the form with your text intact.

Like disposition edits, class changes take effect **immediately at session
scope** — the namer sees a new class on the very next action — and stay
session-local until **Ctrl+S** writes them to the global config. Rows added
this session are tagged `(new)`, edited ones `(edited)`; deleted ones simply
disappear. The save message counts what moved: `Dispositions saved: 2 rows · 1
class added · 1 edited · 1 removed.`

New classes default to **ask**: a newly named intent is exactly the case for
bringing you in, and it is the one default that cannot silently widen what the
agent may do.

Persisted classes live under `capabilities` in the config, merged **by id**
across layers so a project config adding one class keeps the global ones:

```jsonc
{
  "capabilities": {
    // Custom classes join the namer's vocabulary.
    "classes": [
      {
        "id": "touches-customer-data",           // kebab-case, cannot shadow a built-in
        "name": "Touches customer data",         // optional; defaults to the id
        "definition": "Reading or writing rows in the production customer database, including via ORM scripts and migration tooling. Reading fixture or seed data in the repo is read-project instead.",
        "disposition": "deny"                    // optional; defaults to "ask"
      }
    ],
    // Rewrite what a built-in means to the namer, keyed by built-in class id.
    "definitions": {
      "run-dev-tools": "Running this project's own tooling: pnpm scripts, vitest, tsc, biome. Anything invoking terraform or kubectl is off-machine-effects instead."
    }
  },
  "dispositions": {
    "touches-customer-data": "deny"              // custom ids are valid rows
  }
}
```

`definition` is prompt text the namer reads verbatim, so write it as a decision
boundary ("X, but Y is class Z instead") rather than a description. An invalid
entry is skipped with a diagnostic and the rest of the config still loads.

Editing the taxonomy changes the payload prefix the namer sees, which
invalidates the provider's prompt cache once — the accepted cost of a
vocabulary you can edit.

### Session guidance

Answering a rail prompt with a comment records it as session guidance, which
is injected into every later namer and judge call. `/rail guide <text>` adds
an entry directly, without waiting to be asked:

```
/rail guide the deploy script in this repo is expected to push to staging
```

Entries share one ring with approval comments, capped at 12 (oldest drop out);
the confirmation reports the position, `Guidance added for this session
(3/12).` `/rail guide clear` empties it, and `/rail status` lists what is
currently in force. Guidance is session-scoped and never persisted.

### How an action gets named

```
deterministic mappers ──▶ content screen ──▶ namer (one cheap call)
        │                       │                    │
        └──────────▶ disposition table ◀─────────────┘
                allow │ ask │ deny │ judge
                                    │
                              judge (strong model, per action, ask-preferred)
```

- **Deterministic mappers** are caches of an obvious label, not of a verdict:
  in-cwd reads → `read-project`, allowlisted commands → their template's tag,
  `denyRead` matches → `credentials`, out-of-roots writes → `modify-system`.
  Because they cache a *label*, flipping a disposition row retunes the fast
  path too.
- **The content screen** (`src/content-screen.ts`) routes writes and edits
  deterministically: authorization/consent lexicon, phrasing aimed at future
  automated reviewers, persistence surfaces by path (manifests, git hooks,
  shell profiles, cron/launchd/systemd, SSH and agent config), manifest
  lifecycle-script additions, and credential shapes. Clean content gets
  `modify-project`/`modify-system` with zero tokens; tripped content goes to
  the namer.
- **The namer** is one call that returns only `{"labels":[…]}` plus an
  optional short authorization quote. It never decides. Write content is part
  of the action it names. Its output is parsed fail-closed: schema violations
  throw, unknown class ids are dropped, an empty set becomes `unclassified`.
- **The judge** runs only for classes you set to `judge`. It sees more than
  the namer — recent user messages, session guidance, the action, and the
  rail's last few decisions — and decides for that one action only, never as
  a standing approval. Deny is reserved for what confirmation cannot fix;
  everything else unclear is an ask. `classifier.judgeModel` defaults to
  `"current"` (the session's own model). A judge failure degrades to asking
  you, not to allowing.

Authorization evidence the namer quotes only ever *decorates* the confirmation
prompt ("reviewer notes: user said …") — it never removes one, which keeps the
fabricated-consent surface closed.

With the classifier off, capability mode reduces to the deterministic mappers
and the screen: labelled actions still resolve through the table (`judge`
degrades to `ask`), and anything that would need the namer passes through
unreviewed, exactly as before.

### Retired: classifier rule tiers

The prose rule tiers (`classifier.rules` with `allow`/`soft_deny`/`hard_deny`/
`environment`) have been **removed**. A config that still sets the key loads
fine and emits one diagnostic saying it is ignored; the lists are no longer
parsed, merged, or displayed. Their successor is the disposition table plus the
class definitions in `src/capabilities.ts` — edit both from `/rail policy`.

### Command allowlist

`commands.allow` lists command templates that resolve to a capability label
deterministically, with no model call. A rule is words plus an optional trailing `*`: `"pwd"`
matches exactly that command with no arguments, `"git status *"` matches
`git status` with any arguments. Heads compare verbatim (`/usr/bin/grep`
does not match `"grep *"`). The defaults cover read-only inspection
(`grep`, `rg`, `ls`, `cat`, `diff`, `du`, `jq`, hashing, …), read-only
system probes (`ps`, `printenv`, bare `env`/`date`/`hostname`), git's
read-only spellings (`status`/`log`/`diff`/`show`/`blame`/`grep`, exact
forms like `git remote -v`, `git stash list`, `git config --get`), and
toolchain version probes. The inclusion bar: every invocation matching a
template must be unable to write files, run other programs, or use the
network — which is why `find`, `sed`, `awk`, `sort`, `tee`, and `env CMD`
are deliberately absent (see the comment in `src/command-allowlist.ts`).

Each built-in template carries a capability tag: inspection and read-only git
are `read-project`, machine introspection (`uname`, `whoami`, `printenv`) is
`read-system`, and toolchain version probes are `run-dev-tools`. A chain takes
the union of its segments' tags. Templates you add in `commands.allow` are
plain strings and default to `read-project`.

Commands are parsed with a minimal shell grammar, and a chain (`&&`, `||`,
`;`, `|`, newlines) is exempt only when *every* command in it matches a rule:
`grep a || grep b` passes `"grep *"`, `grep a; rm x` does not. Quoting is
respected (a `;` inside quotes is data). Redirects, expansions (`$VAR`,
`$(…)`, backticks), subshells, background `&`, and anything outside the
grammar (heredocs, process substitution) fall through to normal review.

The deterministic labelling applies only while the sandbox is actually
enforcing (filesystem restrictions on with the Seatbelt backend initialized):
`grep` is only safe when Seatbelt bounds what it can read. Otherwise the
command goes to the namer.

```json
{
  "commands": {
    "allow": ["grep *", "git status *", "make lint"]
  }
}
```

The default namer model is `"auto"`: Pi Rail picks the best available
model from a known-good list (see `src/classifier-models.ts`), preferring
subscription providers (openai-codex, github-copilot) over per-token providers
like OpenRouter, and ordered by the benchmark in `eval/RESULTS.md` within each
provider. Models that failed the safety evals are never auto-selected. If none
of the known-good models has configured auth, auto falls back to the session's
current model. Set `"model"` to `"current"` or an explicit `provider/model-id`
to opt out of auto selection. `"judgeModel"` uses the same grammar and defaults
to `"current"`: the judge runs rarely and on the consequential tail, so it
should be the strong model you are already talking to, not the cheap namer.
`/rail model` (judge tab) and `/rail model judge …` write this key, and set a
session override that wins over it until Pi restarts.

## Filesystem policy

Set `filesystem.enabled` to `false` to disable deterministic path checks for
Pi file tools and filesystem restrictions for sandboxed commands. File actions
are still named and resolved through the disposition table. Environment
scrubbing is configured separately.

Reads are blacklist-based by default: tools and sandboxed commands can read ordinary system, project, and home files unless the path matches `denyRead`. The default read denylist covers common credential stores and sensitive app profiles on macOS and Linux, including SSH, cloud credentials, GPG, Kubernetes, Docker, browser profiles, keychains/keyrings, `.env` files, and private key files.

Writes are whitelist-based by default: tools and sandboxed commands can write to the project directory, including local `.git` metadata for normal source-control operations, temp directories, and common development caches such as npm/pnpm/yarn, Cargo registry/git caches, Gradle caches/wrapper, Maven local repository, Go module/build caches, pip caches, NuGet packages, Ivy/Coursier, Bazel, uv, Ruff, and pre-commit caches. Sensitive paths in `denyWrite` remain hard-blocked even if they overlap an allowed write root.

Use project or global config to narrow these defaults for more sensitive workspaces.

## Network policy

Network restrictions are enabled by default. The default allowed domains cover GitHub and common container registries: GitHub/GitHubusercontent/GHCR, Docker Hub, Quay, Google Container Registry and Artifact Registry, Kubernetes registry, Microsoft Container Registry, and public ECR. All other domains are denied by default.

Set `network.enabled` to `false` to disable network restrictions and allow
normal unrestricted networking. With networking disabled, no proxy is set up:
the sandbox runtime's local proxy is never started and sandboxed commands get
no proxy-related environment variables, so tools that break under proxying
work normally. To block networking entirely, keep the policy
enabled and use an empty allowlist:

```json
{
  "network": {
    "enabled": true,
    "allowedDomains": [],
    "deniedDomains": ["*"]
  }
}
```

## What is protected

- Agent `bash` tool calls are routed through Pi Rail.
- User `!` and `!!` bash commands are routed through Pi Rail.
- When filesystem restrictions are enabled, built-in `read`, `write`, and `edit` tool calls are checked by deterministic path policy because Seatbelt only contains subprocesses.
- When filesystem restrictions are enabled, reads are allowed by default except for configured sensitive paths, and writes are limited to configured roots.
- Environment variables are scrubbed before sandboxed commands are spawned: `environment.unset` patterns are removed first, then `environment.allow` (when non-empty) whitelists the rest. The default allow list passes CA-certificate variables (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `AWS_CA_BUNDLE`, `JAVA_TOOL_OPTIONS`, and friends) so a private CA reaches sandboxed tooling; to make that work, the default unset list names explicit AWS credential variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, …) instead of a broad `AWS_*` glob, with the generic `*_TOKEN`/`*_SECRET`/`*_KEY` globs as the backstop for unknown secrets.
- Every intercepted `bash`, `read`, `write`, and `edit` call is named with capability classes after deterministic policy checks and before execution; the disposition table then decides.
- Trusted reads never reach a model: a `read` whose canonical path is inside the session working directory or matches an explicit `allowRead` entry — and does not match `denyRead` — is labelled deterministically (0 tokens, 0 latency; counted as "Exempt (no model consulted)" in the status report, together with allowlisted commands and screen-clean writes). The allow/deny lists are consulted for this routing even when `filesystem.enabled` is `false`, which only disables *blocking*.
- A `read` matching `denyRead` is **not** hard-blocked any more: it is labelled `credentials`, which defaults to `judge`. Reading a test-fixture key and reading toward exfiltration are different actions, and telling them apart is a judgment call. `denyWrite` matches stay hard blocks — writes to secret and config paths are containment, not policy.
- Writes and edits are never exempted by path alone: their content goes through the deterministic content screen, and anything it trips on goes to the namer.
- Reviewer timeouts/network failures are retried with bounded exponential backoff up to five attempts and surfaced to the user. If no usable namer model is available, or fail-closed naming still fails after retries, Pi Rail stops the current turn for user intervention without exiting Pi. A judge failure instead degrades to asking you.

## Approval prompts and session guidance

When the rail needs a human decision — a class set to `ask`, a judge verdict
of `ask`, or a path outside the configured roots — the prompt offers four
choices: **Allow**, **Allow with comment**, **Deny**, and **Deny with
comment**. The prompt names the capabilities that were matched and the row
that decided, so a block is always attributable ("`off-machine-effects`, which
is set to ask (default)"). Comments become *session guidance*: user-authored
notes injected into the namer and the judge for the rest of the session, so
"allow — staging deploys are fine today" or "deny — never touch prod configs"
tunes behavior without editing config files. Deny comments are echoed to the
agent in the block reason so it can change course immediately. Guidance is
session-scoped (last 12 entries) and shown in the status popup.

The policy is ask-first throughout: `deny` is what you set for a class you
never want, and the judge reserves deny for actions that stay unsafe even
after you confirm them. Everything else that merely lacks authorization
becomes a question to you, because answering the question *is* the
authorization process.

## Headless sessions and subagents

`ctx.hasUI` tells the rail whether anyone can answer a prompt:

- **TUI** — prompts are interactive dialogs.
- **RPC mode** (`pi --mode rpc`) — prompts become `extension_ui_request`
  events on stdout; the driving client answers them over the protocol, so
  approvals work if the client implements that sub-protocol (see pi's
  `docs/rpc.md` and `examples/rpc-extension-ui.ts`). Every rail interface
  degrades to protocol dialogs there: approval prompts become select+input,
  and the `/rail` control panel, reviewer model picker, and statusline
  chooser become plain select dialogs (search and live headers are TUI-only).
  `/rail status` and `/rail policy rules` toggle live *widgets*
  (fire-and-forget `setWidget` requests keyed `rail-status`/`rail-policy`,
  refreshed on every rail event) — user-visible in any client that renders
  widgets, and never part of agent context. The two-tab policy page is
  TUI-only, so `/rail policy rules` stays a standalone widget here while
  `/rail policy` (the table) degrades to select dialogs, class editing
  included. Smoke and critique results arrive the same
  way, keyed `rail-report`.
- **json / print modes** — truly headless: there is no one to ask. Ask
  decisions and out-of-roots path approvals become blocks whose reason states
  exactly that ("headless session with no user to ask"), so the agent — or a
  parent process reading the transcript — knows the block is about approval
  availability, not policy.

Subagents spawned as `pi --mode json` subprocesses are therefore headless,
and the denial reason is the propagation channel that exists today. To
propagate the *question* instead, run subagents in RPC mode and forward the
extension-UI requests to the parent's UI — that works with unmodified
pi-rail. A rail-to-rail approval side channel was considered and deferred
(see [docs/history/FEEDBACK_PLAN.md](docs/history/FEEDBACK_PLAN.md)).

### pi-subagents interop

The [`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension
(not affiliated; also distinct from the npm `pi-guard` package it recommends
for bash policy) spawns children that inherit your installed extensions by
default, so each child runs its own rail instance. Pi Rail participates in
its acknowledgement channel both ways:

- **As a child**, when the rail is enforcing it emits
  `subagent:acknowledge-extension` (id `pi-rail`) so the run status records
  that the child was on the rail. The pre-rename id `pi-extension-guard` is
  still accepted parent-side, so a new parent does not mistake an older child
  for one that ran without the rail.
- **As the parent**, it inspects `subagent`/`subagent_wait` results and warns
  once per finished child that never acknowledged — that child ran
  without the rail. Common causes: the agent profile declares `extensions:`
  frontmatter, `subagents.defaultExtensions` is set, a capability ceiling
  passes `--no-extensions`, the agent is an external-CLI runner, or the
  rail was loaded via `pi -ne -e` and is not in ambient settings.

Both channels are best-effort observability, never enforcement.

## Decision telemetry

Every rail decision — capability reviews, deterministic policy blocks, path
approvals, and reviewer errors — is recorded as a `custom` entry
(`customType: "rail"`) in pi's own session log, next to the tool call it
judged. Entries do not participate in LLM context and are written
best-effort: telemetry never blocks or breaks a tool call, and ephemeral
sessions simply skip persistence. Sessions recorded before the rename carry
`customType: "guard"`; the analysis tooling reads both, so an existing corpus
stays usable.

`classifier.telemetry` controls verbosity:

- `"minimal"` (default): decision, capability labels, resolved disposition and
  the row that decided, content-screen verdict, judge fields (model, verdict,
  latency, tokens) when the judge ran, attempts, latency, token usage, namer
  model, reason, and a truncated projection of the tool input.
- `"full"`: complete projection including the policy summary, for eval-case
  extraction.
- `"off"`: no telemetry.

Note that session files can be shared (`pi share` uploads the whole file), so
records stay minimal by default even though the session already contains the
full tool call inputs.

`npm run telemetry` (`eval/session-stats.ts`) aggregates rail entries across
all local sessions: decision rates, capability label frequencies, judge and
screen-trip rates, retry rate, latency p50/p95/max, token cost, models used,
path approvals, and errors.
`npm run telemetry -- --cases` dumps denied/rejected reviews as eval-case
candidates, flagging ones where the same command was executed later in the
session (false-positive candidates worth adding to `eval/cases.ts`).

## Limitations

Pi Rail is a defense-in-depth containment layer, not a complete adversarial security boundary.

- Seatbelt applies to spawned subprocesses, not arbitrary Pi extension code.
- Domain-level network allowlisting is limited and depends on the sandbox runtime's hostname handling. A proxy layer is a better future design for more precise domain policy.
- Broad workspace write access can still allow project-local persistence. Local `.git` writes are allowed so explicit git commands can work; rely on the `off-machine-effects`, `local-destructive`, and `persistence` classes for risky source-control actions, and keep protected paths like `.pi`, `.env`, keys, and shell startup files denied.
- Unix sockets, Docker sockets, inherited credentials, and overly broad writable directories can weaken isolation.
- The namer only names; the disposition table decides. A prompt-injected namer can at worst mislabel a capability, and the table still refuses a class you set to deny. Neither reviewer can override deterministic deny rules or Seatbelt.
- The judge holds decision authority only for classes you explicitly delegated to it, only for one action at a time, and never above a deny that severity-max already produced.
- Disabling filesystem or network restrictions deliberately removes those hard boundaries; reviewer decisions can be wrong or unavailable.

## Future container backend

The backend interface is in `src/backends/types.ts`. A future `container` backend should implement the same interface and reuse the config/policy modules.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test (Node 22.18+ runs TypeScript directly)
npm run test:tui  # tmux-driven TUI integration test (skips without tmux + pi)
```

### UI architecture

Three seam modules own every run-mode branch; feature code never inspects
`ctx.mode` to pick a presentation:

- `src/live-view.ts` — display surfaces (status, policy rules, smoke/critique
  reports): docked panel in the TUI, `setWidget` over RPC, a stderr error
  headless. `showRailView` replaces any open view; `toggleRailView` adds
  toggle semantics for the recurring views; `toggleRailPanel` hosts an
  interactive panel (the disposition page) and returns false where custom
  components do not exist, so the caller degrades.
- `src/approvals.ts` — response dialogs (approval prompts): a custom dialog
  with inline comment input in the TUI, `select`+`input` protocol dialogs
  over RPC. Callers gate on `ctx.hasUI` first because headless approval
  absence is a policy decision (block with an explanatory reason), not a
  presentation choice.
- `src/tui/select-list.ts` — pickers (control panel, model selector,
  statusline chooser): searchable list in the TUI, plain `select` dialog
  elsewhere; resolves `undefined` where no dialog capability exists, which
  callers already treat as cancel.

The disposition page follows the same rule: `src/dispositions.ts` holds the
row model (values, provenance, stats, class add/edit/delete, save) with no UI
in it, and the two surfaces — `src/tui/disposition-page.ts` and the RPC select
loop in `src/commands/dispositions.ts` — render it. The class vocabulary
itself lives one level down in `src/capabilities.ts`: `capabilityRegistry()`
folds built-ins, config classes, and session edits into the ordered list that
both the table and the namer payload read.

Transient signals (`notify`, `setStatus`) work in TUI and RPC and no-op
headless. New UI belongs in one of these seams — extend them rather than
branching on mode inline, so every surface degrades consistently.

### Reviewer testing layers

The reviewers are verified at four layers, and only the last one touches a live model:

1. **Protocol** (`test/classifier-protocol.test.ts`): projection building, payload construction, response parsing, and error classification are pure functions in `src/classifier-protocol.ts`. The key property pinned here is fail-closed parsing — any model output outside the exact JSON schema throws instead of being interpreted, while unknown class ids are dropped and an empty label set becomes `unclassified`.
2. **Screen** (`test/content-screen.test.ts`): the deterministic write/edit screen. The load-bearing case is the regression test that imports the round-2 `subtle-*` cases from `eval/cases.ts` and asserts every one trips the screen — those cases are exactly what a path-only exemption misses, so a screen that lets one through is a broken screen.
3. **Orchestration** (`test/classifier-flow.test.ts`, `test/interceptor.test.ts`, `test/capabilities.test.ts`): the single-call namer, the judge, the shared retry budget, backoff, timeout, auth failures, deterministic label routing, and severity-max table resolution run against scripted fakes, so they are deterministic. No LLM is involved.
4. **Judgment** (`eval/`): whether a real model names and judges well is measured, not asserted. `npm run eval -- provider/model [provider/model ...]` runs the golden dataset in `eval/cases.ts` through the production path — namer, built-in disposition table, judge when the table escalates — and reports decision agreement, critical misses (a "critical" case decided as allow), the labels each case got, judge rate, latency, and token usage. Pass several models to compare them. One model plays both seats there; in production the judge defaults to the session model. API keys come from the usual env vars (`ANTHROPIC_API_KEY`, etc). The eval exits non-zero if any critical case was allowed. It is intentionally not part of `npm test`.

Keys resolve from the provider env var first, then fall back to pi's own auth store (`auth.json` in the pi agent dir) for providers you logged into via pi with an API key — so if `/login` in pi works for a provider, the eval usually needs no extra setup. OAuth-based pi logins (like Claude Pro/Max) are not usable here; those providers still need an env var.

With an OpenRouter key, one `OPENROUTER_API_KEY` covers models from every vendor, which makes cross-vendor comparison easy:

```bash
OPENROUTER_API_KEY=... npm run eval -- \
  openrouter/anthropic/claude-haiku-4.5 \
  openrouter/openai/gpt-5-mini \
  openrouter/google/gemini-2.5-flash
```

Model ids under `openrouter/` follow OpenRouter's own `vendor/model` naming. Ids missing from pi-ai's pinned catalog are synthesized automatically, since OpenRouter serves everything through one OpenAI-compatible endpoint.

The `@earendil-works/*` packages are declared as peer dependencies because Pi
provides them at runtime. Pinned development copies are installed only for
local typechecking and tests.

The same filesystem config is enforced by two engines: `src/policy.ts` for Pi's file tools and the Seatbelt profile for bash. Both consume `compileFilesystemPolicy` (in `src/policy.ts`), which resolves each pattern once and reports the ones a Seatbelt profile cannot express — glob patterns (`.env.*`, `*.pem`) and bare names (`.env`), which reach the sandbox as literal resolved paths — in its `degraded` list. Degraded patterns surface as a session-start warning and in `/rail status`. `test/policy-seatbelt-agreement.test.ts` pins down that both engines deny the same sensitive locations and that every unexpressible pattern is declared degraded; extend it when adding deny patterns.
