import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { OpenCodeSummaryCatalog, OpenCodeSummaryOptions } from "@moss/contracts";

export const openCodeUnavailable = "OpenCode is unavailable. Open OpenCode on this device, then refresh the agents and models.";

export async function discoverOpenCode(): Promise<OpenCodeClient | undefined> {
  const endpoint = await Service.discover();
  if (endpoint) return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

export async function openCodeSelections(client: OpenCodeClient, directory: string, signal: AbortSignal): Promise<OpenCodeSummaryCatalog> {
  const location = { directory };
  const [agents, models] = await Promise.all([
    client.agent.list({ location }, { signal }), client.model.list({ location, types: ["chat"] }, { signal }),
  ]);
  const catalog: OpenCodeSummaryCatalog = {
    available: true, message: "OpenCode is connected. Model inference may use a remote provider.",
    agents: agents.data.filter(agent => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
      .map(agent => ({ id: agent.id, name: agent.name, ...(agent.description ? { description: agent.description } : {}) })),
    models: models.data.filter(model => model.enabled && (!model.type || model.type === "chat"))
      .map(model => ({ id: model.id, providerID: model.providerID, name: model.name, variants: model.variants.map(variant => variant.id) })),
  };
  if (!catalog.agents.length || !catalog.models.length) {
    catalog.available = false;
    catalog.message = "OpenCode has no selectable agents or enabled chat models for this directory. Configure them in OpenCode, then refresh.";
  }
  return catalog;
}

export function hasOpenCodeSelection(catalog: OpenCodeSummaryCatalog, options: OpenCodeSummaryOptions): boolean {
  const model = catalog.models.find(model => model.id === options.model.id && model.providerID === options.model.providerID);
  return catalog.agents.some(agent => agent.id === options.agentID) && model !== undefined
    && (options.model.variant === undefined || model.variants.includes(options.model.variant));
}
