import test from "node:test";
import assert from "node:assert/strict";
import type { OpenCodeSummaryCatalog } from "@moss/contracts";
import { captureOpenCodeSelection, resolveOpenCodeSelection, type OpenCodeSelection } from "../src/opencode-summary";

function catalog(): OpenCodeSummaryCatalog {
  return {
    available: true, message: "Ready",
    agents: [{ id: "general", name: "General" }, { id: "moss-summary", name: "Meeting summary", description: "Summarizes meetings" }],
    models: [
      { id: "chat", providerID: "first", name: "First chat", variants: ["high", "low"] },
      { id: "chat", providerID: "second", name: "Second chat", variants: ["fast"] },
    ],
  };
}

test("defaults prefer the returned moss-summary agent and a returned model without guessing a variant", () => {
  const result = resolveOpenCodeSelection(catalog(), {});
  assert.equal(result?.agent.id, "moss-summary");
  assert.equal(result?.model.providerID, "first");
  assert.equal(result?.variant, undefined);
  const withoutPreferred = catalog();
  withoutPreferred.agents = [withoutPreferred.agents[0]];
  assert.equal(resolveOpenCodeSelection(withoutPreferred, {})?.agent.id, "general");
});

test("a chosen returned agent, provider/model pair, and variant survive refresh", () => {
  const selection = { agentID: "general", model: { id: "chat", providerID: "second", variant: "fast" } };
  const result = resolveOpenCodeSelection(catalog(), selection);
  assert.equal(result?.agent.id, "general");
  assert.equal(result?.model.providerID, "second");
  assert.equal(result?.variant, "fast");
});

test("removed selections fall back only to returned values and drop unavailable variants", () => {
  const selection = { agentID: "removed", model: { id: "removed", providerID: "first", variant: "high" } };
  const result = resolveOpenCodeSelection(catalog(), selection);
  assert.equal(result?.agent.id, "moss-summary");
  assert.equal(result?.model.id, "chat");
  assert.equal(result?.variant, undefined);
  assert.equal(resolveOpenCodeSelection(catalog(), { model: { id: "chat", providerID: "second", variant: "high" } })?.variant, undefined);
});

test("missing, unavailable, or empty catalogs cannot produce a selection", () => {
  assert.equal(resolveOpenCodeSelection(undefined, {}), null);
  assert.equal(captureOpenCodeSelection({ ...catalog(), available: false }, {}), null);
  assert.equal(captureOpenCodeSelection({ ...catalog(), agents: [] }, {}), null);
  assert.equal(captureOpenCodeSelection({ ...catalog(), models: [] }, {}), null);
});

test("confirmation captures an immutable copy that later selection and catalog changes cannot alter", () => {
  const live = catalog();
  const selection: OpenCodeSelection = { agentID: "general", model: { id: "chat", providerID: "second", variant: "fast" } };
  const captured = captureOpenCodeSelection(live, selection)!;
  assert.deepEqual(captured, { agentID: "general", agentName: "General", modelName: "Second chat", model: { id: "chat", providerID: "second", variant: "fast" } });
  selection.agentID = "moss-summary";
  selection.model!.providerID = "first";
  selection.model!.variant = "high";
  live.agents[0].name = "Renamed";
  live.models[1].id = "another-model";
  assert.equal(captured.agentID, "general");
  assert.equal(captured.agentName, "General");
  assert.deepEqual(captured.model, { id: "chat", providerID: "second", variant: "fast" });
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.model));
  assert.throws(() => { Object.assign(captured.model, { variant: "high" }); }, TypeError);
});

test("confirmation omits the default variant and never spreads raw catalog configuration", () => {
  const live = catalog();
  Object.assign(live.models[0], { headers: { Authorization: "not-a-real-secret" }, url: "https://provider.invalid", variants: [] });
  Object.assign(live.agents[1], { tools: { shell: true } });
  const captured = captureOpenCodeSelection(live, {})!;
  assert.deepEqual(captured, { agentID: "moss-summary", agentName: "Meeting summary", modelName: "First chat", model: { id: "chat", providerID: "first" } });
  assert.equal("variant" in captured.model, false);
});
