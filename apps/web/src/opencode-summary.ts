import type { OpenCodeSummaryCatalog, SummaryModel } from "@moss/contracts";

export interface OpenCodeSelection {
  agentID?: string;
  model?: SummaryModel;
}

export function resolveOpenCodeSelection(catalog: OpenCodeSummaryCatalog | undefined, selection: OpenCodeSelection) {
  if (!catalog?.available) return null;
  const agent = catalog.agents.find(agent => agent.id === selection.agentID)
    ?? catalog.agents.find(agent => agent.id === "moss-summary") ?? catalog.agents[0];
  const selectedModel = catalog.models.find(model => model.id === selection.model?.id && model.providerID === selection.model.providerID);
  const model = selectedModel ?? catalog.models[0];
  if (!agent || !model) return null;
  const variant = selectedModel && selection.model?.variant !== undefined && model.variants.includes(selection.model.variant)
    ? selection.model.variant : undefined;
  return { agent, model, variant };
}

export function captureOpenCodeSelection(catalog: OpenCodeSummaryCatalog | undefined, selection: OpenCodeSelection) {
  const resolved = resolveOpenCodeSelection(catalog, selection);
  if (!resolved) return null;
  const { agent, model, variant } = resolved;
  return Object.freeze({
    agentID: agent.id,
    agentName: agent.name,
    modelName: model.name,
    model: Object.freeze({ id: model.id, providerID: model.providerID, ...(variant !== undefined ? { variant } : {}) }),
  });
}

export type OpenCodeSummarySelection = NonNullable<ReturnType<typeof captureOpenCodeSelection>>;
