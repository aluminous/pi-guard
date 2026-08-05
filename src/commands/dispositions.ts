import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_IDS, DISPOSITIONS, isCapabilityId, isDisposition, type CapabilityId, type Disposition } from "../capabilities.ts";
import { loadConfig, type ResolvedGuardConfig } from "../config.ts";
import {
  cycleDisposition,
  describeDispositionSource,
  dispositionCell,
  dispositionRow,
  dispositionRows,
  dispositionSummary,
  DISPOSITION_HELP,
  presetBanner,
  saveDispositions,
  setRowDisposition,
  type SaveResult,
} from "../dispositions.ts";
import { updatePersistentDisposition } from "../persistent-settings.ts";
import type { RuntimeState } from "../state.ts";
import { toggleGuardPanel } from "../live-view.ts";
import { DispositionPage } from "../tui/disposition-page.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";

export interface DispositionCommandDeps {
  state: RuntimeState;
  /** Persist boundary; injectable so tests never touch the real config file. */
  persist?: (id: CapabilityId, disposition: Disposition | undefined) => void;
  notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void;
}

/** "Dispositions saved: 2 rows." plus the honest note when a project config still owns one. */
function saveMessage(result: SaveResult): string {
  if (result.saved.length === 0) return "No session changes to save.";
  const base = `Dispositions saved: ${result.saved.length} row${result.saved.length === 1 ? "" : "s"}.`;
  if (result.shadowed.length === 0) return base;
  return `${base} Project config still sets ${result.shadowed.join(", ")} and wins next session.`;
}

export function createDispositionCommands(deps: DispositionCommandDeps) {
  const { state, notify } = deps;
  const persist = deps.persist ?? updatePersistentDisposition;

  function config(ctx: ExtensionContext) {
    const resolved = state.config ?? loadConfig(ctx);
    state.config = resolved;
    return resolved;
  }

  function save(ctx: ExtensionContext): void {
    try {
      notify(ctx, saveMessage(saveDispositions(state.config, state, persist)));
    } catch (error) {
      notify(ctx, `Could not save dispositions: ${formatError(error)}`, "error");
    }
  }

  /** `/guard policy`: the interactive page in the TUI, a select flow over RPC, an error headless. */
  async function openSettings(ctx: ExtensionContext): Promise<void> {
    const resolved = config(ctx);
    // The page outlives this call, so it reads state.config each refresh (a new
    // session reloads it) and falls back to what we resolved here.
    const current = () => state.config ?? resolved;
    const opened = toggleGuardPanel(ctx, state, "policy", (host) =>
      new DispositionPage({
        ...host,
        rows: () => dispositionRows(current(), state),
        cycle: (id, step) => setRowDisposition(current(), state, id, cycleDisposition(dispositionRow(current(), state, id).value, step)),
        save: () => save(ctx),
        banner: () => presetBanner(state),
      }),
    );
    if (opened) return;
    if (!ctx.hasUI) {
      console.error("The disposition page requires an interactive session (TUI or RPC).");
      return;
    }
    await runSelectFlow(ctx, resolved);
  }

  /**
   * RPC degradation: pick a class (labels carry the current disposition and
   * this session's stats), then pick a disposition; the choice applies at
   * session scope and the class list comes back so several rows can be edited
   * in a row. "Save persistently" is the Ctrl+S equivalent; cancel exits.
   */
  async function runSelectFlow(ctx: ExtensionContext, resolved: ResolvedGuardConfig): Promise<void> {
    for (;;) {
      const rows = dispositionRows(resolved, state);
      const banner = presetBanner(state);
      const items: SelectItem<CapabilityId | "save">[] = rows.map((row) => ({
        value: row.id,
        label: dispositionSummary(row),
        searchText: `${row.id} ${row.value} ${row.name}`,
        description: row.definition,
      }));
      items.push({
        value: "save",
        label: "Save persistently",
        searchText: "save persist write global config dispositions",
        description: "Write every session change to the global guard config",
      });
      const picked = await pickFromList<CapabilityId | "save">(ctx, {
        title: "Capability dispositions (changes apply to this session)",
        headerLines: banner ? [banner] : undefined,
        items,
      });
      if (!picked) return;
      if (picked.value === "save") {
        save(ctx);
        continue;
      }
      const id = picked.value;
      const row = dispositionRow(resolved, state, id);
      const choice = await pickFromList<Disposition>(ctx, {
        title: `${id} — currently ${dispositionCell(row)}`,
        items: DISPOSITIONS.map((disposition) => ({
          value: disposition,
          label: disposition,
          searchText: `${disposition} ${DISPOSITION_HELP[disposition]}`,
          description: DISPOSITION_HELP[disposition],
          current: disposition === row.value,
        })),
      });
      if (!choice) continue;
      setRowDisposition(resolved, state, id, choice.value);
      notify(ctx, `${id} → ${choice.value} for this session.`);
    }
  }

  /** `/guard set <class> [disposition]`: scripting/RPC parity with the page. */
  function runSet(args: string, ctx: ExtensionContext): void {
    const resolved = config(ctx);
    const [id = "", disposition = "", ...extra] = args.trim().split(/\s+/).filter((part) => part !== "");
    if (!id || extra.length > 0) {
      notify(ctx, "Usage: /guard set <class> [allow|judge|ask|deny]", "warning");
      return;
    }
    if (!isCapabilityId(id)) {
      notify(ctx, `Unknown capability class: ${id}. Known classes: ${CAPABILITY_IDS.join(", ")}`, "warning");
      return;
    }
    const row = dispositionRow(resolved, state, id);
    if (!disposition) {
      const preset = row.presetTightened ? ` (row says ${row.value})` : "";
      notify(ctx, `${id}: ${row.effective.disposition} — ${describeDispositionSource(row.effective)}${preset}`);
      return;
    }
    if (!isDisposition(disposition)) {
      notify(ctx, `Unknown disposition: ${disposition}. Use allow, judge, ask, or deny.`, "warning");
      return;
    }
    setRowDisposition(resolved, state, id, disposition);
    const after = dispositionRow(resolved, state, id);
    const preset = after.presetTightened ? ` (${after.effective.source} preset still forces ${after.effective.disposition})` : "";
    notify(ctx, `${id} → ${disposition} for this session${preset}. /guard policy then Ctrl+S persists it.`);
  }

  /** Completions for "set <class> <disposition>"; null when nothing matches. */
  function setCompletions(rest: string): Array<{ value: string; label: string; description: string }> | null {
    const parts = rest.split(/\s+/);
    if (parts.length <= 1) {
      const partial = (parts[0] ?? "").toLowerCase();
      const items = CAPABILITY_IDS.filter((id) => id.includes(partial)).map((id) => ({
        value: `set ${id}`,
        label: id,
        description: `currently ${dispositionRow(state.config, state, id).effective.disposition}`,
      }));
      return items.length > 0 ? items : null;
    }
    const id = parts[0]!.toLowerCase();
    const partial = (parts[1] ?? "").toLowerCase();
    const items = DISPOSITIONS.filter((disposition) => disposition.startsWith(partial)).map((disposition) => ({
      value: `set ${id} ${disposition}`,
      label: disposition,
      description: DISPOSITION_HELP[disposition],
    }));
    return items.length > 0 ? items : null;
  }

  return { openSettings, runSet, setCompletions };
}
