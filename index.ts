import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAttachments, resolveOutboundFile } from "./src/attachments.js";
import { GatewayAuth } from "./src/auth.js";
import { ChannelQueue } from "./src/channel-queue.js";
import { CronScheduler } from "./src/cron.js";
import { loadCronJobs } from "./src/cron-config.js";
import { DiscordTransport, type IncomingMessage } from "./src/discord.js";
import { isPiPackageInstalled } from "./src/pi-packages.js";
import { lookupChannelDirectory, mapChannel } from "./src/routing.js";
import { SessionManager } from "./src/session.js";
import { loadState, migrateState, saveState } from "./src/state.js";
import { StreamRouter } from "./src/streaming.js";

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
  process.exit(1);
});

await migrateState();
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

const describeError = (err: unknown): string => (err instanceof Error ? err.message : "Unknown error");

const sendRequestedFile = async (channelId: string, path: string): Promise<void> => {
  try {
    const dir = sessions.getDirectory(channelId);
    if (!dir) throw new Error("The Pi session is no longer available");
    const file = await resolveOutboundFile(dir, path);
    await transport.sendFile(channelId, file);
  } catch (err) {
    console.error("[attachments] outbound upload failed:", err);
    await transport
      .sendMessage(channelId, `Could not send requested file: ${describeError(err)}`)
      .catch((sendErr) => console.error("[attachments] outbound failure notice failed:", sendErr));
  }
};

const streaming = new StreamRouter(transport, (channelId, path) => sendRequestedFile(channelId, path), {
  respond: (channelId, id, payload) => sessions.respondUIRequest(channelId, id, payload),
  setAwaitingInput: (channelId, waiting) => sessions.setAwaitingInput(channelId, waiting),
});

setInterval(() => sessions.reapIdle(), 60_000);


// Channels an unmapped-channel confirm prompt has already been posted for, so we don't
// re-post it on every subsequent message while the user hasn't responded yet (008).
const pendingConfirm = new Set<string>();

const MAP_COMMAND = /^\/pi map (\S+)\/(\S+)$/i;

const queue = new ChannelQueue(async (channelId, err) => {
  console.error("[message] handling failed:", err);
  await transport
    .sendMessage(channelId, `Could not process message: ${describeError(err)}`)
    .catch((sendErr) => console.error("[message] failure notice failed:", sendErr));
});

const handleMappedPrompt = async (message: IncomingMessage, dir: string): Promise<void> => {
  let paths: string[] = [];
  if (message.attachments.length > 0) {
    transport.sendTyping(message.chatId).catch((err) => console.error("[attachments] typing indicator failed:", err));
    paths = await downloadAttachments(dir, message.attachments);
  }

  const pathBlock = paths.length > 0 ? `\n\nAttached files:\n${paths.map((path) => `- ${path}`).join("\n")}` : "";
  const prompt = message.content || "Please inspect the attached files.";
  const preview = message.content || message.attachments.map((attachment) => `📎 ${attachment.name}`).join(", ");
  sessions.getOrCreate(message.chatId, dir);
  streaming.beginTurn(message.chatId, preview);
  sessions.sendPrompt(message.chatId, `${prompt}${pathBlock}`);
};

const persistMapping = (channelId: string, category: string, channelName: string, reply: (text: string) => Promise<void>) => {
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
};

transport.onMessage((message) => {
  // An open ask_user question always wins over normal prompt routing for this channel.
  streaming
    .tryResolveAskText(message.chatId, message.content)
    .then((resolved) => {
      if (!resolved) routeMessage(message);
    })
    .catch((err) => console.error("[streaming] ask-resolution failed:", err));
});

const routeMessage = (message: IncomingMessage): void => {
  const { allowedChannels } = state.config;
  if (!allowedChannels.includes("*") && !allowedChannels.includes(message.chatId)) return;

  const mapMatch = message.content.match(MAP_COMMAND);
  if (mapMatch) {
    const [, category, channelName] = mapMatch;
    persistMapping(message.chatId, category, channelName, (text) => transport.sendMessage(message.chatId, text));
    return;
  }

  const dir = lookupChannelDirectory(state.routing, message.chatId);
  if (dir) {
    void queue.enqueue(message.chatId, () => handleMappedPrompt(message, dir));
    return;
  }

  if (state.ignoredChannels.includes(message.chatId)) return;

  if (message.attachments.length > 0) {
    transport
      .sendMessage(message.chatId, "Attachments require a mapped project. Use `/pi map <category>/<channel>` first.")
      .catch((err) => console.error("[attachments] unmapped notice failed:", err));
    return;
  }

  mkdtemp(join(tmpdir(), "agent-daemon-"))
    .then((ephemeralDir) => {
      sessions.getOrCreate(message.chatId, ephemeralDir);
      streaming.beginTurn(message.chatId, message.content);
      sessions.sendPrompt(message.chatId, message.content);
    })
    .catch((err) => console.error("[session] ephemeral spawn failed:", err));

  if (!pendingConfirm.has(message.chatId)) {
    pendingConfirm.add(message.chatId);
    transport
      .sendConfirm(message.chatId, message.category, message.channelName)
      .catch((err) => console.error("[discord] confirm prompt failed:", err));
  }
};

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

