import type { ContentSource, ExportFormat, Meeting, MeetingPatch, Summary } from "@moss/contracts";

export class EditConflictError extends Error {
  constructor() { super("These fields changed in another client. Your draft is kept. Review the conflict before replacing those fields."); }
}

export function newMeeting(id: string, now = new Date().toISOString()): Meeting {
  return { id, title: "Untitled meeting", createdAt: now, updatedAt: now,
    notes: "", revision: 0, segments: [], summary: null };
}

export function parsePatch(value: unknown): MeetingPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "title" && key !== "notes" && key !== "expected")) throw new Error("Unknown meeting field.");
  const patch: MeetingPatch = {};
  const expected = input.expected;
  if (expected !== undefined && (!expected || typeof expected !== "object" || Array.isArray(expected)
    || Object.keys(expected).some(key => key !== "title" && key !== "notes"))) throw new Error("Invalid edit preconditions.");
  const base = (expected ?? {}) as Record<string, unknown>;
  const preconditions: NonNullable<MeetingPatch["expected"]> = {};
  if ("title" in input) {
    if (typeof input.title !== "string" || input.title.length > 240) throw new Error("Title must be at most 240 characters.");
    if (typeof base.title !== "string" || base.title.length > 240) throw new Error("A title edit requires expected.title from the last saved version.");
    patch.title = input.title.trim() || "Untitled meeting";
    preconditions.title = base.title;
  }
  if ("notes" in input) {
    if (typeof input.notes !== "string" || input.notes.length > 200_000) throw new Error("Notes must be at most 200,000 characters.");
    if (typeof base.notes !== "string" || base.notes.length > 200_000) throw new Error("A notes edit requires expected.notes from the last saved version.");
    patch.notes = input.notes;
    preconditions.notes = base.notes;
  }
  if (Object.keys(preconditions).length) patch.expected = preconditions;
  return patch;
}

export function quickSummary(meeting: Meeting): Summary {
  const lines = [meeting.notes, ...meeting.segments.map(segment => segment.text)]
    .join("\n").split(/\n+|(?<=[.!?])\s+/).map(line => line.trim()).filter(Boolean);
  const unique = [...new Set(lines)];
  const actions = unique.filter(line => /\b(will|todo|to-do|follow up|action|need to|next step)\b/i.test(line));
  const highlights = unique.filter(line => !actions.includes(line)).slice(0, 8);
  const section = (title: string, values: string[]) => values.length ? `## ${title}\n${values.map(line => `- ${line}`).join("\n")}\n` : "";
  return { kind: "extractive", sourceRevision: meeting.revision,
    markdown: section("Highlights", highlights) + "\n" + section("Possible next steps", actions.slice(0, 8)) };
}

export function exportMarkdown(meeting: Meeting): string {
  const transcript = meeting.segments.map(segment => {
    const seconds = Math.floor(segment.startMs / 1000);
    return `**${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}** ${segment.text}`;
  }).join("\n\n");
  const attribution = meeting.summary?.opencode;
  const provenance = attribution ? `Generated with OpenCode agent ${attribution.agentID}, model ${attribution.model.providerID}/${attribution.model.id}${attribution.model.variant ? ` (${attribution.model.variant})` : ""}.\n\n` : "";
  const work = meeting.agentWork?.length ? `\n## Agent results\n\n${meeting.agentWork.map(item => `### ${item.instruction}\n\nAgent ${item.agentID}, model ${item.model.providerID}/${item.model.id}${item.sourceRevision !== meeting.revision ? " (source changed)" : ""}.\n\n${item.markdown}\n`).join("\n")}` : "";
  return `# ${meeting.title}\n\n${new Date(meeting.createdAt).toLocaleDateString("en-US")}\n\n## My notes\n\n${meeting.notes}\n\n${meeting.summary ? `## ${meeting.summary.kind === "ai" ? "AI summary" : "Extracted highlights"}${meeting.summary.sourceRevision !== meeting.revision ? " (out of date)" : ""}\n\n${provenance}${meeting.summary.markdown}\n\n` : ""}## Transcript\n\n${transcript}\n${work}`;
}

function validAttribution(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const source = value as NonNullable<Summary["opencode"]>;
  return typeof source.agentID === "string" && source.agentID.length > 0 && Boolean(source.model)
    && typeof source.model.providerID === "string" && source.model.providerID.length > 0
    && typeof source.model.id === "string" && source.model.id.length > 0
    && (source.model.variant === undefined || typeof source.model.variant === "string");
}

export function sourceContent(meeting: Meeting, source: ContentSource): string {
  if (source === "meeting") return exportMarkdown(meeting);
  if (source === "notes") return meeting.notes;
  if (source === "transcript") return meeting.segments.map(segment => segment.text).join("\n\n");
  return meeting.summary?.markdown ?? "";
}

export function exportContent(meeting: Meeting, format: ExportFormat): string {
  if (format === "json") return JSON.stringify(meeting, null, 2) + "\n";
  if (format === "text") return `${meeting.title}\n\nMy notes\n${meeting.notes}\n\nSummary\n${meeting.summary?.markdown ?? ""}\n\nTranscript\n${meeting.segments.map(segment => segment.text).join("\n\n")}\n${meeting.agentWork?.length ? `\nAgent results\n${meeting.agentWork.map(work => `${work.instruction}\n${work.markdown}`).join("\n\n")}\n` : ""}`;
  return exportMarkdown(meeting);
}

export function isMeeting(value: unknown): value is Meeting {
  if (!value || typeof value !== "object") return false;
  const m = value as Meeting;
  return typeof m.id === "string" && typeof m.title === "string" && typeof m.notes === "string"
    && typeof m.createdAt === "string" && Number.isFinite(Date.parse(m.createdAt))
    && typeof m.updatedAt === "string" && Number.isFinite(Date.parse(m.updatedAt))
    && Number.isInteger(m.revision) && m.revision >= 0 && Array.isArray(m.segments)
    && m.segments.every(s => typeof s.id === "string" && typeof s.text === "string"
      && Number.isFinite(s.startMs) && s.startMs >= 0 && Number.isFinite(s.durationMs) && s.durationMs >= 0)
    && (m.audioImportHashes === undefined || (Array.isArray(m.audioImportHashes) && m.audioImportHashes.length <= 200 && m.audioImportHashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))))
    && (m.agentWork === undefined || (Array.isArray(m.agentWork) && m.agentWork.length <= 50 && m.agentWork.every(work =>
      work && typeof work === "object" && typeof work.id === "string" && ["meeting", "notes", "transcript", "summary"].includes(work.source)
      && typeof work.instruction === "string" && typeof work.markdown === "string" && Number.isInteger(work.sourceRevision)
      && typeof work.createdAt === "string" && Number.isFinite(Date.parse(work.createdAt)) && validAttribution(work))))
    && (m.summary === null || (typeof m.summary?.markdown === "string"
      && ["ai", "extractive"].includes(m.summary.kind) && Number.isInteger(m.summary.sourceRevision) && validAttribution(m.summary.opencode)));
}
