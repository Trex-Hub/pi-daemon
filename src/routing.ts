import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { GatewayConfig, RoutingEntry } from "./state.js";

const UNGROUPED = "ungrouped";

const sanitizeSegment = (name: string): string => {
  const cleaned = name.replace(/[/\\]/g, "-").trim();
  return cleaned || "unnamed";
};

const resolveUnderRoot = (config: GatewayConfig, category: string, channel: string): string => {
  const root = resolve(config.projectsRoot);
  const dir = resolve(root, sanitizeSegment(category), sanitizeSegment(channel));

  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`Resolved directory escapes projects root: ${dir}`);
  }

  return dir;
};

/** Looks up an existing channel→directory mapping. Returns null for an unmapped channel (008). */
export const lookupChannelDirectory = (routing: Record<string, RoutingEntry>, channelId: string): string | null => {
  return routing[channelId]?.dir ?? null;
};

/** Computes (without persisting) the directory a channel's auto-derived category/name would map to. */
export const candidateDirectory = (config: GatewayConfig, category: string | null, channelName: string): string => {
  return resolveUnderRoot(config, category ?? UNGROUPED, channelName);
};

/** `mkdir -p`s the resolved directory and persists the channel→dir mapping (008 confirm / `/pi map`). */
export const mapChannel = async (
  config: GatewayConfig,
  routing: Record<string, RoutingEntry>,
  channelId: string,
  category: string,
  channel: string
): Promise<string> => {
  const dir = resolveUnderRoot(config, category, channel);
  await mkdir(dir, { recursive: true });
  routing[channelId] = { dir };
  return dir;
};
