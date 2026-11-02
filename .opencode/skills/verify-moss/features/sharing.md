# Agent follow-ups and Google Drive MCP

## User paths

In Summary, choose a returned OpenCode agent/model, then open `Ask another agent`. Choose the content source and enter an instruction. Confirm sharing. Results are kept separately and downloadable as Markdown. Retries of the same confirmation retain the UUID; a new action gets a new UUID.

Open `Google Drive MCP`, refresh connections and explicitly identify the server that provides Drive. A supplied HTTPS endpoint can be added at runtime after confirmation. OAuth remains in OpenCode's `/mcps` screen. Runtime addition is not a persistence guarantee. New server setup uses `codemode:false`; existing servers must expose native tools too.

Choose `moss-drive` or another Drive-capable agent, select export content and optional folder ID, then confirm the handoff. The result is submitted, not a successful file upload. Open the reported OpenCode session, approve each tool action and verify the created file. Text-only Moss profiles cannot perform Drive exports. Code Mode/execute, shell, files and other servers remain denied.

## Automated proof

`apps/service/test/opencode-work.test.ts` exercises the generated OpenCode SDK against isolated HTTP fixtures. It verifies source selection, consent, private configuration stripping, native-tool ask permissions, denied Code Mode, output identity, deadlines and cleanup. `sharing-api.test.ts` verifies separate persisted results and idempotent retries. Client tests cover saving before transmission and retaining drafts on failure.

The Electron harness calls `scripts/verify-sharing.ts` inside its owned window. HTTP fixtures prove selector/confirmation/error flows, stable retry IDs, separate result rendering, consented runtime connection requests and truthful handoff status. `02-sharing-handoff.png` is fixture UI evidence, not a real Drive write. JSON/plain-text downloads are real service exports and are checked against canonical data. Markdown is independently compared byte for byte by the main harness.

## Unattended boundaries

Never run actual OAuth, configure a real MCP server, approve cloud writes, or call a paid model merely to make this check green. Native rendered dialogs and real Google provider behavior are separate proof obligations. OpenCode has no atomic add-if-absent operation, so another client must not concurrently modify the same server name.
