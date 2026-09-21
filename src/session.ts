import { type ChildProcess, spawn } from "node:child_process";

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DISCORD_FILE_PROMPT = "To send one file to Discord, end your response with [[discord-file:relative/path]] on its own line.";

export const buildPiArgs = (): string[] => ["--mode", "rpc", "--append-system-prompt", DISCORD_FILE_PROMPT];

export type Session = {
  channelId: string;
  dir: string;
  process: ChildProcess;
  pid: number;
  lastActivity: number;
};

export type SpawnFn = (dir: string) => ChildProcess;

const defaultSpawn: SpawnFn = (dir) => spawn("pi", buildPiArgs(), { cwd: dir });

export type SessionManagerOptions = {
  notifyCrash: boolean;
  onCrash?: (channelId: string) => void;
  /** Fired for each parsed NDJSON event a session's `pi --mode rpc` process writes to stdout. */
  onEvent?: (channelId: string, event: unknown) => void;
  spawnFn?: SpawnFn;
  idleTimeoutMs?: number;
};

/** Reads NDJSON lines off `pi --mode rpc`'s stdout and forwards parsed events. */
const attachEventReader = (proc: ChildProcess, onEvent: (event: unknown) => void): void => {
  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (err) {
        console.error("[session] failed to parse pi event:", err);
      }
    }
  });
};

/** Per-channel `pi --mode rpc` process registry: one persistent session per resolved directory (005). */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private spawnFn: SpawnFn;
  private idleTimeoutMs: number;

  constructor(private opts: SessionManagerOptions) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  /** Returns the live session for `channelId`, spawning one against `dir` if none exists (or the prior one crashed). */
  getOrCreate(channelId: string, dir: string): Session {
    const existing = this.sessions.get(channelId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }
    return this.spawnSession(channelId, dir);
  }

  touch(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (session) session.lastActivity = Date.now();
  }

  getDirectory(channelId: string): string | null {
    return this.sessions.get(channelId)?.dir ?? null;
  }

  /** Writes a `prompt` command to the session's `pi --mode rpc` stdin. No-op if the channel has no live session. */
  sendPrompt(channelId: string, message: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.lastActivity = Date.now();
    session.process.stdin?.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  }

  /** Kills and drops the session for `channelId`, if any (e.g. switching an ephemeral session to its mapped dir — 008). */
  drop(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    this.sessions.delete(channelId);
    session.process.kill();
  }

  /** Kills and drops any session idle past the timeout. Call on an interval. */
  reapIdle(now: number = Date.now()): void {
    for (const [channelId, session] of this.sessions) {
      if (now - session.lastActivity > this.idleTimeoutMs) {
        session.process.kill();
        this.sessions.delete(channelId);
      }
    }
  }

  private spawnSession(channelId: string, dir: string): Session {
    const proc = this.spawnFn(dir);
    const session: Session = {
      channelId,
      dir,
      process: proc,
      pid: proc.pid ?? -1,
      lastActivity: Date.now(),
    };
    this.sessions.set(channelId, session);

    if (this.opts.onEvent) {
      attachEventReader(proc, (event) => this.opts.onEvent?.(channelId, event));
    }

    proc.once("exit", (code, signal) => {
      if (this.sessions.get(channelId) !== session) return;
      this.sessions.delete(channelId);
      console.error(`[session] pi exited unexpectedly dir=${dir} code=${code} signal=${signal}`);
      if (this.opts.notifyCrash) this.opts.onCrash?.(channelId);
    });

    return session;
  }
}
