import { SlashCommandBuilder } from "discord.js";
import { isPiPackageInstalled } from "./pi-packages.js";

const STOP_COMMAND = new SlashCommandBuilder().setName("stop").setDescription("Abort the agent's current turn in this channel");

const CONTINUE_COMMAND = new SlashCommandBuilder()
  .setName("continue")
  .setDescription("Resume the agent invisibly after an aborted or failed turn (requires pi-invisible-continue)");

const MODEL_COMMAND = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Manage the agent's model for this channel")
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Switch the model for this channel's session")
      .addStringOption((opt) =>
        opt.setName("provider").setDescription('Provider id, e.g. "anthropic"').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName("model").setDescription('Model id, e.g. "claude-sonnet-5"').setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("List models available to this channel's session"));

/** Builds the command set to register with Discord, dropping /continue when its backing pi package isn't installed on this host. */
export const buildSlashCommands = async (): Promise<ReturnType<SlashCommandBuilder["toJSON"]>[]> => {
  const commands = [STOP_COMMAND, MODEL_COMMAND];
  if (await isPiPackageInstalled("pi-invisible-continue")) commands.push(CONTINUE_COMMAND);
  return commands.map((command) => command.toJSON());
};
