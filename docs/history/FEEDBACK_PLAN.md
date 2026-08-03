# User Feedback Plan — August 2026

Seven items of miscellaneous user feedback, with design options considered.
Statuses move to ✅ as items land.

## 1. Guard status as a live overlay, not a conversation message ✅

**Feedback:** `/guard status` inserts the report into conversation history. It
should behave like the model picker — a popup viewable while the agent works,
ideally updating in realtime.

**Findings:** pi's `ctx.ui.custom(factory, { overlay: true, overlayOptions })`
renders a floating component on top of the chat without clearing it. The agent
loop is not blocked while an overlay is open; the overlay only owns keyboard
input while focused. `OverlayHandle` supports `focus/unfocus/setHidden/hide`,
and a component holding the `tui` reference can call `tui.requestRender()` at
any time (this is how `doom-overlay` animates).

**Options considered:**

- **A. Keep posting a message, add `display: false`** — hides the clutter but
  the report is then invisible; rejected.
- **B. Modal `ctx.ui.custom` (non-overlay) viewer** — replaces the editor area
  like `/guard model`; blocks typing, hides chat while open. Rejected: the
  feedback explicitly asks to watch it *while the agent works*.
- **C. Overlay viewer, live-refreshed (chosen)** — `/guard status` in the TUI
  toggles a right-anchored overlay rendering the same report as before.
  `updateGuardStatus` (already called from every entry point) additionally
  refreshes the open overlay, so decisions stream in live; a 1s timer keeps
  the "Ns ago" ages fresh. Esc closes; Tab unfocuses so you can keep typing
  with the panel pinned; `/guard status` again closes it. Outside the TUI the
  old behavior (console + message) is kept, and `/guard status post` still
  posts into history on purpose (useful for sharing a session).

## 2. Classifier hit rate is low — can we improve it? Would more data help? ✅

Interpreting "hit rate" as: too few calls resolve cheaply (fast-path
trivially-safe or no review at all); too many escalate to the slow full
review. Three levers, all applied:

- **Deterministic skip for safe reads (with item 5):** in-project and
  allowlisted reads no longer hit the classifier at all — the biggest traffic
  class becomes free (0 tokens, 0 latency). See item 5.
