import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { ExportFormat, Health, Meeting, OpenCodeSummaryCatalog } from "@moss/contracts";
import { api, errorMessage } from "./api";
import { Workspace } from "./workspace";
import { Recorder } from "./recorder";
import { Icon } from "./Icon";
import { captureOpenCodeSelection, resolveOpenCodeSelection, type OpenCodeSelection, type OpenCodeSummarySelection } from "./opencode-summary";
import { Modal } from "./Modal";
import { download, filename } from "./download";
import { AudioFileImport, MeetingTools } from "./MeetingTools";

export function desktopPlatform(search: string) {
  const platform = new URLSearchParams(search).get("desktop");
  return platform === "darwin" || platform === "win32" || platform === "linux" ? platform : undefined;
}

export function timestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function SummaryText({ text }: { text: string }) {
  return <div className="summary-text">{text.split("\n").map((line, index) => {
    if (/^#{1,6}\s/.test(line)) return <h4 key={index}>{line.replace(/^#{1,6}\s+/, "")}</h4>;
    if (/^[-*]\s/.test(line)) return <p className="summary-bullet" key={index}>{line.replace(/^[-*]\s+/, "")}</p>;
    return line.trim() ? <p key={index}>{line}</p> : null;
  })}</div>;
}

type DialogState = { kind: "import" | "delete" | "ai" | "replace" | "discard-audio"; id: string; error: string | null }
  | { kind: "opencode"; id: string; selection: OpenCodeSummarySelection; error: string | null };
type CatalogState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; catalog: OpenCodeSummaryCatalog };
const dialogTitles = { import: "Import transcript", delete: "Delete this meeting?", ai: "Use your configured AI?", opencode: "Summarize with OpenCode?", replace: "Replace your edited fields?", "discard-audio": "Discard pending audio?" };
const dialogLabels = { import: "Add transcript", delete: "Delete meeting", ai: "Send and generate", opencode: "Send and generate with OpenCode", replace: "Replace my edited fields", "discard-audio": "Discard pending audio" };

