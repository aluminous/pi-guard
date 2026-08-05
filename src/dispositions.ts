/**
 * The view model behind the disposition settings page: one row per capability
 * class, resolved against the persisted config, the session overrides, and any
 * session preset. The TUI page and the RPC select degradation both read it, so
 * the two surfaces describe the same table in the same words.
 */
import {
  CAPABILITY_CLASSES,
  DISPOSITIONS,
  clearSessionDisposition,
  getEffectiveDisposition,
  setSessionDisposition,
  type CapabilityId,
  type CapabilityStats,
  type Disposition,
  type EffectiveDisposition,
} from "./capabilities.ts";
import { configSourceLabel, globalGuardConfigPath, type ResolvedGuardConfig } from "./config.ts";
import { updatePersistentDisposition } from "./persistent-settings.ts";
import { syncCapabilityPreset, type RuntimeState } from "./state.ts";

/** One-line help per disposition, for select labels and completions. */
export const DISPOSITION_HELP: Record<Disposition, string> = {
  allow: "run without review",
  judge: "let the strong model decide, one action at a time",
  ask: "bring me in before it runs",
  deny: "refuse outright",
};

export interface DispositionRow {
  id: CapabilityId;
  name: string;
  definition: string;
  /** The row the user edits: the session override when set, else the persisted value. */
  value: Disposition;
  /** What the row would be with no session override: config-merged, else the class default. */
  persisted: Disposition;
  /** A session override moved this row off its persisted value — the page highlights these. */
  modified: boolean;
  /** What actually decides, including a session preset tightening the row. */
  effective: EffectiveDisposition;
  /** The preset tightened this row past `value`, so the effective value is stricter than the row. */
  presetTightened: boolean;
  stats: CapabilityStats | undefined;
  /** "3 hits · 1 allowed · 1 asked · 1 denied"; empty when the class was never named. */
  statsLabel: string;
}

/** Buckets that partition the seven outcomes: auto-allowed, brought to the user, auto-denied. */
function statsLabel(stats: CapabilityStats | undefined): string {
  if (!stats || stats.hits === 0) return "";
  const outcomes = stats.outcomes;
  const parts = [`${stats.hits} hit${stats.hits === 1 ? "" : "s"}`];
  const allowed = outcomes.allow + outcomes["judge-allow"];
  const asked = outcomes["ask-approved"] + outcomes["ask-denied"] + outcomes["judge-ask"];
  const denied = outcomes.deny + outcomes["judge-deny"];
  if (allowed > 0) parts.push(`${allowed} allowed`);
  if (asked > 0) parts.push(`${asked} asked`);
  if (denied > 0) parts.push(`${denied} denied`);
  return parts.join(" · ");
}

/** Every class in taxonomy order. Recomputed on each refresh, so live stats and preset changes land without extra plumbing. */
export function dispositionRows(config: ResolvedGuardConfig | undefined, state: RuntimeState): DispositionRow[] {
  // The preset is derived from state.readOnly; sync here so a read-only toggle
  // while the page is open shows up on the next refresh.
  syncCapabilityPreset(state);
  return CAPABILITY_CLASSES.map((entry) => {
    const persisted = getEffectiveDisposition(config, undefined, entry.id).disposition;
    const override = state.capabilities.overrides[entry.id];
    const effective = getEffectiveDisposition(config, state.capabilities, entry.id);
    const stats = state.capabilities.stats[entry.id];
    return {
      id: entry.id,
      name: entry.name,
      definition: entry.definition,
      value: override ?? persisted,
      persisted,
      modified: override !== undefined && override !== persisted,
      effective,
      presetTightened: effective.scope === "preset",
      stats,
      statsLabel: statsLabel(stats),
    };
  });
}

export function dispositionRow(config: ResolvedGuardConfig | undefined, state: RuntimeState, id: CapabilityId): DispositionRow {
  return dispositionRows(config, state).find((row) => row.id === id)!;
}

/** Next disposition in allow → judge → ask → deny order; step -1 walks back. */
export function cycleDisposition(current: Disposition, step: 1 | -1): Disposition {
  const index = DISPOSITIONS.indexOf(current);
  const next = (index + step + DISPOSITIONS.length) % DISPOSITIONS.length;
  return DISPOSITIONS[next]!;
}

/**
 * Applies a row edit at session scope. Landing back on the persisted value
 * drops the override instead of recording a no-op one, so Ctrl+S only ever
 * writes rows the user actually changed.
 */
export function setRowDisposition(config: ResolvedGuardConfig | undefined, state: RuntimeState, id: CapabilityId, disposition: Disposition): void {
  const persisted = getEffectiveDisposition(config, undefined, id).disposition;
  if (disposition === persisted) clearSessionDisposition(state.capabilities, id);
  else setSessionDisposition(state.capabilities, id, disposition);
}

export interface SaveResult {
  saved: CapabilityId[];
  /** Rows a project config owns: the global write lands, but that config wins again next session. */
  shadowed: CapabilityId[];
}

/**
 * Ctrl+S: writes every session override to the global config, folds it into
 * the in-memory resolved config, and clears the overrides — they are persisted
 * now, so the modified highlights go away and the effective values do not move.
 */
export function saveDispositions(
  config: ResolvedGuardConfig | undefined,
  state: RuntimeState,
  persist: (id: CapabilityId, disposition: Disposition | undefined) => void = updatePersistentDisposition,
): SaveResult {
  const result: SaveResult = { saved: [], shadowed: [] };
  const globalPath = globalGuardConfigPath();
  for (const [key, disposition] of Object.entries(state.capabilities.overrides)) {
    const id = key as CapabilityId;
    if (!disposition) continue;
    persist(id, disposition);
    result.saved.push(id);
    if (config) {
      const previous = config.provenance.dispositions[id];
      if (previous !== "default" && previous !== globalPath) result.shadowed.push(id);
      config.dispositions[id] = disposition;
      config.provenance.dispositions[id] = globalPath;
    }
    clearSessionDisposition(state.capabilities, id);
  }
  return result;
}

/** "built-in default", "global config", "project config", "this session", "read-only preset". */
export function describeDispositionSource(effective: EffectiveDisposition): string {
  if (effective.scope === "default") return "built-in default";
  if (effective.scope === "session") return "this session";
  if (effective.scope === "preset") return `${effective.source} preset`;
  return `${configSourceLabel(effective.source ?? "config")} config`;
}

/** Banner for an active session preset; undefined when none is active. */
export function presetBanner(state: RuntimeState): string | undefined {
  const preset = state.capabilities.preset;
  if (!preset) return undefined;
  return `${preset.name} preset active: modify/destructive rows tightened to deny (marked *)`;
}

/** "allow", or "allow → deny*" when the preset tightens the row past what it says. */
export function dispositionCell(row: DispositionRow): string {
  return row.presetTightened ? `${row.value} → ${row.effective.disposition}*` : row.value;
}

/** Stats-bearing one-liner for select labels: "off-machine-effects  ask  3 hits · 1 denied". */
export function dispositionSummary(row: DispositionRow): string {
  const parts = [row.id, dispositionCell(row)];
  if (row.modified) parts.push("(modified)");
  if (row.statsLabel) parts.push(row.statsLabel);
  return parts.join("  ");
}