transport.onAskButton(async (action) => {
  const resolved = await streaming.resolveAsk(action.channelId, action.id, action.choice);
  await action.respond(resolved ? "Answered." : "This question has expired.").catch(() => {});
});

transport.onSlashCommand(async (cmd) => {
  try {
    if (cmd.commandName === "stop") {
      const result = await sessions.abort(cmd.channelId);
      await cmd.reply(result.success ? "Stopped." : `Could not stop: ${result.error ?? "no active session in this channel"}`);
      return;
    }

    if (cmd.commandName === "continue") {
      if (!(await isPiPackageInstalled("pi-invisible-continue"))) {
        await cmd.reply("`/continue` isn't available — pi-invisible-continue isn't installed on this host.");
        return;
      }
      if (!sessions.getDirectory(cmd.channelId)) {
        await cmd.reply("No active session in this channel.");
        return;
      }
      sessions.sendPrompt(cmd.channelId, "/continue");
      await cmd.reply("Continuing.");
      return;
    }

    if (cmd.commandName === "model") {
      if (cmd.subcommand === "list") {
        const result = await sessions.getAvailableModels(cmd.channelId);
        if (!result.success) {
          await cmd.reply(`Could not list models: ${result.error ?? "no active session in this channel"}`);
          return;
        }
        const models = (result.data as { models?: { provider: string; id: string }[] } | undefined)?.models ?? [];
        const lines = models.map((model) => `- ${model.provider}/${model.id}`).join("\n");
        await cmd.reply(lines || "No models available.");
        return;
      }

      const provider = cmd.getStringOption("provider");
      const modelId = cmd.getStringOption("model");
      if (!provider || !modelId) {
        await cmd.reply("Usage: `/model set provider:<provider> model:<model-id>`");
        return;
      }
      const result = await sessions.setModel(cmd.channelId, provider, modelId);
      await cmd.reply(result.success ? `Model set to ${provider}/${modelId}.` : `Could not set model: ${result.error}`);
    }
  } catch (err) {
    console.error("[commands] slash command handling failed:", err);
    await cmd.reply(`Command failed: ${describeError(err)}`).catch(() => {});
  }
});

transport.onAutocomplete(async (auto) => {
  try {
    if (auto.commandName !== "model") {
      await auto.respond([]);
      return;
    }

    const result = await sessions.getAvailableModels(auto.channelId);
    const models = result.success ? ((result.data as { models?: { provider: string; id: string }[] } | undefined)?.models ?? []) : [];
    const query = auto.value.toLowerCase();

    if (auto.optionName === "provider") {
      const providers = [...new Set(models.map((m) => m.provider))].filter((p) => p.toLowerCase().includes(query));
      await auto.respond(providers.map((p) => ({ name: p, value: p })));
      return;
    }

    if (auto.optionName === "model") {
      const provider = auto.getStringOption("provider");
      const matches = models
        .filter((m) => !provider || m.provider === provider)
        .filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query));
      await auto.respond(matches.map((m) => ({ name: `${m.provider}/${m.id}`.slice(0, 100), value: m.id.slice(0, 100) })));
    }
  } catch (err) {
    console.error("[commands] autocomplete failed:", err);
    await auto.respond([]).catch(() => {});
  }
});

await transport.connect();
console.log("agent-daemon: connected");

// Cron core (src/cron.ts) knows nothing about Discord — this is the one place `deliverTo`
// gets interpreted. Started only after connect() resolves, since sendMessage throws on a cold client.
const cronJobs = await loadCronJobs();
const cron = new CronScheduler({
  jobs: cronJobs,
  onJobResult: (result) => {
    const channelId = result.deliverTo?.startsWith("discord:") ? result.deliverTo.slice("discord:".length) : null;
    if (!channelId) return;
    const body = result.ok ? result.output : `cron job \`${result.id}\` failed:\n${result.output}`;
    transport.sendMessage(channelId, body).catch((err) => console.error("[cron] delivery failed:", err));
  },
});
cron.start();
console.log(`agent-daemon: ${cronJobs.length} cron job(s) scheduled`);
