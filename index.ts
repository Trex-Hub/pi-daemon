import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayAuth } from "./src/auth.js";
import { DiscordTransport } from "./src/discord.js";
import { lookupChannelDirectory, mapChannel } from "./src/routing.js";
import { SessionManager } from "./src/session.js";
import { loadState, saveState } from "./src/state.js";
import { StreamRouter } from "./src/streaming.js";

const state = await loadState();

const transport: DiscordTransport = new DiscordTransport(
  state.config.discordToken,
  new GatewayAuth(
    state,
    (code, username) => console.log(`[auth] challenge code for ${username}: ${code}`),
    (message, level = "info") => console.log(`[auth:${level}] ${message}`),
    () => {
      saveState(state).catch((err) => console.error("[state] save failed:", err));
    }
  )
);

const streaming = new StreamRouter(transport);

const sessions = new SessionManager({
  notifyCrash: state.config.notifyOnCrash,
  onCrash: (channelId) => {
    transport
      .sendMessage(channelId, "pi session crashed, will restart on your next message")
      .catch((err) => console.error("[session] crash notice failed:", err));
  },
  onEvent: (channelId, event) => {
    streaming.handleEvent(channelId, event).catch((err) => console.error("[streaming] event handling failed:", err));
  },
});

setInterval(() => sessions.reapIdle(), 60_000);

// Channels an unmapped-channel confirm prompt has already been posted for, so we don't
// re-post it on every subsequent message while the user hasn't responded yet (008).
const pendingConfirm = new Set<string>();

const MAP_COMMAND = /^\/pi map (\S+)\/(\S+)$/i;

function persistMapping(channelId: string, category: string, channelName: string, reply: (text: string) => Promise<void>) {
  mapChannel(state.config, state.routing, channelId, category, channelName)
    .then((dir) => {
      sessions.drop(channelId);
      pendingConfirm.delete(channelId);
      saveState(state).catch((err) => console.error("[state] save failed:", err));
      return reply(`Mapped to ${dir}`);
    })
    .catch((err) => {
      console.error("[routing] mapping failed:", err);
      reply(`Failed to map: ${(err as Error).message}`).catch(() => {});
    });
}

transport.onMessage((message) => {
  const mapMatch = message.content.match(MAP_COMMAND);
  if (mapMatch) {
    const [, category, channelName] = mapMatch;
    persistMapping(message.chatId, category, channelName, (text) => transport.sendMessage(message.chatId, text));
    return;
  }

  const dir = lookupChannelDirectory(state.routing, message.chatId);
  if (dir) {
    sessions.getOrCreate(message.chatId, dir);
    sessions.sendPrompt(message.chatId, message.content);
    return;
  }

  if (state.ignoredChannels.includes(message.chatId)) return;

  mkdtemp(join(tmpdir(), "pi-gateway-"))
    .then((ephemeralDir) => {
      sessions.getOrCreate(message.chatId, ephemeralDir);
      sessions.sendPrompt(message.chatId, message.content);
    })
    .catch((err) => console.error("[session] ephemeral spawn failed:", err));

  if (!pendingConfirm.has(message.chatId)) {
    pendingConfirm.add(message.chatId);
    transport
      .sendConfirm(message.chatId, message.category, message.channelName)
      .catch((err) => console.error("[discord] confirm prompt failed:", err));
  }
});

transport.onButtonAction((action) => {
  if (action.action === "create") {
    persistMapping(action.channelId, action.category ?? "ungrouped", action.channelName, action.reply);
    return;
  }

  if (action.action === "attach") {
    action.reply("Reply with `/pi map <category>/<channel>` in this channel to attach an existing folder.").catch(() => {});
    return;
  }

  state.ignoredChannels.push(action.channelId);
  sessions.drop(action.channelId);
  pendingConfirm.delete(action.channelId);
  saveState(state).catch((err) => console.error("[state] save failed:", err));
  action.reply("Ignored — this channel won't spawn a session.").catch(() => {});
});

await transport.connect();
console.log("pi-gateway: connected");
