# Permission System Audit & Redesign Proposals — August 2026

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
