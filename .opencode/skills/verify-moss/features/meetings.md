# Meeting library

## Sub-features

Create, select, search, rename, persist, and explicitly delete a meeting.

## How to get to it (user POV)

Use `Create your first meeting` in the empty state or `New meeting` in the sidebar. Select a meeting in the `Meetings` navigation region. Use `Search meetings` to filter. Use the `Delete meeting` button and confirmation dialog to remove it.

## Driving it with Playwright Electron

Run `npm run verify`. The harness fills `Meeting title` and `My notes`, checks the saved file and public API, filters the library, relaunches the app, and confirms the same meeting remains. It deletes only the fixture through the visible confirmation. `receipts.txt` and the empty/restored screenshots retain proof.

## Gotchas

The service is the only meeting-file writer. A list render alone does not prove persistence. Native SwiftUI has corresponding entry points, but its visual interactions are not covered by the Electron drive.
