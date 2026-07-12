# Plan: Pi Guard Extension

> Historical design document. This records the original implementation plan
> and does not describe the current feature set, commands, or defaults. See
> the repository README for current documentation.

## Background

The current workspace is empty, so this plan targets a new Pi extension package rather than modifying existing project code. Pi extensions can intercept lifecycle/tool events, override built-in tools, wrap built-in tool operations, register flags and commands, and route `!` user bash commands through custom `BashOperations`.

The most relevant Pi reference implementation is `examples/extensions/guard/`, which:
- Uses `@anthropic-ai/sandbox-runtime`.
- Overrides the built-in `bash` tool via `createBashTool(..., { operations })`.
- Wraps bash commands with `SandboxManager.wrapWithSandbox(command)`.
- Applies merged global/project config from `~/.pi/agent/extensions/guard.json` and `<cwd>/.pi/guard.json`.
- Handles `user_bash` with the same sandboxed operations.
- Exposes status UI and a `/guard` command.

This plan keeps macOS Seatbelt as the first backend and deliberately designs a backend boundary so container-based sandboxing can be added later. Windows and non-container Linux are out of scope for now.

## Specifications

### Goals

1. Provide a Pi extension that runs shell commands under macOS Seatbelt by default.
2. Protect common credential and host-sensitive paths from sandboxed command reads/writes.
3. Restrict writes to the workspace and configured temporary directories.
4. Make network behavior explicit and configurable, with a conservative default.
5. Route both agent `bash` tool calls and user `!` / `!!` bash commands through the same sandbox path.
6. Keep a clean abstraction for future backends, especially container backends.
7. Fail closed for risky execution when sandbox initialization or policy compilation fails, unless the user explicitly disables sandboxing.

### Non-goals

1. No Windows support.
2. No direct Linux bubblewrap implementation in this phase.
3. No claim of adversarial complete containment.
4. No LLM reviewer/classifier in this extension MVP; this sandbox is the enforcement layer that a future auto-mode reviewer could rely on.
5. No transparent TLS inspection or robust domain-fronting defense.

### Proposed package layout

```text
.pi/extensions/guard/
  package.json
  index.ts
  src/
    config.ts
    policy.ts
    backends/
      types.ts
      seatbelt.ts
      none.ts
    tools/
      bash.ts
    ui.ts
  README.md
```

For a user-global install, the same directory can live under `~/.pi/agent/extensions/guard/`.

### Configuration

Merge config in this order, later wins:

1. Built-in defaults.
2. Global config: `~/.pi/agent/extensions/guard.json`.
3. Trusted project config: `<cwd>/.pi/guard.json`.

Project config should only be honored when `ctx.isProjectTrusted()` is true.

Example config:

```json
{
  "enabled": true,
  "backend": "seatbelt",
  "filesystem": {
    "allowRead": [".", "/tmp"],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", ".env", ".env.*"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".git", ".pi", ".env", ".env.*", "*.pem", "*.key"]
  },
  "environment": {
    "unset": ["AWS_*", "GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    "allow": ["PATH", "HOME", "TMPDIR", "CI", "TERM"]
  },
  "network": {
    "enabled": false,
    "allowedDomains": [],
    "deniedDomains": ["*"]
  }
}
```

### Backend abstraction

Define a backend interface before implementing Seatbelt specifics:

```ts
interface GuardBackend {
  name: string;
  supported(): Promise<{ ok: true } | { ok: false; reason: string }>;
  initialize(config: ResolvedGuardConfig, ctx: ExtensionContext): Promise<void>;
  wrapBash(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<WrappedCommand>;
  shutdown(): Promise<void>;
}
```

`WrappedCommand` should describe command executable, argv, cwd, env, and optional diagnostics. This avoids hard-coding `bash -c` wrappers throughout the extension and leaves room for a future `container` backend.

### Seatbelt backend behavior

Preferred implementation path:

1. Reuse `@anthropic-ai/sandbox-runtime` if it remains compatible and sufficient.
2. Keep the Pi reference implementation’s proven pattern: initialize a `SandboxManager`, call `wrapWithSandbox(command)`, spawn `bash -c <wrappedCommand>` in a detached process group, and kill the process group on abort/timeout.
3. If `@anthropic-ai/sandbox-runtime` lacks necessary control, isolate direct Seatbelt profile generation in `src/backends/seatbelt.ts` rather than leaking it into tool code.

