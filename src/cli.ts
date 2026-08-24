#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { defaultState, loadState, saveState } from "./state.js";

const PM2_NAME = "pi-gateway";

function daemonScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

function pm2(args: string[]): number {
  const result = spawnSync("pm2", args, { stdio: "inherit" });
  if (result.error) {
    console.error(`pm2 not found — install it first: npm install -g pm2 (${result.error.message})`);
    return 1;
  }
  return result.status ?? 1;
}

async function promptInstall(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const state = await loadState().catch(() => defaultState());

  try {
    const discordToken = await rl.question("Discord bot token: ");
    const adminUserId = await rl.question("Admin Discord user id: ");
    const projectsRoot = await rl.question(`Projects root path [${state.config.projectsRoot}]: `);

    state.config.discordToken = discordToken.trim() || state.config.discordToken;
    state.config.adminUserId = adminUserId.trim() || state.config.adminUserId;
    state.config.projectsRoot = projectsRoot.trim() || state.config.projectsRoot;
  } finally {
    rl.close();
  }

  await saveState(state);
  console.log("state written, starting daemon via pm2");
  pm2(["start", daemonScript(), "--name", PM2_NAME]);
}

const COMMANDS = new Set(["start", "stop", "restart", "status", "logs", "install"]);

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || !COMMANDS.has(command)) {
    console.log("usage: pi-gateway <start|stop|restart|status|logs|install>");
    process.exitCode = command ? 1 : 0;
    return;
  }

  if (command === "install") {
    await promptInstall();
    return;
  }

  const pm2Args: Record<string, string[]> = {
    start: ["start", daemonScript(), "--name", PM2_NAME],
    stop: ["stop", PM2_NAME],
    restart: ["restart", PM2_NAME],
    status: ["describe", PM2_NAME],
    logs: ["logs", PM2_NAME],
  };

  process.exitCode = pm2(pm2Args[command]);
}

main();
