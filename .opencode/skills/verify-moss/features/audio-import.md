# Audio file imports

## User path

Create or open a meeting. Drop one local sound file into `Import audio file`, or use `Choose audio file`. A drop only stages the selection. Prepare Hex, confirm participant permission, then choose `Transcribe audio file`. Cancel or retry explicitly; failures keep the selected original file available. Files are limited to 100 MiB and two hours. Common supported containers are listed in health; corrupt and encrypted media may fail.

## Automated proof

`npm test` runs synthetic real-FFmpeg codec, segmentation, duration, temporary-file, cancellation and deadline tests in `apps/service/test/audio-import.test.ts`. Inference is injected, not real Hex. Public-route tests verify consent, all-or-nothing persistence and content-hash retry deduplication. Browser API tests verify raw bytes and encoded filename/consent headers. Swift tests cover bounded file selection, stable retry bytes, cancellation and readiness guards.

`npm run verify` dispatches an actual DOM file-drop event in its owned Electron window. It simulates only the health/upload HTTP boundary, asserts no request before confirmation, and observes selected-file retention on failure. It never prepares or runs Hex. Retain the receipts; the UI fixture is not native inference proof.

## Limits

FFmpeg is an external prerequisite, not bundled. Uploaded audio is temporarily decoded on disk in a private owned directory and removed after processing. A cancelled SDK request must stop its own helper; fake transcribers do not prove native cancellation. Only an explicit hardware/inference check can establish real speech accuracy.
