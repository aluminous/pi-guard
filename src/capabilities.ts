/**
 * The capability taxonomy and the disposition table that turns names into
 * outcomes. Twelve classes, deliberately capped: growing the list is how
 * edge-case disease comes back (PERMISSIONS_PLAN, "Architecture B"). Commands
 * are unbounded but intents are few, and `unclassified` is the completeness
 * valve rather than a reason to add a thirteenth class.
 *
 * The `definition` strings are prompt text — the namer receives them verbatim
 * as the entire description of each class, so they are written as decision
 * boundaries ("X, but Y is class Z instead"), not as marketing copy. Edit them
 * as you would edit a prompt.
 */
import type { ResolvedGuardConfig } from "./config.ts";

export const CAPABILITY_IDS = [
  "read-project",
  "read-system",
  "run-dev-tools",
  "modify-project",
  "install-dependencies",
  "off-machine-effects",
  "modify-system",
  "credentials",
  "local-destructive",
  "persistence",
  "network-fetch",
  "unclassified",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * What the user wants to happen to a class. `judge` delegates the decision to
 * a strong model for this one action; it is the user saying "think about this
 * class", parallel to `ask` = "bring me in".
 */
export type Disposition = "allow" | "judge" | "ask" | "deny";

export const DISPOSITIONS: Disposition[] = ["allow", "judge", "ask", "deny"];

/** Severity-max order: a multi-label action takes the strictest disposition among its labels. */
const SEVERITY: Record<Disposition, number> = { allow: 0, judge: 1, ask: 2, deny: 3 };

export interface CapabilityClass {
  id: CapabilityId;
  /** Short human label for panels, traces, and block reasons. */
  name: string;
  /** Prompt text: the namer's entire description of this class. */
  definition: string;
  default: Disposition;
}

export const CAPABILITY_CLASSES: CapabilityClass[] = [
  {
    id: "read-project",
    name: "Read project",
    definition:
      "Reading, listing, or searching files, directories, and version-control history inside the session working directory. Read-only: the action produces output and changes nothing. Reading a credential file that happens to sit in the project is credentials instead.",
    default: "allow",
  },
  {
    id: "read-system",
    name: "Read system",
    definition:
      "Reading files, listing directories, or querying machine state outside the project — system paths, home-directory configuration, installed packages and toolchain versions, environment variables, processes, OS information. Still read-only. Credential stores and key material are credentials instead.",
    default: "allow",
  },
  {
    id: "run-dev-tools",
    name: "Run dev tools",
    definition:
      "Running this project's own development tooling: tests, builds, linters, formatters, type checks, code generators, and scripts already declared in its manifests or build configuration — including the files those tools write into the project and its build/dependency caches. Publishing, deploying, or anything reaching off this machine is off-machine-effects instead.",
    default: "allow",
  },
  {
    id: "modify-project",
    name: "Modify project",
    definition:
      "Creating, editing, or appending files inside the session working directory, together with the content being written. Ordinary source, test, documentation, and configuration edits. Deleting or overwriting existing work is local-destructive instead; content that grants standing permissions, addresses future reviewers, or installs hooks is persistence instead.",
    default: "allow",
  },
  {
    id: "install-dependencies",
    name: "Install dependencies",
    definition:
      "Installing, upgrading, or removing packages and language toolchains for this project through a package manager (npm/pnpm/yarn, pip/uv/poetry, cargo, go, gem, bundler, maven, gradle, brew, apt, and similar), including the manifest and lockfile changes and the registry downloads that installation implies.",
    default: "allow",
  },
  {
    id: "off-machine-effects",
    name: "Off-machine effects",
    definition:
      "Any effect that leaves this machine: pushing, publishing, or otherwise writing to a remote; opening, commenting on, or closing issues and pull requests; sending mail or chat messages; deploying; calling a remote API that changes state; changing remote infrastructure or cloud accounts. The MACHINE BOUNDARY decides, not the tool name: kubectl, docker, and similar tools pointed at a LOCAL cluster or daemon (kind, minikube, k3d, docker-desktop, colima, rancher-desktop, a localhost/127.0.0.1 context) stay local and are NOT off-machine-effects; the same commands against a remote or cloud context are. Retrieving remote data without changing it is network-fetch instead.",
    default: "ask",
  },
  {
    id: "modify-system",
    name: "Modify system",
    definition:
      "Writing, moving, or changing files and settings on this machine but outside the project: home-directory files, system directories, package-manager-owned locations, OS or user preferences, local services and daemons — where no more specific class applies. Startup and hook surfaces are persistence instead.",
    default: "ask",
  },
  {
    id: "credentials",
    name: "Credentials",
    definition:
      "Handling secret material: reading, searching, listing, printing, copying, decoding, or passing along private keys, tokens, API keys, passwords, cloud/cluster credential files, keychains and keyrings, browser profiles, .env files, and credential stores — and writing content that contains such material. A plain read of a credential file counts; so does a command that merely embeds one in an argument.",
    default: "judge",
  },
  {
    id: "local-destructive",
    name: "Local destructive",
    definition:
      "Destroying or irreversibly overwriting local state: deleting or truncating existing files and directories, git operations that discard or rewrite work (reset --hard, clean, checkout over changes, rebase, amend, branch -D), dropping local databases, containers, or volumes. Creating a local git commit is also this class: it is a local state change the user is expected to re-scope per session.",
    default: "judge",
  },
  {
    id: "persistence",
    name: "Persistence",
    definition:
      "Establishing something that keeps acting after this action ends: shell profiles and rc files, cron/launchd/systemd/scheduled tasks, git hooks, package lifecycle scripts (preinstall, postinstall, prepare, and friends), SSH authorized keys, login and startup items, editor or agent configuration loaded on startup — and file content that asserts standing approvals, records consent that was never given, or instructs future automated reviewers, whatever kind of file it lives in.",
    default: "judge",
  },
  {
    id: "network-fetch",
    name: "Network fetch",
    definition:
      "Reaching the network to retrieve something without changing remote state: HTTP GETs, curl/wget downloads, cloning or fetching a repository, pulling a container image, querying a read-only API. If the retrieved content is then written to disk or executed, name that consequence too.",
    default: "judge",
  },
  {
    id: "unclassified",
    name: "Unclassified",
    definition:
      "The action does not fit any class above. This is the completeness valve for genuinely unanticipated intents — not a hedge when two named classes both partly apply (name both of those instead).",
    default: "judge",
  },
];

const CLASSES_BY_ID = new Map<CapabilityId, CapabilityClass>(CAPABILITY_CLASSES.map((entry) => [entry.id, entry]));

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && CLASSES_BY_ID.has(value as CapabilityId);
}

