# Permission System Audit & Redesign Proposals — August 2026

> **Naming note.** This document was written while the project was called
> pi-guard; it has since been renamed to **Pi Rail** (`/rail`, `rail.json`,
> `--no-rail`). Every "guard" below is left as written — it is a record of the
> discussion as it happened, and rewriting it would misquote it. Read "guard"
> as "rail" throughout.

Status: discussion draft. Nothing here is implemented; Stage 0 items are
candidates regardless of which architecture wins.

## North star (maintainer direction, recorded)

- This is **defense in depth against accidental overstepping** — catching an
  agent that drifts past what the user intended. It is not, and should not
  pretend to be, a complete boundary against adversarial agents.
- **The classifier is the most important layer**: models generate novel
  commands no rule list can anticipate. Its two goals are (1) implementing
  the user's policy on novel actions and (2) *not* impeding autonomy with
  false denies/asks. False friction is a failure mode equal to misses.
- The classifier deliberately sees limited session context (prompt-injection
  containment). Policies must be written for a reviewer with that limited
  view: **the more edge cases a policy enumerates, the more benign commands
  get caught.** The policies that matter encode user red-lines ("don't push
  to git without explicit approval each time"), not rare-scenario taxonomies.
- **The policy engine exists for speed and token savings** on the commands
  agents actually run dozens of times (grep, git status, builds) — not to
  enumerate every CLI tool.
- **The sandbox is optional containment** for what libraries and scripts do
  internally. It has the highest breakage risk (private CA files, keychains,
  files you don't know you need until they're blocked, network edge cases).
- Users must be able to **see the policy, change it, and attribute any
  block** to the rule that caused it. Seatbelt makes attribution hardest.

## Audit: where the current system fights the user

Five rule domains, five vocabularies, three enforcement points:

| domain | grammar | enforced by | dispositions | sharp edges |
|---|---|---|---|---|
| filesystem | globs + roots + bare names | policy engine (file tools) + compiled Seatbelt literals (bash) | allow / deny / ask(outside-roots) | reads are blacklist-default, writes whitelist-default; `enabled:false` disables blocking but lists still route classifier exemptions; sandbox fidelity is declared (degraded list) but still a second semantics |
| commands | word templates + trailing `*` | interceptor, only while Seatbelt enforces | allow only | wildcard means something different than in path globs; no deny form |
| environment | name globs | spawn-time scrub | allow + unset (unset wins) | ordering surprise (the AWS_CA_BUNDLE episode); third wildcard dialect |
| network | domain wildcards | Seatbelt proxy only | allow / deny lists | `deniedDomains` is near-vestigial; zero classifier tie-in; least attributable |
| classifier | named prose rules, 3 tiers + environment notes | LLM | allow / soft_deny / hard_deny → verdict allow/ask/deny | prose ≠ matchers; merge-by-name with `replace`; powerful but a different language entirely |

Cross-cutting problems:

1. **Disposition vocabulary is inconsistent**: block vs deny vs ask vs
   review vs exempt, each defined per layer.
2. **Layer interactions are individually documented but compositionally
   opaque**: read exemption consults filesystem lists even when enforcement
   is off; the command allowlist requires the sandbox on; read-only mode
   swaps the classifier ruleset; session approvals and guidance layer on
   top. Each rule is defensible; holding the product of them in your head
   is not realistic.
3. **Defaults are visible only at runtime** (`/guard policy` shows the
   resolved state but not *which layer of config produced each line*).
4. **Attribution is weakest exactly where breakage is highest**: a Seatbelt
   denial surfaces as `Operation not permitted` deep in a command's stderr,
   with no link back to the deny rule (or degraded pattern) that caused it.
5. The observed failure mode of all of this is rational: **when a section
   misbehaves, the user disables the whole section** — the system loses a
   layer because one rule in it couldn't be found or fixed.

## An invariant worth writing down

Whatever the architecture: **the deterministic layers are caches of obvious
classifier verdicts, and the sandbox is containment, not policy.** The read
exemption and command allowlist are precomputed "the classifier would
obviously allow this"; deny-paths are precomputed "obviously deny". Framing
them as caches explains what belongs in them (high-frequency, unambiguous
cases) and what does not (anything requiring judgment).

---

## Architecture A — One policy language (unified DSL)

A single rule file where every rule is `disposition · action-matcher`, and
every layer is a compilation target:

```
deny  read   ~/.ssh/**
allow run    "grep *"
ask   run    "git push *"        # every time, no standing approval
deny  env    AWS_SECRET_ACCESS_KEY
ask   write  outside(project)
```

Compiled outward: policy-engine checks, Seatbelt profile (with the existing
degraded-fidelity report), command allowlist, and a generated preamble for
the classifier ("the user's explicit rules are…").

**UX story**: one file, one grammar, one place to look. `/guard policy` *is*
the file. "Don't push without approval" is one line.

**Why this loses (mostly)**: the classifier's value is precisely the part a
matcher grammar cannot express. "Authorization Planting", "Untrusted Source
Intake", "content is part of a write action" — these are judgments, not
matchers. A DSL either grows prose escape hatches (and becomes two languages
in one file) or flattens the classifier into a matcher-shaped tool, which is
backwards given the north star. There is also a real cost to inventing a
language: parsing, linting, docs, migration — all for a user base that the
maintainer has said should never write long policy files. **Salvageable
piece**: the compilation discipline (one source → per-layer artifacts +
fidelity report) already exists for filesystem rules and should extend to
whatever architecture wins.

## Architecture B — Capability dispositions (intent-level policy)

Reorganize the *user-facing* policy around a small taxonomy of intents; the
mechanisms become implementations that map concrete actions to intents.
Sketch taxonomy (deliberately ≤ 12; growing it is how edge-case disease
returns):

```
read-project        modify-project      run-dev-tools
read-system         modify-system       install-dependencies
source-control-share (push/publish)     network-fetch
credentials         persistence         external-effects
```

The whole user policy is one disposition table:

```
source-control-share: ask        # ← "don't push without approval each time"
install-dependencies: allow
credentials:          deny
external-effects:     ask
…
```

Mechanisms map actions → capabilities: allowlist templates carry a
capability tag (`grep * → read-project`), path rules likewise
(`~/.ssh → credentials`), and — the important move — **the classifier's job
changes from "decide allow/ask/deny" to "name the capability (and whether
authorization is present)"**. The disposition table then decides
deterministically. A command spanning capabilities takes the most severe
disposition.

