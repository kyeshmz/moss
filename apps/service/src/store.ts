import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentWork, Meeting, MeetingPatch, Segment, Summary } from "@moss/contracts";
import { EditConflictError, isMeeting, newMeeting } from "@moss/core";

export class MeetingStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid meeting ID.");
    return join(this.directory, `${id}.json`);
  }

  get(id: string): Meeting {
    const meeting: unknown = JSON.parse(readFileSync(this.path(id), "utf8"));
    if (!isMeeting(meeting) || meeting.id !== id) throw new Error("Meeting data is invalid; the file has been left untouched.");
    return meeting;
  }

  list(): Meeting[] {
    return readdirSync(this.directory).filter(file => /^[0-9a-f-]{36}\.json$/i.test(file))
      .map(file => this.get(file.slice(0, -5))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private write(meeting: Meeting) {
    const path = this.path(meeting.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(meeting, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
    return meeting;
  }

  create() { return this.write(newMeeting(randomUUID())); }

  patch(id: string, patch: MeetingPatch) {
    const meeting = this.get(id);
    const { expected, ...fields } = patch;
    if ((expected?.title !== undefined && expected.title !== meeting.title)
      || (expected?.notes !== undefined && expected.notes !== meeting.notes)) throw new EditConflictError();
    const changed = (patch.notes !== undefined && patch.notes !== meeting.notes)
      || (patch.title !== undefined && patch.title !== meeting.title);
    return this.write({ ...meeting, ...fields, revision: meeting.revision + Number(changed), updatedAt: new Date().toISOString() });
  }

  append(id: string, segment: Segment) {
    const meeting = this.get(id);
    if (meeting.segments.some(item => item.id === segment.id)) return meeting;
    return this.write({ ...meeting, segments: [...meeting.segments, segment].sort((a, b) => a.startMs - b.startMs),
      revision: meeting.revision + 1, updatedAt: new Date().toISOString() });
  }

  summarize(id: string, summary: Summary) {
    return this.write({ ...this.get(id), summary, updatedAt: new Date().toISOString() });
  }

  appendImportedAudio(id: string, segments: Segment[], hash?: string) {
    const meeting = this.get(id);
    if (hash && meeting.audioImportHashes?.includes(hash)) return meeting;
    if (hash && (meeting.audioImportHashes?.length ?? 0) >= 200) throw new Error("This meeting already has 200 imported audio files. Start another meeting for additional files.");
    const existing = new Set(meeting.segments.map(segment => segment.id));
    const added = segments.filter(segment => !existing.has(segment.id));
    if (!added.length) return meeting;
    const start = meeting.segments.reduce((end, segment) => Math.max(end, segment.startMs + segment.durationMs), 0);
    return this.write({ ...meeting, segments: [...meeting.segments, ...added.map(segment => ({ ...segment, startMs: start + segment.startMs }))],
      ...(hash ? { audioImportHashes: [...meeting.audioImportHashes ?? [], hash] } : {}),
      revision: meeting.revision + 1, updatedAt: new Date().toISOString() });
  }

  addAgentWork(id: string, work: AgentWork) {
    const meeting = this.get(id);
    if (meeting.agentWork?.some(item => item.id === work.id)) return meeting;
    if ((meeting.agentWork?.length ?? 0) >= 50) throw new Error("This meeting already has 50 agent results. Export them before starting another meeting.");
    return this.write({ ...meeting, agentWork: [...meeting.agentWork ?? [], work], updatedAt: new Date().toISOString() });
  }

  delete(id: string) { unlinkSync(this.path(id)); }
}