export function isDisposition(value: unknown): value is Disposition {
  return value === "allow" || value === "judge" || value === "ask" || value === "deny";
}

export function capabilityClass(id: CapabilityId): CapabilityClass {
  return CLASSES_BY_ID.get(id)!;
}

export function capabilityName(id: CapabilityId): string {
  return CLASSES_BY_ID.get(id)?.name ?? id;
}

/** The strictest of the given dispositions (deny > ask > judge > allow); allow when the list is empty. */
export function strictestDisposition(dispositions: Disposition[]): Disposition {
  let winner: Disposition = "allow";
  for (const disposition of dispositions) {
    if (SEVERITY[disposition] > SEVERITY[winner]) winner = disposition;
  }
  return winner;
}

export function isStricter(a: Disposition, b: Disposition): boolean {
  return SEVERITY[a] > SEVERITY[b];
}

export const DEFAULT_DISPOSITIONS: Record<CapabilityId, Disposition> = Object.fromEntries(
  CAPABILITY_CLASSES.map((entry) => [entry.id, entry.default]),
) as Record<CapabilityId, Disposition>;

// ── Session scope and per-class stats ────────────────────────────────────────

export type CapabilityOutcome =
  | "allow"
  | "ask-approved"
  | "ask-denied"
  | "deny"
  | "judge-allow"
  | "judge-ask"
  | "judge-deny";

export const CAPABILITY_OUTCOMES: CapabilityOutcome[] = [
  "allow",
  "ask-approved",
  "ask-denied",
  "deny",
  "judge-allow",
  "judge-ask",
  "judge-deny",
];

export interface CapabilityStats {
  /** Times this class appeared among an action's labels. */
  hits: number;
  outcomes: Record<CapabilityOutcome, number>;
  /** Content-screen verdicts on actions that carried this label. */
  screenTripped: number;
  screenClean: number;
}

/**
 * Session-scoped capability state. Lives in RuntimeState and is reset per
 * session: overrides are "for this session" by construction, which is how
 * local-destructive and friends are meant to be re-scoped.
 */
export interface CapabilityState {
  overrides: Partial<Record<CapabilityId, Disposition>>;
  /**
   * Session preset flipping a set of classes to deny; read-only mode sets
   * this. A preset can only tighten — it is severity-maxed against whatever
   * the config and session overrides resolved to.
   */
  preset?: { name: string; deny: CapabilityId[] };
  stats: Partial<Record<CapabilityId, CapabilityStats>>;
}

export function createCapabilityState(): CapabilityState {
  return { overrides: {}, stats: {} };
}

export function createCapabilityStats(): CapabilityStats {
  return {
    hits: 0,
    outcomes: { allow: 0, "ask-approved": 0, "ask-denied": 0, deny: 0, "judge-allow": 0, "judge-ask": 0, "judge-deny": 0 },
    screenTripped: 0,
    screenClean: 0,
  };
}

