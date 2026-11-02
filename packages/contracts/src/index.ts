export interface Segment {
  id: string;
  startMs: number;
  durationMs: number;
  text: string;
}

export interface Summary {
  markdown: string;
  kind: "extractive" | "ai";
  sourceRevision: number;
  opencode?: { agentID: string; model: SummaryModel };
}

export interface SummaryModel { id: string; providerID: string; variant?: string }
export interface OpenCodeSummaryOptions { agentID: string; model: SummaryModel; consent: true }
export interface OpenCodeSummaryCatalog {
  available: boolean;
  message: string;
  agents: { id: string; name: string; description?: string }[];
  models: { id: string; providerID: string; name: string; variants: string[] }[];
}
export type SummaryKind = "extractive" | "ai" | "opencode";

export type ContentSource = "meeting" | "notes" | "transcript" | "summary";
export interface AgentWorkOptions extends OpenCodeSummaryOptions {
  source: ContentSource;
  instruction: string;
  requestID: string;
}
export interface AgentWork {
  id: string;
  source: ContentSource;
  instruction: string;
  markdown: string;
  sourceRevision: number;
  agentID: string;
  model: SummaryModel;
  createdAt: string;
}
export interface DriveCatalog {
  available: boolean;
  message: string;
  servers: { name: string; title?: string; status: "connected" | "pending" | "disabled" | "failed" | "needs_auth" }[];
}
export interface DriveConnectionOptions { server: string; url?: string; consent: true }
export interface DriveExportOptions extends OpenCodeSummaryOptions {
  server: string;
  source: ContentSource;
  folderID?: string;
}
export interface DriveExportHandoff { sessionID: string; status: "submitted"; message: string }
export type ExportFormat = "markdown" | "text" | "json";
export interface AudioImportHealth {
  available: boolean;
  message: string;
  formats: string[];
  maxBytes: number;
  maxDurationMs: number;
}

export interface Meeting {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  revision: number;
  segments: Segment[];
  summary: Summary | null;
  agentWork?: AgentWork[];
  audioImportHashes?: string[];
}

export interface Health {
  name: "Moss";
  apiVersion: 1;
  hex: {
    state: "unavailable" | "idle" | "preparing" | "ready" | "error";
    model: string;
    message: string;
  };
  ai: { configured: boolean; remote: boolean };
  audioImport?: AudioImportHealth;
}

export interface MeetingPatch {
  title?: string;
  notes?: string;
  expected?: { title?: string; notes?: string };
}
export interface ApiError { error: string }
export const API_PORT = 4310;
export const CLIENT_HEADER = "X-Moss-Client";
