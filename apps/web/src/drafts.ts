import type { MeetingPatch } from "@moss/contracts";

export type EditableFields = Pick<MeetingPatch, "title" | "notes">;
export interface Draft extends EditableFields {
  expected: EditableFields;
  conflicted?: boolean;
}
export type Drafts = Record<string, Draft>;
export type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export const DRAFT_KEY = "moss:drafts:v1";
export const DRAFT_LIMITS = { count: 50, characters: 2_000_000, title: 240, notes: 200_000 } as const;
export const EDIT_FIELDS = ["title", "notes"] as const;

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function validDraft(value: unknown): value is Draft {
  if (!object(value) || !object(value.expected)) return false;
  if (value.conflicted !== undefined && typeof value.conflicted !== "boolean") return false;
  if (Object.keys(value).some(key => ![...EDIT_FIELDS, "expected", "conflicted"].includes(key))) return false;
  if (Object.keys(value.expected).some(key => !(EDIT_FIELDS as readonly string[]).includes(key))) return false;
  let fields = 0;
  for (const field of EDIT_FIELDS) {
    const text = value[field];
    const base = value.expected[field];
    if (text === undefined && base === undefined) continue;
    if (typeof text !== "string" || typeof base !== "string" || text.length > DRAFT_LIMITS[field] || base.length > DRAFT_LIMITS[field]) return false;
    fields++;
  }
  return fields > 0;
}

function validId(id: string) { return id.length > 0 && id.length <= 128 && /^[\w-]+$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id); }

function browserStorage(): DraftStorage {
  if (typeof window === "undefined") throw new Error("Browser storage is unavailable.");
  return window.localStorage;
}

export class DraftStore {
  constructor(private readonly storage: () => DraftStorage = browserStorage) {}

  load(): { drafts: Drafts; error: string | null } {
    try {
      const raw = this.storage().getItem(DRAFT_KEY);
      if (raw === null) return { drafts: {}, error: null };
      if (raw.length > DRAFT_LIMITS.characters) throw new Error("Draft storage exceeds its safety limit.");
      const record: unknown = JSON.parse(raw);
      if (!object(record) || record.version !== 1 || !object(record.drafts)) throw new Error("Draft storage has an unsupported format.");
      const entries = Object.entries(record.drafts);
      if (entries.length > DRAFT_LIMITS.count) throw new Error("Too many saved drafts.");
      const valid = entries.filter((entry): entry is [string, Draft] => validId(entry[0]) && validDraft(entry[1]));
      return { drafts: Object.fromEntries(valid), error: valid.length === entries.length ? null : "Some saved drafts were invalid and could not be restored. The original storage record has not been changed." };
    } catch {
      return { drafts: {}, error: "Saved drafts could not be read. Browser storage may be unavailable or damaged. The original record has not been changed." };
    }
  }

  save(drafts: Drafts) {
    const entries = Object.entries(drafts);
    if (entries.length > DRAFT_LIMITS.count || entries.some(([id, draft]) => !validId(id) || !validDraft(draft))) {
      throw new Error("Draft recovery limits exceeded. Save your edits to the service or copy them before closing this window.");
    }
    const raw = JSON.stringify({ version: 1, drafts });
    if (raw.length > DRAFT_LIMITS.characters) throw new Error("Draft recovery storage is full. Save your edits to the service or copy them before closing this window.");
    try { this.storage().setItem(DRAFT_KEY, raw); }
    catch { throw new Error("Draft recovery storage is unavailable or full. Your edits are only in this window. Save to the service or copy them before closing."); }
  }
}
