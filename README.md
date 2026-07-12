# Pi Guard Extension

Defense-in-depth command and file-tool guardrails for Pi. Today Pi Guard uses macOS Seatbelt for contained shell execution, deterministic path policy for Pi file tools, environment scrubbing, and an optional LLM classifier. The extension is structured around a backend interface so a container backend can be added later.

## Relationship to pi-sandbox

Pi Guard is inspired by Chris Arderne's [`pi-sandbox`](https://github.com/carderne/pi-sandbox), which provides OS-level sandboxing for Pi with interactive permission prompts. Both extensions wrap shell execution in an OS sandbox and intercept Pi's direct `read`, `write`, and `edit` tools because those file operations do not run inside subprocess containment.

The main differences are:

- Pi Guard adds an optional AI classifier that semantically reviews `bash`, `read`, `write`, and `edit` calls after deterministic policy checks.
- Pi Guard currently targets macOS Seatbelt via `@anthropic-ai/sandbox-runtime`; `pi-sandbox` supports macOS `sandbox-exec` and Linux `bubblewrap` through `@carderne/sandbox-runtime`.
- Pi Guard treats configured deny-write paths as hard blocks and keeps path approvals session-local; `pi-sandbox` emphasizes interactive prompts that can persist allowances to project or global config.
- Pi Guard includes environment scrubbing and classifier rule critique/model selection commands in addition to sandbox status controls.

If you do not need classifier review and want the mature prompt-oriented sandbox, especially on Linux, start with `pi-sandbox`.

## Scope

- Supported now: macOS Seatbelt containment for `bash` and user `!` / `!!` commands.
- Supported now: policy checks for built-in `read`, `write`, and `edit` tools.
- Optional: classifier review of `bash`, `read`, `write`, and `edit` actions.
- Planned later: container backend.
- Not goals now: Windows, non-container Linux.

## Install

Pi extensions execute with the same system permissions as Pi. Review the source
and security limitations before installing third-party extensions.

Install Pi Guard directly from GitHub:

```bash
pi install git:github.com/aluminous/pi-guard
```

To try it for one run without adding it to your settings:

```bash
pi -ne -e git:github.com/aluminous/pi-guard
```

To remove it later:

```bash
pi remove git:github.com/aluminous/pi-guard
```

For local development, clone the repository and install dependencies:

