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
bash e2e/loop2.sh                 # loop 2: two tasks through checks, review, a question and accept; PM chat and a card
bash e2e/loop1.sh                 # loop 1: idea to approved task list, its tasks, Verify, then Ship by local merge
bash e2e/exit.sh                  # M1 exit test: loop 1 with a spec edit during Build, through Verify and Ship
bash e2e/ui.sh                    # the same scenario clicked through Foundry's screens in Paseo's web app (needs Playwright)
```

## Install on your own Paseo

```sh
scripts/install-local.sh          # install, or update and reload after you pull
scripts/install-local.sh --pull   # git pull --ff-only first
```

It installs the plugin's dependencies, type-checks, then installs Foundry into your running Paseo
(or reloads it if it's already there) and waits until Paseo reports it running. `PASEO_HOME` picks a
daemon home other than `~/.paseo`. Paseo runs the plugin from this checkout, so keep it in place.

Foundry appears in Paseo's sidebar. On a first install it opens on a welcome guide:

1. **Set up your agents** (required). For each of Foundry's profiles (builder, reviewer, planner, project
   manager) pick a harness and a model from what Paseo has on this machine. Continue adds only the
   missing profiles to Paseo's settings, plus a `foundry-<harness>` provider that hides Paseo's own agent
   tools from Foundry's agents. Existing profiles are never changed.
2. **Pick a project** from your Paseo projects. The first time, Foundry says what it will do in that repo
   and waits for your yes.
3. **Start a first feature.**

Then: the features overview, a feature's docs and approvals, the review panel for each task, Verify and
Ship, and the project manager's chat with its cards. After an update, a one-time What's new card lists
the changes; a change to how Foundry acts on your code waits for Got it before those actions run. If its
database can't be opened or upgraded, Foundry changes nothing and starts in safe mode, naming the backup.

To uninstall, use Settings → Foundry → Before you uninstall, or the script. Uninstalling on its own
deletes nothing, so reinstalling picks up where you left off:

```sh
scripts/uninstall-local.sh           # list what Foundry left behind, then remove the plugin
scripts/uninstall-local.sh --purge   # first stop its work, remove the profiles it added that nobody changed,
                                     # and delete its data (a final copy is kept beside the folder)
```

Branches in your repos are never deleted, and Foundry's providers stay in Paseo's settings (a plugin
can't delete them).

To test onboarding from scratch (development installs only):

```sh
scripts/dev-reset.sh             # show what a reset would remove
scripts/dev-reset.sh --yes       # archive Foundry's workspaces, remove foundry-* profiles, empty its data (copied to /tmp), reload
scripts/dev-reset.sh --sandbox   # a separate throwaway Paseo daemon with a fresh Foundry; your Paseo is untouched
```

Foundry keeps its data in `~/.foundry-paseo/foundry.db` (`FOUNDRY_HOME` moves it). It refuses a database that another program made, such as the older Go Foundry's `~/.foundry`, rather than change it.

The setup check lists anything missing (role profiles, a
provider that leaves Paseo's orchestration tools on, MCP injection off, a daemon shell that isn't zsh)
and how to fix it.
