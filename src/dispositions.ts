/**
 * The view model behind the disposition settings page: one row per capability
 * class, resolved against the persisted config, the session overrides, and any
 * session preset. The TUI page and the RPC select degradation both read it, so
 * the two surfaces describe the same table in the same words.
 */
import {
  CUSTOM_CLASS_ID_PATTERN,
  DISPOSITIONS,
  addSessionClass,
  capabilityRegistry,
  clearSessionDisposition,
  deleteSessionClass,
  getEffectiveDisposition,
  isBuiltinCapabilityId,
  setSessionDefinition,
  setSessionDisposition,
  type CapabilityClass,
  type CapabilityId,
  type CapabilityStats,
  type Disposition,
  type EffectiveDisposition,
} from "./capabilities.ts";
import { configSourceLabel, globalGuardConfigPath, type ResolvedGuardConfig } from "./config.ts";
import {
  updatePersistentCapabilityClass,
  updatePersistentCapabilityDefinition,
  updatePersistentDisposition,
  type PersistedCapabilityClass,
} from "./persistent-settings.ts";
import { syncCapabilityPreset, type RuntimeState } from "./state.ts";

/** One-line help per disposition, for select labels and completions. */
export const DISPOSITION_HELP: Record<Disposition, string> = {
  allow: "run without review",
  judge: "let the strong model decide, one action at a time",
  ask: "bring me in before it runs",
  deny: "refuse outright",
};

/**
 * First sentence of a class definition, capped. The definitions are prompt
 * text written for the namer; the page footer wants a line, not a prompt dump.
 */
function shortDefinition(definition: string): string {
  const sentence = definition.match(/^.*?\.(?=\s|$)/)?.[0] ?? definition;
  return sentence.length > 150 ? `${sentence.slice(0, 149).trimEnd()}…` : sentence;
}