- **Rule coverage:** the allow list had no rule for *running* the repo's own
  validation (tests/builds/linters/type checks) — even the best eval model
  asked before `npm test` (see eval/RESULTS.md, gpt-5-mini's only miss). Added
  "Local Validation" and "Source Control Reads" allow rules so routine dev
  traffic can fast-path.
- **Session guidance (with item 7):** allow/deny comments are injected into
  both review stages, so one "yes, and stop asking about staging deploys"
  raises the hit rate for the rest of the session.

**Would more data help?** Yes, two different kinds:

- *Corpus data:* decision telemetry now lands in session logs, but the
  feature is new — there is no corpus yet (`npm run telemetry` scanned 66
  sessions, 0 with guard records at the time of writing). Once sessions
  accumulate, `npm run telemetry -- --cases` surfaces false-positive
  candidates (denied-then-executed-anyway) to grow `eval/cases.ts`, and rule
  changes get measured instead of guessed. This is the intended loop; it
  needs time, not new machinery.
- *Context data:* the fast stage stays low-context by design (round-2 evals
  showed the fast path was the injection vulnerability — giving it more to
  "reason" about authorization would weaken it). Session guidance from item 7
  is the safe form of extra context: it is user-authored, not
  model-inferred.

**Rejected:** feeding recent user messages to the fast stage (authorization
inference is exactly what the fast prompt forbids); caching identical
command→decision pairs (a repeated command in new context can mean something
new — e.g. the second `git push` after a denied force-push; and the win
overlaps with the deterministic read skip).

### Clarified next day: "hit rate" meant provider prompt-cache hit rate

Real complaint: subsequent classifier calls billed ~92% uncached. Root cause
was payload key order — both stages put the volatile part first
(`pendingAction` in fast, `recentUserMessages` in full), so the byte-stable
prefix was only the ~330–500-token system prompt: below OpenAI-style
automatic caching's 1024-token minimum (→ 0% from the payload), and
mid-message divergence defeats Anthropic breakpoint caching too (pi-ai marks
the system prompt and end-of-message, not interior boundaries). The full
payload also embedded the entire rules object **twice** (`rules` +
`rulesText`, the same JSON re-stringified).

Fix: payloads now run static→volatile — `rules` → `activePolicy` (moved out
of the projection) → `cwd` → `userSessionGuidance` → `recentUserMessages`
(full only) → `pendingAction` strictly last — and `rulesText` is gone. On the
default config that makes ≈3,016 of ≈3,045 payload tokens a stable, cacheable
prefix (only `pendingAction` ≈30 tokens varies per call); user messages are
stable across the tool calls within a turn. The key order is pinned by a
byte-stable-prefix test and documented as a cache contract in
`classifier-protocol.ts`. Cache visibility landed alongside: pi-ai's
`cacheRead`/`cacheWrite` now flow into telemetry, session stats
(`npm run telemetry` prints the hit rate), and the status report's
"Tokens: N in (M% cached)" line, so the effect is measurable per session.

## 3. Default to ask, not deny ✅

**Feedback:** except obviously forbidden cases, the guard should ask the
user. In reality it mostly denies.

**Diagnosis:** `FULL_SYSTEM_PROMPT` framed soft-deny as "require explicit
authorization; otherwise ask or deny" — models take the stricter branch. Only
one rule mentioned preferring ask, and only for already-authorized actions.

**Change:** the decision rules now state the default explicitly: *ask is the
default for any soft_deny action a user confirmation could legitimately
authorize; deny is reserved for hard_deny, critical risk, credential
exposure/exfiltration, guard bypass, and actions that stay unsafe even with
user confirmation*. The eval expectations already accept `ask` on all
non-critical soft-deny cases, so the golden set still scores; critical cases
still require deny.

Note the interplay with headless mode (item 6): `ask` without a UI becomes a
block with an explanatory reason — asking-by-default is still correct there
because the reason surfaces to the driving process.

## 4. `/guard policy` command ✅ (this plan's item; see also `/guard` panel)

Shows the resolved deterministic policy (filesystem read/write allow/deny,
network, environment scrubbing, config sources) *and* the classifier rules
(allow / soft_deny / hard_deny / environment assumptions) — the parts of
status that don't change per-session. In the TUI it opens the same overlay
viewer as item 1; outside the TUI it prints. `/guard policy post` posts into
history.

## 5. Allowlisted files should not hit the classifier ✅

**Feedback:** allowlisted files need not hit the classifier at all; the
allowlist seems to apply only via the sandbox and is ignored when the sandbox
is disabled.

**Confirmed:** `decidePathAccess` returns "allowed" immediately when
`filesystem.enabled` is false — the allow/deny lists were consulted only for
enforcement, never for classifier routing. And even with enforcement on, an
allowed read still went to the classifier.

**Options considered:**

- **A. Skip classifier for any path passing policy** — with the default
  `allowWrite: ["."]` this would exempt every in-project *write* from review,
  reopening the content-level attacks the round-2 evals were specifically
  hardened against (authorization planting, memory poisoning, postinstall
  hooks live in *allowed* paths). Rejected.
- **B. New `classifier.skipPaths` config** — works but adds a policy file
  knob; this repo's design principle is presets over user-authored policy.
  Rejected for now.
- **C. Deterministic read exemption (chosen):** `read` calls whose canonical
  path is inside the session cwd or matches an explicit `allowRead` entry —
  and does not match `denyRead` — skip the classifier entirely. This applies
  whether or not filesystem enforcement is enabled (the lists are now always
  evaluated; `enabled: false` only turns off *blocking*). Writes and edits
  always keep classifier review because their content is the risk, not their
  path; reads carry no content into the session via the guard's projection
  (the classifier only ever saw the path anyway). Deny-matching reads with
  enforcement off still go to the classifier rather than being silently
  exempted.

A `skipped` counter was added to session stats so the effect is visible in
the status report.

## 6. Headless / RPC mode (research) ✅

**How pi's modes actually behave** (verified against pi-coding-agent
internals, `docs/rpc.md`, and `examples/rpc-extension-ui.ts`):