export function App() {
  const [desktop] = useState(() => desktopPlatform(window.location.search));
  const [workspace] = useState(() => new Workspace());
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [recorder] = useState(() => new Recorder((id, chunk) => workspace.audio(id, chunk)));
  const recording = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [openCodeSelection, setOpenCodeSelection] = useState<OpenCodeSelection>({});
  const [preparing, setPreparing] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [importText, setImportText] = useState("");
  const [consent, setConsent] = useState(false);
  const [tab, setTab] = useState<"transcript" | "summary">("transcript");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("markdown");
  const meeting = state.meetings.find(item => item.id === selectedId) ?? (selectedId === null ? state.meetings[0] : undefined);
  const draft = meeting ? { ...meeting, ...state.drafts[meeting.id] } : null;
  const save = meeting ? state.saves[meeting.id] : null;
  const dirty = meeting ? Boolean(state.drafts[meeting.id]) : false;
  const activeAudio = recording.phase !== "idle" || recording.pending.length > 0;
  const recordingHere = meeting?.id === recording.meetingId && activeAudio;
  const catalog = catalogState.status === "ready" ? catalogState.catalog : undefined;
  const openCode = resolveOpenCodeSelection(catalog, openCodeSelection);
  const filtered = state.meetings.filter(item => {
    const draft = { ...item, ...state.drafts[item.id] };
    const query = search.toLocaleLowerCase();
    return [draft.title, draft.notes, ...item.segments.map(segment => segment.text)].some(text => text.toLocaleLowerCase().includes(query));
  });

  useEffect(() => {
    void workspace.load();
    return () => { workspace.pauseAutosave(); recorder.dispose(); };
  }, [workspace, recorder]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.health();
        if (alive) { setHealth(value); setHealthError(null); }
      } catch (error) {
        if (alive) setHealthError(errorMessage(error));
      }
      if (alive) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    let alive = true;
    void api.opencodeSummaryCatalog().then(catalog => {
      if (alive) setCatalogState({ status: "ready", catalog });
    }).catch(error => {
      if (alive) setCatalogState({ status: "error", message: errorMessage(error) });
    });
    return () => { alive = false; };
  }, [catalogRefresh]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(workspace.getSnapshot().drafts).length || recorder.getSnapshot().phase !== "idle" || recorder.getSnapshot().pending.length) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [workspace, recorder]);

  async function action(name: string, task: () => Promise<void>) {
    if (job) return;
    setJob(name); setError(null); setNotice(null);
    try { await task(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setJob(null); }
  }

  function select(id: string) { setSelectedId(id); setError(null); setNotice(null); setConsent(false); }

  async function create() {
    await action("create", async () => {
      const created = await workspace.create();
      select(created.id); setSearch(""); setTab("transcript");
    });
  }

  async function prepare() {
    setPreparing(true); setHealthError(null);
    try { setHealth(await api.prepare()); }
    catch (error) { setHealthError(errorMessage(error)); }
    finally { setPreparing(false); }
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || job) return;
    const { kind, id } = dialog;
    setJob(kind);
    try {
      if (kind === "import") {
        if (!importText.trim()) throw new Error("Paste some transcript text first.");
        await workspace.import(id, importText.trim());
        setImportText(""); setTab("transcript");
      } else if (kind === "delete") {
        await workspace.remove(id);
        if (selectedId === id) setSelectedId(null);
      } else if (kind === "replace") {
        await workspace.replaceConflictingFields(id);
      } else if (kind === "discard-audio") {
        recorder.discardPending(true);
      } else if (dialog.kind === "opencode") {
        const { agentID, model } = dialog.selection;
        await workspace.summarize(id, "opencode", { agentID, model, consent: true }); setTab("summary");
      } else {
        await workspace.summarize(id, "ai"); setTab("summary");
      }
      setDialog(null);
    } catch (error) {
      setDialog(current => current ? { ...current, error: errorMessage(error) } : null);
    } finally { setJob(null); }
  }

  function summarize() {
    if (!meeting) return;
    const id = meeting.id;
    void action("summary", async () => { await workspace.summarize(id, "extractive"); setTab("summary"); });
  }

  function confirmOpenCodeSummary() {
    if (!meeting || job || recordingHere) return;
    const selection = captureOpenCodeSelection(catalog, openCodeSelection);
    if (selection) setDialog({ kind: "opencode", id: meeting.id, selection, error: null });
  }

  async function exportMeeting(item: Meeting) {
    await action("export", async () => {
      const content = await workspace.export(item.id, exportFormat);
      const current = workspace.getSnapshot().meetings.find(meeting => meeting.id === item.id) ?? item;
      const formats = { markdown: { type: "text/markdown;charset=utf-8", extension: "md", label: "Markdown" }, text: { type: "text/plain;charset=utf-8", extension: "txt", label: "Plain text" }, json: { type: "application/json", extension: "json", label: "JSON" } };
      const format = formats[exportFormat];
      download(new Blob([content], { type: format.type }), `${filename(current.title)}.${format.extension}`);
      setNotice(`${format.label} downloaded.`);
    });
  }

  const engineReady = health?.hex.state === "ready" && !healthError;
  const engineBusy = preparing || health?.hex.state === "preparing";
  const transcriptDuration = meeting?.segments.reduce((max, segment) => Math.max(max, segment.startMs + segment.durationMs), 0) ?? 0;
  const hasContent = Boolean(meeting && (draft?.notes.trim() || meeting.segments.length));

  return <div className="app-shell" data-desktop={desktop}>
    <a href="#workspace" className="skip-link">Skip to meeting</a>
    <header className="topbar"><div className="brand-slot"><a className="brand" href="#workspace" aria-label="Moss home"><img src="/moss.svg" width="20" height="20" alt="" /><span>Moss</span></a></div><div className="breadcrumbs"><Icon name="note" size={14} /><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>Meetings</strong></div><span className="local-badge"><Icon name="shield" size={13} />Local workspace</span></header>
    <aside className="sidebar" aria-label="Meeting library">
      <div className="workspace-label"><span className="workspace-avatar">M</span><span>Personal workspace<small>On this device</small></span></div>
      <button className="button new-meeting" disabled={Boolean(job) || state.loading} onClick={() => { void create(); }}><Icon name="plus" size={16} />{job === "create" ? "Creating…" : "New meeting"}</button>
      <label className="search-field"><Icon name="search" size={16} /><input type="search" placeholder="Search meetings" aria-label="Search meetings" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="list-heading"><span>Meetings</span><span>{state.meetings.length}</span></div>
      <nav className="meeting-list" aria-label="Meetings">
        {state.loading ? <p className="sidebar-empty" role="status">Opening your workspace…</p> : null}
        {!state.loading && !filtered.length ? <p className="sidebar-empty">{search ? "No matching meetings. Try another word." : "No meetings yet."}</p> : null}
        {filtered.map(item => <button key={item.id} className={`meeting-item ${meeting?.id === item.id ? "selected" : ""}`} aria-current={meeting?.id === item.id ? "page" : undefined} disabled={Boolean(job)} onClick={() => select(item.id)}>
          <span className="meeting-item-icon"><Icon name="note" size={18} /></span><span className="meeting-item-copy"><strong>{state.drafts[item.id]?.title || item.title}</strong><small>{new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}<span>·</span>{state.drafts[item.id] ? "Unsaved edits" : item.segments.length ? `${item.segments.length} passage${item.segments.length === 1 ? "" : "s"}` : "Notes only"}</small></span>
          {recording.meetingId === item.id && activeAudio ? <span className="status-dot recording" aria-label="Audio in progress" /> : null}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="engine-card"><div className="engine-heading"><span className={`status-dot ${engineReady ? "ready" : ""}`} /><strong>{engineReady ? "Local engine ready" : engineBusy ? "Preparing local engine" : "Local speech engine"}</strong><span className="hex-label">HEX</span></div>
          <p>{healthError ?? health?.hex.message ?? "Connecting to the local Moss service…"}</p>
          {health && !engineReady ? <button className="text-button" disabled={engineBusy || health.hex.state === "unavailable"} onClick={() => { void prepare(); }}>{engineBusy ? "Preparing model…" : "Prepare speech model"}<Icon name="arrow" size={14} /></button> : null}
          {engineBusy ? <small className="engine-progress" role="status">The first model download can take a few minutes.</small> : null}
        </div>
        <div className="privacy-line"><Icon name="shield" size={14} /><span>Notes stored on this device</span></div>
      </div>
    </aside>

    <main id="workspace" className="workspace" tabIndex={-1}>
      {state.loadError ? <div className="banner error-banner" role="alert"><span>{state.loadError}</span><button className="text-button" onClick={() => { void workspace.load(); }}>Retry connection</button></div> : null}
      {state.storageError ? <div className="banner error-banner" role="alert"><span>{state.storageError}</span><button className="text-button" onClick={() => workspace.retryDraftStorage()}>Retry draft storage</button></div> : null}
      {error ? <div className="banner error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><Icon name="close" size={16} /></button></div> : null}
      {notice ? <div className="banner success-banner" role="status"><Icon name="check" size={16} />{notice}</div> : null}
      {recording.meetingId && (activeAudio || recording.error) ? <section className={`audio-status ${recording.error ? "audio-error" : ""}`} aria-label="Audio capture status">
        <div className="audio-status-main"><Icon name={recording.phase === "recording" ? "mic" : "clock"} /><div><strong>{recording.phase === "recording" ? `Recording microphone · ${timestamp(recording.elapsedMs)}` : recording.phase === "starting" ? "Waiting for microphone access…" : recording.phase === "stopping" ? "Stopping microphone…" : recording.pending.length ? "Transcribing retained audio" : "Microphone stopped"}</strong><p>{recording.error ?? (recording.pending.length ? `${recording.pending.length} audio chunk${recording.pending.length === 1 ? "" : "s"} waiting for local transcription. Keep this window open.` : "Only your microphone is captured. System audio is not recorded.")}</p></div>
          {recording.phase === "recording" || recording.phase === "starting" ? <button className="button stop-button" onClick={() => { void recorder.stop(); }}><Icon name="stop" size={15} />Stop</button> : null}
          {recording.meetingId !== meeting?.id ? <button className="text-button" onClick={() => select(recording.meetingId!)}>Open meeting</button> : null}
        </div>
        {recording.pending.length ? <div className="audio-recovery"><p>Pending audio is held in this window, not saved on disk. Retry or download it before closing.</p><div className="recovery-actions"><button className="button small" disabled={recording.uploading || recording.phase !== "idle"} onClick={() => { void recorder.retry(); }}>{recording.uploading ? "Transcribing…" : "Retry pending audio"}</button>{recording.pending.map((chunk, index) => <button key={chunk.id} className="text-button" onClick={() => download(chunk.wav, `moss-${recording.meetingId}-${chunk.startMs}.wav`)}><Icon name="download" size={14} />WAV {index + 1} · {timestamp(chunk.startMs)}</button>)}<button className="text-button" disabled={recording.uploading || recording.phase !== "idle" || Boolean(job)} onClick={() => setDialog({ kind: "discard-audio", id: recording.meetingId!, error: null })}>Discard pending audio…</button></div></div> : null}
      </section> : null}

      {meeting && draft ? <article className="meeting-workspace">
        <div className="meeting-heading"><span className="section-label"><Icon name="note" size={14} />Meeting</span><div className="meeting-actions"><select aria-label="Export format" value={exportFormat} disabled={Boolean(job)} onChange={event => setExportFormat(event.target.value as ExportFormat)}><option value="markdown">Markdown</option><option value="text">Plain text</option><option value="json">JSON</option></select><button className="button small" disabled={Boolean(job)} onClick={() => { void exportMeeting(meeting); }}><Icon name="download" size={15} />{job === "export" ? "Exporting…" : "Export"}</button><button className="icon-button muted" title="Delete meeting" aria-label="Delete meeting" disabled={Boolean(job) || recordingHere} onClick={() => setDialog({ kind: "delete", id: meeting.id, error: null })}><Icon name="trash" size={16} /></button></div></div>
        <label className="sr-only" htmlFor="meeting-title">Meeting title</label><input id="meeting-title" className="meeting-title" maxLength={240} placeholder="Untitled meeting" value={draft.title} onChange={event => workspace.edit(meeting.id, { title: event.target.value })} onBlur={() => { void workspace.save(meeting.id).catch(() => undefined); }} />
        <div className="meeting-meta"><time dateTime={meeting.createdAt}>{new Date(meeting.createdAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</time><span>·</span><span><Icon name="clock" size={13} />{transcriptDuration ? `${timestamp(transcriptDuration)} of transcript` : "No recorded audio"}</span></div>

        <div className="capture-bar"><div className="capture-copy"><span className="capture-symbol"><Icon name="mic" size={16} /></span><div><strong>{recordingHere ? "Meeting audio" : "Record meeting"}</strong><p>Microphone only. Transcribed on your device with Hex.</p></div></div><div className="capture-controls">
          {recordingHere && recording.phase !== "idle" ? <button className="button stop-button" disabled={recording.phase === "stopping"} onClick={() => { void recorder.stop(); }}><Icon name="stop" size={15} />{recording.phase === "stopping" ? "Stopping…" : "Stop recording"}</button> : <button className="button primary" disabled={!engineReady || !consent || activeAudio || Boolean(job)} onClick={() => { void recorder.start(meeting.id, transcriptDuration); }}><Icon name="mic" size={16} />Start recording</button>}
        </div></div>
        {!recordingHere ? <label className="consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I have the participants’ consent to record this meeting.</label> : null}
        {!engineReady && !recordingHere ? <p className="capture-help">{engineBusy ? "Your local model is getting ready. You can write notes while you wait." : "Prepare the local speech engine to record, or add a transcript below."}</p> : null}
        <AudioFileImport key={meeting.id} meetingID={meeting.id} workspace={workspace} health={health} disabled={Boolean(job) || activeAudio} run={action} />

        <div className="editor-grid"><section className="notes-panel" aria-labelledby="notes-heading"><div className="panel-heading"><h2 id="notes-heading">My notes</h2><span className={`save-status ${save?.state === "error" || save?.state === "conflict" ? "save-error" : ""}`} role="status">{save?.state === "conflict" ? "Edit conflict" : save?.state === "error" ? "Couldn’t save" : save?.state === "saving" ? "Saving…" : dirty ? "Unsaved edits" : <><Icon name="check" size={13} />Saved locally</>}</span></div>
          <label className="sr-only" htmlFor="meeting-notes">My notes</label><textarea id="meeting-notes" className="notes-editor" maxLength={200000} placeholder="Write meeting notes…" value={draft.notes} onChange={event => workspace.edit(meeting.id, { notes: event.target.value })} onBlur={() => { void workspace.save(meeting.id).catch(() => undefined); }} />
          <div className="notes-footer"><span>{save?.error ?? (state.storageError ? "Draft recovery is unavailable. Copy unsaved edits before closing." : "Unsaved edits are kept in this browser across reloads.")}</span><button className="text-button" disabled={!dirty || save?.state === "saving" || Boolean(job)} onClick={() => { if (save?.state === "conflict") setDialog({ kind: "replace", id: meeting.id, error: null }); else void workspace.save(meeting.id).catch(() => undefined); }}>{save?.state === "conflict" ? "Resolve conflict…" : save?.state === "error" ? "Retry save" : "Save now"}</button></div>
        </section>

        <section className="context-panel" aria-label="Meeting context"><div className="context-tabs" role="tablist" aria-label="Meeting content"><button id="transcript-tab" role="tab" aria-selected={tab === "transcript"} aria-controls="transcript-panel" tabIndex={tab === "transcript" ? 0 : -1} className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { setTab("summary"); document.getElementById("summary-tab")?.focus(); } }}>Transcript<span className="tab-count">{meeting.segments.length}</span></button><button id="summary-tab" role="tab" aria-selected={tab === "summary"} aria-controls="summary-panel" tabIndex={tab === "summary" ? 0 : -1} className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { setTab("transcript"); document.getElementById("transcript-tab")?.focus(); } }}>Summary<Icon name="spark" size={14} /></button></div>
          {tab === "transcript" ? <div id="transcript-panel" role="tabpanel" aria-labelledby="transcript-tab" className="tab-panel"><div className="context-toolbar"><span>Transcript</span><button className="text-button" disabled={Boolean(job) || recordingHere} onClick={() => { setImportText(""); setDialog({ kind: "import", id: meeting.id, error: null }); }}><Icon name="import" size={14} />Import text</button></div>
            {meeting.segments.length ? <div className="transcript-list">{meeting.segments.map(segment => <div className="transcript-segment" key={segment.id}><time>{timestamp(segment.startMs)}</time><p>{segment.text}</p></div>)}</div> : <div className="context-empty"><Icon name="note" size={20} /><h3>No transcript yet</h3><p>Record your microphone or import an existing transcript.</p><button className="button small" disabled={Boolean(job) || recordingHere} onClick={() => { setImportText(""); setDialog({ kind: "import", id: meeting.id, error: null }); }}><Icon name="plus" size={15} />Add a transcript</button></div>}
           </div> : <div id="summary-panel" role="tabpanel" aria-labelledby="summary-tab" className="tab-panel"><div className="context-toolbar"><span>{meeting.summary?.kind === "ai" ? "AI summary" : "Extracted highlights · Not AI"}</span></div>
             {meeting.summary?.opencode ? <p className="summary-attribution">OpenCode · {meeting.summary.opencode.agentID} · {meeting.summary.opencode.model.providerID}/{meeting.summary.opencode.model.id}{meeting.summary.opencode.model.variant !== undefined ? ` · ${meeting.summary.opencode.model.variant}` : ""}</p> : null}
            {meeting.summary && (meeting.summary.sourceRevision !== meeting.revision || dirty) ? <p className="stale-warning" role="status">Your notes or transcript have changed. Generate again to bring this up to date.</p> : null}
            {meeting.summary ? <SummaryText text={meeting.summary.markdown} /> : <div className="context-empty"><Icon name="note" size={20} /><h3>No summary yet</h3><p>Extract excerpts and possible next steps locally from your notes and transcript.</p></div>}
             <div className="summary-actions"><button className="button" disabled={!hasContent || Boolean(job) || recordingHere} onClick={summarize}><Icon name="note" size={15} />{job === "summary" ? "Extracting…" : meeting.summary ? "Refresh excerpts" : "Extract highlights"}</button>{health?.ai.configured ? <button className="text-button" disabled={!hasContent || Boolean(job) || recordingHere} onClick={() => setDialog({ kind: "ai", id: meeting.id, error: null })}><Icon name="spark" size={15} />Use configured AI</button> : <p className="summary-footnote">AI summaries are optional. Configure a provider in the local service to enable them.</p>}</div>
             <section className="opencode-summary" aria-labelledby="opencode-heading" aria-busy={catalogState.status === "loading"}>
               <div className="context-toolbar"><h3 id="opencode-heading">OpenCode</h3><button className="text-button" disabled={catalogState.status === "loading" || Boolean(job) || recordingHere} onClick={() => { setCatalogState({ status: "loading" }); setCatalogRefresh(value => value + 1); }}>Refresh OpenCode models</button></div>
               {catalogState.status === "loading" ? <p className="summary-footnote" role="status">Loading OpenCode agents and models…</p> : catalogState.status === "error" ? <p className="form-error" role="alert">{catalogState.message} Start OpenCode, then refresh OpenCode models.</p> : <p className="summary-footnote" role="status">{catalogState.catalog.message}{!catalogState.catalog.available ? " Start OpenCode, then refresh OpenCode models." : !openCode ? " No selectable agents or chat models. Enable them in OpenCode, then refresh." : ""}</p>}
               {openCode && catalog ? <div className="opencode-fields">
                 <label>OpenCode agent<select aria-label="OpenCode agent" disabled={Boolean(job) || recordingHere} value={openCode.agent.id} onChange={event => { if (catalog.agents.some(agent => agent.id === event.target.value)) setOpenCodeSelection({ ...openCodeSelection, agentID: event.target.value }); }}>{catalog.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
                 <label>OpenCode model<select aria-label="OpenCode model" disabled={Boolean(job) || recordingHere} value={JSON.stringify([openCode.model.providerID, openCode.model.id])} onChange={event => {
                   const model = catalog.models.find(model => JSON.stringify([model.providerID, model.id]) === event.target.value);
                   if (model) setOpenCodeSelection({ agentID: openCode.agent.id, model: { id: model.id, providerID: model.providerID } });
                 }}>{catalog.models.map(model => <option key={JSON.stringify([model.providerID, model.id])} value={JSON.stringify([model.providerID, model.id])}>{model.name} · {model.providerID}</option>)}</select></label>
                 <label>OpenCode variant<select aria-label="OpenCode variant" disabled={Boolean(job) || recordingHere || !openCode.model.variants.length} value={openCode.variant === undefined ? "" : JSON.stringify(openCode.variant)} onChange={event => {
                   const variant = openCode.model.variants.find(variant => JSON.stringify(variant) === event.target.value);
                   setOpenCodeSelection({ agentID: openCode.agent.id, model: { id: openCode.model.id, providerID: openCode.model.providerID, ...(variant !== undefined ? { variant } : {}) } });
                 }}><option value="">Server default</option>{openCode.model.variants.map(variant => <option key={variant} value={JSON.stringify(variant)}>{variant}</option>)}</select></label>
                 {openCode.agent.description ? <p className="summary-footnote">{openCode.agent.description}</p> : null}
               </div> : null}
               <button className="button" disabled={!hasContent || !openCode || Boolean(job) || recordingHere} onClick={confirmOpenCodeSummary}><Icon name="spark" size={15} />{job === "opencode" ? "Summarizing with OpenCode…" : "Summarize with OpenCode"}</button>
                <p className="summary-footnote">Uses your OpenCode server’s models. You’ll confirm sharing before sending.</p>
              </section>
              <MeetingTools key={meeting.id} meeting={meeting} workspace={workspace} selection={openCode ? { agentID: openCode.agent.id, model: { id: openCode.model.id, providerID: openCode.model.providerID, ...(openCode.variant !== undefined ? { variant: openCode.variant } : {}) } } : null} busy={Boolean(job) || activeAudio} run={action} />
          </div>}
        </section></div>
      </article> : <div className="welcome"><h1>A little more present.</h1><p>Create a meeting to take notes, record your microphone,<br />or import a transcript.</p><button className="button primary" disabled={Boolean(job) || state.loading || Boolean(state.loadError)} onClick={() => { void create(); }}><Icon name="plus" size={16} />Create your first meeting</button><div className="welcome-privacy"><Icon name="shield" size={14} /><span>No automatic recording. Notes stay with the local Moss service.</span></div></div>}
    </main>

     {dialog ? <Modal title={dialogTitles[dialog.kind]} busy={Boolean(job)} onClose={() => { if (!job) setDialog(null); }}><form onSubmit={event => { void submitDialog(event); }}>
      {dialog.kind === "import" ? <><p className="dialog-description">Paste a transcript to add it to this meeting. Existing passages will be kept.</p><label className="field-label" htmlFor="import-text">Transcript text</label><textarea id="import-text" className="import-editor" maxLength={200000} autoFocus value={importText} onChange={event => setImportText(event.target.value)} placeholder="Paste the conversation here…" required /></> : dialog.kind === "delete" ? <p className="dialog-description">This permanently removes this meeting, its notes, transcript, and summary from the local service. Unsaved edits will also be removed. This cannot be undone.</p> : dialog.kind === "replace" ? <p className="dialog-description">Another client changed this meeting. Continuing will read the latest version, then replace only the title or notes fields you edited with your draft. Other fields will be preserved. Cancel to keep your draft without replacing anything.</p> : dialog.kind === "discard-audio" ? <p className="dialog-description">This permanently discards all audio chunks still held in this window. Download the WAV files first if you need them. Already transcribed passages are kept. This cannot be undone.</p> : dialog.kind === "opencode" ? <><p className="dialog-description">Your notes and transcript will be stored in OpenCode session history and may be sent to the selected provider, {dialog.selection.model.providerID}. Only continue if everyone’s information may be shared with that provider. Extracted highlights do not use AI.</p><dl className="opencode-confirmation"><dt>Agent</dt><dd>{dialog.selection.agentName} ({dialog.selection.agentID})</dd><dt>Model</dt><dd>{dialog.selection.modelName} · {dialog.selection.model.providerID}/{dialog.selection.model.id}</dd><dt>Variant</dt><dd>{dialog.selection.model.variant ?? "Server default"}</dd></dl></> : <p className="dialog-description">{health?.ai.remote ? "Your notes and transcript will be sent to the remote AI provider configured in the Moss service. Only continue if everyone’s information may be shared with that provider." : "Your notes and transcript will be sent to the AI endpoint configured in the Moss service. Check your service configuration if you are unsure where it runs."} Extracted highlights do not use AI and stay on this device.</p>}
      {dialog.error ? <p className="form-error" role="alert">{dialog.error}</p> : null}<div className="dialog-actions"><button type="button" className="button" disabled={Boolean(job)} onClick={() => setDialog(null)}>Cancel</button><button type="submit" className={`button ${dialog.kind === "delete" || dialog.kind === "discard-audio" ? "danger" : "primary"}`} disabled={Boolean(job) || (dialog.kind === "import" && !importText.trim())}>{job ? "Working…" : dialogLabels[dialog.kind]}</button></div>
    </form></Modal> : null}
  </div>;
}
