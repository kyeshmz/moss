import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Health } from "@moss/contracts";
import { EditConflictError, parsePatch, exportContent, quickSummary } from "@moss/core";
import { MeetingStore } from "./store.js";
import { HexEngine } from "./hex.js";
import { aiSummary, summaryConfiguration } from "./summary.js";
import { validateWav } from "./audio.js";
import { OpenCodeSummaries, parseOpenCodeOptions } from "./opencode-summary.js";
import { audioImportStatus, importAudioFile } from "./audio-import.js";
import { OpenCodeWork, parseAgentWorkOptions, parseDriveConnectionOptions, parseDriveExportOptions } from "./opencode-work.js";

type Engine = Pick<HexEngine, "status" | "prepare" | "transcribe" | "close">;
export interface ServerOptions { dataDirectory: string; webDirectory?: string; engine?: Engine; opencode?: OpenCodeSummaries; audioImporter?: typeof importAudioFile; work?: Pick<OpenCodeWork, "catalog" | "connectDrive" | "work" | "exportDrive" | "close"> }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > limit) throw new HttpError(413, "Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected application/json.");
  const value: unknown = JSON.parse((await body(request, 1_000_000)).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createMossServer(options: ServerOptions) {
  const store = new MeetingStore(options.dataDirectory);
  const engine = options.engine ?? new HexEngine();
  const opencode = options.opencode ?? new OpenCodeSummaries();
  const work = options.work ?? new OpenCodeWork();
  const lifetime = new AbortController();
  const imports = new Set<Promise<unknown>>();
  let importing = false;
  const health = (): Health => {
    const { configured, remote } = summaryConfiguration();
    return { name: "Moss", apiVersion: 1, hex: engine.status(), ai: { configured, remote }, audioImport: audioImportStatus() };
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const port = (server.address() as { port: number }).port;
      const host = request.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host ?? "")) throw new HttpError(403, "Untrusted host.");
      const origin = request.headers.origin;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:5173", "http://localhost:5173"];
      if (origin && !origins.includes(origin)) throw new HttpError(403, "Untrusted origin.");
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Content-Type, X-Moss-Client, X-Chunk-Id, X-Start-Ms, X-File-Name, X-Audio-Consent",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith("/api/")) {
        if (request.method !== "GET" || !options.webDirectory) throw new HttpError(404, "Not found.");
        const root = resolve(options.webDirectory);
        const candidate = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (!candidate.startsWith(`${root}/`) && candidate !== root) throw new HttpError(403, "Invalid path.");
        const path = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html");
        const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
        response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'",
          "Cache-Control": "no-cache" });
        response.end(readFileSync(path));
        return;
      }
      if (request.headers["x-moss-client"] !== "1") throw new HttpError(403, "Missing Moss client header.");
      const route = url.pathname.slice(4);
      if (route === "/health" && request.method === "GET") return send(response, health());
      if (route === "/summary/opencode" && request.method === "GET") return send(response, await opencode.catalog());
      if (route === "/drive" && request.method === "GET") return send(response, await work.catalog());
      if (route === "/drive/connect" && request.method === "POST") return send(response, await work.connectDrive(parseDriveConnectionOptions(await jsonBody(request))));
      if (route === "/engine/prepare" && request.method === "POST") {
        await jsonBody(request);
        await engine.prepare();
        return send(response, health());
      }
      if (route === "/meetings") {
        if (request.method === "GET") return send(response, store.list());
        if (request.method === "POST") { await jsonBody(request); return send(response, store.create(), 201); }
      }
      const match = route.match(/^\/meetings\/([0-9a-f-]{36})(?:\/(audio|audio-file|transcript|summary|agent-work|drive-export|export))?$/i);
      if (!match) throw new HttpError(404, "Not found.");
      const [, id, action] = match;
      const meeting = store.get(id);
      if (!action && request.method === "PATCH") return send(response, store.patch(id, parsePatch(await jsonBody(request))));
      if (!action && request.method === "DELETE") { store.delete(id); return send(response, { ok: true }); }
      if (action === "audio-file" && request.method === "POST") {
        if (request.headers["x-audio-consent"] !== "1") throw new HttpError(400, "Confirm permission to transcribe this audio before importing.");
        if (request.headers["content-type"] !== "application/octet-stream") throw new HttpError(415, "Expected application/octet-stream audio file bytes.");
        const encodedName = request.headers["x-file-name"];
        if (typeof encodedName !== "string" || !decodeURIComponent(encodedName).trim() || decodeURIComponent(encodedName).length > 240) throw new HttpError(400, "Provide a valid audio filename.");
        if (importing) throw new HttpError(409, "Another audio file is being imported. Wait for it to finish, then retry.");
        importing = true;
        const cancelled = new AbortController();
        const onClose = () => { if (!response.writableEnded) cancelled.abort(); };
        response.once("close", onClose);
        const signal = AbortSignal.any([cancelled.signal, lifetime.signal, AbortSignal.timeout(30 * 60_000)]);
        const task = (async () => {
          const bytes = await body(request, 100 * 1024 * 1024);
          signal.throwIfAborted();
          const hash = createHash("sha256").update(bytes).digest("hex");
          const current = store.get(id);
          if (current.audioImportHashes?.includes(hash)) return current;
          if (engine.status().state !== "ready") throw new HttpError(400, "Prepare the local Hex speech model before importing audio files.");
          if ((current.audioImportHashes?.length ?? 0) >= 200) throw new HttpError(400, "This meeting already has 200 imported audio files. Start another meeting.");
          const segments = await (options.audioImporter ?? importAudioFile)(bytes, { signal, transcribe: (wav, signal) => engine.transcribe(wav, signal) });
          signal.throwIfAborted();
          return store.appendImportedAudio(id, segments, hash);
        })();
        imports.add(task);
        try { return send(response, await task); }
        finally { imports.delete(task); importing = false; response.off("close", onClose); }
      }
      if (action === "audio" && request.method === "POST") {
        if (request.headers["content-type"] !== "audio/wav") throw new HttpError(415, "Expected audio/wav.");
        const chunkId = request.headers["x-chunk-id"];
        const startHeader = request.headers["x-start-ms"];
        const startMs = Number(startHeader);
        if (typeof chunkId !== "string" || !/^[0-9a-f-]{36}$/i.test(chunkId)
          || typeof startHeader !== "string" || !/^\d+$/.test(startHeader)
          || !Number.isSafeInteger(startMs) || startMs > 604_800_000) throw new HttpError(400, "Invalid audio chunk metadata.");
        if (meeting.segments.some(segment => segment.id === chunkId)) return send(response, meeting);
        const wav = await body(request, 16 * 1024 * 1024);
        validateWav(wav);
        const result = await engine.transcribe(wav);
        const segment = { id: chunkId, startMs, durationMs: result.durationMs, text: result.transcript.trim() };
        return send(response, store.append(id, segment));
      }
      if (action === "transcript" && request.method === "POST") {
        const { text } = await jsonBody(request);
        if (typeof text !== "string" || !text.trim() || text.length > 200_000) throw new HttpError(400, "Transcript must contain 1–200,000 characters.");
        const end = meeting.segments.reduce((max, segment) => Math.max(max, segment.startMs + segment.durationMs), 0);
        return send(response, store.append(id, { id: randomUUID(), startMs: end, durationMs: 0, text: text.trim() }));
      }
      if (action === "summary" && request.method === "POST") {
        const input = await jsonBody(request);
        const { kind } = input;
        if (kind !== "extractive" && kind !== "ai" && kind !== "opencode") throw new HttpError(400, "Choose extractive, ai, or opencode summary.");
        if (!meeting.notes.trim() && !meeting.segments.some(segment => segment.text.trim())) throw new HttpError(400, "Add notes or a transcript first.");
        const cancelled = new AbortController();
        const onClose = () => { if (!response.writableEnded) cancelled.abort(); };
        response.once("close", onClose);
        try {
          const summary = kind === "opencode" ? await opencode.summarize(meeting, parseOpenCodeOptions(input), cancelled.signal)
            : kind === "ai" ? await aiSummary(meeting) : quickSummary(meeting);
          cancelled.signal.throwIfAborted();
          return send(response, store.summarize(id, summary));
        } finally { response.off("close", onClose); }
      }
      if (action === "agent-work" && request.method === "POST") {
        const input = parseAgentWorkOptions(await jsonBody(request));
        const previous = meeting.agentWork?.find(item => item.id === input.requestID);
        if (previous) {
          if (previous.source !== input.source || previous.instruction !== input.instruction || previous.agentID !== input.agentID
            || previous.model.id !== input.model.id || previous.model.providerID !== input.model.providerID || previous.model.variant !== input.model.variant) {
            throw new HttpError(409, "This request ID belongs to different agent work. Start a new action.");
          }
          return send(response, store.get(id));
        }
        if ((meeting.agentWork?.length ?? 0) >= 50) throw new HttpError(400, "This meeting already has 50 agent results. Start another meeting.");
        const cancelled = new AbortController();
        const onClose = () => { if (!response.writableEnded) cancelled.abort(); };
        response.once("close", onClose);
        try {
          const result = await work.work(meeting, input, cancelled.signal);
          cancelled.signal.throwIfAborted();
          return send(response, store.addAgentWork(id, result));
        } finally { response.off("close", onClose); }
      }
      if (action === "drive-export" && request.method === "POST") {
        const input = parseDriveExportOptions(await jsonBody(request));
        return send(response, await work.exportDrive(meeting, input));
      }
      if (action === "export" && request.method === "GET") {
        const format = url.searchParams.get("format") ?? "markdown";
        if (format !== "markdown" && format !== "text" && format !== "json") throw new HttpError(400, "Choose Markdown, text, or JSON export.");
        const mime = { markdown: "text/markdown; charset=utf-8", text: "text/plain; charset=utf-8", json: "application/json; charset=utf-8" };
        response.writeHead(200, { "Content-Type": mime[format], "Cache-Control": "no-store" });
        response.end(exportContent(meeting, format));
        return;
      }
      throw new HttpError(405, "Method not allowed.");
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      const status = error instanceof HttpError ? error.status : error instanceof EditConflictError ? 409 : missing ? 404 : 400;
      if (!response.headersSent) send(response, { error: missing ? "Meeting not found." : error instanceof Error ? error.message : "Request failed." }, status);
      else response.end();
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  return { server, close: async () => {
    lifetime.abort();
    await opencode.close();
    await work.close();
    if (process.env.MOSS_DIAGNOSTICS === "1") console.info("Moss shutdown: closing Hex engine.");
    await engine.close();
    await Promise.allSettled(imports);
    if (process.env.MOSS_DIAGNOSTICS === "1") console.info("Moss shutdown: closing HTTP listener.");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.env.MOSS_DIAGNOSTICS === "1") console.info("Moss shutdown: HTTP listener closed.");
  } };
}
