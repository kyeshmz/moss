import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { Health, Meeting, OpenCodeSummaryCatalog } from "@moss/contracts";
import { verifySharing } from "./verify-sharing.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, ".artifacts", "verification");
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(artifacts, "run-"));
const data = join(run, "meetings");
const profile = join(run, "profile");
const snapshot = join(run, "app");
let port = Number(process.env.MOSS_VERIFY_PORT ?? 0);
let origin = "";
const receipts: string[] = [];
let application: ElectronApplication | undefined;

async function portFree() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is in use. Refusing to drive or stop an existing Moss instance.`)));
    probe.listen(port, "127.0.0.1", resolve);
  });
  port = (probe.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, { headers: { "X-Moss-Client": "1" }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json() as Promise<T>;
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!matches(value)) {
    if (Date.now() > deadline) throw new Error(`Expected state was not observed. Last result: ${JSON.stringify(value)}`);
    await delay(100);
    value = await read();
  }
  return value;
}

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.MOSS_DATA_DIR = data;
  env.MOSS_PROFILE_DIR = profile;
  env.MOSS_PORT = String(port);
  env.MOSS_DIAGNOSTICS = "1";
  application = await _electron.launch({ args: [snapshot], env, cwd: root, timeout: 30_000 });
  application.on("console", message => appendFileSync(join(run, "runtime.log"), `${message.text()}\n`, { mode: 0o600 }));
  const ownedProcess = application.process();
  ownedProcess.stderr?.on("data", chunk => appendFileSync(join(run, "runtime.log"), chunk, { mode: 0o600 }));
  ownedProcess.stdout?.on("data", chunk => appendFileSync(join(run, "runtime.log"), chunk, { mode: 0o600 }));
  const watchdog = setTimeout(() => {
    receipts.push("FAILED: the isolated Electron run exceeded its 90-second runtime budget.");
    ownedProcess.kill("SIGKILL");
  }, 90_000);
  watchdog.unref();
  ownedProcess.once("exit", () => clearTimeout(watchdog));
  writeFileSync(join(run, "owned-process.json"), JSON.stringify({ pid: application.process().pid, profile, data }), { mode: 0o600 });
  await application.evaluate(({ session }, directory) => {
    session.defaultSession.on("will-download", (_event, item) => item.setSavePath(`${directory}/ui-export.md`));
  }, run);
  const page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.emulateMedia({ colorScheme: "light" });
  page.on("pageerror", error => receipts.push(`PAGE ERROR: ${error.message}`));
  await page.getByRole("button", { name: /New meeting/ }).waitFor();
  return page;
}

async function close() {
  if (!application) return;
  const owned = application;
  application = undefined;
  await owned.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([owned.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned Electron instance did not close within 15 seconds.")), 15_000);
    })]);
  } catch (error) {
    const process = owned.process();
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await new Promise<void>(resolve => process.once("exit", () => resolve()));
    }
    throw error;
  } finally { clearTimeout(timer); }
  await portFree();
}

try {
  await portFree();
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "compile", "-w", "@moss/desktop"], {
    cwd: root, stdio: "inherit", env: { ...process.env, MOSS_BUILD_DIR: join(snapshot, "dist") },
  });
  writeFileSync(join(snapshot, "package.json"), JSON.stringify({ name: "moss-verification", version: "0.0.1", type: "module", main: "dist/main.mjs" }));
  let page = await launch();
  const health = await api<Health>("/health");
  assert.equal(health.name, "Moss");
  assert.equal(health.apiVersion, 1);
  assert.deepEqual(await api<Meeting[]>("/meetings"), []);
  receipts.push(`Doctor passed. Hex is ${health.hex.state}. Real microphone and inference are not exercised.`);
  const preferences = await application!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (!("getLastWebPreferences" in contents) || typeof contents.getLastWebPreferences !== "function") {
      throw new Error("This Electron version does not support runtime preference inspection.");
    }
    const preferences = contents.getLastWebPreferences() as { contextIsolation?: boolean; sandbox?: boolean; nodeIntegration?: boolean };
    return { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration };
  });
  assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  receipts.push("Electron renderer isolation and sandbox preferences verified.");
  await page.screenshot({ path: join(run, "01-empty.png"), scale: "css" });
  const shellMetrics = await page.evaluate(() => ({
    sidebar: document.querySelector(".sidebar")!.getBoundingClientRect().width,
    header: document.querySelector(".topbar")!.getBoundingClientRect().height,
    background: getComputedStyle(document.querySelector(".workspace")!).backgroundColor,
  }));
  assert.deepEqual(shellMetrics, { sidebar: 276, header: 36, background: "rgb(255, 255, 255)" });
  assert.equal(await page.locator(".app-shell").getAttribute("data-desktop"), process.platform);
  receipts.push("OpenCode-style light appearance renders with a 276px sidebar, 36px header, and white content surface.");
  await page.getByRole("button", { name: "Create your first meeting" }).click();
  await page.getByRole("textbox", { name: "Meeting title", exact: true }).fill("Prototype draft");
  await page.getByRole("textbox", { name: "My notes", exact: true }).fill("Keep the first release small. We will test the prototype on Friday.");
  await page.getByRole("textbox", { name: "My notes", exact: true }).blur();
  let meetings = await until(() => api<Meeting[]>("/meetings"), list => list[0]?.title === "Prototype draft" && list[0].notes.includes("Friday"));
  const id = meetings[0].id;
  assert.equal(JSON.parse(readFileSync(join(data, `${id}.json`), "utf8")).notes, meetings[0].notes);
  receipts.push("Created and edited a meeting through Electron. Observed the exact saved text in API and private meeting file.");
  const remoteNotes = `${meetings[0].notes} Another client added this detail.`;
  const remoteEdit = await fetch(`${origin}/api/meetings/${id}`, { method: "PATCH",
    headers: { "X-Moss-Client": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ notes: remoteNotes, expected: { notes: meetings[0].notes } }) });
  assert.equal(remoteEdit.status, 200);
  await page.getByRole("textbox", { name: "Meeting title", exact: true }).fill("Prototype review");
  await page.getByRole("textbox", { name: "Meeting title", exact: true }).blur();
  meetings = await until(() => api<Meeting[]>("/meetings"), list => list[0]?.title === "Prototype review");
  assert.equal(meetings[0].notes, remoteNotes);
  receipts.push("A stale Electron client changed only the title. Notes edited through the public API by a second client were preserved.");
  await page.getByRole("button", { name: "Import text", exact: true }).click();
  await page.getByRole("textbox", { name: "Transcript text", exact: true }).fill("The team agreed to keep the scope small. We will review the prototype on Friday. Launch timing is still undecided.");
  await page.getByRole("button", { name: "Add transcript", exact: true }).click();
  await page.getByText("Launch timing is still undecided.", { exact: false }).waitFor();
  meetings = await until(() => api<Meeting[]>("/meetings"), list => list[0]?.segments.length === 1);
  assert.equal(meetings[0].segments[0].durationMs, 0);
  await page.getByRole("tab", { name: "Summary" }).click();
  await page.getByRole("button", { name: "Extract highlights", exact: true }).click();
  await page.getByRole("button", { name: "Refresh excerpts", exact: true }).waitFor();
  meetings = await api<Meeting[]>("/meetings");
  assert.equal(meetings[0].summary?.kind, "extractive");
  assert.equal(meetings[0].summary?.sourceRevision, meetings[0].revision);
  assert.match(meetings[0].summary!.markdown, /Launch timing is still undecided/);
  receipts.push("Imported a transcript and extracted fact-preserving highlights through UI controls.");
  const catalog = await api<OpenCodeSummaryCatalog>("/summary/opencode");
  receipts.push(`OpenCode catalog read through bundled service. Available=${catalog.available}; agents=${catalog.agents.length}; chat models=${catalog.models.length}. No generation was sent.`);
  const uiCatalog: OpenCodeSummaryCatalog = { available: true, message: "Isolated UI contract fixture. No provider requests.",
    agents: [{ id: "moss-summary", name: "Meeting summary" }, { id: "moss-editor", name: "Meeting editor" }, { id: "moss-drive", name: "Drive export" }], models: [{ id: "fixture-chat", providerID: "fixture", name: "Fixture Chat", variants: ["high"] }] };
  await page.route("**/api/summary/opencode", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(uiCatalog) }));
  await page.getByRole("button", { name: "Refresh OpenCode models", exact: true }).click();
  await until(() => page.getByRole("combobox", { name: "OpenCode model", exact: true }).inputValue(), value => value === JSON.stringify(["fixture", "fixture-chat"]));
  assert.equal(await page.getByRole("combobox", { name: "OpenCode agent", exact: true }).inputValue(), "moss-summary");
  await page.getByRole("combobox", { name: "OpenCode variant", exact: true }).selectOption(JSON.stringify("high"));
  let summaryRequests = 0;
  await page.route(`**/api/meetings/${id}/summary`, async route => {
    summaryRequests++;
    assert.deepEqual(route.request().postDataJSON(), { kind: "opencode", agentID: "moss-summary", model: { id: "fixture-chat", providerID: "fixture", variant: "high" }, consent: true });
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Isolated provider outage. Previous summary kept."}' });
  });
  await page.getByRole("button", { name: "Summarize with OpenCode", exact: true }).click();
  await page.getByRole("dialog").getByText(/stored in OpenCode session history/).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(summaryRequests, 0);
  await page.getByRole("button", { name: "Summarize with OpenCode", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send and generate with OpenCode", exact: true }).click();
  await page.getByRole("dialog").getByText("Isolated provider outage. Previous summary kept.", { exact: true }).waitFor();
  assert.equal(summaryRequests, 1);
  assert.equal((await api<Meeting[]>("/meetings"))[0].summary?.kind, "extractive");
  await page.screenshot({ path: join(run, "02-opencode-confirmation.png"), scale: "css" });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.unroute(`**/api/meetings/${id}/summary`);
  receipts.push(...await verifySharing(page, run, health, async () => (await api<Meeting[]>("/meetings"))[0]));
  await page.unroute("**/api/summary/opencode");
  await page.getByRole("button", { name: "Refresh OpenCode models", exact: true }).click();
  if (catalog.available) {
    await until(() => page.getByRole("combobox", { name: "OpenCode model", exact: true }).locator("option").count(), count => count === catalog.models.length);
    const selected = JSON.parse(await page.getByRole("combobox", { name: "OpenCode model", exact: true }).inputValue()) as [string, string];
    assert.ok(catalog.models.some(model => model.providerID === selected[0] && model.id === selected[1]));
    receipts.push("Electron selectors rendered the live server catalog after the isolated UI fixture was removed.");
  }
  receipts.push("OpenCode UI boundary fixture verified model/variant selection, consent cancellation with no request, exact consented request, and visible provider failure preserving the prior summary. No live inference.");
  await page.screenshot({ path: join(run, "02-meeting.png"), scale: "css" });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.locator(".workspace").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(22, 22, 22)");
  await page.screenshot({ path: join(run, "02-meeting-dark.png"), scale: "css" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 900, height: 650 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(run, "02-meeting-narrow.png"), scale: "css" });
  await page.setViewportSize({ width: 1280, height: 850 });
  receipts.push("Dark appearance uses the oc-2 #161616 surface. The 900px layout has no horizontal overflow; both appearances were captured.");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByText("Markdown downloaded.", { exact: true }).waitFor();
  receipts.push("Export action completed through the Electron UI.");
  const markdownResponse = await fetch(`${origin}/api/meetings/${id}/export`, { headers: { "X-Moss-Client": "1" } });
  const markdown = await markdownResponse.text();
  assert.match(markdown, /# Prototype review/);
  assert.match(markdown, /Extracted highlights/);
  writeFileSync(join(run, "meeting-export.md"), markdown, { mode: 0o600 });
  await until(async () => {
    try { return readFileSync(join(run, "ui-export.md"), "utf8"); } catch { return ""; }
  }, text => text === markdown);
  receipts.push("The actual UI-downloaded Markdown matches the API export byte for byte.");
  await page.getByRole("searchbox", { name: "Search meetings" }).fill("no-such-meeting");
  await page.getByText("No matching meetings. Try another word.", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Search meetings" }).fill("Prototype");
  await page.getByRole("navigation", { name: "Meetings", exact: true }).getByRole("button", { name: /Prototype review/ }).waitFor();
  receipts.push("Meeting search filters and restores the matching saved meeting.");
  await page.route("**/api/meetings/*", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Injected temporary save outage"}' })
    : route.continue());
  await page.getByRole("textbox", { name: "My notes", exact: true }).fill(`${remoteNotes} Retained after a cancelled quit.`);
  await page.getByRole("textbox", { name: "My notes", exact: true }).blur();
  await page.getByRole("button", { name: "Retry save", exact: true }).waitFor();
  await application!.evaluate(({ app, dialog }) => {
    dialog.showMessageBoxSync = () => { process.env.MOSS_TEST_QUIT_CANCELLED = "1"; return 0; };
    app.quit();
  });
  await until(() => application!.evaluate(() => process.env.MOSS_TEST_QUIT_CANCELLED), value => value === "1");
  assert.equal((await api<Health>("/health")).name, "Moss");
  assert.match(await page.getByRole("textbox", { name: "My notes", exact: true }).inputValue(), /Retained after a cancelled quit/);
  await page.unroute("**/api/meetings/*");
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await until(() => api<Meeting[]>("/meetings"), list => list[0]?.notes.includes("Retained after a cancelled quit"));
  receipts.push("Cancelled quit at the native confirmation boundary. The service stayed healthy and the retained draft saved on retry.");
  const pendingRequest = httpRequest(`${origin}/api/meetings`, { method: "POST", agent: false,
    headers: { "X-Moss-Client": "1", "Content-Type": "application/json", "Content-Length": "2" } });
  const pendingResponse = new Promise<void>((resolve, reject) => {
    pendingRequest.once("error", reject);
    pendingRequest.once("response", response => { response.resume(); response.once("end", resolve); response.once("error", reject); });
  });
  void pendingResponse.catch(() => undefined);
  await new Promise<void>((resolve, reject) => pendingRequest.write("[", error => error ? reject(error) : resolve()));
  try {
    await application!.evaluate(({ app }) => {
      app.on("will-quit", event => {
        process.env.MOSS_TEST_DRAIN_ATTEMPTS = String(Number(process.env.MOSS_TEST_DRAIN_ATTEMPTS ?? 0) + 1);
        process.env.MOSS_TEST_DRAIN_PREVENTED = String(event.defaultPrevented);
      });
      app.quit();
    });
    await until(() => application!.evaluate(() => process.env.MOSS_TEST_DRAIN_ATTEMPTS), value => value === "1");
    assert.equal(await application!.evaluate(() => process.env.MOSS_TEST_DRAIN_PREVENTED), "true");
    await application!.evaluate(({ app }) => app.quit());
    await until(() => application!.evaluate(() => process.env.MOSS_TEST_DRAIN_ATTEMPTS), value => value === "2");
    assert.equal(await application!.evaluate(() => process.env.MOSS_TEST_DRAIN_PREVENTED), "true");
    const closing = close();
    pendingRequest.end("]");
    await Promise.all([closing, pendingResponse]);
    receipts.push("Repeated Quit remained prevented while a real incomplete local HTTP request kept service cleanup pending. Completing it allowed clean shutdown.");
  } finally {
    pendingRequest.destroy();
    await pendingResponse.catch(() => undefined);
  }
  page = await launch();
  await until(() => page.getByRole("textbox", { name: "Meeting title", exact: true }).inputValue(), value => value === "Prototype review");
  assert.match(await page.getByRole("textbox", { name: "My notes", exact: true }).inputValue(), /Friday/);
  assert.equal((await api<Meeting[]>("/meetings"))[0].segments.length, 1);
  await page.screenshot({ path: join(run, "03-restored.png"), scale: "css" });
  receipts.push("Closed and relaunched the real Electron application. Notes and transcript persisted.");
  await page.getByRole("button", { name: "Delete meeting", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete meeting", exact: true }).click();
  await page.getByRole("heading", { name: "A little more present.", exact: true }).waitFor();
  assert.deepEqual(await api<Meeting[]>("/meetings"), []);
  assert.equal(readdirSync(data).filter(file => file.endsWith(".json")).length, 0);
  receipts.push("Deleted only the disposable test meeting through the UI and observed its file removed.");
  assert.equal(receipts.filter(line => line.startsWith("PAGE ERROR:")).length, 0);
  await close();
  receipts.push(`Owned Electron process and service stopped. Port ${port} is free. Screenshots and receipts remain intact.`);
  writeFileSync(join(run, "receipts.txt"), `${receipts.join("\n")}\n`, { mode: 0o600 });
  console.log(`Verification passed. Evidence: ${run}`);
} catch (error) {
  receipts.push(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  if (application) {
    const page = application.windows()[0];
    if (page) {
      await page.screenshot({ path: join(run, "failure.png") }).catch(() => undefined);
      writeFileSync(join(run, "failure-dom.txt"), await page.locator("body").innerText().catch(() => "No readable page"));
    }
  }
  writeFileSync(join(run, "receipts.txt"), `${receipts.join("\n")}\n`, { mode: 0o600 });
  console.error(`Verification failed. Evidence: ${run}`);
  throw error;
} finally {
  await close();
}
