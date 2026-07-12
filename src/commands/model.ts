import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, resolveClassifierModel } from "../classifier.ts";
import { resolveAutoClassifierModel } from "../classifier-models.ts";
import { loadConfig } from "../config.ts";
import { selectClassifierModel } from "../model-selector.ts";
import { getPersistentConfigPath, updatePersistentClassifierSettings } from "../persistent-settings.ts";
import type { RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

function persist(ctx: ExtensionContext, update: { enabled?: boolean; model?: string }): void {
  try {
    updatePersistentClassifierSettings(update);
  } catch (error) {
    ctx.ui.notify(`Could not persist guard classifier setting: ${formatError(error)}`, "warning");
  }
}

/** Handles `/guard model [auto|current|off|status|provider/model]`; no arg opens the selector in TUI mode. */
export async function runModelCommand(args: string, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const config = state.config ?? loadConfig(ctx);
  const arg = args.trim();
  const show = (message: string) => {
    if (!ctx.hasUI) console.log(message);
    ctx.ui.notify(message, "info");
  };

  if (arg === "off") {
    state.classifier.enabledOverride = false;
    persist(ctx, { enabled: false });
    show("Guard classifier disabled and saved.");
    return;
  }
  if (arg === "auto") {
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "auto";
    persist(ctx, { enabled: true, model: "auto" });
    const resolved = resolveClassifierModel(ctx, config, state.classifier);
    show(`Guard classifier enabled in auto mode and saved${resolved ? `; currently resolves to ${resolved.provider}/${resolved.id}` : "; no known-good model is available yet"}.`);
    return;
  }
  if (arg === "current") {
    if (!ctx.model) {
      ctx.ui.notify("No current Pi model is selected.", "error");
      return;
    }
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "current";
    persist(ctx, { enabled: true, model: "current" });
    show(`Guard classifier enabled using current model and saved: ${ctx.model.provider}/${ctx.model.id}`);
    return;
  }
  if (arg && arg !== "status") {
    const slash = arg.indexOf("/");
    const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
    if (!model) {
      ctx.ui.notify(`Model not found: ${arg}`, "error");
      return;
    }
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = `${model.provider}/${model.id}`;
    persist(ctx, { enabled: true, model: state.classifier.modelOverride });
    show(`Guard classifier enabled and saved using ${model.provider}/${model.id}`);
    return;
  }

  if (!arg && ctx.mode === "tui") {
    ctx.modelRegistry.refresh();
    const choice = await selectClassifierModel({
      ctx,
      models: ctx.modelRegistry.getAvailable(),
      currentModel: ctx.model && ctx.model.provider !== "unknown" && ctx.model.id !== "unknown" ? ctx.model : undefined,
      autoModel: resolveAutoClassifierModel(ctx.modelRegistry.getAvailable()),
      selectedLabel: state.classifier.modelOverride ?? config.classifier.model,
    });
    if (!choice) return;
    if (choice.value === "off") {
      state.classifier.enabledOverride = false;
    } else if (choice.value === "auto") {
      state.classifier.enabledOverride = true;
      state.classifier.modelOverride = "auto";
    } else if (choice.value === "current") {
      state.classifier.enabledOverride = true;
      state.classifier.modelOverride = "current";
    } else if (choice.model) {
      state.classifier.enabledOverride = true;
      state.classifier.modelOverride = `${choice.model.provider}/${choice.model.id}`;
    }
    persist(ctx, { enabled: state.classifier.enabledOverride, model: state.classifier.modelOverride });
  }

  const selected = resolveClassifierModel(ctx, config, state.classifier);
  const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`).slice(0, 30);
  show([
    `Classifier: ${classifierEnabled(config, state.classifier) ? "enabled" : "disabled"}`,
    `Configured model: ${state.classifier.modelOverride ?? config.classifier.model}`,
    `Resolved model: ${selected ? `${selected.provider}/${selected.id}` : "(none)"}`,
    `Persistent config: ${getPersistentConfigPath()}`,
    state.classifier.lastDecision ? `Last decision: ${state.classifier.lastDecision.decision} ${state.classifier.lastDecision.reason}` : undefined,
    state.classifier.lastError ? `Last error: ${state.classifier.lastError}` : undefined,
    "",
    "Available models:",
    ...(available.length > 0 ? available.map((model) => `- ${model}`) : ["(none with configured auth)"]),
  ].filter((line): line is string => typeof line === "string").join("\n"));
}
