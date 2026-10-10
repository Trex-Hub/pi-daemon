# agent-daemon

agent-daemon connects a Discord bot to a Pi coding agent. You message the bot in a Discord channel, and it runs the agent against a project directory and replies in the channel. Each Discord channel maps to one project folder on disk.

## Requirements

- Node.js 18 or newer
- pm2, installed globally: `npm install -g pm2`
- A Discord bot token and the Discord user ID of the person who should have admin control

## Installation

1. Install dependencies and build:

```
npm install
npm run build
```

2. Run the install wizard. This asks for your Discord bot token, your admin Discord user ID, and the folder where project directories should live, then saves that as the daemon's configuration.

```
node dist/src/cli.js install
```

The wizard also starts the daemon under pm2 once configuration is saved.

3. Optionally install `agent-daemon` globally so you can run the CLI by name instead of the full path:

```
npm link
```

After this, the commands below can be run as `agent-daemon <command>` instead of `node dist/src/cli.js <command>`.

## Commands

```
agent-daemon start      start the daemon
agent-daemon stop       stop the daemon
agent-daemon restart    restart the daemon, picking up new config or code
agent-daemon status     show whether the daemon is running
agent-daemon logs       tail the daemon's logs
agent-daemon install    run the setup wizard
```

## Mapping a channel to a project

When you message the bot in a channel it doesn't recognize, it starts an ephemeral session so you get a reply right away, and asks whether to create a new project folder or attach the channel to an existing one.

You can also map a channel manually by sending this in the channel:

```
/pi map <category>/<channel-name>
```

This creates (or attaches to) a folder at `<projects-root>/<category>/<channel-name>` and routes all future messages in that channel there.

## Slash commands

Registered per-guild on connect (Discord dedups by name, so this is safe on every restart):

- `/stop` — aborts the channel's current turn.
- `/model set provider:<provider> model:<model-id>` — switches the model for the channel's session. `/model list` shows what's available.
- `/continue` — resumes the agent invisibly (no prompt text the LLM sees) after an aborted or failed turn. Only registered when [`pi-invisible-continue`](https://github.com/monotykamary/pi-invisible-continue) is installed on this host (`pi install npm:pi-invisible-continue`) — gated via `src/pi-packages.ts`, which checks `~/.pi/agent/settings.json`'s `packages` list. The same gate is meant to be reused for future pi-package-backed commands (e.g. pi-llm-wiki).

All three require the same channel authorization as regular messages.

## Attachments

Attachments work only in mapped channels. The daemon accepts opaque files up to 10 MiB total per message (up to five files), downloads them to `<project>/uploads/`, and tells Pi their paths. Uploads are retained; cleanup is intentionally not implemented yet.

To send one generated file back, Pi ends its response with a line like `[[discord-file:report.pdf]]`. The file must be a regular file under the project, outside dot-directories, and no larger than 10 MiB.

## Configuration file

Settings are stored in `~/.pi/agent/gateway/state.json`. This includes the Discord token, the admin user ID, the project root path, channel-to-folder routing, and access rules. `config.allowedChannels` restricts which channel ids the bot will respond in — defaults to `["*"]` (all channels). You normally do not need to edit this file directly. The install wizard and the `/pi map` command manage it for you.

## Running at startup on your machine

To have the daemon start automatically when you log in:

```
pm2 startup
pm2 save
```

`pm2 startup` prints a command you need to run once with `sudo`. `pm2 save` freezes the current list of running processes so pm2 restores them on the next login.

## Development

```
npm run typecheck   check types without building
npm test            run the test suite
npm run lint        check code style
```
