import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { pickFromList, type CustomUiHost, type SelectItem, type SelectTab } from "./tui/select-list.ts";

/** Which reviewer stage a pick applies to; the dialog's two tabs. */
export type ClassifierModelTarget = "namer" | "judge";

export type ClassifierModelValue = "off" | "auto" | "current" | "model";

export interface ClassifierModelChoice {
  target: ClassifierModelTarget;
  value: ClassifierModelValue;
  model?: Model<Api>;
}

/** One stage's configured spec and what it resolves to right now. */
export interface ClassifierModelTargetState {
  /** "auto" | "current" | "provider/id" — the spec the ✓ is matched against. */
  spec: string;
  resolved?: Model<Api>;
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function summaryLine(target: ClassifierModelTarget, state: ClassifierModelTargetState): string {
  return `${target}: ${state.spec}${state.resolved ? ` → ${modelLabel(state.resolved)}` : " → (unavailable)"}`;
}

/** The explicit provider/model rows, shared by both tabs but checked per target. */
function modelItems(target: ClassifierModelTarget, models: Model<Api>[], spec: string): SelectItem<ClassifierModelChoice>[] {
  return models.map((model) => ({
    value: { target, value: "model", model },
    label: modelLabel(model),
    searchText: `${model.provider} ${model.id} ${model.name ?? ""}`,
    suffix: `[${model.provider}]`,
    description: model.name,
    current: spec === modelLabel(model),
  }));
}

function namerItems(params: {
  models: Model<Api>[];
  currentModel?: Model<Api>;
  autoModel?: Model<Api>;
  spec: string;
}): SelectItem<ClassifierModelChoice>[] {
  const items: SelectItem<ClassifierModelChoice>[] = [
    {
      value: { target: "namer", value: "auto" },
      label: "auto",
      searchText: "auto default known good subscription",
      description: params.autoModel
        ? `Best available known-good model, subscriptions first (currently ${modelLabel(params.autoModel)})`
        : "Best available known-good model, subscriptions first (none available yet)",
      current: params.spec === "auto",
    },
    {
      value: { target: "namer", value: "off" },
      label: "off",
      searchText: "off disable classifier",
      description: "Disable classifier review",
    },
  ];

  if (params.currentModel) {
    items.push({
      value: { target: "namer", value: "current", model: params.currentModel },
      label: `current (${modelLabel(params.currentModel)})`,
      searchText: `current ${params.currentModel.provider} ${params.currentModel.id} ${params.currentModel.name ?? ""}`,
      description: "Always use Pi's current active model",
      current: params.spec === "current",
    });
  }

  return [...items, ...modelItems("namer", params.models, params.spec)];
}

/**
 * The judge tab deliberately offers neither "off" nor "auto":
 *
 * - "off" would make a `judge` disposition undecidable, and that failure is
 *   meant to stay loud rather than become a setting.
 * - "auto" resolves against AUTO_CLASSIFIER_PREFERENCES, a list of cheap
 *   high-volume namer models. Silently pointing the escalation review at a
 *   mini model is the opposite of what the judge is for.
 */
function judgeItems(params: { models: Model<Api>[]; currentModel?: Model<Api>; spec: string }): SelectItem<ClassifierModelChoice>[] {
  const items: SelectItem<ClassifierModelChoice>[] = [];
  if (params.currentModel) {
    items.push({
      value: { target: "judge", value: "current", model: params.currentModel },
      label: `current (${modelLabel(params.currentModel)})`,
      searchText: `current ${params.currentModel.provider} ${params.currentModel.id} ${params.currentModel.name ?? ""}`,
      description: "Always use Pi's current active model — the session's own strong model",
      current: params.spec === "current",
    });
  }
  return [...items, ...modelItems("judge", params.models, params.spec)];
}

/**
 * The two-tab reviewer model picker. Tab cycles namer ⇄ judge; the header
 * carries both stages' configured spec and what it resolves to, so the
 * consequence of a pick is visible from either tab.
 */
export async function selectClassifierModel(params: {
  ctx: CustomUiHost;
  models: Model<Api>[];
  currentModel?: Model<Api>;
  autoModel?: Model<Api>;
  namer: ClassifierModelTargetState;
  judge: ClassifierModelTargetState;
}): Promise<ClassifierModelChoice | undefined> {
  const tabs: SelectTab<ClassifierModelChoice>[] = [
    {
      id: "namer",
      label: "namer",
      items: namerItems({ models: params.models, currentModel: params.currentModel, autoModel: params.autoModel, spec: params.namer.spec }),
    },
    {
      id: "judge",
      label: "judge",
      headerLines: ["The judge cannot be turned off — pick which model reviews escalations."],
      items: judgeItems({ models: params.models, currentModel: params.currentModel, spec: params.judge.spec }),
    },
  ];

  const picked = await pickFromList<ClassifierModelChoice>(params.ctx, {
    title: "Rail classifier model",
    headerLines: [summaryLine("namer", params.namer), summaryLine("judge", params.judge)],
    tabs,
  });
  return picked?.value;
}
