import { type ChildProcess, spawn } from "node:child_process";

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export interface Session {
  channelId: string;
  dir: string;
  process: ChildProcess;
  pid: number;
  lastActivity: number;
}

export type SpawnFn = (dir: string) => ChildProcess;

const defaultSpawn: SpawnFn = (dir) => spawn("pi", ["--mode", "rpc"], { cwd: dir });

export interface SessionManagerOptions {
  notifyCrash: boolean;
  onCrash?: (channelId: string) => void;
  spawnFn?: SpawnFn;
  idleTimeoutMs?: number;
}

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

    proc.once("exit", (code, signal) => {
      if (this.sessions.get(channelId) !== session) return;
      this.sessions.delete(channelId);
      console.error(`[session] pi exited unexpectedly dir=${dir} code=${code} signal=${signal}`);
      if (this.opts.notifyCrash) this.opts.onCrash?.(channelId);
    });

    return session;
  }
}