**Fast paths survive — and get better.** This does NOT mean every action
hits the classifier. The deterministic layers keep their cache role; what
changes is what they cache: a capability label instead of a bare verdict.
`grep *` tagged `read-project` resolves capability *and* disposition (via
the table) with zero LLM calls — exactly today's allowlist speed. In-cwd
reads map to `read-project` deterministically — exactly today's read
exemption. The classifier is consulted only for actions no deterministic
mapper can label, same escalation structure as now. The improvement:
flipping a disposition row automatically retunes the fast path too (set
`read-project: ask` and the exemptions respect it), where today a
disposition change means editing mechanism lists by hand.

**UX story**: `/guard` panel shows the table; changing "no pushes without
asking" is flipping one row (or saying it once in an approval comment —
guidance can *suggest* a row change). Attribution is uniform and humane:
"blocked: `git push` → source-control-share, which you have set to **ask**
(preset: balanced)". Presets become disposition matrices, trivially
diffable. Novel commands get exactly the treatment the north star wants:
the model classifies, the *policy* decides.

**DX/injection story**: this shrinks the classifier prompt (taxonomy + short
capability definitions instead of 40 prose rules) and shrinks its authority
— a prompt-injected classifier can at worst mislabel a capability, and the
disposition table still refuses `credentials: deny`. The eval reframes as a
classification benchmark (accuracy per capability), which is easier to
measure and to trust than decision agreement.

**Costs/risks**: taxonomy design is the whole game — too coarse and users
can't express "pushes yes, publishes no" (hence share vs fetch split); too
fine and it's the edge-case list again. Migration touches every layer's
config shape. Ambiguous mappings need a severity rule and honest telemetry.
Some current prose rules (Authorization Planting) become capability
*definitions* ("writing standing approvals into files = persistence"), which
must be validated against the round-2 subtle-case evals before trusting.

## Architecture C — Honest layers + radical attribution (justify the status quo)

Thesis: the per-layer semantics differ because the *domains* differ — path
containment, command matching, env scrubbing, and semantic judgment are
genuinely different problems, and a unified abstraction would leak worse
than honest layers. The actual complaints — "rules don't apply as
expected", "can't see defaults", "can't tell what blocked me" — are
observability failures, so spend everything there:

