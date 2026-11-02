# Summaries and Markdown export

## Sub-features

Extractive highlights, OpenCode agent/model summaries, optional OpenAI-compatible summaries, stale-summary reporting, and Markdown download with provenance.

## How to get to it (user POV)

Open `Summary` and choose `Extract highlights`. Configured AI is a separate opt-in action with confirmation. Choose `Export` in the meeting toolbar for Markdown.

For OpenCode, open the desktop app on this device, then use `Refresh OpenCode models`. Choose `OpenCode agent`, `OpenCode model`, and optional `OpenCode variant`. Choose `Summarize with OpenCode` and review the confirmation. Its selection is captured before the dialog opens. Notes and transcript remain in OpenCode history and may reach the selected provider. Cancellation sends no generation request.

## Driving it with Playwright Electron

`npm run verify` extracts highlights from real user-entered fixture text, checks kind and source revision, and downloads Markdown through the UI. Its download is compared byte for byte with an independent export API request. Provider-consent tests prove no remote request occurs without explicit environment opt-in.

The harness reads the real OpenCode catalog through its owned Moss service without generating. It then intercepts only its owned renderer's catalog/summary HTTP boundary for deterministic selector, confirmation, cancellation, exact request-body, and provider-error checks. `02-opencode-confirmation.png` retains the visible failure and disclosure. The fixture never calls a provider. After removing interception, the harness refreshes and checks the live selector options when a server is available.

`apps/service/test/opencode-summary.test.ts` separately drives the real generated OpenCode client against an isolated HTTP server. It proves catalog filtering, secret stripping, consent/selection validation, all-tools-denied session creation, asynchronous prompt/wait/completed-text retrieval, model identity checks, timeout/cancellation/shutdown interruption, and concurrent-edit revision safety. Web and native tests cover save-before-send and conflict blocking.

## Gotchas

Extracted highlights are excerpts, not AI. A changed revision makes an old summary stale. No real AI provider is required or exercised by the unattended harness. OpenCode summaries require per-request confirmation; a local OpenCode server does not imply local model inference. The separate OpenAI-compatible path requires HTTPS and environment opt-in for remote providers. Deleting a Moss meeting does not remove its OpenCode sessions. Native picker and alert interactions remain manual checks.
