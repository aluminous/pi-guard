import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityId, Disposition } from "../capabilities.ts";
import { loadConfig, type StatusLineMode } from "../config.ts";
import { formatDecisionTrace, formatEmptyTrace } from "../decision-trace.ts";
import { updatePersistentStatusLine } from "../persistent-settings.ts";
import type { RuntimeState } from "../state.ts";
import { classifierModelLabel, formatGuardPolicy, formatGuardStatus, networkPolicyLabel, updateGuardStatus } from "../status.ts";
import { showGuardView, toggleGuardView } from "../live-view.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";
import { createDispositionCommands } from "./dispositions.ts";
import { runModelCommand } from "./model.ts";
import { createGuardTest } from "./test.ts";
import { createGuardWhy } from "./why.ts";

export interface GuardCommandDeps {
  state: RuntimeState;
  enableGuard(ctx: ExtensionContext): Promise<void>;
  disableGuard(ctx: ExtensionContext, scope: "next-agent" | "session"): Promise<void>;
  runGuardSmoke(ctx: ExtensionContext): Promise<void>;
  runCritique(args: string, ctx: ExtensionContext): Promise<void>;
  /** Disposition persist boundary; defaults to the global config writer, overridden in tests. */
  persistDisposition?: (id: CapabilityId, disposition: Disposition | undefined) => void;
}

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "status", description: "Toggle the live status popup" },
  { value: "policy", description: "Open the capability disposition page (edit rows for this session; Ctrl+S saves)" },
  { value: "policy rules", description: "Show the resolved mechanism policy: filesystem, network, environment, legacy rules" },
  { value: "set", description: "Set one class for this session: set <class> [allow|judge|ask|deny]" },
  { value: "explain", description: "Show the newest decision trace (explain <n> for older ones)" },
  { value: "test", description: "Dry-run a shell command through the guard without executing it" },
  { value: "test read", description: "Dry-run a file read through the guard (test read <path>)" },
  { value: "test write", description: "Dry-run a file write through the guard (test write <path>)" },
  { value: "why", description: "Map sandbox denials from the last guarded command to guard rules" },
  { value: "on", description: "Enable the guard" },
  { value: "off", description: "Disable for the next agent turn, then re-enable" },
  { value: "off session", description: "Disable until the session ends (unguarded!)" },
  { value: "readonly", description: "Toggle read-only mode: write/edit blocked, bash restricted" },
  { value: "model", description: "Choose the namer model (auto|current|off|provider/model)" },
  { value: "smoke", description: "Run sandbox and namer smoke tests" },
  { value: "critique", description: "Critique the capability classes and content screen with a model" },
];

