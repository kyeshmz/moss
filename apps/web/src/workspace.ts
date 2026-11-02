import type { AgentWorkOptions, DriveExportOptions, ExportFormat, Meeting, MeetingPatch, OpenCodeSummaryOptions, SummaryKind } from "@moss/contracts";
import { api, ApiError, errorMessage } from "./api";
import { DraftStore, EDIT_FIELDS, type Drafts, type EditableFields } from "./drafts";

export interface WorkspaceState {
  meetings: Meeting[];
  drafts: Drafts;
  saves: Record<string, { state: "saving" | "error" | "conflict"; error?: string }>;
  loading: boolean;
  loadError: string | null;
  storageError: string | null;
}

type WorkspaceApi = Pick<typeof api, "meetings" | "create" | "patch" | "remove" | "import" | "summarize" | "audio" | "export"> & Partial<Pick<typeof api, "agentWork" | "driveExport" | "audioFile">>;
const conflictMessage = "This meeting was edited elsewhere. Your draft is kept. Confirm replacement before saving conflicting fields.";

export class Workspace {
  private state: WorkspaceState;
  private listeners = new Set<() => void>();
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private loadGeneration = 0;

  constructor(private readonly client: WorkspaceApi = api, private readonly draftStore = new DraftStore()) {
    const restored = draftStore.load();
    this.state = { meetings: [], drafts: restored.drafts, saves: Object.fromEntries(Object.entries(restored.drafts)
      .filter(([, draft]) => draft.conflicted).map(([id]) => [id, { state: "conflict", error: conflictMessage }])),
    loading: true, loadError: null, storageError: restored.error };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<WorkspaceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  private updateDrafts(drafts: Drafts, patch: Partial<WorkspaceState> = {}) {
    let storageError: string | null = null;
    try { this.draftStore.save(drafts); }
    catch (error) { storageError = errorMessage(error); }
    this.update({ ...patch, drafts, storageError });
  }

  retryDraftStorage() { this.updateDrafts(this.state.drafts); }

  private accept(meeting: Meeting) {
    const previous = this.state.meetings.find(item => item.id === meeting.id);
    if (previous && previous.revision > meeting.revision) return;
    this.update({ meetings: [meeting, ...this.state.meetings.filter(item => item.id !== meeting.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  }

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }

  async load() {
    const generation = ++this.loadGeneration;
    this.update({ loading: true, loadError: null });
    try {
      const meetings = await this.client.meetings();
      if (generation === this.loadGeneration) this.update({ meetings, loading: false });
    } catch (error) {
      if (generation === this.loadGeneration) this.update({ loading: false, loadError: errorMessage(error) });
    }
  }

  async create() {
    const meeting = await this.client.create();
    this.accept(meeting);
    return meeting;
  }

  edit(id: string, patch: EditableFields) {
    const meeting = this.state.meetings.find(item => item.id === id);
    if (!meeting) return;
    const previous = this.state.drafts[id];
    const draft = { ...previous, expected: { ...previous?.expected } };
    for (const field of EDIT_FIELDS) {
      if (patch[field] === undefined) continue;
      const base = draft.expected[field] ?? meeting[field];
      if (patch[field] === base && (this.state.saves[id]?.state !== "saving" || previous?.[field] === undefined)) {
        delete draft[field];
        delete draft.expected[field];
      } else {
        draft[field] = patch[field];
        draft.expected[field] = base;
      }
    }
    const drafts = { ...this.state.drafts, [id]: draft };
    if (!EDIT_FIELDS.some(field => draft[field] !== undefined)) delete drafts[id];
    const saves = { ...this.state.saves };
    if (!drafts[id]) delete saves[id];
    this.updateDrafts(drafts, { saves });
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (drafts[id] && !drafts[id].conflicted) this.timers.set(id, setTimeout(() => { void this.save(id).catch(() => undefined); }, 900));
  }

  private async saveDraft(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    while (this.state.drafts[id]) {
      const submitted = this.state.drafts[id];
      if (submitted.conflicted) throw new ApiError(conflictMessage, 409);
      const patch: MeetingPatch = { expected: submitted.expected };
      for (const field of EDIT_FIELDS) if (submitted[field] !== undefined) patch[field] = submitted[field];
      this.update({ saves: { ...this.state.saves, [id]: { state: "saving" } } });
      try {
        const meeting = await this.client.patch(id, patch);
        this.accept(meeting);
        const drafts = { ...this.state.drafts };
        const current = drafts[id];
        if (current) {
          const remaining = { ...current, expected: { ...current.expected } };
          for (const field of EDIT_FIELDS) {
            if (submitted[field] === undefined) continue;
            if (current[field] === submitted[field]) {
              delete remaining[field];
              delete remaining.expected[field];
            } else if (current[field] !== undefined) remaining.expected[field] = meeting[field];
          }
          if (EDIT_FIELDS.some(field => remaining[field] !== undefined)) drafts[id] = remaining;
          else delete drafts[id];
        }
        const saves = { ...this.state.saves };
        delete saves[id];
        this.updateDrafts(drafts, { saves });
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        const drafts = { ...this.state.drafts };
        if (conflict && drafts[id]) drafts[id] = { ...drafts[id], conflicted: true };
        this.updateDrafts(drafts, { saves: { ...this.state.saves, [id]: { state: conflict ? "conflict" : "error", error: conflict ? conflictMessage : errorMessage(error) } } });
        throw error;
      }
    }
  }

  save(id: string) { return this.enqueue(id, () => this.saveDraft(id)); }

  replaceConflictingFields(id: string) {
    return this.enqueue(id, async () => {
      if (!this.state.drafts[id]?.conflicted) return;
      const meetings = await this.client.meetings();
      const meeting = meetings.find(item => item.id === id);
      if (!meeting) throw new Error("This meeting no longer exists in the service. Copy your draft before leaving.");
      this.accept(meeting);
      const current = this.state.drafts[id];
      const expected: EditableFields = {};
      for (const field of EDIT_FIELDS) if (current[field] !== undefined) expected[field] = meeting[field];
      this.updateDrafts({ ...this.state.drafts, [id]: { ...current, expected, conflicted: false } });
      await this.saveDraft(id);
    });
  }

  import(id: string, text: string) {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      const meeting = await this.client.import(id, text);
      this.accept(meeting);
    });
  }

  summarize(id: string, kind: SummaryKind, options?: OpenCodeSummaryOptions) {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      const meeting = await this.client.summarize(id, kind, options);
      this.accept(meeting);
    });
  }

