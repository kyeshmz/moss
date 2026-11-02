# Moss for macOS

A native SwiftUI client for the shared Moss service. Requires macOS 14+, Swift 6, and the local service already running at `http://127.0.0.1:4310`. This client does not launch the service or install Hex. The service owns meetings; the native client stores only local recovery drafts.

## Build and test

From the monorepo root:

```sh
swift build --package-path apps/macos
swift test --package-path apps/macos
bash apps/macos/scripts/package-app.sh
```

The script builds a release executable, adds `Info.plist` with a microphone usage description, and ad-hoc signs `apps/macos/dist/Moss.app`. It does not launch the app. Signing for distribution, notarization, and an installer are out of scope. To launch it yourself after starting the service:

```sh
open apps/macos/dist/Moss.app
```

Use the packaged `.app`, rather than `swift run`, when testing microphone permission. Get participant consent before clicking Record. Moss captures **microphone only**, not system audio. Prepare the Hex model using the sidebar before recording. Initial download can take several minutes; health polling shows the service's current message.

## Appearance

Moss follows macOS light and dark appearance. Its neutral palette uses the OpenCode 2.2.5 oc-2 v2 tokens. The workspace uses 13–14pt system sans-serif text, 20pt meeting headings, monospaced dates and transcript timestamps, thin pane separators, and a preferred 276pt sidebar. Lists, buttons, splitters, menus, dialogs, and compact window chrome remain native. No OpenCode fonts or logos are bundled.

`MossAppearanceTests` checks resolved sRGB values in both palettes and the compact size tokens without opening a window. These checks do not prove rendered parity. No matching live OpenCode window capture was available, and native layout, appearance switching, keyboard focus, VoiceOver, and clipping still need a manual run.

## Saves and recovery

- Title and notes autosave after 800 ms. Save / Retry save and Command-S are also available. Each meeting keeps its own draft during selection changes, refreshes, transcript uploads, and failed saves. Save status is explicit. Summary, agent requests, Drive handoffs, audio-file import, and all export formats wait for a successful save.
- Saves send only edited fields and their original values in `expected`. Refreshes and recording updates never rebase a dirty field. A 409 pauses saving, retains the draft, and disables ordinary Save and autosave for that meeting. **Replace conflicting fields…** requires confirmation, reads fresh service state, and replaces only locally edited fields. Another concurrent change stops the replacement again.
- Title and notes drafts, original field values, and conflict state are written atomically to `~/Library/Application Support/Moss/NativeDrafts/drafts.json`. This is separate from service meeting storage. The containing directory is mode `0700` and the file is mode `0600`. The file is not encrypted. It contains no transcript, summary, or audio. Successful saves remove their recovery records.
- Recovery restores drafts before connecting to the service, including drafts for meetings unavailable on the service. Recovered drafts wait for Save or another edit rather than retrying automatically. An interrupted save is marked for explicit conflict review because its server outcome may be unknown.
- The versioned recovery file validates UUIDs, field types, duplicate IDs, and size bounds. It permits 100 drafts, 16 MiB total, 4 KiB per title value, and 1 MiB per notes value, including original values. Exceeding a bound or failing a disk write leaves the draft in memory and shows a persistent recovery warning. Keep Moss open until edits save or recovery works. Retry draft recovery is available. A malformed recovery file is left untouched; repair or move it yourself before retrying recovery.
- Pending microphone audio is still only in memory. Quitting warns if work is unsaved. A crash or forced quit can lose pending audio; use Save WAV files first. The quit warning distinguishes recoverable notes from failed recovery and memory-only audio.
- The microphone is converted to 16 kHz mono 16-bit PCM WAV, with 20-second chunks uploaded sequentially. The final shorter chunk is sealed on Stop. Chunk UUIDs stay unchanged on retry.
- On a conversion or transcription error, recording stops. The failed chunk, later queued chunks, and final partial chunk remain available for retry or explicit WAV export. Audio can only be discarded with confirmation. At most six full chunks (120 seconds) wait in memory before capture automatically stops. No automatic remote inference fallback exists.
- Use Save WAV files to rescue pending audio to a chosen folder before quitting. Export does not remove pending chunks. The local service does not keep uploaded WAVs.
- Extracted highlights are labeled as excerpts, not AI. AI summary is available only when the service configures it and requires explicit confirmation. Remote AI usage is disclosed. Stale summaries show a warning.

## Audio files and sharing

