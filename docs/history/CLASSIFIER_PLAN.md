# Plan: Add LLM Classifier / Reviewer to Pi Guard Extension

> Historical design document. This predates the classifier implementation and
> retains superseded command names and design choices for project history. See
> the repository README for current documentation.

## Background

The current extension provides:

- macOS Seatbelt sandboxing for `bash` and user `!` / `!!` commands through `@anthropic-ai/sandbox-runtime`.
- Deterministic path policy gates for Pi `read`, `write`, and `edit` tools.
- `/guard` and `/guard-smoke` commands.
- Config loading from global and trusted project config.

It does **not** currently include an LLM classifier. The next change should add a separate reviewer layer that evaluates ambiguous or risky tool calls before execution. This reviewer should not replace deterministic policy or Seatbelt enforcement; it should sit between policy fast paths and tool execution.

Pi extension APIs support model access through `ctx.modelRegistry`, `ctx.model`, and `@earendil-works/pi-ai/compat` `complete(...)`, as shown in Pi’s `handoff.ts` and `summarize.ts` extension examples. Model selection can be exposed as a slash command.

## Specifications

### Goals

1. Add an optional LLM reviewer/classifier for risky or ambiguous tool calls.
2. Let the user choose the classifier model from configured/available Pi provider models.
3. Provide a `/guard-model` command for inspecting and changing the classifier model.
4. Fail closed when classifier review is required but unavailable, times out, or returns invalid output.
5. Keep deterministic deny rules and Seatbelt as the enforcement boundary.
6. Avoid passing persuasive assistant prose or raw untrusted tool output to the classifier.

### Non-goals

1. Do not implement a full Claude/Codex-quality auto-mode in one pass.
2. Do not classify every safe fast-path action by default.
3. Do not let the classifier override deterministic hard denies.
4. Do not treat the classifier as a sandbox.
5. Do not add external dependencies beyond current Pi/Anthropic packages.

## Proposed User Experience

### `/guard-model`

Behaviors:

- `/guard-model` with no args:
  - In TUI/RPC mode, show a selectable list of configured/available models.
  - In print/json mode, print current classifier model and available models.
- `/guard-model current`:
  - Set classifier model to Pi’s current active model.
- `/guard-model provider/model-id`:
  - Set classifier model directly if found in `ctx.modelRegistry`.
- `/guard-model off`:
  - Disable classifier while keeping deterministic policy + sandbox.
- `/guard-model status`:
  - Show classifier state, selected model, last decision, and failure mode.

Persist model choice in extension/session state initially; optionally support config persistence later. Because extension command handlers should not silently edit user settings, persistent global config writes should be a follow-up unless explicitly requested.

### Config additions

Add to `guard.json`:

```json
{
  "classifier": {
    "enabled": true,
    "model": "current",
    "timeoutMs": 8000,
    "failClosed": true,
    "review": {
      "bash": "risky",
      "read": "out-of-policy-only",
      "write": "risky",
      "edit": "risky"
    }
  }
}
```

Default proposal:

```json
{
  "classifier": {
    "enabled": false,
    "model": "current",
    "timeoutMs": 8000,
    "failClosed": true
  }
}
```

Rationale: ship disabled by default first, so users can validate sandbox behavior independently. Enable with config or `/guard-model current` + `/guard-classifier on` if we add that command.

## Architecture

Add modules:

```text
.pi/extensions/guard/src/classifier/
  types.ts
  projection.ts
  prompt.ts
  reviewer.ts
  model-selection.ts
```

### 1. Projection

Build a review object from the pending tool call, not from raw transcript dumps.

Example projection:

```ts
interface ReviewActionProjection {
  toolName: string;
  inputSummary: unknown;
  cwd: string;
  paths: string[];
  command?: string;
  networkLikely?: boolean;
  policyDecision?: string;
}
```

Projection rules:

- `bash`: include command string, cwd, likely path references if cheap to infer, and sandbox policy summary.
- `read`: include path only.
- `write`: include path, content length, small prefix only; do not send full file content by default.
- `edit`: include path and edit count; include small prefixes of old/new text only.
- Avoid tool results and arbitrary file contents.
- Do not include assistant explanations.

### 2. Context selection

The reviewer input should include:

- Recent user messages from current branch.
- Project context names/paths if needed, not full raw tool outputs.
- Resolved sandbox policy summary.
- Pending action projection.

Exclude:

- Assistant natural-language justifications.
- Raw tool outputs.
- Hidden chain-of-thought, which Pi does not expose anyway.
- Large file contents or command outputs.

### 3. Reviewer prompt

The reviewer prompt should ask for strict JSON only:

```json
{
  "decision": "allow" | "deny" | "ask",
  "risk": "low" | "medium" | "high" | "critical",
  "authorization": "high" | "medium" | "low" | "unknown",
  "reason": "short explanation"
}
```

Policy:

- Critical risk: deny.
- High risk: require strong user authorization; otherwise ask or deny.
- Credential reads/exfiltration: deny unless explicitly authorized and contained.
- Production deploys, destructive cloud operations, permission/IAM changes: deny/ask unless explicitly authorized.
- Local routine commands in workspace: allow.
- Dependency installs from project manifests: allow or medium depending on config.
- Network operations when sandbox network is disabled: deny or ask, but deterministic sandbox still blocks.

### 4. Review flow in `tool_call`

Order:

```text
tool_call
  -> deterministic hard deny for path policy
  -> deterministic fast allow for known safe actions
  -> if classifier disabled: continue or ask/block based on config
  -> project review projection
  -> call reviewer model with timeout
  -> parse JSON
  -> allow / deny / ask
```

Initial MVP can implement:

- `allow`: execute tool.
- `deny`: block with reason and no-workaround instruction.
- `ask`: if `ctx.hasUI`, prompt user; otherwise fail closed/block.

