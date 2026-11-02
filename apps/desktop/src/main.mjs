import { app, BrowserWindow, dialog, nativeTheme, session, systemPreferences } from "electron";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { join } from "node:path";
import { startMoss } from "./service.mjs";

const developmentEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (!app.isPackaged && existsSync(developmentEnv)) loadEnvFile(developmentEnv);
const port = Number(process.env.MOSS_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MOSS_PORT must be an integer from 1024 to 65535.");
const origin = `http://127.0.0.1:${port}`;
app.setName("Moss");
app.setPath("userData", process.env.MOSS_PROFILE_DIR ?? join(app.getPath("appData"), "Moss", "Electron"));
let service;
let shutdown = "open";

function trusted(url) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

async function connectService() {
  try {
    service = await startMoss({ port, webDirectory: fileURLToPath(new URL("./web", import.meta.url)) });
  } catch (error) {
    if (error?.code === "EADDRINUSE") throw new Error(`Port ${port} is already in use. Stop the separate Moss development service before starting Electron. Electron must own the service it displays.`);
    throw error;
  }
}

function createWindow() {
  const frame = process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 14 } }
    : process.platform === "win32" ? { frame: false, titleBarStyle: "hidden", titleBarOverlay: {
      color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#fafafa" : "#161616", height: 36 } } : {};
  const window = new BrowserWindow({ width: 1280, height: 850, minWidth: 900, minHeight: 650,
    title: "Moss", backgroundColor: nativeTheme.shouldUseDarkColors ? "#161616" : "#ffffff", show: false, ...frame,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!trusted(url)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-prevent-unload", event => {
    const choice = dialog.showMessageBoxSync(window, { type: "warning", title: "Keep your unsaved work?",
      message: "This window has unsaved notes or pending audio.", detail: "Keep working to save notes or download pending WAV files. Stored drafts may be recoverable next time. Pending audio exists only in this window and will be lost if you close it.",
      buttons: ["Keep working", "Close anyway"], defaultId: 0, cancelId: 0 });
    if (choice === 1) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${origin}/?desktop=${process.platform}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    await connectService();
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      permission === "media" && trusted(requestingOrigin) && trusted(contents?.getURL() ?? "") && details.mediaType !== "video");
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const allowed = permission === "media" && trusted(contents.getURL()) && trusted(details.requestingUrl)
        && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === "audio");
      if (!allowed) return callback(false);
      if (process.platform === "darwin") {
        void systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
      } else callback(true);
    });
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox("Moss could not start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", event => {
    if (process.env.MOSS_DIAGNOSTICS === "1") console.info(`Moss will-quit: shutdown=${shutdown}`);
    if (!service || shutdown === "closed") return;
    event.preventDefault();
    if (shutdown === "closing") return;
    shutdown = "closing";
    void service.close().catch(error => console.error("Moss shutdown failed:", error)).finally(() => {
      shutdown = "closed";
      if (process.env.MOSS_DIAGNOSTICS === "1") console.info("Moss service closed; quitting application.");
      setImmediate(() => app.quit());
    });
  });
}
