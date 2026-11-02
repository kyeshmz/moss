# Meeting API

The Node service is the sole owner of meeting files and speech inference. React and SwiftUI clients share these HTTP operations. TypeScript consumers import public types from `@moss/contracts`. Swift decoding tests use `fixtures/meeting.json` to check the wire representation.

Base URL is `http://127.0.0.1:4310/api`. Include `X-Moss-Client: 1` on every API request. JSON requests use `Content-Type: application/json`. Error responses have a non-2xx status and `{ "error": "message" }`.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/health` | None | `Health`, including API version and Hex preparation status. |
| POST | `/engine/prepare` | `{}` | `Health` after local model preparation. |
| GET | `/meetings` | None | `Meeting[]`, newest updated first. |
| POST | `/meetings` | `{}` | A new empty `Meeting`. |
| PATCH | `/meetings/:id` | Changed fields and matching saved values in `expected`. | The updated `Meeting`, or HTTP 409 on a conflict. |
| DELETE | `/meetings/:id` | None | `{ok: true}`. |
| POST | `/meetings/:id/audio` | Raw 16-bit PCM WAV. | The updated `Meeting`. |
| POST | `/meetings/:id/transcript` | `{text: string}` | The updated `Meeting`. |
| POST | `/meetings/:id/summary` | `{kind: "extractive" \| "ai"}` | The updated `Meeting`. |
| GET | `/meetings/:id/export` | None | `text/markdown`. |

Audio requests require `Content-Type: audio/wav`, `X-Chunk-Id` with a stable UUID, and `X-Start-Ms` with a nonnegative integer offset. Retry an unacknowledged chunk with the **same** UUID. A successful retry does not duplicate stored text. Submit chunks sequentially and bound the client's pending audio. Keep failed audio available for an explicit retry or discard.

`revision` changes when meeting content changes. A summary with a different `sourceRevision` is stale. Summary generation reads the meeting once and updates only the summary, so later user notes remain intact. Clients should keep local editor drafts separate from server snapshots while saves are pending.

Edit only changed fields. For example, `{ "title": "New title", "expected": { "title": "Previous title" } }` changes a title without resubmitting stale notes. A notes edit requires `expected.notes` with its saved base. The service compares edited fields atomically and returns HTTP 409 without writing when a base differs. Preserve the draft and ask the user before refreshing its base to replace conflicting fields. Never auto-retry a conflict with freshly fetched preconditions.

Timestamps are ISO 8601 strings, audio offsets and durations are milliseconds, IDs are UUID strings, and a missing summary is JSON `null`. Imported text has no measured audio duration and uses `durationMs: 0`. The fixture is test material, never automatically inserted into user storage.

Loopback access is for local applications belonging to the same trusted OS user. This API is not an authenticated network service. Do not expose it through a public interface or tunnel.