  audio(id: string, chunk: { id: string; startMs: number; wav: Blob }) {
    return this.enqueue(id, async () => {
      const meeting = await this.client.audio(id, chunk);
      this.accept(meeting);
    });
  }

  agentWork(id: string, options: AgentWorkOptions) {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      this.accept(await (this.client.agentWork ?? api.agentWork)(id, options));
    });
  }

  driveExport(id: string, options: DriveExportOptions) {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      return (this.client.driveExport ?? api.driveExport)(id, options);
    });
  }

  audioFile(id: string, file: File, signal?: AbortSignal) {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      if (signal?.aborted) throw new Error("Audio import cancelled.");
      this.accept(await (this.client.audioFile ?? api.audioFile)(id, file, signal));
    });
  }

  export(id: string, format: ExportFormat = "markdown") {
    return this.enqueue(id, async () => {
      await this.saveDraft(id);
      return this.client.export(id, format);
    });
  }

  remove(id: string) {
    return this.enqueue(id, async () => {
      await this.client.remove(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      const drafts = { ...this.state.drafts };
      const saves = { ...this.state.saves };
      delete drafts[id];
      delete saves[id];
      this.updateDrafts(drafts, { meetings: this.state.meetings.filter(item => item.id !== id), saves });
    });
  }

  pauseAutosave() {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }
}