- `ctx.mode` is one of `"tui" | "rpc" | "json" | "print"`; `ctx.hasUI` is
  true in **tui and rpc** modes only.
- **RPC mode is not headless for approvals:** `ctx.ui.confirm/select/input`
  are translated to `extension_ui_request` events on stdout; the driving
  client answers with `extension_ui_response`. Guard prompts already work
  there — *if* the client implements the sub-protocol. A client that ignores
  it hangs the tool call; a `timeout` in `ExtensionUIDialogOptions` exists as
  a guard-rail if this becomes a problem in practice.
- **json/print modes are truly headless:** extensions get a no-op UI where
  `confirm()` resolves `false`. Guard already detects this via `ctx.hasUI`
  and auto-blocks approval-requiring actions with a reason instead of
  hanging.
- **Subagents:** pi's subagent pattern (see `examples/extensions/subagent/`)
  spawns child `pi --mode json` processes — so a guard inside a subagent is
  headless and every `ask` becomes a block whose reason text flows back to
  the parent agent through the tool result. That is the propagation channel
  that exists today: *the denial reason, not the question.*

**Options for propagating approvals up from subagents:**

- **A. Run subagents in RPC mode** — the parent extension forwards
  `extension_ui_request` from the child to its own `ctx.ui`, answers flow
  back down. Works today with zero pi-guard changes; it is a subagent-
  extension concern. This is the recommended pattern.
- **B. Guard-to-guard side channel** — parent guard serves a Unix socket,
  advertises it via env var, child guard forwards approval requests.
  Mode-independent but invents a bespoke protocol, needs auth on the socket,
  and duplicates what RPC mode already provides. Deferred.
- **C. Deny-and-retry** — child blocks with a structured "needs approval:
  X" reason; parent collects, asks its user, re-runs the subagent with the
  approval pre-granted (e.g. session-approved paths passed through config).
  No protocol work, but re-running loses the subagent's progress. Viable
  fallback; not built.

**What landed now:** headless block reasons state the situation explicitly
("headless session: no user is available to approve...") so the agent — or
the parent driving it — understands the block is about approval availability
and not policy, plus a README section documenting the modes. The socket
protocol (B) stays deferred until a real subagent integration needs it.

## 7. Allow/deny with comment ✅

Approval prompts (classifier `ask` and out-of-roots path approvals) now offer
four choices: **Allow · Allow with comment · Deny · Deny with comment**. In
the TUI this is a custom dialog with an inline comment input; in RPC mode it
degrades to `select` + `input` dialogs over the protocol.

Comments become *session guidance*: they are appended to a session-scoped
list injected into both classifier stages' payloads (`sessionGuidance`), so
"allow — staging pushes are fine today" or "deny — never touch prod configs"
tunes the rest of the session without config edits. This is the
model-initiated-approval philosophy: users steer with one-line reactions, not
policy files. Deny comments are also echoed into the block reason returned to
the agent, so it can act on the user's redirect immediately.

Guidance entries are capped (last 12) and session-scoped by design; a future
follow-up could offer promoting one to project config.

## 8. Named classifier rule overrides ✅

**Feedback:** user policies should override individual classifier rules
without replacing the whole set — overwrite by `"Name:"`, delete with an
empty value.

**Options considered:**

- **A. Separate `ruleOverrides` key** (replace semantics stay on `rules`) —
  two keys expressing one idea; users must learn which to use. Rejected.
- **B. Name-merge as the only semantics** — breaks the `classifier-*-only`
  profiles, which genuinely want "only these rules"; deleting 30+ defaults by
  name is absurd. Rejected.
