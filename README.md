# Moss

A local-first meeting notebook inspired by Granola. Write your own notes, capture microphone audio, and turn a transcript into highlights. Speech recognition uses [Anomaly's Hex](https://github.com/anomalyco/hex) through its official TypeScript SDK.

Public repository: [kyeshmz/moss](https://github.com/kyeshmz/moss).

The monorepo has two desktop clients. Electron shares its React workspace with the browser. The native macOS client is written in SwiftUI. Both talk to the same local service and see the same meetings.

Both clients use OpenCode 2.2.5's desktop visual language, with neutral light/dark surfaces, compact sans-serif text, mono timestamps, a 276px sidebar, and thin split-pane dividers. Appearance follows the system. The Electron host uses real native caption controls, not drawn imitations. This is source-guided styling, not a pixel-perfect clone or an affiliated OpenCode product.

## Layout

```text
apps/
  desktop/       Electron host. Starts the local service and loads the built UI.
  macos/         Native SwiftUI macOS application.
  service/       Loopback HTTP API, private persistence, Hex lifecycle, summaries.
  web/           React meeting workspace used by Electron and the browser.
packages/
  contracts/     Shared TypeScript wire types and a Swift decoding fixture.
  core/          Meeting rules, extractive highlights, and Markdown export.
scripts/         Repeatable integration verification.
```

The service is the only storage writer. Neither desktop client owns a separate database. This avoids two implementations of transcription, persistence, and summary rules. The alternative, embedding that logic independently in Rust and Swift, would duplicate those behaviors.

[OpenCode V2 uses Electron and SolidJS](https://opencode.ai/v2/docs/build/plugins/gui/). Moss matches its Electron desktop host and local-service architecture. Its shared frontend uses React rather than SolidJS. There is no Tauri dependency.

## Prerequisites

- Node.js 22.12 or newer and npm.
- [Hex](https://anoma.ly/hex/) for real transcription. On macOS it requires Apple silicon and macOS 15 or newer. Installing the SDK does **not** install the native Hex executable.
- Swift 6.1 or newer and the macOS SDK to build the native client.
- A local FFmpeg executable for audio-file imports. Microphone recording does not need FFmpeg. Set `FFMPEG_BIN` if it is not on `PATH`; common Homebrew paths are also detected on macOS.

Moss works as a notes and imported-transcript notebook without Hex. It never fabricates a transcript when Hex is missing.

## Import sound files

Both clients have a drop area and file picker. Choose one file, confirm permission to transcribe it, prepare the local speech model, then start the import. Dropping a file does not start transcription automatically.

Common WAV, MP3, M4A, FLAC, OGG, AIFF, AAC and WebM audio are supported through your local FFmpeg build. Corrupt, encrypted or unsupported codecs are rejected. Each file is limited to 100 MiB and two hours. Conversion and inference have finite deadlines and can be cancelled. The full transcript is staged before one save; failure keeps the previous transcript and the selected file available for retry. Importing the same bytes again into the same meeting does not duplicate the transcript.

The service uses private temporary files and removes only its own import directory. Audio is not sent to an AI provider or stored with the meeting. Temporary decoded audio can use about 230 MiB for a two-hour file, in addition to the original upload.

## Run Electron

```sh
npm install
npm run dev:desktop
```

This builds the shared frontend and service, then launches Electron. The Electron main process starts its own service at `http://127.0.0.1:4310`. It refuses an occupied port rather than trusting content from an unknown listener. Stop a separate development service before launching Electron. The renderer is sandboxed, has no Node integration, and cannot open arbitrary windows or navigate to external pages. The native Swift client can connect to the service owned by Electron.

To build a local development application directory:

```sh
npm run build:desktop
```

macOS builds use an ad-hoc signature, not a keychain distribution identity. Distribution signing, notarization, automatic updates, and bundling Hex are not configured.

## Run the browser workspace

```sh
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the same local service. Run only one service on port 4310 at a time.

## Run native macOS

Keep the service running with `npm run dev:service`, or leave Electron running. Then run `npm run dev:macos` to package and open the native app. The native client uses the same loopback API. See [`apps/macos`](apps/macos) for its native entry points. `npm run build:macos` compiles it, `npm run package:macos` creates the local `.app` without launching it, and `npm run test:macos` runs its tests.

The SwiftUI app is a separate native client, not a webview wrapper. The service and Hex remain external prerequisites for that client. Launch the packaged `.app` for microphone permissions rather than relying on an unbundled `swift run` executable.

## Configure Hex and summaries

Copy `.env.example` to `.env` in the repository root. Restart the service after changing settings. The development Electron launcher and service scripts read this file. A packaged Electron app instead inherits environment variables from its launcher.

Hex is detected at `/Applications/Hex.app/Contents/MacOS/hex` on macOS, then on `PATH`. Set `HEX_BIN` to override it. The first explicit model preparation may download model files. After preparation, speech inference is local. Model and language selection are service-owned through `HEX_MODEL` and `HEX_LANGUAGE`.

**Extracted highlights** work without an LLM. They select excerpts from your notes and transcript. They are not presented as AI-generated summaries.

### Summarize with OpenCode

1. Open OpenCode V2 on this device and connect your model providers there.
2. Open a meeting's **Summary** panel in either Moss client.
3. Refresh OpenCode models, choose an agent, model, and optional variant, then select **Summarize with OpenCode**.
4. Confirm sharing the notes and transcript. Moss saves pending edits before sending them.

Moss discovers the already-running local OpenCode server using `@opencode/client`. It neither starts nor stops that server. Authentication remains in the Moss service; no OpenCode credentials or raw provider configuration reach either UI. `SUMMARY_MODEL` and a separate provider key in Moss are not needed for this path.

Agents and enabled chat models are loaded for `MOSS_OPENCODE_DIRECTORY`, defaulting to the Moss service's working directory. Set it to this repository's absolute path when launching a packaged Electron app if you want this project's configuration and bundled `.opencode/agents/moss-summary.md`. That agent is preferred when available. Other visible primary agents can also be selected. Hidden maintenance agents are excluded.

Each summary creates its own OpenCode session with tool permissions denied. Notes and transcript remain in OpenCode session history and may be sent to the selected model's provider. Deleting a meeting in Moss does not delete its OpenCode history. Manage that history in OpenCode. Generation has a 120-second budget; failures, disconnects, and service shutdown attempt to interrupt only the owned summary session. If interruption cannot be confirmed, the error says so. Completed summaries retain their agent/model attribution and original source revision.

### Ask other agents

Use **Ask another agent** in the Summary panel. Choose notes, transcript, current summary, or the whole meeting, then enter an instruction. The selected OpenCode agent/model receives that source after confirmation. Results are saved separately and can be downloaded as Markdown; original notes, transcript and summary are not replaced. Whole-meeting context and exports include previous agent results. Each meeting keeps at most 50 results.

Project profiles include `moss-summary`, `moss-reviewer` and `moss-editor`. Other visible primary/all agents from your server can be selected. Subagent-only profiles cannot be used as primary sessions through OpenCode's V2 API. These text tasks deny all tools.

### Google Drive MCP

Open **Google Drive MCP**, refresh connections, and explicitly choose the server that provides your Google Drive tools. Moss lists public MCP names/statuses, not credentials. If needed, enter your trusted provider's HTTPS MCP endpoint to add a runtime connection. Moss does not invent an endpoint or supply a Google account. Runtime additions may need permanent configuration in OpenCode after restart.

Finish OAuth in OpenCode's `/mcps` screen, then refresh in Moss. For existing servers, set `codemode: false` so native MCP tools are exposed. Newly added servers use that setting. A permanent V2 configuration has this shape, replacing the example URL with your provider's real endpoint:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "moss-drive": { "type": "remote", "url": "https://YOUR_PROVIDER/mcp", "codemode": false }
    }
  }
}
```

For export, choose `moss-drive` or another Drive-capable agent in the OpenCode selectors, select the source and optional Drive folder ID, and confirm **Hand off Markdown to Drive**. This creates an OpenCode export session. It is shown as **submitted, not confirmed exported**. Open that session in OpenCode, approve each selected MCP tool action, and verify the resulting file. Retrying creates another task and may produce duplicate files.

Export sessions deny Code Mode, direct HTTP through Code Mode, shell, local edits and other MCP servers. Only the selected server's normalized MCP actions can request approval. Moss's text-only profiles are rejected for Drive export. Server additions are checked against existing names, but OpenCode's API has no atomic add-if-absent operation; avoid simultaneous changes to the same name from another client.

### Local exports

The meeting toolbar exports Markdown, plain text or JSON. Markdown includes original notes, summary attribution, transcript and agent results. JSON preserves the complete meeting representation. Agent outputs can also be downloaded individually as Markdown.

Alternatively, point `SUMMARY_BASE_URL` to an OpenAI-compatible local endpoint, such as `http://127.0.0.1:11434/v1`, and set `SUMMARY_MODEL` to a model you already have. Moss does not install or start an LLM. Remote endpoints on this separate path require HTTPS and `SUMMARY_ALLOW_REMOTE=true`. That opt-in sends notes and transcript text, not audio, to the configured provider.

## Keep the Hex integration aligned

[`oc-port-agent.json`](oc-port-agent.json) tracks selected SDK, local API and transcription behavior on Anomaly Hex's `dev` branch using your [OC port tool](https://github.com/kyeshmz/oc-port-agent). The baseline is a pinned observation, not a claim of full parity. The policy preserves Moss's service ownership and both clients; it cannot rewrite unrelated UI or merge updates automatically.

The **Hex upstream** GitHub workflow runs a daily, model-free drift check. Run it manually with `mode=sync` to propose a tested draft PR. Before sync, configure the `OC_PORT_API_KEY` repository secret and `OC_PORT_MODEL` repository variable using a model available to that provider. Set `OC_PORT_API_KEY_ENV` for external providers, such as `OPENAI_API_KEY`; it defaults to `OPENCODE_API_KEY`. `OC_PORT_GITHUB_TOKEN` is optional when the normal workflow token can publish PRs. No provider or GitHub credentials are committed.

The pinned OC port Action currently has a moderate advisory in its `fast-uri` build-tool dependency. It is separate from Moss's application dependency tree. The scheduled check reads only the committed trusted policy; review upstream tool updates and proposed changes before enabling credentialed sync.

OC port checks source compatibility. It does not install or automatically update your native Hex application. Keep that executable updated through Hex's own distribution. Real speech inference is not verified by the model-free check or unit tests.

## Privacy and limits

- Recording starts only from an explicit action. Get all participants' consent first.
- The first version captures the microphone, not the other participants' system audio. No automatic joining, calendar integration, or speaker diarization is implemented.
- WAV chunks go to the loopback service and then the local Hex helper. The service does not retain raw audio. Clients retain failed chunks for explicit retry or discard while they are open.
- Notes and transcripts are stored unencrypted on the local disk. The default macOS directory is `~/Library/Application Support/Moss/meetings`. Linux uses `$XDG_DATA_HOME/Moss/meetings` or `~/.local/share/Moss/meetings`. Windows uses `%LOCALAPPDATA%/Moss/meetings`. Set `MOSS_DATA_DIR` to isolate data.
- Unsaved browser/Electron drafts have bounded, validated local-storage recovery. Native drafts use `~/Library/Application Support/Moss/NativeDrafts/drafts.json`, separate from meeting storage. Recovery copies are also unencrypted. Storage failures remain visible. Conflicting edits pause saves until you explicitly confirm replacing the edited fields.
- The service binds only to `127.0.0.1`. It validates Host, browser Origin, and the custom client header. It is not a multi-user or remotely exposed server. Other local programs running as your user are trusted.
- Requests are bounded. Audio must be 16-bit PCM WAV, at most 16 MiB and 120 seconds per chunk. Clients use shorter chunks. Notes and imported transcripts accept at most 200,000 characters. AI summaries reject inputs over 120,000 characters instead of silently truncating them.
- Exported Markdown contains your meeting text. Treat exports as private data.

## Verify

```sh
npm run check
npm test
npm run build
npm run build:macos
npm run test:macos
npm run verify
```

The integration harness uses a private build snapshot, disposable data, an isolated Electron profile, and an automatically selected free loopback port. It never reuses an existing app or records the microphone. Its light/dark screenshots and receipts remain in `.artifacts/verification/`. Runtime and cleanup are bounded. Set `MOSS_VERIFY_PORT` only when deliberately reserving a specific free port. `MOSS_PORT` is an advanced service/host override; the native client and Vite development proxy use the standard port 4310.

Unit tests inject a transcriber at the Hex boundary and do not prove native inference. Actual microphone permissions and speech recognition require a separate consented test with Hex installed.

The project verification guide lives at `.opencode/skills/verify-moss/SKILL.md`. Update its feature map when user paths or proof requirements change.
