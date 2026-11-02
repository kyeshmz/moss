import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Health, Meeting } from "@moss/contracts";

export async function verifySharing(page: Page, run: string, health: Health, readMeeting: () => Promise<Meeting>): Promise<string[]> {
  const receipts: string[] = [];
  await page.getByText("Ask another agent", { exact: true }).click();
  await page.getByRole("combobox", { name: "OpenCode agent", exact: true }).selectOption("moss-editor");
  await page.getByRole("combobox", { name: "Agent content source", exact: true }).selectOption("summary");
  const instruction = "Review the summary for unsupported claims.";
  await page.getByRole("textbox", { name: "Agent instructions", exact: true }).fill(instruction);
  let workID: string | undefined;
  let workRequests = 0;
  await page.route("**/api/meetings/*/agent-work", async route => {
    const input = route.request().postDataJSON();
    assert.equal(input.consent, true); assert.equal(input.source, "summary"); assert.equal(input.agentID, "moss-editor"); assert.equal(input.instruction, instruction);
    assert.match(input.requestID, /^[0-9a-f-]{36}$/i);
    if (workID) assert.equal(input.requestID, workID);
    workID = input.requestID;
    workRequests++;
    if (workRequests === 1) return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Isolated agent outage; retry this request."}' });
    const meeting = await readMeeting();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...meeting, agentWork: [{
      id: input.requestID, source: input.source, instruction, agentID: input.agentID, model: input.model, sourceRevision: meeting.revision,
      markdown: "No unsupported claims in this isolated UI fixture.", createdAt: meeting.createdAt,
    }] }) });
  });
  await page.getByRole("button", { name: "Ask agent", exact: true }).click();
  assert.equal(workRequests, 0);
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and continue", exact: true }).click();
  await page.getByRole("dialog").getByText("Isolated agent outage; retry this request.", { exact: true }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and continue", exact: true }).click();
  await page.getByRole("region", { name: "Agent results", exact: true }).locator("summary").click();
  await page.getByText("No unsupported claims in this isolated UI fixture.", { exact: true }).waitFor();
  assert.equal(workRequests, 2);
  receipts.push("Agent UI boundary fixture verified source/instruction selection, separate result rendering, and a stable request UUID across a failed submission and retry. No real generation.");

  await page.getByText("Google Drive MCP", { exact: true }).click();
  let connected = false;
  const driveCatalog = () => ({ available: true, message: "Isolated Drive fixture; authenticate through OpenCode /mcps.", servers: [{ name: "moss-drive", status: connected ? "connected" : "needs_auth" }] });
  await page.route("**/api/drive", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(driveCatalog()) }));
  await page.route("**/api/drive/connect", async route => {
    assert.deepEqual(route.request().postDataJSON(), { server: "moss-drive", url: "https://drive.fixture.invalid/mcp", consent: true });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(driveCatalog()) });
  });
  await page.getByRole("button", { name: "Refresh Drive connections", exact: true }).click();
  await page.getByRole("textbox", { name: "Drive MCP endpoint", exact: true }).fill("https://drive.fixture.invalid/mcp");
  await page.getByRole("button", { name: "Connect Drive MCP", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Google Drive MCP server", exact: true }).selectOption("moss-drive");
  connected = true;
  await page.getByRole("button", { name: "Refresh Drive connections", exact: true }).click();
  await page.getByRole("combobox", { name: "OpenCode agent", exact: true }).selectOption("moss-drive");
  await page.getByRole("combobox", { name: "Drive export content", exact: true }).selectOption("summary");
  let exports = 0;
  await page.route("**/api/meetings/*/drive-export", async route => {
    const input = route.request().postDataJSON();
    assert.equal(input.consent, true); assert.equal(input.server, "moss-drive"); assert.equal(input.agentID, "moss-drive"); assert.equal(input.source, "summary");
    exports++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionID: "ses_isolated_export", status: "submitted", message: "Approve the selected native Drive tools in OpenCode and verify the file." }) });
  });
  await page.getByRole("button", { name: "Hand off Markdown to Drive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(exports, 0);
  await page.getByRole("button", { name: "Hand off Markdown to Drive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm and continue", exact: true }).click();
  await page.getByText("Submitted to OpenCode, not confirmed exported.", { exact: true }).waitFor();
  assert.equal(exports, 1);
  await page.screenshot({ path: join(run, "02-sharing-handoff.png"), scale: "css" });
  receipts.push("Drive UI boundary fixture verified consented endpoint submission, authentication-needed state, explicit server selection, cancellation with no export request, and truthful submitted-only handoff. No OAuth or Drive writes.");

  const ready = { ...health, hex: { ...health.hex, state: "ready" }, audioImport: { available: true, message: "Isolated ready status", formats: ["mp3"], maxBytes: 100 * 1024 * 1024, maxDurationMs: 7200000 } };
  await page.route("**/api/health", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ready) }));
  await page.getByText("Local engine ready", { exact: true }).waitFor();
  let imports = 0;
  await page.route("**/api/meetings/*/audio-file", async route => {
    assert.equal(route.request().headers()["x-audio-consent"], "1");
    assert.equal(decodeURIComponent(route.request().headers()["x-file-name"]!), "fixture.mp3");
    imports++;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Isolated audio outage"}' });
  });
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer(); data.items.add(new File(["synthetic fixture"], "fixture.mp3", { type: "audio/mpeg" })); return data;
  });
  await page.getByRole("region", { name: "Import audio file", exact: true }).dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  assert.equal(imports, 0);
  await page.getByRole("checkbox", { name: "I have permission to transcribe this audio on this device.", exact: true }).check();
  await page.getByRole("button", { name: "Transcribe audio file", exact: true }).click();
  await page.getByText(/Isolated audio outage.*retained for retry/).waitFor();
  assert.equal(imports, 1);
  await page.getByRole("button", { name: "Clear selected file", exact: true }).click();
  receipts.push("Audio drop UI boundary fixture verified that drop alone sends nothing, transcription requires consent, and failure retains the selected file. Real codec conversion is covered by synthetic FFmpeg tests, not live Hex.");

  for (const format of ["json", "text"]) {
    await page.getByRole("combobox", { name: "Export format", exact: true }).selectOption(format);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const path = join(run, `ui-export.${format === "json" ? "json" : "txt"}`);
    const expected = await readMeeting();
    let content: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const downloaded = readFileSync(join(run, "ui-export.md"), "utf8");
        const matches = format === "json" ? JSON.stringify(JSON.parse(downloaded)) === JSON.stringify(expected)
          : downloaded.startsWith(expected.title + "\n") && downloaded.includes("Launch timing is still undecided");
        if (matches) { content = downloaded; break; }
      } catch {}
      await delay(50);
    }
    assert.ok(content, `The ${format} UI download did not match canonical content.`);
    writeFileSync(path, content, { mode: 0o600 });
  }
  receipts.push("Actual UI JSON and plain-text downloads matched canonical meeting content; Markdown is checked separately byte for byte.");
  for (const pattern of ["**/api/meetings/*/agent-work", "**/api/drive", "**/api/drive/connect", "**/api/meetings/*/drive-export", "**/api/health", "**/api/meetings/*/audio-file"]) await page.unroute(pattern);
  await page.reload();
  await page.getByRole("tab", { name: "Summary", exact: true }).click();
  await page.getByRole("button", { name: "Refresh excerpts", exact: true }).waitFor();
  return receipts;
}
