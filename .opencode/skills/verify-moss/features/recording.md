# Microphone recording

## Sub-features

Explicit consent, local model preparation, microphone-only capture, bounded WAV chunks, stop, retry, recovery download, and confirmed discard.

## How to get to it (user POV)

Install Hex separately and restart the service. Choose `Prepare speech model`. After the local engine is ready, check participant consent and choose `Start recording`. Use `Stop recording`, retry retained audio, download pending WAVs, or explicitly confirm discard.

## Driving it with Playwright Electron

The unattended harness never records. `npm test` exercises WAV encoding, worklet chunking, queue limits, stable retry UUIDs, request deadlines, and microphone-resource cleanup through controlled boundaries. `npm run test:macos` tests the native PCM ledger and HTTP shape. A manual hardware run needs participant consent before using the real controls.

## Gotchas

Hex is not included with the npm SDK. The first preparation may download a model. Pending audio lives only in client memory unless the user downloads it. Native permissions, actual audio devices, long meeting capture, and real Hex results remain separate proof obligations. Never simulate success when Hex is unavailable.
