# Working on Foundry

- The behaviour spec is the source of truth for what Foundry does. Error codes in CAPS are names the
  UI and agents react to: keep them stable.
- Plugin only, on upstream Paseo. Never patch or fork Paseo. If Paseo lacks something, work around it
  in `plugin/server/adapter/` and note it as an upstream ask in the PR.
- No duplication of Paseo: use `paseo.json` scripts, Paseo workspaces, terminals, profiles,
  notifications and settings. Do not add a Foundry setting for something Paseo already configures.
- `plugin/server/core/` never imports `@getpaseo/*`. It talks to the host through `core/host.ts`.
- Every issue status change goes through `Store.setIssueStatus` (transition rules plus an event with
  its actor). Multi-row changes that must be all-or-nothing go through `Store.tx`.
- Reviews and approvals are SHA-bound: an action names the SHA it was read at and is refused if it moved.
- Tests: `cd plugin && npm run typecheck && npm test`. The real-daemon smoke test is `bash e2e/smoke.sh`.