1. **Decision trace + `/guard explain`**: every intercepted call records the
   full chain (which stage decided, which rule matched, what the other
   stages would have said). `/guard explain` shows the last decision's
   chain; block reasons carry the rule name.
2. **`/guard test <command|path>` (what-if)**: run the full stack — path
   policy, allowlist parse + match, classifier review — without executing,
   and print each layer's verdict. This alone likely ends the
   "disable the whole section" spiral: it turns config editing into a
   red-green loop.
3. **Provenance in `/guard policy`**: every line tagged `default` /
   `global` / `project` / `overridden(name)` — the merged view finally
   shows *whose* rule each line is.
4. **Decision-driven editing**: from an ask dialog or `/guard explain`,
   offer "allow once / allow this session / save as rule" — the save path
   writes a named rule override, so config accretes from real decisions
   (the stated preference) instead of hand-edited JSON.
5. **Sandbox violation capture**: on macOS, Seatbelt violations land in the
   unified log. After a guarded command fails, `/guard why` (or automatic
   stderr sniffing for `Operation not permitted`) queries recent violations
   for that process and maps the denied path back to the deny rule or
   degraded pattern. This is the single biggest attribution win available,
   and it needs no redesign at all.
6. **Config lint at load**: dead rules ("never matches because shadowed"),
   will-degrade warnings (exists), unknown-name deletions (exists).

**Cost**: none of this reduces the five-vocabulary problem; it makes it
legible. **Risk**: legibility may be enough for the maintainer and too
little for casual users.

## Architecture D — Classifier-first with compiled caches

Take the invariant literally: the prose policy is the *only* policy; the
deterministic rules are a **generated cache** of it. `/guard compile` asks a
strong model to derive the command allowlist / path exemptions from the
prose rules; the eval harness verifies cache-vs-classifier agreement on the
golden set + mined benign set; drift fails the build. Users edit one
artifact (prose, named-merge as today).

**UX story**: one editable thing; everything fast is derived and provably
consistent. **Why it loses today**: generation trust and drift management
are real machinery; the sandbox still needs its own path/network config
(containment ≠ policy), so "one artifact" is aspirational; and the cache
regeneration loop needs eval infrastructure run routinely, which is not yet
habit. Worth revisiting once telemetry + benign evals are routine.

**Maintainer note (2026-08-05): viable with user review.** If `/guard
compile` *proposes* the derived rules as a reviewable diff — like a PR the
user approves before it takes effect — the generation-trust objection
mostly dissolves: the human is the drift gate, and the agreement eval
becomes a pre-review check rather than the sole safeguard. This also
composes with B rather than competing: compile can generate capability
*mappings* (templates → capability tags) from the prose definitions, with
the user reviewing the mapping diff.

---

## Recommendation

**B's user surface on C's plumbing, staged so every step is useful alone.**

- **Stage 0 (no-regret, do first regardless)**: C.1–C.3 + C.5 — decision
  trace, `/guard explain`, `/guard test`, provenance tags, sandbox
  violation capture. These directly attack every named pain and inform the
  taxonomy with data.
- **Stage 1**: introduce capabilities as *metadata*: tag existing allowlist
  templates and path rules, add the disposition table alongside (not
  replacing) current config, and have the classifier emit a capability
  label in addition to its decision. Compare label-driven dispositions
  against current decisions in telemetry before trusting them.
- **Stage 2**: flip the user surface — the panel edits the disposition
  table and presets; today's JSON sections become advanced/mechanism
  config; classifier decisions become capability classification.

Open questions to settle in discussion:

1. Taxonomy: is the 11-capability sketch the right altitude? What does the
   maintainer actually want to say "ask me every time" about — is it just
   {push, publish, install, external-effects, credentials, out-of-project
   writes}?
2. Should the classifier retain any decision authority (e.g. an
   `escalate` verdict for "this doesn't fit the taxonomy"), or is
   mislabel-then-table strictly better?
3. Does `soft_deny` survive as a tier, or does it dissolve into
   per-capability `ask`?
4. Network policy is sandbox-only today. Does it become a capability
   (`network-fetch: ask`?) with classifier enforcement for the
   non-sandboxed case, or stay pure containment?
5. Where does read-only mode land — a preset (disposition matrix), rather
   than a bespoke mode?

