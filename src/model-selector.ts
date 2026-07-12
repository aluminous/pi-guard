import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { pickFromList, type CustomUiHost, type SelectItem } from "./tui/select-list.ts";

export type ClassifierModelValue = "off" | "auto" | "current" | "model";

export interface ClassifierModelChoice {
  value: ClassifierModelValue;
  model?: Model<Api>;
}

export async function selectClassifierModel(params: {
  ctx: CustomUiHost;
  models: Model<Api>[];
  currentModel?: Model<Api>;
  autoModel?: Model<Api>;
  selectedLabel?: string;
}): Promise<ClassifierModelChoice | undefined> {
  const items: SelectItem<ClassifierModelChoice>[] = [
    {
      value: { value: "auto" },
      label: "auto",
      searchText: "auto default known good subscription",
      description: params.autoModel
        ? `Best available known-good model, subscriptions first (currently ${params.autoModel.provider}/${params.autoModel.id})`
        : "Best available known-good model, subscriptions first (none available yet)",
      current: params.selectedLabel === "auto",
    },
    {
      value: { value: "off" },
      label: "off",
      searchText: "off disable classifier",
      description: "Disable classifier review",
    },
  ];

  if (params.currentModel) {
    items.push({
      value: { value: "current", model: params.currentModel },
      label: `current (${params.currentModel.provider}/${params.currentModel.id})`,
      searchText: `current ${params.currentModel.provider} ${params.currentModel.id} ${params.currentModel.name ?? ""}`,
      description: "Always use Pi's current active model",
      current: params.selectedLabel === "current",
    });
  }

  for (const model of params.models) {
    const label = `${model.provider}/${model.id}`;
    items.push({
      value: { value: "model", model },
      label,
      searchText: `${model.provider} ${model.id} ${model.name ?? ""}`,
      suffix: `[${model.provider}]`,
      description: model.name,
      current: params.selectedLabel === label,
    });
  }

  const picked = await pickFromList(params.ctx, { title: "Guard classifier model", items });
  return picked?.value;
}
