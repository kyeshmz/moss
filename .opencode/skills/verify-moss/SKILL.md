---
name: verify-moss
description: Verify Moss's Electron meeting workspace and shared local API with isolated data, public UI interactions, persistence checks, and retained screenshots. Use after meeting, draft, transcription, summary, or desktop appearance changes.
---

# Verify Moss

## Launch

From the repository root, run `npm run verify`. The harness builds a private Electron snapshot, chooses a free loopback port, creates an isolated profile and meeting directory, and launches its own application. It checks `/api/health` before driving the UI. Successful completion prints `Verification passed. Evidence:` followed by the exact run directory under `.artifacts/verification/`.

Do not drive another agent's running instance. Do not reuse the default port or existing user profile. `MOSS_VERIFY_PORT` is optional and must name a free port; the harness refuses an occupied one. The normal application uses port 4310, while isolated verification selects its own port.

## Doctor

For a manually launched standard Moss instance, `npm run doctor` performs a read-only health request with `X-Moss-Client: 1`. It validates the name and API version, reports the Hex state, and never reads meeting content. Do not treat a healthy name as authorization to drive an unknown process.

The isolated harness performs the equivalent read-only check against its own selected port and records the result in `receipts.txt`. It also verifies Electron's sandbox, context isolation, and disabled renderer Node integration. `npm run check` validates source typing before a drive.

## Drive

`scripts/verify.ts` uses the installed Playwright Electron API. It launches only its own snapshot and uses accessible controls, not hidden application setters.

- Choose `Create your first meeting` or `New meeting`.
- Fill the `Meeting title` and `My notes` textboxes. Observe exact saved values through the public API and private meeting file.
- Choose `Import text`, fill `Transcript text`, then choose `Add transcript`.
- Open the `Summary` tab and choose `Extract highlights`.
- Refresh OpenCode models and inspect the public catalog. The harness separately simulates the owned renderer's provider boundary to check agent/model/variant selection, confirmation cancellation, consented request encoding, and visible failure without live inference.
- Use the sharing helper to verify agent follow-ups, Drive handoff disclosure and audio-drop consent against isolated HTTP boundary fixtures. Download real JSON and plain-text exports and compare canonical content. These fixtures do not prove real provider, OAuth, Drive or Hex behavior.
- Choose `Export`. The actual downloaded Markdown must match the API export byte for byte.
- Fill the `Search meetings` searchbox and confirm the library filters correctly.
- Close and relaunch the owned Electron app. Confirm persisted title, notes, and transcript.
- Choose `Delete meeting`, then confirm `Delete meeting` in the dialog. Only the disposable fixture is removed.

The harness also submits a second client's edit through the public API to prove a stale title-only save preserves remote notes. An injected HTTP save outage and a mocked native dialog response exercise cancelled quit and retry. Those controlled boundary simulations are not proof of real native dialog appearance or live inference.

For shutdown draining, the harness leaves an invalid JSON array request unfinished, quits twice, and observes that both quit events remain prevented while cleanup is pending. Completing the request must permit a normal exit. This fixture neither creates a meeting nor prepares Hex.

## Evidence

Each run retains its own directory under `.artifacts/verification/`.

- `receipts.txt` records observed outcomes and any failure.
- `owned-process.json` records the exact owned PID, profile, and data directory.
- `01-empty.png`, `02-meeting.png`, `02-meeting-dark.png`, `02-meeting-narrow.png`, and `03-restored.png` capture the real renderer.
- `02-opencode-confirmation.png` captures the disclosure and controlled provider-error state. It is UI boundary evidence, not live inference proof.
- `02-sharing-handoff.png`, `ui-export.json` and `ui-export.txt` retain sharing UI and real local export evidence. See the sharing feature guide for fixture limits.
- `ui-export.md` is the actual UI download. `meeting-export.md` is the independently retrieved comparison.
- `failure.png` and `failure-dom.txt` are saved when a readable failed window exists.

Screenshots do not prove interactions. Keep the corresponding receipts and persistence checks. OpenCode's source tokens and dimensions are the appearance reference. Do not claim pixel-perfect parity or native caption alignment from a renderer screenshot.

## Cleanup

The harness closes only its own Electron process and service, then checks its selected port is free. It confirms the leave dialog only for its disposable profile. Shutdown has a 15-second bound, and the isolated app has a 90-second watchdog. Forced cleanup makes the run fail; it is not successful behavior proof.

Never kill by process name, close other browser sessions, or delete real meeting files. Evidence and the disposable profile remain after teardown. Do not delete them as routine cleanup. A separately backgrounded older run remains separately owned and must not be polled or stopped unless the active task authorizes it.

## Helpers

- `npm run check` checks TypeScript.
- `npm test` runs shared-service/core and web regressions.
- `npm run test:macos` builds and tests the Swift package without launching it.
- `npm run verify` performs the isolated Electron drive and cleanup.
- `npm run doctor` inspects a deliberately launched standard service.

No global browser CLI or browser download is required. The harness uses the workspace's Electron and Playwright dependencies. Real microphone recording requires explicit participant consent, microphone permission, and a separately installed Hex executable. It is never part of this unattended drive.

Maintain `features/` when user paths, selectors, or proof requirements change.