```bash
git clone https://github.com/aluminous/pi-guard.git
cd pi-guard
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

- `--no-guard`: explicitly disable Pi Guard and run bash unguarded.

Commands — everything lives under `/guard`, with argument autocomplete:

- `/guard`: open the control panel (searchable actions with a live status header). Outside the TUI it posts the status report instead.
- `/guard status`: post the full status report (policy, approvals, recent decisions, warnings).
- `/guard on`: enable Pi Guard.
- `/guard off`: disable for the next agent turn, then re-enable automatically.
- `/guard off session`: disable until the session ends.
- `/guard model`: choose the classifier model interactively.
- `/guard model auto|current|off|provider/model-id`: set the classifier model directly and save it globally. `auto` (the default) picks the best available known-good model, preferring subscription providers.
- `/guard model status`: print classifier status, resolved model, and available models.
- `/guard smoke`: run the command-containment and classifier smoke tests.
- `/guard critique [provider/model-id]`: critique the classifier rules with Pi's current model or a specific one.

Statusline legend — the guard statusline is deliberately terse:

```
Guard: seatbelt, 26 domains, auto (openai-codex/gpt-5.4-mini) R2(+1) C4 D1 ↑12k ↓800
```

`R` = deterministic policy rule hits, `C` = classifier reviews, `D` = classifier
denials, `(+n)` = added this turn, `↑`/`↓` = classifier input/output tokens this
session. The counters turn yellow when there are denials, blocks, or errors.

## Configuration

Config is merged in this order:

1. Built-in defaults.
2. `~/.pi/agent/extensions/guard.json`
3. `<cwd>/.pi/guard.json` when the project is trusted.

`/guard model` persists classifier choices by updating the global extension config at `~/.pi/agent/extensions/guard.json`. It does not write extension-specific fields into Pi's main `settings.json`. A trusted project config can still override the global classifier settings.

Example `.pi/guard.json`:

```json
{
  "enabled": true,
  "backend": "seatbelt",
  "filesystem": {
    "allowRead": [],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc", ".env", ".env.*", "*.pem", "*.key"],
    "allowWrite": [".", "/tmp", "~/.cache", "~/Library/Caches", "~/.npm", "~/.cargo/registry", "~/.cargo/git", "~/.gradle/caches", "~/.m2/repository", "~/go/pkg/mod"],
    "denyWrite": [".pi", ".env", ".env.*", "*.pem", "*.key", "~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker"]
  },
  "environment": {
    "allow": ["PATH", "HOME", "TMPDIR", "CI", "TERM"],
    "unset": ["AWS_*", "GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
  },
  "network": {
    "enabled": true,
    "allowedDomains": ["github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "*.ghcr.io", "docker.io", "*.docker.io", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "quay.io", "*.quay.io", "gcr.io", "*.gcr.io", "*.pkg.dev", "registry.k8s.io", "mcr.microsoft.com", "public.ecr.aws"],
    "deniedDomains": ["*"]
  },
  "classifier": {
    "enabled": false,
    "model": "auto",
    "timeoutMs": 8000,
    "failClosed": true
  }
}
```

The default classifier model is `"auto"`: Pi Guard picks the best available
model from a known-good list (see `src/classifier-models.ts`), preferring
subscription providers (openai-codex, github-copilot) over per-token providers
like OpenRouter, and ordered by the benchmark in `eval/RESULTS.md` within each
provider. Models that failed the safety evals are never auto-selected. If none
of the known-good models has configured auth, auto falls back to the session's
current model. Set `"model"` to `"current"` or an explicit `provider/model-id`
to opt out of auto selection.

## Filesystem policy

Reads are blacklist-based by default: tools and sandboxed commands can read ordinary system, project, and home files unless the path matches `denyRead`. The default read denylist covers common credential stores and sensitive app profiles on macOS and Linux, including SSH, cloud credentials, GPG, Kubernetes, Docker, browser profiles, keychains/keyrings, `.env` files, and private key files.

Writes are whitelist-based by default: tools and sandboxed commands can write to the project directory, including local `.git` metadata for normal source-control operations, temp directories, and common development caches such as npm/pnpm/yarn, Cargo registry/git caches, Gradle caches/wrapper, Maven local repository, Go module/build caches, pip caches, NuGet packages, Ivy/Coursier, Bazel, uv, Ruff, and pre-commit caches. Sensitive paths in `denyWrite` remain hard-blocked even if they overlap an allowed write root.

Use project or global config to narrow these defaults for more sensitive workspaces.

## Network policy

Network access is enabled by default but allowlisted. The default allowed domains cover GitHub and common container registries: GitHub/GitHubusercontent/GHCR, Docker Hub, Quay, Google Container Registry and Artifact Registry, Kubernetes registry, Microsoft Container Registry, and public ECR. All other domains are denied by default.

Set `network.enabled` to `false` to block network access entirely, or override `allowedDomains` in global/project config for stricter or broader workflows.

## What is protected

- Agent `bash` tool calls are routed through Pi Guard.
- User `!` and `!!` bash commands are routed through Pi Guard.
- Built-in `read`, `write`, and `edit` tool calls are checked by deterministic path policy because Seatbelt only contains subprocesses.
- Reads are allowed by default except for configured sensitive paths.
- Writes are limited to configured write roots and blocked for configured sensitive paths.
- Environment variables are scrubbed before guarded commands are spawned.
- If enabled, the classifier reviews `bash`, `read`, `write`, and `edit` calls after deterministic policy checks and before execution.
- Classifier timeouts/network failures are retried with bounded exponential backoff up to five attempts and surfaced to the user. If no usable classifier model is available, Pi Guard stops the current turn. If fail-closed review still fails after retries, Pi Guard stops the session for user intervention.

## Limitations

Pi Guard is a defense-in-depth containment layer, not a complete adversarial security boundary.

- Seatbelt applies to spawned subprocesses, not arbitrary Pi extension code.
- Domain-level network allowlisting is limited and depends on the sandbox runtime's hostname handling. A proxy layer is a better future design for more precise domain policy.
- Broad workspace write access can still allow project-local persistence. Local `.git` writes are allowed so explicit git commands can work; rely on classifier review for risky source-control actions, and keep protected paths like `.pi`, `.env`, keys, and shell startup files denied.
- Unix sockets, Docker sockets, inherited credentials, and overly broad writable directories can weaken isolation.
- The LLM classifier is a semantic reviewer, not enforcement. It cannot override deterministic deny rules or Seatbelt.

## Future container backend

The backend interface is in `src/backends/types.ts`. A future `container` backend should implement the same interface and reuse the config/policy modules.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test (Node 22.18+ runs TypeScript directly)
```

### Classifier testing layers

The classifier is verified at three layers, and only the last one touches a live model:

1. **Protocol** (`test/classifier-protocol.test.ts`): projection building, payload construction, response parsing, and error classification are pure functions in `src/classifier-protocol.ts`. The key property pinned here is fail-closed parsing — any model output outside the exact JSON schema throws instead of being interpreted.
2. **Orchestration** (`test/classifier-flow.test.ts`): the two-stage fast/full flow, shared retry budget, backoff, timeout, and auth failures run against a scripted fake `ClassifierIO` (`src/classifier.ts`), so they are deterministic. No LLM is involved.
3. **Judgment** (`eval/`): whether a real model makes good decisions is measured, not asserted. `npm run eval -- provider/model [provider/model ...]` runs the golden dataset in `eval/cases.ts` through the production review flow and reports decision agreement, critical misses (a "critical" case decided as allow), fast-path rate, latency, and token usage — pass several models to compare them for the quality/latency tradeoff. API keys come from the usual env vars (`ANTHROPIC_API_KEY`, etc). The eval exits non-zero if any critical case was allowed. It is intentionally not part of `npm test`.

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

The same filesystem config is enforced by two engines: `src/policy.ts` for Pi's file tools and the Seatbelt profile for bash. `test/policy-seatbelt-agreement.test.ts` pins down that both deny the same sensitive locations; extend it when adding deny patterns. Note that glob patterns (`.env.*`, `*.pem`) are matched by the policy engine but passed to Seatbelt as literal resolved paths.
