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

## Configuration file

Settings are stored in `~/.pi/agent/gateway/state.json`. This includes the Discord token, the admin user ID, the project root path, channel-to-folder routing, and access rules. You normally do not need to edit this file directly. The install wizard and the `/pi map` command manage it for you.

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