The Seatbelt profile should:
- Deny by default where possible.
- Allow process execution needed for local build/test tooling.
- Allow reads in workspace and configured read roots, minus explicit deny paths.
- Allow writes only in configured write roots, minus explicit deny paths.
- Optionally deny network entirely for MVP, or delegate domain allowlisting to a later proxy layer because Seatbelt is not a high-level domain policy engine.

### Tool integration

MVP tool integration:
- Override built-in `bash` with `createBashTool(localCwd, { operations: createGuardedBashOps(...) })`.
- Intercept `user_bash` and return the same sandboxed operations.
- Register `--no-guard` for explicit opt-out.
- Register `/guard` to show resolved config, selected backend, initialization state, and recent denials/errors.

Important follow-up integration:
- Add `tool_call` deterministic gates for `read`, `write`, and `edit` paths, because Seatbelt only contains subprocesses and does not automatically constrain Pi’s built-in file tools.
- Either block built-in file tool access outside policy or override file tools with policy-checking wrappers.

### Denial and failure semantics

- If sandboxing is enabled but the backend is unsupported or fails to initialize, block bash execution and return a clear reason.
- If config parsing fails, ignore only the invalid config file and warn; if the resulting config is invalid, fail closed.
- If a command is blocked, return actionable feedback without suggesting bypasses.
- If `--no-guard` is set, run unsandboxed but visibly mark status as disabled.

### Future container backend

Design now for:

```json
{
  "backend": "container",
  "container": {
    "image": "pi-guard:latest",
    "workspaceMount": "/workspace",
    "network": "none"
  }
}
```

The container backend should implement the same `GuardBackend` interface and reuse policy/config normalization. Do not bake Seatbelt terms into public config names except under a backend-specific `seatbelt` object.

## Key Changes

1. Create a new extension package with TypeScript source and `pi.extensions` metadata.
2. Implement config loading, schema validation, path expansion, and project-trust-aware project config.
3. Implement a backend abstraction with a first `seatbelt` backend.
4. Implement sandboxed `BashOperations` and process-group cleanup.
5. Override Pi’s built-in `bash` tool and `user_bash` execution.
6. Add deterministic path gates or wrappers for built-in file tools as a safety complement.
7. Add `/guard` diagnostics and footer status.
8. Document limitations, setup, and examples.

## Steps

1. Scaffold extension package
   - Add `package.json` with `type: "module"`, `pi.extensions: ["./index.ts"]`, and required dependencies.
   - Add `index.ts` as the extension entrypoint.
   - Add `README.md` with install/use instructions.

2. Implement config module
   - Define default config.
   - Load global config and trusted project config.
   - Validate config shape with useful errors.
   - Normalize paths: `~`, relative paths against `ctx.cwd`, glob-like entries retained for policy matching.

3. Implement policy module
   - Provide path classification helpers: allowed read/write, denied read/write, protected paths.
   - Add environment scrubbing helpers.
   - Add command-independent diagnostics used by `/guard`.

4. Implement backend interface
   - Add `src/backends/types.ts`.
   - Add `src/backends/none.ts` for explicit disabled/no-op mode in tests.
   - Add `src/backends/seatbelt.ts`.

5. Implement Seatbelt backend
   - Start with `@anthropic-ai/sandbox-runtime` to match the reference implementation.
   - Initialize once per session.
   - Wrap commands on execution.
   - Reset/cleanup on `session_shutdown`.
   - Return clear unsupported-platform errors when `process.platform !== "darwin"`.

6. Implement sandboxed bash operations
   - Spawn wrapped command with `bash -c` or backend-provided executable/args.
   - Set `cwd` to the current workspace.
   - Scrub environment before spawn.
   - Stream stdout/stderr through Pi’s `onData`.
   - Support timeout and abort by killing the process group.