- The transcript pane accepts one local audio-file drop or file-picker selection. Selecting only reads the file; it never starts transcription. Prepare Hex in the sidebar first; import is disabled until the local engine is ready. Review participant consent before sending bytes to the local service. The limit is 100 MiB and two hours. Common audio containers need the service's local ffmpeg installation. Encrypted, corrupt, or unsupported media can fail. Moss does not install ffmpeg or silently use a remote transcription provider.
- Import shows indeterminate upload/transcription progress, error details, Cancel import, and a consented retry. A request timeout and a separate wall-clock deadline both limit import to 30 minutes. Cancellation cancels URLSession. The chosen bytes and filename stay in memory until acknowledgement or explicit removal. Original files are never changed. Identical retries are deduplicated by the service even when cancellation races an acknowledgement. Pending microphone work blocks file selection and import; capture and conflicting jobs are blocked during import.
- **Ask agent** reuses the existing live OpenCode agent/model/variant selection. Choose whole meeting, notes, transcript, or current summary and enter a custom instruction. Review a saved-content snapshot, provider disclosure, and OpenCode session-history disclosure before sending. A failed confirmation remains open and reuses its UUID for an explicit retry. A new review gets a new UUID. Known source changes require a new review. The service reads the latest saved source at submission; another client's concurrent edit cannot be atomically pinned by this API.
- Agent results are separate history, bounded by the service to 50 results per meeting. They never replace notes, transcript, or summary. Each result has its own Markdown download. Downloads refuse to overwrite existing files.
- **Google Drive MCP** lists configured server names and status without guessing which is Drive. Select your server explicitly. Connecting requires confirmation. Adding a supplied HTTPS endpoint separately discloses a runtime add/connect for the current OpenCode location and requires consent. It is not guaranteed to persist; permanent setup may be needed in OpenCode after restart. Credential-bearing URLs, query strings, fragments, and replacement of existing configuration are rejected. No endpoint or OAuth URL is invented. Authenticate in OpenCode's `/mcps` UI, then refresh servers. Existing Drive MCP servers need `codemode:false` in OpenCode.
- Drive handoff reuses the selected agent/model, source selector, and optional folder ID. Choose `moss-drive` or another Drive-capable agent in the existing Agent selector. Text-only `moss-summary`, `moss-reviewer`, and `moss-editor` cannot export to Drive. Its confirmation shows saved source content and provider/history disclosure. The result is **submitted**, with a session ID, not proof of upload. Open that session in OpenCode, approve the selected server's native MCP actions, and verify the resulting file. Execute and Code Mode are denied. No remote write is automatically approved. If submission fails, inspect OpenCode before resubmitting because a separate session may already exist.
- Meeting actions export Markdown, plain text, or JSON through the shared service after saving edits. Native save dialogs refuse to overwrite existing files. The existing default Markdown API remains available.
- Quit warns about active jobs and retained file selection. The original file survives, but file selection, unsubmitted confirmations, and active job status are not restored after quitting. Pending microphone WAVs still need explicit rescue before quitting.

## API usage

All requests target `http://127.0.0.1:4310/api` and include `X-Moss-Client: 1`.

| Endpoint | Native use |
| --- | --- |
| `GET /health` | Connection, engine progress, optional AI configuration |
| `POST /engine/prepare` | Explicit model preparation, up to 15-minute timeout |
| `GET /meetings` | Initial load and explicit refresh |
| `POST /meetings` | Create a blank meeting |
| `PATCH /meetings/:id` | Only changed title/notes fields with matching `expected` bases; handle 409 without automatic rebasing |
| `DELETE /meetings/:id` | Confirmed deletion |
| `POST /meetings/:id/audio` | WAV bytes, `X-Chunk-Id`, `X-Start-Ms`; sequential retries |
| `POST /meetings/:id/audio-file` | Raw bytes, percent-encoded `X-File-Name`, `X-Audio-Consent: 1`; consent, cancellation, 30-minute deadline |
| `POST /meetings/:id/transcript` | Append pasted text |
| `POST /meetings/:id/summary` | Explicit extractive or AI summary |
| `GET /summary/opencode` | One shared live agent/model/variant catalog |
| `POST /meetings/:id/agent-work` | Flat confirmed options, source, instruction, stable request UUID; separate result history |
| `GET /drive` | Public configured MCP server names/status |
| `POST /drive/connect` | Explicit existing-server connection or consented supplied HTTPS endpoint |
| `POST /meetings/:id/drive-export` | Confirmed source, server, optional folder, agent/model; submitted session only |
| `GET /meetings/:id/export?format=markdown\|text\|json` | Service content, then native save dialog; default remains Markdown |

Tests decode the actual shared fixture at `packages/contracts/fixtures/meeting.json`, inspect HTTP requests through an isolated URLSession protocol stub, and exercise draft and PCM queue invariants. Conflict tests run two workspaces against a precondition-checking service stub. Recovery tests inject unique temporary files under `.build/draft-tests`, never the application recovery file. They cover failed and interrupted saves, disjoint edits, confirmed replacement, repeated conflicts, corrupt archives, validation bounds, private permissions, and persistence failures. No test starts the app, calls a live service, or accesses a microphone. These checks do not prove native permission, capture hardware, live Hex inference, or visual behavior. Those require a consented manual run.

Sharing checks cover optional legacy DTO decoding, ignored service-only metadata, source isolation, flat bodies, consent headers, encoded filenames, file-size bounds, ready-Hex and ffmpeg gates, save-before-action guards, unchanged originals, stable retries, result-download overwrite refusal, Drive endpoint validation, rejection of known text-only Drive agents, and truthful handoff status. A suspended URLSession protocol proves cancellation and an injected short wall-clock deadline without waiting 30 minutes. Native drag/drop, file dialogs, sheet layout, VoiceOver, live model work, OAuth, and Drive approvals remain unverified interactions. No test connects a real MCP server or writes to Drive.