export function createGuardCommand(deps: GuardCommandDeps) {
  const { state } = deps;
  const runGuardTest = createGuardTest({ state });
  const runGuardWhy = createGuardWhy({ state });

  const show = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (!ctx.hasUI) console.log(message);
    ctx.ui.notify(message, level);
  };

  const dispositions = createDispositionCommands({ state, persist: deps.persistDisposition, notify: show });

  async function enable(ctx: ExtensionContext): Promise<void> {
    try {
      await deps.enableGuard(ctx);
      show(ctx, "Pi Guard enabled.");
    } catch (error) {
      state.enabled = false;
      state.initialized = false;
      state.lastError = formatError(error);
      show(ctx, `Could not enable Pi Guard: ${state.lastError}`, "error");
    }
  }

  async function disableTurn(ctx: ExtensionContext): Promise<void> {
    await deps.disableGuard(ctx, "next-agent");
    show(ctx, "Pi Guard disabled for the next agent turn; it will re-enable when the agent finishes.", "warning");
  }

  async function disableSession(ctx: ExtensionContext): Promise<void> {
    await deps.disableGuard(ctx, "session");
    show(ctx, "Pi Guard disabled for this session; bash and file-tool policy checks are unguarded.", "warning");
  }

  function toggleReadOnly(ctx: ExtensionContext): void {
    state.readOnly = !state.readOnly;
    if (state.readOnly) show(ctx, "Guard read-only mode on: write/edit are blocked and bash is restricted to read-only commands.");
    else show(ctx, "Guard read-only mode off.");
  }

  /** Shows the nth-newest decision trace (1-based, default newest) through the report view. */
  function showExplain(ctx: ExtensionContext, args: string): void {
    const total = state.traces.length;
    if (total === 0) {
      showGuardView(ctx, state, "report", () => formatEmptyTrace().split("\n"));
      return;
    }
    const n = args.trim() === "" ? 1 : Number.parseInt(args.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > total) {
      show(ctx, `Usage: /guard explain [n] with n between 1 (newest) and ${total}.`, "warning");
      return;
    }
    const trace = state.traces[n - 1]!;
    showGuardView(ctx, state, "report", () => formatDecisionTrace(trace, n, total).split("\n"));
  }

  /** TUI: toggle the live popup. RPC: toggle a live widget. Headless: print to stdout. Never posted to the agent. */
  function showView(ctx: ExtensionContext, kind: "status" | "policy"): void {
    toggleGuardView(ctx, state, kind, () => {
      const config = state.config ?? loadConfig(ctx);
      return (kind === "status" ? formatGuardStatus(state, config) : formatGuardPolicy(state, config)).split("\n");
    });
  }

  function panelHeader(ctx: ExtensionContext): string[] {
    const config = state.config ?? loadConfig(ctx);
    const health = state.enabled && state.initialized ? "enforcing" : state.enabled ? "enabled, not initialized" : state.disabledForNextAgent ? "off next turn" : "disabled";
    const modelLabel = classifierModelLabel(ctx, config, state);
    const classifier = modelLabel.startsWith("classifier") ? modelLabel : `classifier ${modelLabel}`;
    const s = state.stats;
    return [
      `${state.backend?.name ?? config.backend} · ${health} · ${networkPolicyLabel(config)} · ${classifier}`,
      `R${s.ruleHits} deterministic · C${s.classifierHits} reviews · D${s.classifierDenials} denials · ${s.blocked} blocked · ${s.errors} errors · ↑${s.classifierInputTokens} ↓${s.classifierOutputTokens} tokens`,
    ];
  }

  const STATUS_LINE_MODES: Array<{ value: StatusLineMode; description: string }> = [
    { value: "always", description: "Show the guard statusline at all times" },
    { value: "auto", description: "Show only when the guard is off or erroring, or something was denied since your last message" },
    { value: "never", description: "Hide the guard statusline entirely" },
  ];

  async function chooseStatusLine(ctx: ExtensionContext): Promise<void> {
    const config = state.config ?? loadConfig(ctx);
    state.config = config;
    const items: SelectItem<StatusLineMode>[] = STATUS_LINE_MODES.map((mode) => ({
      value: mode.value,
      label: mode.value,
      searchText: `${mode.value} statusline ${mode.description}`,
      description: mode.description,
      current: config.statusLine === mode.value,
    }));
    const picked = await pickFromList<StatusLineMode>(ctx, { title: "Guard statusline", items });
    if (!picked) return;
    config.statusLine = picked.value;
    try {
      updatePersistentStatusLine(picked.value);
      show(ctx, `Guard statusline set to ${picked.value} and saved.`);
    } catch (error) {
      show(ctx, `Guard statusline set to ${picked.value} for this session, but saving failed: ${formatError(error)}`, "warning");
    }
  }

  type PanelAction = "on" | "off-turn" | "off-session" | "readonly" | "model" | "statusline" | "smoke" | "critique" | "status" | "dispositions" | "policy-rules" | "explain";

  async function openPanel(ctx: ExtensionContext): Promise<void> {
    const items: SelectItem<PanelAction>[] = [];
    if (!state.enabled) {
      items.push({ value: "on", label: "Enable guard", searchText: "enable on start guard", description: "Initialize the sandbox backend and enforce policy" });
    } else {
      items.push(
        { value: "off-turn", label: "Disable for next turn", searchText: "disable off next turn pause", description: "One unguarded agent turn, then the guard re-enables itself" },
        { value: "off-session", label: "Disable for session", searchText: "disable off session unguarded", description: "Unguarded until Pi restarts — asks for confirmation" },
      );
    }
    items.push(
      { value: "readonly", label: `Read-only mode: ${state.readOnly ? "on" : "off"}`, searchText: "readonly read only ro toggle mode", description: "Block write/edit and restrict bash to read-only commands" },
      { value: "model", label: "Namer model…", searchText: "model namer classifier auto choose select", description: "Pick auto, the current model, a specific model, or turn review off" },
      { value: "statusline", label: "Statusline visibility…", searchText: "statusline status line visibility always never auto hide show", description: "Show the guard statusline always, never, or only when notable" },
      { value: "smoke", label: "Run smoke tests", searchText: "smoke test verify sandbox namer classifier", description: "Verify sandboxed execution and capability naming end to end" },
      { value: "critique", label: "Critique capabilities", searchText: "critique capabilities classes screen rules review improve", description: "Have Pi's current model review the class definitions, table, and screen" },
      { value: "status", label: "Status popup", searchText: "status report details approvals live popup overlay", description: "Live status popup: decisions, approvals, guidance — updates while the agent works" },
      { value: "dispositions", label: "Dispositions…", searchText: "dispositions policy capabilities classes allow deny ask judge edit table page", description: "Edit the capability disposition table: arrows cycle a row for this session, Ctrl+S saves" },
      { value: "policy-rules", label: "Policy rules", searchText: "policy rules filesystem network environment provenance mechanism show", description: "Resolved filesystem/network/environment rules with their config provenance" },
      { value: "explain", label: "Explain last decision", searchText: "explain trace decision why last chain stages", description: "Show the decision chain the guard ran for the most recent tool call" },
    );

    const picked = await pickFromList<PanelAction>(ctx, { title: "Pi Guard", headerLines: panelHeader(ctx), items });
    if (!picked) return;
    switch (picked.value) {
      case "on":
        return enable(ctx);
      case "off-turn":
        return disableTurn(ctx);
      case "off-session": {
        const ok = await ctx.ui.confirm("Disable Pi Guard for this session?", "Bash and file-tool policy checks will run unguarded until Pi restarts.");
        if (ok) return disableSession(ctx);
        return;
      }
      case "readonly":
        return toggleReadOnly(ctx);
      case "model":
        return runModelCommand("", ctx, state);
      case "statusline":
        return chooseStatusLine(ctx);
      case "smoke":
        return deps.runGuardSmoke(ctx);
      case "critique":
        return deps.runCritique("", ctx);
      case "status":
        return showView(ctx, "status");
      case "dispositions":
        return dispositions.openSettings(ctx);
      case "policy-rules":
        return showView(ctx, "policy");
      case "explain":
        return showExplain(ctx, "");
    }
  }

  async function handler(args: string, ctx: ExtensionContext): Promise<void> {
    try {
      await dispatch(args, ctx);
    } finally {
      updateGuardStatus(ctx, state);
    }
  }

  async function dispatch(args: string, ctx: ExtensionContext): Promise<void> {
    const trimmed = args.trim();
    const [head = "", ...restParts] = trimmed.split(/\s+/);
    const rest = restParts.join(" ");
    const sub = head.toLowerCase();

    // Headless modes have no user to drive these; the seam modules turn them
    // into a clean no-op (pickFromList resolves undefined) or stderr error.
    if (!sub) return openPanel(ctx);
    if (sub === "status") return showView(ctx, "status");
    // /guard policy IS the disposition page now; the mechanism report moved one level down.
    if (sub === "policy") {
      const target = rest.trim().toLowerCase();
      if (!target) return dispositions.openSettings(ctx);
      if (target === "rules") return showView(ctx, "policy");
      show(ctx, "Usage: /guard policy [rules]", "warning");
      return;
    }
    if (sub === "set") return dispositions.runSet(rest, ctx);
    if (sub === "explain") return showExplain(ctx, rest);
    if (sub === "test") return runGuardTest(rest, ctx);
    if (sub === "why" && !rest) return runGuardWhy(ctx);
    if (sub === "on" || sub === "enable") return enable(ctx);
    if (sub === "off" || sub === "disable") {
      if (rest.toLowerCase() === "session") return disableSession(ctx);
      if (!rest) return disableTurn(ctx);
    }
    if ((sub === "readonly" || sub === "ro") && !rest) return toggleReadOnly(ctx);
    if (sub === "model") return runModelCommand(rest, ctx, state);
    if (sub === "smoke" && !rest) return deps.runGuardSmoke(ctx);
    if (sub === "critique") return deps.runCritique(rest, ctx);

    show(ctx, "Usage: /guard [status|policy [rules]|set <class> [disposition]|explain [n]|test …|why|on|off|off session|readonly|model …|smoke|critique …]", "warning");
  }

  function getArgumentCompletions(argumentPrefix: string) {
    const prefix = argumentPrefix.replace(/^\s+/, "");
    const setMatch = prefix.match(/^set\s+(.*)$/i);
    if (setMatch) return dispositions.setCompletions(setMatch[1]!);
    const modelMatch = prefix.match(/^(model|critique)\s+(.*)$/i);
    if (modelMatch) {
      const sub = modelMatch[1]!.toLowerCase();
      const partial = modelMatch[2]!.toLowerCase();
      const fixed = sub === "model" ? ["auto", "current", "off", "status"] : [];
      const specs = [...fixed, ...state.availableModelSpecs];
      const items = specs
        .filter((spec) => spec.toLowerCase().includes(partial))
        .slice(0, 20)
        .map((spec) => ({ value: `${sub} ${spec}`, label: spec, description: fixed.includes(spec) ? undefined : "configured model" }));
      return items.length > 0 ? items : null;
    }
    const items = SUBCOMMANDS
      .filter((cmd) => cmd.value.startsWith(prefix.toLowerCase()))
      .map((cmd) => ({ value: cmd.value, label: cmd.value, description: cmd.description }));
    return items.length > 0 ? items : null;
  }

  return { handler, getArgumentCompletions };
}
