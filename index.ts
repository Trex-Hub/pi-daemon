import { GatewayAuth } from "./src/auth.js";
import { DiscordTransport } from "./src/discord.js";
import { resolveChannelDirectory } from "./src/routing.js";
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

transport.onMessage((message) => {
  const dir = resolveChannelDirectory(state.config, state.routing, message.chatId, message.category, message.channelName);
  saveState(state).catch((err) => console.error("[state] save failed:", err));
  sessions.getOrCreate(message.chatId, dir);
  sessions.sendPrompt(message.chatId, message.content);
});

await transport.connect();
console.log("pi-gateway: connected");