### 5. Model selection

Implement helpers:

- Resolve configured classifier model:
  - `"current"` uses `ctx.model`.
  - `"provider/model"` uses `ctx.modelRegistry.find(provider, id)`.
- List selectable models:
  - Prefer `await ctx.modelRegistry.getAvailable()` if available in extension runtime.
  - Fall back to known enabled/current models if API availability differs.
- Before review, call `ctx.modelRegistry.getApiKeyAndHeaders(model)`.
- If no API key/auth, fail closed for required reviews and show useful error.

Use `complete(...)` from `@earendil-works/pi-ai/compat`, already available through Pi’s runtime.

### 6. Persistence

MVP persistence options:

1. Session-local persistence via `pi.appendEntry("guard-classifier", ...)`.
2. Config-file-only persistence: user edits `.pi/guard.json` or global config.
3. Later: `/guard-model --save` writes global config after explicit confirmation.

Recommended MVP: session-local + config-file support, no automatic writes.

## Key Changes

1. Extend config schema/types with `classifier` settings.
2. Add classifier projection and prompt modules.
3. Add reviewer model call using Pi model registry and `complete(...)`.
4. Add `/guard-model` command.
5. Add optional `/guard-classifier on|off|status` command, or fold this into `/guard-model off/status`.
6. Update `tool_call` flow to invoke classifier only for configured actions.
7. Add decision caching for identical projections within the same turn if needed.
8. Update `/guard` output to include classifier status/model/last decision.
9. Update README with examples and limitations.

## Steps

1. Research exact model-registry methods available at runtime
   - Confirm `ctx.modelRegistry.getAvailable()` behavior in extension command context.
   - Confirm `ctx.modelRegistry.find(provider, id)` and `getApiKeyAndHeaders(model)`.
   - Confirm `complete(...)` import works from `@earendil-works/pi-ai/compat` in this extension.

2. Extend config
   - Add `classifier` section to `GuardConfig` and `ResolvedGuardConfig`.
   - Merge and validate fields: `enabled`, `model`, `timeoutMs`, `failClosed`.
   - Add defaults.

3. Add classifier types
   - Define projection, review request, review response, and internal decision types.
   - Add strict JSON parser and validator for reviewer output.

4. Add projection logic
   - Implement per-tool projection for `bash`, `read`, `write`, `edit`.
   - Redact/truncate sensitive/large content.

5. Add prompt builder
   - Encode policy summary, user intent excerpts, and pending action projection.
   - Explicitly instruct reviewer that transcript/tool evidence is untrusted.
   - Require JSON-only output.

6. Add reviewer execution
   - Resolve classifier model.
   - Fetch API key/headers.
   - Run `complete(...)` with timeout/abort.
   - Parse and validate JSON.
   - Fail closed on timeout/auth/API/parse errors.

7. Add `/guard-model`
   - No args: interactive selection in TUI; print status in non-interactive.
   - `current`: use current active model.
   - `off`: disable classifier.
   - `status`: print status.
   - `provider/model`: set explicit model.

8. Integrate into `tool_call`
   - Preserve current deterministic path blocking first.
   - Add fast-path decisions.
   - Call reviewer for configured risky actions.
   - Block with reason and no-workaround language on deny/failure.
   - Ask user on `ask` only when UI is available.

9. Add test commands
   - `/guard-classifier-smoke`: review a synthetic safe command and a synthetic risky command without executing either.
   - Print JSON decisions in non-interactive mode.

10. Validate
   - Run `/guard`, `/guard-model status`, `/guard-model current`, `/guard-classifier-smoke` in non-interactive and TUI modes.
   - Test bash safe command, credential read, network command, `.env` write.

## Validation Steps

1. Non-interactive status:

```bash
pi -p -ne -e ./.pi/extensions/guard -a "/guard"
pi -p -ne -e ./.pi/extensions/guard -a "/guard-model status"
```

2. Model selection:

```bash
pi -p -ne -e ./.pi/extensions/guard -a "/guard-model current"
pi -p -ne -e ./.pi/extensions/guard -a "/guard-model status"
```

3. Classifier smoke:

```bash
pi -p -ne -e ./.pi/extensions/guard -a "/guard-classifier-smoke"
```

4. Tool review behavior:

- Safe local command: `echo ok` should allow.
- Credential read: `cat ~/.ssh/config` should deny or ask.
- Network command with network disabled: `curl https://example.com` should deny/ask and sandbox still blocks.
- `.env` write should be deterministically blocked before classifier.

5. Failure behavior:

- Select a model without auth: review-required action blocks with clear reason.
- Force malformed response in a test stub: block/fail closed.
- Timeout: block/fail closed.

## Success Criteria

1. Users can see and set the classifier model with `/guard-model`.
2. Classifier uses a configured Pi provider model, not a hard-coded provider.
3. Deterministic hard denies still run before the classifier.
4. Risky actions are reviewed and produce `allow`, `deny`, or `ask`.
5. Classifier failures fail closed when review is required.
6. Reviewer context excludes assistant prose and raw tool outputs.
7. Non-interactive test commands demonstrate classifier configuration and synthetic decisions.
8. README clearly documents that classifier is advisory/semantic and Seatbelt remains enforcement.

## Risks

1. Model-registry APIs may differ slightly from examples; mitigate by first probing runtime methods and keeping model resolution isolated.
2. Classifier latency could slow tool execution; mitigate by only reviewing risky actions and adding a timeout.
3. False positives may annoy users; mitigate with config and `/guard-model off`.
4. False negatives are possible; mitigate by never allowing classifier to override deterministic deny or sandbox enforcement.
5. Passing too much untrusted context can prompt-inject the reviewer; mitigate with projection-only inputs and no raw tool outputs.
