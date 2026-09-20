import { type ChildProcess, spawn } from "node:child_process";
import { Cron } from "croner";
import type { JobSpec } from "./cron-config.js";

const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000;

export type SpawnFn = (job: JobSpec) => ChildProcess;

export type JobResult = {
  id: string;
  ok: boolean;
  output: string;
  deliverTo?: string;
};

export type CronSchedulerOptions = {
  jobs: JobSpec[];
  onJobResult: (result: JobResult) => void;
  spawnFn?: SpawnFn;
  maxRuntimeMs?: number;
};

const defaultSpawn: SpawnFn = (job) =>
  // stdin must be "ignore": a one-shot `pi -p` run never writes to it, and leaving it an
  // open, unclosed pipe makes `pi` block waiting for EOF that will never come.
  spawn("pi", ["-p", job.prompt, ...(job.tools ? ["-t", job.tools.join(",")] : [])], {
    cwd: job.dir,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Discord-free cron engine: one-shot `pi -p` subprocess per due job (Hermes pattern), not a pinned session.
 * Never imports discord.ts/session.ts/state.ts — the adapter that owns deliverTo interpretation lives in index.ts. */
export class CronScheduler {
  private jobs: JobSpec[];
  private spawnFn: SpawnFn;
  private maxRuntimeMs: number;
  private onJobResult: (result: JobResult) => void;
  private running = new Set<string>();
  private tasks: Cron[] = [];

  constructor(opts: CronSchedulerOptions) {
    this.jobs = opts.jobs;
    this.onJobResult = opts.onJobResult;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.maxRuntimeMs = opts.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  }

  /** Registers one Cron timer per job. Wall-clock driven — a pm2 restart just re-syncs to real time, no state to lose. */
  start(): void {
    for (const job of this.jobs) {
      this.tasks.push(new Cron(job.cron, () => this.fire(job)));
    }
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
    this.tasks = [];
  }

  private fire(job: JobSpec): void {
    if (this.running.has(job.id)) {
      console.warn(`[cron] ${job.id} still running, skip this tick`);
      return;
    }
    // Never let a job failure escape uncaught — index.ts hard-exits on unhandledRejection.
    this.runJob(job)
      .then((result) => this.onJobResult(result))
      .catch((err) => console.error(`[cron] ${job.id} crashed the runner unexpectedly:`, err));
  }

  /** Spawns the job, captures stdout+stderr, and resolves a JobResult. Exported behavior via the class for direct testing. */
  async runJob(job: JobSpec): Promise<JobResult> {
    this.running.add(job.id);
    try {
      return await new Promise<JobResult>((resolve) => {
        let proc: ChildProcess;
        try {
          proc = this.spawnFn(job);
        } catch (err) {
          resolve({ id: job.id, ok: false, output: `failed to spawn: ${(err as Error).message}`, deliverTo: job.deliverTo });
          return;
        }

        let output = "";
        proc.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, this.maxRuntimeMs);

        proc.once("exit", (code) => {
          clearTimeout(timer);
          resolve({
            id: job.id,
            ok: !timedOut && code === 0,
            output: timedOut ? `${output}\n[cron] killed after exceeding ${this.maxRuntimeMs}ms` : output,
            deliverTo: job.deliverTo,
          });
        });

        proc.once("error", (err) => {
          clearTimeout(timer);
          resolve({ id: job.id, ok: false, output: `process error: ${err.message}`, deliverTo: job.deliverTo });
        });
      });
    } finally {
      this.running.delete(job.id);
    }
  }
}
