import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMossServer } from "../src/server.js";
import { api } from "../../web/src/api.js";

test("the real web model-preparation request satisfies the service JSON contract", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-web-contract-"));
  let preparations = 0;
  const engine = {
    status: () => ({ state: "ready" as const, model: "contract-test", message: "Injected test boundary" }),
    prepare: async () => { preparations++; }, close: async () => {},
    transcribe: async () => ({ transcript: "", durationMs: 0 }),
  };
  const app = createMossServer({ dataDirectory: directory, engine });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => originalFetch(new URL(String(input), origin), init);
  try {
    const health = await api.prepare();
    assert.equal(preparations, 1);
    assert.equal(health.hex.state, "ready");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
