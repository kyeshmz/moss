# Transcripts

## Sub-features

Append imported text, display timestamps, and receive idempotent audio-chunk transcripts.

## How to get to it (user POV)

Open the `Transcript` tab. Choose `Import text` or `Add a transcript`, paste into `Transcript text`, and choose `Add transcript`.

## Driving it with Playwright Electron

`npm run verify` imports text using the dialog and observes one matching persisted segment. Imported text has no measured duration and therefore uses `durationMs: 0`. Service tests submit the same audio chunk UUID twice and assert only one stored segment and one transcriber call.

## Gotchas

The audio transcriber is injected in service tests. Those tests do not prove Hex inference. No diarization or system-audio capture is implemented. Preserve failed WAV bytes and their chunk UUID for retry.