---

## Discussion notes (2026-08-05): taxonomy mechanics settled

Three resolutions from maintainer discussion of Architecture B:

1. **Decision authority moves entirely to the disposition table.** The
   classifier (or a deterministic tag) names what an action *is*; settings
   decide what happens. The classifier never emits allow/ask/deny. Vestige
   of today's authorization-upgrade logic: the classifier MAY emit
   *authorization evidence* ("user said 'push this branch'"), which only
   ever decorates the ask prompt (making confirmation one keystroke) and
   never bypasses it — keeping the fabricated-consent attack surface closed
   while recovering most of the friction savings.
2. **Multi-label classification with severity-max resolution.** Actions
   span capabilities (`curl -o f URL` = network-fetch + modify-project;
   chain segments map separately via the shell parser). The classifier
   emits a small set; the strictest disposition wins (deny > ask > allow).
   Severity-max is injection-resistant: extra benign labels cannot dilute a
   strict one. The ask dialog lists all matched capabilities.
3. **User-defined capabilities are first-class — they are the successor to
   custom prose rules.** Two tiers plus a valve: a small stable core
   taxonomy (mechanism tags, presets); user capabilities as
   name + short prose definition + disposition ("prod-deploy: anything
   touching the k8s prod context → deny"), managed by the existing
   named-merge machinery, proposable from session-guidance comments; and an
   implicit **`unclassified` capability with its own disposition
   (default ask)** as the completeness valve. The taxonomy does not need to
   anticipate every task: commands are unbounded but intents are few, and
   an unanticipated intent resolving to "ask" is the correct outcome by
   construction. Edge-case disease in user definitions is a lint concern
   (/guard critique), not an architectural one.

### The `judge` disposition (2026-08-05)

Maintainer proposal, adopted into the sketch: dispositions become
**allow / ask / deny / judge**. `judge` escalates the action to a strong
model for a thoughtful review; the cheap classifier stays a pure namer.
The full pipeline:

```
deterministic tags ──▶ cheap classifier (names capabilities only)
        │                         │
        └────────► disposition table ◄────────┘
              allow | ask | deny | judge
                                    │
                        strong-model judge (rare, slow, costly is fine)
                        richer but still CURATED context; verdict
                        allow / ask / deny, ask-preferred
```

Why this is the right home for the asymmetric staging idea: the eval
remeasurement showed an always-on cheap prefix stage does not pay (12–15%
hit rate, pure added latency). A **policy-gated** strong review does pay,
because judge-classes are by construction the rare-and-consequential tail
(external-effects, source-control-share, unclassified) — the strong model
runs on a few percent of traffic, exactly where capability demonstrably
matters (round-2 subtle cases).

Design bounds for judge (it is the largest model-authority surface, so the
bounds are the design):

1. It holds decision authority **only for classes the user explicitly
   delegated** via the table — `judge` is the user choosing "let a strong
   model think about this class", parallel to `ask` = "bring me in".
2. **Severity-max still binds it**: an action also matching a deny-class is
   denied before the judge is consulted; the judge cannot override
   deterministic denies.
3. Its verdict is per-action, **never a standing approval**; ask-preferred
   decision rules (deny reserved for confirmation-can't-fix cases).
4. Its context is richer than the namer's but still curated projections,
   never raw transcript: recent user messages (capped), session guidance,
   deterministic environment facts (manifests, remotes, tracked-status),
   the action projection, and recent guard decisions (a third force-push
   after two denials is signal). Strong models are also the most
   injection-resistant reviewers we measured, and this is where that
   robustness belongs.
5. Judged separately in evals: the decision-agreement benchmark becomes the
   judge benchmark; the namer gets a classification benchmark.

Natural defaults: `unclassified: judge` (a thoughtful look before
bothering the human; the judge asks when unsure) — friction lower than
unclassified:ask with safety preserved. Today's soft_deny prose migrates
into judge-class definitions plus judge decision rules.

### Session-scoped dispositions (2026-08-05)

Maintainer requirement, adopted: dispositions carry scopes layered like
config — default < preset < global < project < **session**. "Allow this
class for this session" (/guard allow install-dependencies, or an approval
comment that proposes it) is a session-scope row; read-only mode stops
being a bespoke mode and becomes a session preset flipping modify-* /
share-* rows to deny; today's session path-approvals become session-scope
capability grants. One mechanism replaces three bespoke ones.

### Maintainer disposition calibration (2026-08-05)

The "ask me every time" list, verbatim intent:

| class of action | disposition |
|---|---|
| anything with impact beyond this machine — pushing, posting comments, modifying k8s resources (EXCEPT local clusters) | **ask** |
| broad reads (project and system) | **allow** |
| reading possible secrets | **judge** |
| committing and deleting local files | **judge**, expected to vary by session |

Taxonomy consequences adopted into the sketch:

1. **The machine boundary, not tool identity, defines the ask tier** —
   rename/define `external-effects` as `off-machine-effects`: "any effect
   beyond this machine". kubectl against kind/minikube/docker-desktop
   contexts is local (judge at most); the same command against a remote
   context is off-machine (ask). Mappers need the context distinction
   (deterministic: kubeconfig current-context is readable), which is a
   concrete example of the environment-facts enrichment paying off.
2. **`credentials` defaults to judge, not deny** — reading a test-fixture
   key is fine, an exfil-adjacent read is not; that distinction IS a
   judgment call, and flat-deny was over-strict.
3. **`local-destructive` (deleting/overwriting local state, and local
   commits) is its own class, default judge** — explicitly expected to be
   re-scoped per session (the session-disposition mechanism is not a
   nicety; it is how this class is meant to be used).
4. Broad reads defaulting allow confirms the read-exemption direction and
   keeps the read classes out of the friction budget entirely.

### Adopted (2026-08-05): network-fetch is a class

`network-fetch` joins the core taxonomy, default **judge**. Outbound
sensitive data is never network-fetch (that is credentials /
off-machine-effects by classification, regardless of domain). The domain
allowlist remains sandbox enforcement input; promoting it to a
deterministic trusted-fetch mapper (trusted domain → allow without review)
is a later refinement — v1 labeling of fetches comes from the classifier,
so network policy finally exists even with the sandbox off.

### Adopted (2026-08-05): the disposition settings page replaces /guard policy

The interactive page becomes THE policy surface (mechanism/rule view stays
reachable as `/guard policy rules` — Stage 0's provenance annotations live
there). Spec:

- One row per class: name · disposition · session hit stats (hits, allows,
  denies; asks when present). Left/right (or Enter) cycles
  allow / ask / deny / judge on the highlighted row.
- Every toggle takes effect immediately at **session scope**. Rows whose
  effective disposition differs from the persisted value are highlighted in
  a distinct color. **Ctrl+S persists** the current table globally
  (persistent-settings pattern); highlights clear on save.
- Stats refresh live (liveView refresh hook). Esc closes. Docked panel like
  the other guard views; select-dialog degradation over RPC.
- Adding/editing/defining classes in-page: explicitly deferred.

Bootstrap defaults (maintainer calibration): read-project, read-system,
run-dev-tools, modify-project, install-dependencies → **allow**;
off-machine-effects → **ask**; credentials, local-destructive,
persistence, network-fetch, unclassified → **judge**.

v1 enforcement semantics (leapfrogs Stage 1's observe-first caution at
maintainer direction; telemetry records label vs legacy decisions for
audit): deterministic mappers (read exemption → read-project, command
allowlist tags, path denies → credentials) resolve via the table directly;
classifier emits a label set alongside its decision and the table resolves
by severity-max over labels, with the classifier's own decision used only
when no label is emitted. `judge` is a documented placeholder for full
classifier review until the strong-model judge exists. `ask` uses the
existing approval dialog; approval comments keep feeding session guidance.

### Adopted (2026-08-05): dogfood the final semantics on the experimental branch

No hybrid, no advisory mode — on `stage-0-attribution` the table and
taxonomy actually decide, for real telemetry. Final decision path:

- **Classifier becomes a single-stage namer** (the two-stage fast/full
  split dies, per the remeasurement): it emits a label set + optional
  authorization evidence, never a decision. Cache-friendly payload
  discipline retained; class definitions replace prose rule tiers in the
  prompt. Legacy classifier.rules config parses but is inert in capability
  mode (diagnostic notes it).
- **Deterministic mappers label without LLM**: read exemption →
  read-project; allowlist templates carry capability tags; trusted-path
  denials → credentials.
- **Writes/edits get a deterministic content screen, not an unconditional
  LLM pass** (revised 2026-08-05 after maintainer pushback — edits are 24%
  of classifier traffic and burst-edit latency is real harm). Clean
  content → deterministic modify-project/modify-system label → table, zero
  LLM. The screen escalates to the namer when content or target is
  lexically/structurally interesting: authorization/review/approval
  lexicon and agent-directive phrasing; persistence surfaces by path
  (manifest script blocks, git hooks, shell profiles, cron/launchd);
  manifest diffs that add lifecycle scripts (structural JSON check);
  credential-looking content (key material, long secrets, base64 blobs).
  The namer then labels content-level risks (planting → persistence,
  secrets → credentials) and severity-max resolves. Honest limits: a
  paraphrasing adversary can evade a lexicon — accepted per the north star
  (not an adversarial boundary; sandbox and deny-paths still bound blast
  radius). Regression criterion: every round-2 subtle-* eval case MUST
  trip the screen; the screen's trip rate is telemetry so over/under-
  triggering is measurable. Users wanting always-review keep it: set
  modify-project to judge for the session.
- **Table resolves by severity-max** over labels: deny > ask > judge >
  allow. Empty label set → unclassified.
- **The judge is real, not a placeholder**: a thoughtful review with
  curated richer context (recent user messages, session guidance, action
  projection, recent guard decisions), ask-preferred decision rules,
  per-action verdicts, model = `classifier.judgeModel` (default
  "current" — the session model is typically the strong one).
- **Core taxonomy grows modify-system** (writes outside the project),
  default ask — out-of-roots writes need a class; 12 core classes total.
- **Read-only mode becomes a session preset** flipping modify/destructive/
  share rows to deny, keeping its deterministic write/edit block and its
  fail-closed bash behavior when the namer is unavailable.
- Classifier disabled = capability mode limited to deterministic mappers,
  as today. Eval harness adapts to the new pipeline (same expected
  decision sets; judge runs with the eval model) rather than being
  abandoned.
- Verification: /guard test (Stage 0) is the dogfood vehicle — it
  exercises namer → table → judge without agent turns; manual tmux pass
  over the settings page (toggle, highlight, Ctrl+S, live stats) and the
  decision paths on implementation.

### Adopted (2026-08-05): the class vocabulary becomes editable

This lifts "Adding/editing/defining classes in-page: explicitly deferred" from
the disposition-settings-page section above, at maintainer direction. The page
was shipped first with a fixed taxonomy to get the table itself right; with
that settled, the deferral is over and the page now adds, edits, and deletes
classes. Decisions:

- **Built-ins are editable but not deletable.** Their definitions are prompt
  text and can be rewritten freely, but the twelve ids are referenced as
  literals by deterministic paths — interceptor attribution, the command
  allowlist tags, `READ_ONLY_PRESET_DENY` — so deleting one would leave those
  pointing at nothing. The page refuses `d` on a built-in and names the two
  real alternatives: set it to deny, or edit its definition. Custom classes
  have no such references and delete freely.
- **New classes default to `ask`.** A class the user bothered to name is by
  construction an intent they want to think about, and `ask` is the only
  default that cannot silently widen what the agent may do. `judge` would
  spend a model call on a class whose shape the user has just told us; `allow`
  would be a footgun.
- **Custom classes enter the namer's vocabulary immediately, at session
  scope.** Same semantics as a disposition edit: live on the next action,
  persisted only by Ctrl+S. The alternative — requiring a save before the
  class is usable — would make the page's "try it and see" loop useless, which
  is the loop that gets definitions right.
- **Cache-prefix invalidation on registry change is accepted.** The class
  definitions head the namer payload precisely because they are stable; editing
  them moves the cacheable prefix and costs one full-price call per provider
  cache. Editing is rare and deliberate, the payload is still byte-stable for
  an unchanged registry, and the alternative (freezing the taxonomy for the
  session, or versioning prefixes) buys less than it costs in surprise.

An id that no layer defines — a label naming a class deleted mid-session, or one
the namer invented — resolves to `ask`/`default` rather than inheriting a stale
override. Labels can outlive their class within a session; the safe direction
for an orphaned one is to bring the user in.

`/guard policy rules` also stops being its own view and becomes the second tab
of the policy page, so the mechanism report and the table it annotates are one
surface. Non-TUI clients keep the standalone widget: tabs are a TUI affordance.
