import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { buildClassifierPromptForCritique } from "../classifier.ts";
import { loadConfig, type ResolvedGuardConfig } from "../config.ts";
import { getPersistentConfigPath } from "../persistent-settings.ts";
import type { RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

const CRITIQUE_SYSTEM_PROMPT = `You are an expert reviewer of auto mode classifier rules for a local coding agent guard.

The guard has an auto mode classifier that uses an AI reviewer to decide whether tool calls should be auto-approved, denied, or require user confirmation. Users can write custom rules in these categories:

- allow: Actions the classifier may auto-approve
- soft_deny: Actions the classifier should block or ask for user confirmation unless clearly authorized
- hard_deny: Actions the classifier should always deny
- environment: Context about the user's setup and trust boundaries

Your job is to critique the rules for clarity, completeness, and potential issues. The classifier is an LLM that reads these rules as part of its system prompt.

For each rule, evaluate:
1. Clarity: Is the rule unambiguous? Could the classifier misinterpret it?
2. Completeness: Are there gaps or edge cases the rule does not cover?
3. Conflicts: Do any rules conflict with each other?
4. Actionability: Is the rule specific enough for the classifier to act on?

Be concise and constructive. Only comment on rules that could be improved. If all rules look good, say so.`;

function formatRulesForCritique(config: ResolvedGuardConfig): string {
  const sections = config.classifier.rules;
  return [
    "allow:",
    ...sections.allow.map((rule) => `- ${rule}`),
    "",
    "soft_deny:",
    ...sections.soft_deny.map((rule) => `- ${rule}`),
    "",
    "hard_deny:",
    ...sections.hard_deny.map((rule) => `- ${rule}`),
    "",
    "environment:",
    ...sections.environment.map((rule) => `- ${rule}`),
  ].join("\n");
}

/** Handles `/guard critique [provider/model]`; defaults to Pi's current model. */
export function createCritiqueRunner(deps: { pi: ExtensionAPI; state: RuntimeState }) {
  const { pi, state } = deps;

  return async function runCritiqueCommand(args: string, ctx: ExtensionContext) {
    const config = state.config ?? loadConfig(ctx);
    const modelSpec = args.trim();
    const model = modelSpec
      ? (() => {
          const slash = modelSpec.indexOf("/");
          return slash > 0 ? ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1)) : undefined;
        })()
      : ctx.model;

    if (!model || model.provider === "unknown" || model.id === "unknown") {
      ctx.ui.notify("No critique model selected. Use /guard critique provider/model or select a Pi model first.", "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "error");
      return;
    }

    ctx.ui.setStatus("guard-critique", ctx.ui.theme.fg("accent", "Critiquing guard rules"));
    ctx.ui.notify(`Critiquing guard rules with ${model.provider}/${model.id}...`, "info");
    const userPrompt = [
      "Here is the full classifier system prompt that the guard auto mode classifier receives:",
      "",
      "<classifier_system_prompt>",
      buildClassifierPromptForCritique(config),
      "</classifier_system_prompt>",
      "",
      "Here are the resolved classifier rules from the current config. Configured sections replace the corresponding defaults; otherwise defaults are used:",
      "",
      formatRulesForCritique(config),
      "",
      "Please critique these rules.",
    ].join("\n");

    const message: Message = { role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() };
    try {
      const response = await complete(
        model,
        { systemPrompt: CRITIQUE_SYSTEM_PROMPT, messages: [message] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
      );
      if (response.stopReason === "aborted") throw new Error("critique aborted");
      const critique = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const output = [
        "# Guard rule critique",
        "",
        `Model: ${model.provider}/${model.id}`,
        `Config: ${getPersistentConfigPath()}`,
        "",
        critique || "No critique returned.",
      ].join("\n");
      if (!ctx.hasUI) console.log(output);
      pi.sendMessage({ customType: "pi-guard", content: output, display: true });
      ctx.ui.notify("Guard rule critique posted.", "info");
    } catch (error) {
      const reason = formatError(error);
      if (!ctx.hasUI) console.log(`Guard critique failed: ${reason}`);
      ctx.ui.notify(`Guard critique failed: ${reason}`, "error");
    } finally {
      ctx.ui.setStatus("guard-critique", undefined);
    }
  };
}
