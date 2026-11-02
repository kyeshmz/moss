# Notes, recovery, and conflicts

## Sub-features

Autosave, explicit retry, bounded draft recovery, field-level edit preconditions, and confirmed conflict replacement.

## How to get to it (user POV)

Edit `Meeting title` or `My notes`. Observe the save status. A failed save shows `Retry save`. A conflicting save shows `Resolve conflict…` and requires explicit replacement confirmation. Browser recovery failures show a visible storage error.

## Driving it with Playwright Electron

`npm run verify` edits notes, observes exact persisted content, submits a second client's note edit through the public API, and confirms a stale title-only UI save does not overwrite that note. It injects a temporary HTTP save outage, cancels quit at the native confirmation boundary, verifies the service stays alive, and retries the retained draft. Web and Swift tests separately prove same-field conflicts, replacement races, draft recreation, and invalid storage behavior.

## Gotchas

Do not silently refresh a dirty field's saved base before a retry. A conflict is not an ordinary transient error. Draft recovery is unencrypted and distinct from the canonical meeting file. Pending audio is not durable draft data.
