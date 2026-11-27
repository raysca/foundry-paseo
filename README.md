# Foundry on Paseo

Foundry is a [Paseo](https://github.com/getpaseo/paseo) plugin that adds a product workflow on top of
Paseo's agents: features with specs, plans and task graphs you approve (loop 1), a deterministic task
loop of builder, checks and reviewer (loop 2), and a project manager agent over both.

It runs on upstream Paseo with no core patches, and it duplicates nothing Paseo already does:

- worktrees are Paseo workspaces, and setup, teardown and checks are the project's `paseo.json` scripts;
- roles come from Paseo agent profiles named `foundry-builder`, `foundry-reviewer`, `foundry-planner`
  (optional, falls back to `foundry-pm`) and `foundry-pm`;
- concurrency, terminals, notifications and settings are Paseo's.

Foundry owns only the workflow: features, specs, requirements, the task graph, issues, attempts,
SHA-bound reviews, cards and the ledger, in a SQLite store inside the plugin process.

The behaviour spec and the milestone plan live in the project's Claude Docs. This repo is built
milestone by milestone; Milestone 1 is a thin vertical slice of both loops and the PM.

## Layout

| Path | What |
| --- | --- |
| `plugin/` | The Paseo plugin (`paseo-plugin.json`, server and client entries) |
| `plugin/server/core/` | Host-independent core: model, store, setup check, runtime. Never imports Paseo |
| `plugin/server/adapter/` | The only code that knows Paseo's SDK: workspaces, agents, scripts, hooks, tools |
| `plugin/shared/` | Plugin RPC and settings shared by server and client |
| `plugin/client/` | Screens inside Paseo's app |
| `plugin/test/` | Unit tests (`node --test`) |
| `e2e/` | A real Paseo daemon, the scripted harness and the Shout fixture repo |

## Develop

```sh
cd plugin && npm install
npm run typecheck
npm test
```

End to end, against a real Paseo 0.18 daemon on its own home and port (needs zsh, git, python3):

```sh
(cd e2e && npm install) && (cd e2e/scripted-harness && npm install)
bash e2e/smoke.sh                 # scripted harness, as CI runs it
HARNESS=claude bash e2e/smoke.sh  # real Claude Code, on a Mac
bash e2e/loop2.sh                 # loop 2: two tasks through checks, review, a question and accept
```

## Install on your own Paseo

```sh
cd plugin && npm install
paseo plugin install "$PWD"
```

Then open Settings → Foundry in Paseo. The setup check lists anything missing (role profiles, a
provider that leaves Paseo's orchestration tools on, MCP injection off, a daemon shell that isn't zsh)
and how to fix it.
