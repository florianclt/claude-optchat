# claude-optchat

A Claude Code plugin that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one endless chat per profile, remembered through a summary tree. It is a port of [pi-optchat](https://github.com/jonaslsaa/pi-optchat), the Pi / oh-my-pi extension, and keeps its memory format, so profiles carry over between the two.

- **Memory**: every message of every session is logged and summarized into a binary tree. Each session starts with a bounded memory view of everything before it; the agent uses `zoom` and `date` (and optionally `search`) to read the originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: an `optchat-subagent` agent that starts with the profile's memory view and can read memory.
- **Import**: bring in history from Claude Code (conversations and memories), Codex, Pi and [OMP](https://github.com/can1357/oh-my-pi), or ChatGPT.

## Install

```
/plugin marketplace add florianclt/claude-optchat
/plugin install optchat@claude-optchat
```

Restart Claude Code after installing. Requirements: Claude Code with plugin support, Node.js 22.19+ on `PATH`, and Git. Summaries are written through the `claude` command with the login Claude Code already has, so no API key is needed; they count against your Claude usage like any other request.

## Quick start

1. `/optchat:profile work` creates the profile `work` and makes it the default.
2. `/clear` to start from its memory view.
3. Chat normally. Every new session uses the last profile you picked; a resumed session keeps the profile it had.

A session's start, `/clear` and every compaction bring in the view, with a line such as `OptChat · work · 1,204 messages`. `OPTCHAT_PROFILE=personal claude` forces a profile for one run (also for `claude -p`), and `OPTCHAT_PROFILE=off` or `/optchat:profile off` gives plain Claude Code.

## Commands

| Command | Action |
| --- | --- |
| `/optchat:status` | Profile, message count, summaries waiting, compactor, worker. |
| `/optchat:profile [name\|off]` | List profiles, or switch to one (created if new). The switch applies to this session from now on and to new sessions; `/clear` to load its view. |
| `/optchat:settings [key value]` | This profile's settings, or change one. |
| `/optchat:model [model] [effort]` | Compactor model and effort, for example `/optchat:model claude-sonnet-5-5 medium`. |
| `/optchat:activity` | Memory gauge: view size against the 128 KB budget, summaries catching up, the last error. |
| `/optchat:instructions` | Shows the profile's `AGENTS.md`; Claude offers to edit it. |
| `/optchat:browse` | Writes and opens a readable HTML snapshot of memory, with search. |
| `/optchat:import …` | Import history (see below). |

## How it works in Claude Code

Pi lets an extension rebuild the model's whole context on every turn, so pi-optchat sends each turn as the view plus the new message, and nothing else. Claude Code keeps a session's messages in context and lets a plugin add context, so the port works per session:

| pi-optchat | claude-optchat |
| --- | --- |
| Each turn starts from a fresh context: view, previous exchange, new message. | Each session starts with the view (and, after `/clear` or a compaction, the previous exchange); the session's own messages stay in context until `/clear` or compaction. Use `/clear` freely: nothing is lost. |
| Pi's compaction is turned off. | Claude Code's compaction stays on, and after it the fresh view comes back in. |
| The Pi process logs messages and builds summaries. | Hooks read the session's transcript and hand new messages to a background worker per profile, the only process that writes memory. It starts when needed and exits when idle. |
| `zoom`, `date`, `search` tools. | The same tools, from the plugin's MCP server (`mcp__plugin_optchat_memory__*`). |
| Compactor through Pi's provider logins, with Anthropic cache marks. | Compactor through `claude -p` (no tools, no MCP, no settings, no CLAUDE.md), which caches the prompt on its own. The "Too long" retry is a new request that quotes the rejected line. |
| `spawn` / `tell` background subagents with levels, limits and grouped reports. | Claude Code's Agent tool with the `optchat:optchat-subagent` agent, which gets the view at launch; background agents are Claude Code's. A report is logged as `work`, and `zoom("<agent id>")` reads the subagent's chat. |

Not ported, because Claude Code has no place for them or does them itself: the Agents / Usage / Activity inspector bar and live agent view (Claude Code has its own agent and cost views; `/optchat:activity` covers the memory gauge), `tell` to a running or finished subagent, subagent levels, max active agents and grouped reports (the settings stay in `config.json` for Pi), the usage ledger, connected windows, `/complete` and `/tell-main` (two sessions on one profile simply both log into it), the tab title, and headless joining (`--optchat-connect`). Images are kept as Claude Code received them, without Pi's resizer, which is also what broke `omp install npm:pi-optchat`.

## Models

| Role | Default | Change with |
| --- | --- | --- |
| Main agent | Whatever Claude Code uses | `/model` |
| Subagents | Opus (`agents/optchat-subagent.md`) | Claude Code's Agent tool `model` |
| Compactor | `claude-sonnet-5-5`, medium | `/optchat:model` |

## Settings

`/optchat:settings` lists each setting with its value, default and what it does; `/optchat:settings <key> <value>` saves it to the profile's `config.json`.

| Setting | Default | What it does |
| --- | --- | --- |
| `previousExchange` | on | After `/clear` or a compaction, replays your last request and answer in full after the view. |
| `previousExchangeKB` | 16 | A larger last exchange is left out. |
| `memorySearch` | off | Gives the agent a `search` tool over your original messages. Applies from the next session. |
| `summaryAcceptBytes` | 640 | The compactor is asked for 512-byte lines; a longer line up to this size is kept instead of retried. |
| `importJobs` | 8 | Summaries an import builds at once, 1 to 64. |

## Subagents

Ask in plain words, for example "Spawn an optchat subagent to investigate this repository and report back", or let Claude delegate. The `optchat:optchat-subagent` agent starts with the subagent prompt from the recipe, the profile's instructions and the memory view as it is at launch, and can read memory with `zoom`, `date` and `search`. Its report is logged as `work` and ends with `Full chat: zoom("<agent id>")`, so the main agent can check it against what the subagent did.

## Import history

Run `/optchat:import` and Claude walks you through it: source (Claude Code, Claude Code memories, Codex, Pi / OMP, or a ChatGPT export), projects, an optional date range, append or rebuild, then a preview before anything starts. The steps are subcommands you can also run yourself:

```
/optchat:import scan --source claude
/optchat:import plan --source claude --project ~/code/app --after 2026-01-01
/optchat:import start --source claude --project ~/code/app --after 2026-01-01
/optchat:import status        # pause, resume, discard
```

The import runs in the background. What gets imported, duplicate handling and safety are as in pi-optchat: user messages and final replies with their original dates, marked historical; a new memory generation that replaces the old one only when the whole tree is built; the previous generation kept on disk. Claude Code sessions that ran with OptChat are skipped, since they are in memory already. Chatting in the profile pauses until the import finishes or is discarded.

## Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`), the same layout as pi-optchat: `main/` (the log), `tree/` (summaries), `view.json`, `images/`, `AGENTS.md`, `config.json`, and after an import `active-memory.json` and `memories/<id>/`. The port adds `inbox/` (messages waiting for the worker), `sessions/` (how far each session's transcript has been read), and `worker.*` (the worker's lock, status and log). Each profile folder is a local Git repository committed as memory changes; it has no remote, so it is not a backup.

To move from pi-optchat, install this plugin and use the same profile names: memory, instructions and settings carry over. Use one at a time on a profile: both write the same log, and each refuses to write while the other holds the profile.

## Development

```sh
git clone https://github.com/florianclt/claude-optchat.git
cd claude-optchat
npm ci --ignore-scripts
npm run check   # type check
npm test        # offline tests, no model calls
npm run build   # compiles src/ to dist/, which the plugin runs; commit it with the source
claude --plugin-dir .
```

## Credits and license

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem), and on Jonas Silva's [pi-optchat](https://github.com/jonaslsaa/pi-optchat), whose memory, store, prompts and import code this port reuses. `docs/victor-recipe.md` maps the recipe to the code.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