7. Register extension hooks
   - Register `--no-guard` and optional diagnostics flags.
   - On `session_start`, resolve config and initialize backend.
   - Override `bash` with sandboxed operations.
   - Route `user_bash` through sandboxed operations.
   - On `session_shutdown`, cleanup backend state.

8. Add file-tool deterministic gate
   - In `tool_call`, inspect `read`, `write`, and `edit` inputs.
   - Apply normalized path policy.
   - Block out-of-policy paths with specific reasons.
   - Document that this is a Pi tool policy gate, while Seatbelt protects subprocesses.

9. Add UI/commands
   - Show status: enabled/disabled, backend, network mode, write roots.
   - Add `/guard` for resolved config and state.
   - Add warnings for unsupported platform, disabled sandbox, or project config ignored due to untrusted project.

10. Add tests/check scripts where practical
   - Config merge/validation unit tests.
   - Path policy unit tests.
   - Environment scrubbing unit tests.
   - macOS smoke script for sandbox behavior.

11. Document limitations
   - Seatbelt applies to spawned subprocesses, not arbitrary Pi extension code.
   - Built-in file tools need explicit policy gates/wrappers.
   - Domain-level network allowlisting is not solved by Seatbelt alone.
   - Unix sockets, Docker socket, broad writable roots, and inherited credentials can weaken isolation.

## Validation Steps

1. Static checks
   - `npm install`
   - `npm run check` or equivalent TypeScript check if configured.

2. Config validation
   - Start Pi with no config and verify defaults appear in `/guard`.
   - Add invalid JSON globally and verify warning behavior.
   - Add project config in a trusted project and verify it overrides global config.
   - Verify project config is ignored or warned when project is untrusted.

3. Platform behavior
   - On macOS, verify Seatbelt backend initializes.
   - On non-macOS, verify it fails closed with a clear unsupported message unless disabled.

4. Filesystem enforcement smoke tests on macOS
   - `bash: touch sandbox-ok.txt` succeeds in workspace.
   - `bash: touch /tmp/pi-guard-ok` succeeds if `/tmp` is allowed.
   - `bash: cat ~/.ssh/config` fails when `~/.ssh` is deny-read.
   - `bash: echo x > ~/.ssh/pi-test` fails.
   - `bash: echo x > .env` fails when `.env` is deny-write.

5. Pi file-tool policy tests
   - `read` on an allowed workspace file succeeds.
   - `read` on a denied credential path is blocked before execution.
   - `write` or `edit` on `.env` is blocked.
   - `write` in workspace succeeds.

6. Execution lifecycle tests
   - Long-running command is killed on timeout.
   - Command is killed when the turn is aborted.
   - `/reload` or session shutdown resets backend state cleanly.
   - `!` and `!!` user bash commands are sandboxed the same way as agent bash.

7. Opt-out behavior
   - `pi -e ./guard --no-guard` runs unsandboxed and displays disabled status.

## Success Criteria

1. On macOS, agent and user bash commands execute through Seatbelt by default.
2. Denied file reads/writes from subprocesses fail in smoke tests.
3. Pi built-in `read`, `write`, and `edit` calls are blocked when they violate configured policy.
4. Sandbox initialization failure blocks bash execution unless explicitly disabled.
5. Config merging is deterministic and documented.
6. The code has a backend interface suitable for adding a future container backend without rewriting tool integration.
7. `/guard` accurately reports enabled state, backend, policy summary, and relevant warnings.
8. README clearly states security limitations and setup requirements.

## Risks

1. `@anthropic-ai/sandbox-runtime` may not expose enough direct Seatbelt control; mitigate by isolating it behind `SeatbeltBackend` so a direct profile generator can replace it.
2. Seatbelt network policy may not satisfy domain allowlisting expectations; mitigate by defaulting network off and planning a proxy layer later.
3. Built-in file tools bypass OS sandboxing; mitigate with deterministic path gates or file-tool overrides.
4. Broad workspace write access can still allow malicious project-local persistence; mitigate with protected paths like `.git`, `.pi`, `.env`, package-manager config, and shell startup files.
5. Secrets inherited in environment can be leaked through allowed channels; mitigate with environment scrubbing by default.
6. Shell command parsing remains hard; rely on Seatbelt for enforcement rather than command allowlists.