export interface DispositionRow {
  id: CapabilityId;
  name: string;
  /** Short form of the class definition, for the page footer and select descriptions. */
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
  /** Built-ins can be edited but never deleted; the page uses this for the `d` refusal. */
  builtin: boolean;
  /** This session added the class — it is not in any config file yet. */
  sessionNew: boolean;
  /** This session changed the class definition. */
  sessionEdited: boolean;
  /** The full definition text, for the edit form (`definition` is the shortened footer form). */
  fullDefinition: string;
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

/** Every class in registry order. Recomputed on each refresh, so live stats, class edits, and preset changes land without extra plumbing. */
export function dispositionRows(config: ResolvedGuardConfig | undefined, state: RuntimeState): DispositionRow[] {
  // The preset is derived from state.readOnly; sync here so a read-only toggle
  // while the page is open shows up on the next refresh.
  syncCapabilityPreset(state);
  const sessionAdded = new Set(state.capabilities.customClasses.map((entry) => entry.id));
  return capabilityRegistry(config, state.capabilities).map((entry) => {
    const persisted = getEffectiveDisposition(config, undefined, entry.id).disposition;
    const override = state.capabilities.overrides[entry.id];
    const effective = getEffectiveDisposition(config, state.capabilities, entry.id);
    const stats = state.capabilities.stats[entry.id];
    return {
      id: entry.id,
      name: entry.name,
      definition: shortDefinition(entry.definition),
      value: override ?? persisted,
      persisted,
      modified: override !== undefined && override !== persisted,
      effective,
      presetTightened: effective.scope === "preset",
      stats,
      statsLabel: statsLabel(stats),
      builtin: isBuiltinCapabilityId(entry.id),
      sessionNew: sessionAdded.has(entry.id),
      // A session-added class carries its edits inside its own entry, so only
      // a definitionEdits key counts as editing something that already existed.
      sessionEdited: state.capabilities.definitionEdits[entry.id] !== undefined,
      fullDefinition: entry.definition,
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
  /** Custom classes this save created in the global config. */
  added: CapabilityId[];
  /** Classes whose definition this save rewrote (built-in overrides and custom-class edits alike). */
  edited: CapabilityId[];
  /** Custom classes this save removed from the global config. */
  removed: CapabilityId[];
}

/** The persist boundary Ctrl+S writes through; injectable so tests never touch the real config file. */
export interface DispositionPersistence {
  disposition(id: CapabilityId, disposition: Disposition | undefined): void;
  capabilityClass(id: string, entry: PersistedCapabilityClass | undefined): void;
  capabilityDefinition(id: string, definition: string | undefined): void;
}

export const DEFAULT_DISPOSITION_PERSISTENCE: DispositionPersistence = {
  disposition: updatePersistentDisposition,
  capabilityClass: updatePersistentCapabilityClass,
  capabilityDefinition: updatePersistentCapabilityDefinition,
};

/**
 * Ctrl+S: writes every session change — disposition rows, added classes,
 * definition edits, deleted classes — to the global config, folds each into the
 * in-memory resolved config, and clears the session layer. Everything is
 * persisted now, so the modified/new/edited markers go away and no effective
 * value moves.
 */
export function saveDispositions(
  config: ResolvedGuardConfig | undefined,
  state: RuntimeState,
  persist: DispositionPersistence = DEFAULT_DISPOSITION_PERSISTENCE,
): SaveResult {
  const result: SaveResult = { saved: [], shadowed: [], added: [], edited: [], removed: [] };
  const globalPath = globalGuardConfigPath();

  // Classes first: a disposition row for a class added in the same session has
  // to land in a config that already declares the class.
  for (const entry of [...state.capabilities.customClasses]) {
    persist.capabilityClass(entry.id, toPersistedClass(entry));
    result.added.push(entry.id);
    if (config) {
      const at = config.capabilities.classes.findIndex((existing) => existing.id === entry.id);
      if (at === -1) config.capabilities.classes.push({ ...entry });
      else config.capabilities.classes[at] = { ...entry };
      config.provenance.capabilityClasses[entry.id] = globalPath;
    }
  }
  state.capabilities.customClasses = [];

  for (const [id, definition] of Object.entries(state.capabilities.definitionEdits)) {
    if (isBuiltinCapabilityId(id)) {
      persist.capabilityDefinition(id, definition);
      if (config) {
        config.capabilities.definitions[id] = definition;
        config.provenance.capabilityDefinitions[id] = globalPath;
      }
    } else {
      // A persisted custom class stores its definition inline, so editing it is
      // a rewrite of the class entry rather than a definitions-map override.
      const existing = config?.capabilities.classes.find((entry) => entry.id === id);
      if (existing) {
        existing.definition = definition;
        persist.capabilityClass(id, toPersistedClass(existing));
        config!.provenance.capabilityClasses[id] = globalPath;
      }
    }
    result.edited.push(id);
  }
  state.capabilities.definitionEdits = {};

  for (const id of [...state.capabilities.deletedCustom]) {
    persist.capabilityClass(id, undefined);
    result.removed.push(id);
    if (config) {
      config.capabilities.classes = config.capabilities.classes.filter((entry) => entry.id !== id);
      delete config.provenance.capabilityClasses[id];
    }
  }
  state.capabilities.deletedCustom = [];

  for (const [key, disposition] of Object.entries(state.capabilities.overrides)) {
    const id = key as CapabilityId;
    if (!disposition) continue;
    persist.disposition(id, disposition);
    result.saved.push(id);
    if (config) {
      const previous = config.provenance.dispositions[id];
      if (previous !== undefined && previous !== "default" && previous !== globalPath) result.shadowed.push(id);
      config.dispositions[id] = disposition;
      config.provenance.dispositions[id] = globalPath;
    }
    clearSessionDisposition(state.capabilities, id);
  }
  return result;
}

function toPersistedClass(entry: CapabilityClass): PersistedCapabilityClass {
  return {
    id: entry.id,
    ...(entry.name && entry.name !== entry.id ? { name: entry.name } : {}),
    definition: entry.definition,
    disposition: entry.default,
  };
}

/** True when Ctrl+S has anything to write. */
export function hasUnsavedChanges(state: RuntimeState): boolean {
  const capabilities = state.capabilities;
  return (
    Object.keys(capabilities.overrides).length > 0
    || capabilities.customClasses.length > 0
    || Object.keys(capabilities.definitionEdits).length > 0
    || capabilities.deletedCustom.length > 0
  );
}

// ── Class editing (session scope until Ctrl+S) ───────────────────────────────

/** New classes default to ask — see PERMISSIONS_PLAN: a newly named intent is exactly what the user wants to be asked about. */
export const NEW_CLASS_DISPOSITION: Disposition = "ask";

/**
 * Validates and adds a class at session scope. Returns an error message when
 * the id is malformed or taken; the caller keeps the user in the form so the
 * typed definition is not lost.
 */
export function addClass(
  config: ResolvedGuardConfig | undefined,
  state: RuntimeState,
  input: { id: string; definition: string; name?: string },
): string | undefined {
  const id = input.id.trim().toLowerCase();
  const definition = input.definition.trim();
  if (!id) return "A class id is required.";
  if (isBuiltinCapabilityId(id)) return `${id} is a built-in class. Edit its definition instead of redefining it.`;
  if (!CUSTOM_CLASS_ID_PATTERN.test(id)) return "Ids are kebab-case: a letter, then letters, digits, or hyphens (2-41 characters).";
  if (capabilityRegistry(config, state.capabilities).some((entry) => entry.id === id)) return `${id} already exists.`;
  if (!definition) return "A definition is required — it is the prompt text the namer reads.";
  addSessionClass(state.capabilities, {
    id,
    name: input.name?.trim() || id,
    definition,
    default: NEW_CLASS_DISPOSITION,
  });
  return undefined;
}

/** Edits a class definition at session scope. Any class may be edited, including built-ins. */
export function editClassDefinition(
  config: ResolvedGuardConfig | undefined,
  state: RuntimeState,
  id: CapabilityId,
  definition: string,
): string | undefined {
  const trimmed = definition.trim();
  if (!trimmed) return "A definition is required — it is the prompt text the namer reads.";
  if (!capabilityRegistry(config, state.capabilities).some((entry) => entry.id === id)) return `Unknown capability class: ${id}.`;
  setSessionDefinition(state.capabilities, id, trimmed);
  return undefined;
}

/**
 * Deletes a custom class at session scope. Built-ins are editable but not
 * deletable: deterministic mappers and the read-only preset name them as
 * literals, so removing one would leave those paths pointing at nothing.
 */
export function deleteClass(state: RuntimeState, id: CapabilityId): string | undefined {
  if (isBuiltinCapabilityId(id)) return `${id} is built-in and cannot be deleted — set it to deny, or edit its definition.`;
  deleteSessionClass(state.capabilities, id);
  clearSessionDisposition(state.capabilities, id);
  return undefined;
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
