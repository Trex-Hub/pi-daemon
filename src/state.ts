import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

/** True OS home dir, read from the system user database — ignores $HOME so an overwritten/doubled HOME env can't move state.json. */
function trueHomedir(): string {
  return userInfo().homedir;
}

/** Base dir for gateway working data (projects root, etc). Overridable via GATEWAY_HOME; falls back to the true home dir. Never affects where state.json lives. */
function gatewayHome(): string {
  return process.env.GATEWAY_HOME || trueHomedir();
}

export type ChannelAuthMode = "all" | "mentions" | "trusted-only";

/** `<transport>:<userId>`, e.g. `discord:123456789012345678`. Namespaced now even though v1 has one transport. */
export type TrustedUserId = string;

export interface RoutingEntry {
  dir: string;
}

export interface GatewayConfig {
  discordToken: string;
  adminUserId: string;
  projectsRoot: string;
  notifyOnCrash: boolean;
}

export interface AuthState {
  channelModes: Record<string, ChannelAuthMode>;
  /** Whole-server default mode, keyed by guildId. A channelModes entry for the same channel wins. */
  guildModes: Record<string, ChannelAuthMode>;
  trustedUsers: TrustedUserId[];
}

export interface GatewayState {
  config: GatewayConfig;
  routing: Record<string, RoutingEntry>;
  auth: AuthState;
  /** Channels where the user picked "Ignore" on the new-channel confirm (008) — no session, no re-prompt. */
  ignoredChannels: string[];
}

export const DEFAULT_STATE_PATH = join(trueHomedir(), ".pi", "gateway", "state.json");

export function defaultState(): GatewayState {
  return {
    config: {
      discordToken: "",
      adminUserId: "",
      projectsRoot: join(gatewayHome(), ".pi", "gateway", "projects"),
      notifyOnCrash: true,
    },
    routing: {},
    auth: {
      channelModes: {},
      guildModes: {},
      trustedUsers: [],
    },
    ignoredChannels: [],
  };
}

export async function loadState(path: string = DEFAULT_STATE_PATH): Promise<GatewayState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayState>;
    const defaults = defaultState();
    return {
      config: { ...defaults.config, ...parsed.config },
      routing: parsed.routing ?? defaults.routing,
      auth: { ...defaults.auth, ...parsed.auth },
      ignoredChannels: parsed.ignoredChannels ?? defaults.ignoredChannels,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState();
    }
    throw err;
  }
}

export async function saveState(state: GatewayState, path: string = DEFAULT_STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
