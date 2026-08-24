import { resolve, sep } from "node:path";
import type { GatewayConfig, RoutingEntry } from "./state.js";

const UNGROUPED = "ungrouped";

function sanitizeSegment(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "-").trim();
  return cleaned || "unnamed";
}

/** Resolves (and caches in `routing`) the on-disk directory for a Discord channel. Throws if the resolved path would escape `config.projectsRoot`. */
export function resolveChannelDirectory(
  config: GatewayConfig,
  routing: Record<string, RoutingEntry>,
  channelId: string,
  category: string | null,
  channelName: string
): string {
  const existing = routing[channelId];
  if (existing) return existing.dir;

  const categorySegment = sanitizeSegment(category ?? UNGROUPED);
  const channelSegment = sanitizeSegment(channelName);

  const root = resolve(config.projectsRoot);
  const dir = resolve(root, categorySegment, channelSegment);

  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`Resolved directory escapes projects root: ${dir}`);
  }

  routing[channelId] = { dir };
  return dir;
}