/** Classes read-only mode denies. Writes and edits are already blocked deterministically; this covers bash. */
export const READ_ONLY_PRESET_DENY: CapabilityId[] = [
  "modify-project",
  "modify-system",
  "local-destructive",
  "off-machine-effects",
  "persistence",
];

export function applyReadOnlyPreset(state: CapabilityState): void {
  state.preset = { name: "read-only", deny: READ_ONLY_PRESET_DENY };
}

export function clearPreset(state: CapabilityState): void {
  state.preset = undefined;
}

export function setSessionDisposition(state: CapabilityState, id: CapabilityId, disposition: Disposition): void {
  state.overrides[id] = disposition;
}

export function clearSessionDisposition(state: CapabilityState, id: CapabilityId): void {
  delete state.overrides[id];
}

export type DispositionScope = "default" | "config" | "session" | "preset";

export interface EffectiveDisposition {
  id: CapabilityId;
  disposition: Disposition;
  scope: DispositionScope;
  /** For scope "config": the config file path that set it (see configSourceLabel). For "preset": the preset name. */
  source?: string;
}

/**
 * Effective disposition for one class: session override beats persisted
 * config (global then project, already merged) beats the class default; an
 * active preset then applies severity-max on top, so a session preset can
 * tighten but never loosen what the user configured.
 */
export function getEffectiveDisposition(
  config: ResolvedGuardConfig | undefined,
  state: CapabilityState | undefined,
  id: CapabilityId,
): EffectiveDisposition {
  let resolved: EffectiveDisposition = { id, disposition: DEFAULT_DISPOSITIONS[id], scope: "default" };
  const source = config?.provenance.dispositions[id];
  if (config && source && source !== "default") {
    resolved = { id, disposition: config.dispositions[id], scope: "config", source };
  }
  const override = state?.overrides[id];
  if (override) resolved = { id, disposition: override, scope: "session" };
  const preset = state?.preset;
  if (preset && preset.deny.includes(id) && isStricter("deny", resolved.disposition)) {
    resolved = { id, disposition: "deny", scope: "preset", source: preset.name };
  }
  return resolved;
}

export interface CapabilityResolution {
  labels: CapabilityId[];
  /** Per-label effective dispositions, in label order. */
  effective: EffectiveDisposition[];
  /** Severity-max across the labels. */
  disposition: Disposition;
  /** The label that produced the winning disposition (first one at max severity). */
  decidedBy: EffectiveDisposition;
}

/** Severity-max resolution across an action's labels. An empty label set resolves as `unclassified`. */
export function resolveCapabilities(
  config: ResolvedGuardConfig | undefined,
  state: CapabilityState | undefined,
  labels: CapabilityId[],
): CapabilityResolution {
  const ids = labels.length > 0 ? labels : (["unclassified"] as CapabilityId[]);
  const effective = ids.map((id) => getEffectiveDisposition(config, state, id));
  const disposition = strictestDisposition(effective.map((entry) => entry.disposition));
  const decidedBy = effective.find((entry) => entry.disposition === disposition) ?? effective[0]!;
  return { labels: ids, effective, disposition, decidedBy };
}

// ── Stats accessors ──────────────────────────────────────────────────────────

export function capabilityStats(state: CapabilityState, id: CapabilityId): CapabilityStats {
  const existing = state.stats[id];
  if (existing) return existing;
  const created = createCapabilityStats();
  state.stats[id] = created;
  return created;
}

/** Read-only view for panels: only classes seen this session, in taxonomy order. */
export function usedCapabilityStats(state: CapabilityState): Array<{ id: CapabilityId; stats: CapabilityStats }> {
  return CAPABILITY_IDS.filter((id) => state.stats[id]).map((id) => ({ id, stats: state.stats[id]! }));
}

export function recordCapabilityHits(state: CapabilityState, labels: CapabilityId[]): void {
  for (const id of labels) capabilityStats(state, id).hits++;
}

export function recordCapabilityOutcome(state: CapabilityState, labels: CapabilityId[], outcome: CapabilityOutcome): void {
  for (const id of labels) capabilityStats(state, id).outcomes[outcome]++;
}

export function recordScreenVerdict(state: CapabilityState, labels: CapabilityId[], tripped: boolean): void {
  for (const id of labels) {
    const stats = capabilityStats(state, id);
    if (tripped) stats.screenTripped++;
    else stats.screenClean++;
  }
}

/** The taxonomy block sent to the namer and the judge; static per build, so it heads the cacheable prefix. */
export function capabilityDefinitionsForPrompt(): Array<{ id: CapabilityId; definition: string }> {
  return CAPABILITY_CLASSES.map((entry) => ({ id: entry.id, definition: entry.definition }));
}
