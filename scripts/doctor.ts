import { API_PORT, CLIENT_HEADER, type Health } from "@moss/contracts";

try {
  const port = Number(process.env.MOSS_PORT ?? API_PORT);
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { [CLIENT_HEADER]: "1" }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}.`);
  const health = await response.json() as Health;
  if (health.name !== "Moss" || health.apiVersion !== 1) throw new Error(`Port ${port} is not a compatible Moss service.`);
  console.log(`Moss API ${health.apiVersion} is healthy at http://127.0.0.1:${port}`);
  console.log(`Hex ${health.hex.state}: ${health.hex.message}`);
  console.log(`AI summaries ${health.ai.configured ? health.ai.remote ? "configured for a remote endpoint" : "configured for a local endpoint" : "not configured"}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
