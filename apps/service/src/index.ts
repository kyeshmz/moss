import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_PORT } from "@moss/contracts";
import { createMossServer } from "./server.js";

export function dataDirectory() {
  if (process.env.MOSS_DATA_DIR) return process.env.MOSS_DATA_DIR;
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(base, "Moss", "meetings");
}

export async function startMoss(options: { webDirectory?: string; port?: number } = {}) {
  const app = createMossServer({ dataDirectory: dataDirectory(), webDirectory: options.webDirectory });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(options.port ?? API_PORT, "127.0.0.1", resolve);
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOSS_PORT ?? API_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MOSS_PORT must be an integer from 1024 to 65535.");
  const app = await startMoss({ port, webDirectory: fileURLToPath(new URL("../../web/dist", import.meta.url)) });
  console.log(`Moss service listening at http://127.0.0.1:${port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