- **C. Name-merge by default, `"replace": true` for profiles (chosen)** —
  the common case (tweak one rule) needs no ceremony; the rare case (define a
  complete set) declares itself. Overrides keep the base rule's list position
  so the classifier's cacheable prompt prefix doesn't churn; unknown-name
  deletions warn (typo protection); layering is sequential, so project
  overrides beat global overrides of the same name.

## 9. User-visible, agent-invisible output over RPC ✅ (option A landed; C proposed upstream)

**The problem, precisely:** `pi.sendMessage` custom messages are the only
transcript-visible channel an extension has, and pi's `convertToLlm` turns
every custom message into a `role: "user"` LLM message — there is no
display-only flag. So `status post`/`policy post` cost agent context in every
mode. In the TUI the overlay avoids this entirely, but RPC clients can't
render `ui.custom` (it returns `undefined` there), so RPC currently falls
back to posting.

**Channels that exist today, and what they give up:**

| channel | user sees it | agent sees it | in transcript | live-updatable |
|---|---|---|---|---|
| custom message (`sendMessage`) | ✓ (message events) | ✓ always | ✓ | ✗ |
| `ui.notify` | ✓ (transient) | ✗ | ✗ | ✗ |
| `ui.setWidget` | ✓ (if client renders) | ✗ | ✗ | ✓ (re-set by key) |
| `ui.setStatus` | ✓ (statusline) | ✗ | ✗ | ✓ |
| `appendEntry` | ✗ (log only) | ✗ | session file only | — |

**Options:**

- **A. Widget mirror over RPC (chosen, landed):**
  in RPC mode `/guard status` toggles a live `setWidget("guard-status",
  lines)` instead of posting — the RPC analog of the TUI overlay. `setWidget`
  is a fire-and-forget `extension_ui_request` carrying `widgetKey` +
  `widgetLines`; re-setting the key updates it (our `updateGuardStatus` hook
  already refreshes on every event) and clearing the key closes it. Same for
  `/guard policy`. Caveats: rendering is client-dependent (a client may
  ignore widgets — the reference `rpc-extension-ui.ts` client renders them),
  and nothing lands in the transcript.
- **B. `ui.notify` with the report text:** works everywhere today, zero
  context — but transient and unstructured; clients typically render toasts.
  Fine for one-liners, wrong for 50-line reports. Use only as a fallback.
- **C. Upstream pi: context-excluded messages.** Add
  `excludeFromContext?: boolean` to `CustomMessage`, honored by
  `convertToLlm` (skip, like `!!` bashExecution messages already do). Then
  `post` gains a display-only variant that is genuinely in the transcript —
  shareable, renderable by message renderers, replayable — without agent
  cost, in every mode. Small, additive, precedented; benefits all
  extensions. This is the right end state; needs a pi PR.
- **D. Custom entries + guard-aware client:** telemetry entries are already
  in the session file, but RPC emits no entry events and clients would need
  guard-specific rendering. Most work, least generality. Rejected.

**Recommendation:** do A now (pi-guard-local, closes the RPC gap the same
way the overlay closed the TUI gap); pursue C upstream and switch `post` to
offer both flavors when it lands. Related hardening note discovered en route:
RPC dialog requests support a `timeout` field with agent-side auto-resolve —
worth adding to guard approval prompts eventually, so a client that ignores
the extension-UI sub-protocol can't hang a tool call forever.

### Addendum (2026-08-04): explicit posts dropped entirely

Decision: the `post` variants (and the unconditional smoke/critique posts)
are gone. A guard report in agent context is a security liability, not a
convenience — it hands a possibly injected agent the rule lists, session
approvals, and guidance it would need to craft evasions. All guard output now
flows through user-only channels: TUI overlay, RPC widget (`guard-status`,
`guard-policy`, `guard-report` for smoke/critique results), notifications,
or stdout when headless. `pi.sendMessage` no longer appears in the codebase;
the pi-guard message renderer stays registered so old sessions still render
their historical reports. If context-excluded transcript messages ever land
upstream (option C), a display-only post can return.
