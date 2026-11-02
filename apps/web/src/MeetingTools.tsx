import { useEffect, useRef, useState } from "react";
import type { AgentWorkOptions, ContentSource, DriveCatalog, DriveConnectionOptions, DriveExportHandoff, DriveExportOptions, Health, Meeting, SummaryModel } from "@moss/contracts";
import { api, errorMessage } from "./api";
import { Workspace } from "./workspace";
import { Modal } from "./Modal";
import { download, filename } from "./download";

type Run = (name: string, task: () => Promise<void>) => Promise<void>;
const sources: { value: ContentSource; label: string }[] = [
  { value: "meeting", label: "Whole meeting" }, { value: "notes", label: "My notes" },
  { value: "transcript", label: "Transcript" }, { value: "summary", label: "Current summary" },
];

function SourcePicker({ value, onChange, label }: { value: ContentSource; onChange: (source: ContentSource) => void; label: string }) {
  return <label>{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value as ContentSource)}>{sources.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}</select></label>;
}

export function AudioFileImport({ meetingID, workspace, health, disabled, run }: { meetingID: string; workspace: Workspace; health: Health | null; disabled: boolean; run: Run }) {
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);

  function choose(files: FileList | null) {
    if (!files?.length || disabled) return;
    if (files.length !== 1) { setError("Choose one audio file at a time."); return; }
    if (!files[0].size || files[0].size > 100 * 1024 * 1024) { setError("Choose a nonempty audio file no larger than 100 MiB."); return; }
    setFile(files[0]); setConsent(false); setError(null);
  }

  async function start() {
    if (!file || !consent || disabled) return;
    const selected = file;
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setImporting(true); setError(null);
    try {
      await run("audio-import", async () => {
        try { await workspace.audioFile(meetingID, selected, signal); setFile(null); setConsent(false); }
        catch (error) { setError(errorMessage(error)); throw error; }
      });
    } finally { controller.current = null; setImporting(false); }
  }

  return <section className="audio-file-import" aria-label="Import audio file" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files); }}>
    <div className="context-toolbar"><strong>Import audio</strong><label className="button small file-picker">Choose audio file<input type="file" aria-label="Choose audio file" accept="audio/*,.m4a,.mp4,.flac,.ogg,.opus,.aiff,.aif,.webm" disabled={disabled} onChange={event => { choose(event.target.files); event.target.value = ""; }} /></label></div>
    <p className="summary-footnote">Drop one sound file here. WAV, MP3, M4A, FLAC, OGG and other common audio formats. Up to 100 MiB and 2 hours. Local Hex and FFmpeg are required.</p>
    {health?.audioImport && !health.audioImport.available ? <p className="summary-footnote">{health.audioImport.message}</p> : null}
    {health?.hex.state !== "ready" ? <p className="summary-footnote">Prepare the local speech model before importing a file.</p> : null}
    {file ? <><p className="selected-audio">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MiB</p><label className="consent"><input type="checkbox" checked={consent} disabled={disabled} onChange={event => setConsent(event.target.checked)} />I have permission to transcribe this audio on this device.</label><div className="recovery-actions"><button className="button small" disabled={disabled || !consent || health?.hex.state !== "ready" || health?.audioImport?.available === false} onClick={() => { void start(); }}>{importing ? "Importing and transcribing…" : "Transcribe audio file"}</button>{importing ? <button className="button small" onClick={() => controller.current?.abort()}>Cancel audio import</button> : <button className="text-button" disabled={disabled} onClick={() => { setFile(null); setError(null); setConsent(false); }}>Clear selected file</button>}</div></> : null}
    {importing ? <p className="summary-footnote" role="status">Converting and transcribing locally. This may take several minutes. The transcript is saved only after the whole file succeeds.</p> : null}
    {error ? <p className="form-error" role="alert">{error} The selected file is retained for retry.</p> : null}
  </section>;
}

type Confirmation = ({ kind: "agent"; options: AgentWorkOptions } | { kind: "connect"; options: DriveConnectionOptions } | { kind: "drive"; options: DriveExportOptions }) & { error?: string };

