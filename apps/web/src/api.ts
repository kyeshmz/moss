import type { AgentWorkOptions, DriveCatalog, DriveConnectionOptions, DriveExportHandoff, DriveExportOptions, ExportFormat, Health, Meeting, MeetingPatch, OpenCodeSummaryCatalog, OpenCodeSummaryOptions, SummaryKind } from "@moss/contracts";

export const REQUEST_DEADLINES = { standard: 15_000, prepare: 15 * 60_000, audio: 3 * 60_000, summary: 150_000, audioImport: 30 * 60_000 } as const;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class RequestTimeoutError extends Error {
  constructor() { super("The local Moss request timed out. It may still finish in the service. Your unsaved edits and pending audio are retained; retry when ready."); }
}

async function request<T>(path: string, init: RequestInit, read: (response: Response) => Promise<T>, deadline: number): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-Moss-Client", "1");
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RequestTimeoutError());
        controller.abort();
      }, deadline);
    });
    const operation = (async () => {
      let response: Response;
      try {
        response = await fetch(`/api${path}`, { ...init, headers, signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]) });
      } catch {
        if (init.signal?.aborted) throw new Error("The operation was cancelled. Your original content was kept.");
        if (controller.signal.aborted) throw new RequestTimeoutError();
        throw new Error("Cannot reach the local Moss service. Check that it is running, then retry.");
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new ApiError(typeof body?.error === "string" ? body.error : `Moss request failed (${response.status}).`, response.status);
      }
      return read(response);
    })();
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function json<T>(path: string, init: RequestInit = {}, deadline: number = REQUEST_DEADLINES.standard): Promise<T> {
  return request(path, init, response => response.json() as Promise<T>, deadline);
}

const meetingPath = (id: string) => `/meetings/${encodeURIComponent(id)}`;

export const api = {
  health: () => json<Health>("/health"),
  opencodeSummaryCatalog: () => json<OpenCodeSummaryCatalog>("/summary/opencode"),
  driveCatalog: () => json<DriveCatalog>("/drive"),
  connectDrive: (options: DriveConnectionOptions) => json<DriveCatalog>("/drive/connect", { method: "POST", body: JSON.stringify(options) }, 45_000),
  prepare: () => json<Health>("/engine/prepare", { method: "POST", body: "{}" }, REQUEST_DEADLINES.prepare),
  meetings: () => json<Meeting[]>("/meetings"),
  create: () => json<Meeting>("/meetings", { method: "POST", body: "{}" }),
  patch: (id: string, patch: MeetingPatch) => json<Meeting>(meetingPath(id), { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => json<{ ok: true }>(meetingPath(id), { method: "DELETE" }),
  import: (id: string, text: string) => json<Meeting>(`${meetingPath(id)}/transcript`, { method: "POST", body: JSON.stringify({ text }) }),
  summarize: (id: string, kind: SummaryKind, options?: OpenCodeSummaryOptions) => json<Meeting>(`${meetingPath(id)}/summary`, { method: "POST", body: JSON.stringify(kind === "opencode" ? { kind, ...options } : { kind }) }, REQUEST_DEADLINES.summary),
  agentWork: (id: string, options: AgentWorkOptions) => json<Meeting>(`${meetingPath(id)}/agent-work`, { method: "POST", body: JSON.stringify(options) }, REQUEST_DEADLINES.summary),
  driveExport: (id: string, options: DriveExportOptions) => json<DriveExportHandoff>(`${meetingPath(id)}/drive-export`, { method: "POST", body: JSON.stringify(options) }, 45_000),
  audioFile: (id: string, file: File, signal?: AbortSignal) => json<Meeting>(`${meetingPath(id)}/audio-file`, {
    method: "POST", body: file, signal, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Audio-Consent": "1" },
  }, REQUEST_DEADLINES.audioImport),
  audio: (id: string, chunk: { id: string; startMs: number; wav: Blob }) => json<Meeting>(`${meetingPath(id)}/audio`, {
    method: "POST", body: chunk.wav,
    headers: { "Content-Type": "audio/wav", "X-Chunk-Id": chunk.id, "X-Start-Ms": String(chunk.startMs) },
  }, REQUEST_DEADLINES.audio),
  export: (id: string, format: ExportFormat = "markdown") => request(`${meetingPath(id)}/export${format === "markdown" ? "" : `?format=${format}`}`, {}, response => response.text(), REQUEST_DEADLINES.standard),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please retry.";
}