export function MeetingTools({ meeting, workspace, selection, busy, run }: { meeting: Meeting; workspace: Workspace; selection: { agentID: string; model: SummaryModel } | null; busy: boolean; run: Run }) {
  const [source, setSource] = useState<ContentSource>("meeting");
  const [instruction, setInstruction] = useState("Review this content and suggest a clearer summary. Preserve uncertainty and do not invent facts.");
  const [drive, setDrive] = useState<DriveCatalog | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [server, setServer] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [newServer, setNewServer] = useState("moss-drive");
  const [folderID, setFolderID] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [handoff, setHandoff] = useState<DriveExportHandoff | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.driveCatalog().then(catalog => { if (alive) { setDrive(catalog); setDriveError(null); } })
      .catch(error => { if (alive) { setDrive(null); setDriveError(errorMessage(error)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refresh]);
  const chosenServer = drive?.servers.find(item => item.name === server);

  async function submit() {
    if (!confirmation || busy) return;
    const snapshot = confirmation;
    await run(`tools-${snapshot.kind}`, async () => {
      try {
        if (snapshot.kind === "agent") await workspace.agentWork(meeting.id, snapshot.options);
        else if (snapshot.kind === "connect") { setDrive(await api.connectDrive(snapshot.options)); setServer(snapshot.options.server); setEndpoint(""); }
        else setHandoff(await workspace.driveExport(meeting.id, snapshot.options));
        setConfirmation(null);
      } catch (error) { setConfirmation({ ...snapshot, error: errorMessage(error) }); throw error; }
    });
  }

  return <div className="meeting-tools">
    <details><summary>Ask another agent</summary><div className="tool-fields">
      <p className="summary-footnote">Uses the OpenCode agent and model selected above. Results are saved separately; your original notes, transcript and summary are kept.</p>
      <SourcePicker label="Agent content source" value={source} onChange={setSource} />
      <label>What should the agent do?<textarea aria-label="Agent instructions" maxLength={4000} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} /></label>
      <button className="button" disabled={busy || !selection || !instruction.trim() || (source === "summary" && !meeting.summary)} onClick={() => { if (selection) setConfirmation({ kind: "agent", options: { ...structuredClone(selection), source, instruction: instruction.trim(), requestID: crypto.randomUUID(), consent: true } }); }}>Ask agent</button>
    </div></details>
    {meeting.agentWork?.length ? <section aria-label="Agent results"><h3>Agent results</h3>{meeting.agentWork.map(result => <details key={result.id}><summary>{result.instruction.slice(0, 80)}</summary><p className="summary-footnote">{result.agentID} · {result.model.providerID}/{result.model.id} · {result.source}{result.sourceRevision !== meeting.revision ? " · Source has changed" : ""}</p><pre className="agent-output">{result.markdown}</pre><button className="text-button" onClick={() => download(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }), `${filename(meeting.title)}-agent.md`)}>Download agent Markdown</button></details>)}</section> : null}
    <details><summary>Google Drive MCP</summary><div className="tool-fields">
      <button className="text-button" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>Refresh Drive connections</button>
      <p className="summary-footnote" role="status">{loading ? "Loading OpenCode MCP connections…" : driveError ?? drive?.message}</p>
      <label>Google Drive MCP server<select aria-label="Google Drive MCP server" value={server} disabled={busy} onChange={event => setServer(event.target.value)}><option value="">Choose your Drive server</option>{drive?.servers.map(item => <option key={item.name} value={item.name}>{item.title ?? item.name} · {item.status}</option>)}</select></label>
      <p className="summary-footnote">Select your Google Drive server explicitly. Other configured MCP servers may be listed. Sign in through OpenCode’s /mcps screen, then refresh here. For export, choose moss-drive or a Drive-capable agent above. Existing Drive servers need codemode:false; Code Mode is never enabled by an export.</p>
      <label>New Drive MCP HTTPS endpoint<input type="url" aria-label="Drive MCP endpoint" placeholder="Your provider's MCP endpoint" value={endpoint} disabled={busy} onChange={event => setEndpoint(event.target.value)} /></label>
      {endpoint ? <label>New MCP server name<input aria-label="New MCP server name" value={newServer} disabled={busy} onChange={event => setNewServer(event.target.value)} /></label> : null}
      <button className="button" disabled={busy || loading || (!server && !endpoint.trim())} onClick={() => setConfirmation({ kind: "connect", options: { server: endpoint.trim() ? newServer.trim() : server, ...(endpoint.trim() ? { url: endpoint.trim() } : {}), consent: true } })}>Connect Drive MCP</button>
      <SourcePicker label="Drive export content" value={source} onChange={setSource} />
      <label>Drive folder ID (optional)<input aria-label="Drive folder ID" value={folderID} disabled={busy} onChange={event => setFolderID(event.target.value)} /></label>
      <button className="button" disabled={busy || !selection || chosenServer?.status !== "connected"} onClick={() => { if (selection) setConfirmation({ kind: "drive", options: { ...structuredClone(selection), server, source, ...(folderID.trim() ? { folderID: folderID.trim() } : {}), consent: true } }); }}>Hand off Markdown to Drive</button>
      {handoff ? <div role="status"><strong>Submitted to OpenCode, not confirmed exported.</strong><p className="summary-footnote">{handoff.message}</p><code className="session-id">{handoff.sessionID}</code></div> : null}
    </div></details>
    {confirmation ? <Modal title={confirmation.kind === "connect" ? "Connect Google Drive MCP?" : confirmation.kind === "agent" ? "Send content to this agent?" : "Hand off Drive export?"} busy={busy} onClose={() => { if (!busy) setConfirmation(null); }}>
      <p className="dialog-description">{confirmation.kind === "connect" ? `This adds or connects ${confirmation.options.server} in OpenCode for this location. Credentials and OAuth stay in OpenCode. Runtime additions may need permanent setup in OpenCode after a restart. Only connect a server you trust.` : `The selected ${confirmation.options.source} content will remain in OpenCode session history and may be sent to ${confirmation.options.model.providerID}. Continue only with permission to share it.`}</p>
      {confirmation.kind === "agent" ? <p className="dialog-description">Agent {confirmation.options.agentID}. Instruction: {confirmation.options.instruction}</p> : null}
      {confirmation.kind === "drive" ? <p className="dialog-description">This creates an export task, not a confirmed Drive file. Open OpenCode to approve the selected MCP server's tools and verify the resulting file. Retrying may create another task.</p> : null}
      {confirmation.error ? <p className="form-error" role="alert">{confirmation.error}</p> : null}
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={() => { void submit(); }}>{busy ? "Working…" : "Confirm and continue"}</button></div>
    </Modal> : null}
  </div>;
}
