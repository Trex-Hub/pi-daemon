import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";

/** True OS home dir — same rationale as state.ts: ignores $HOME so it can't move cron-jobs.json. Copied rather than
 * imported from state.ts to keep this module free of gateway-state imports. */
const trueHomedir = (): string => userInfo().homedir;

export const DEFAULT_CRON_PATH = join(trueHomedir(), ".pi", "agent", "gateway", "cron-jobs.json");

export type JobSpec = {
  id: string;
  /** Standard 5/6-field cron expression, e.g. "0 9 * * 1-5". */
  cron: string;
  prompt: string;
  /** cwd for the `pi -p` run. */
  dir: string;
  /** Tool allowlist, passed as `-t a,b,c`. */
  tools?: string[];
  /** Opaque to the cron core — interpreted only by the adapter that reads onJobResult. */
  deliverTo?: string;
};

type RawFile = {
  jobs?: unknown;
};

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Validates one raw job entry, logging and returning null rather than throwing — one bad job must not block boot. */
const validateJob = (raw: unknown, seenIds: Set<string>): JobSpec | null => {
  if (typeof raw !== "object" || raw === null) {
    console.error("[cron] skipping job: not an object");
    return null;
  }
  const j = raw as Record<string, unknown>;

  if (!isNonEmptyString(j.id)) {
    console.error("[cron] skipping job: missing/empty id");
    return null;
  }
  if (seenIds.has(j.id)) {
    console.error(`[cron] skipping job ${j.id}: duplicate id`);
    return null;
  }
  if (!isNonEmptyString(j.cron)) {
    console.error(`[cron] skipping job ${j.id}: missing/empty cron expression`);
    return null;
  }
  if (!isNonEmptyString(j.prompt)) {
    console.error(`[cron] skipping job ${j.id}: missing/empty prompt`);
    return null;
  }
  if (!isNonEmptyString(j.dir)) {
    console.error(`[cron] skipping job ${j.id}: missing/empty dir`);
    return null;
  }
  if (j.tools !== undefined && (!Array.isArray(j.tools) || !j.tools.every(isNonEmptyString))) {
    console.error(`[cron] skipping job ${j.id}: tools must be an array of strings`);
    return null;
  }
  if (j.deliverTo !== undefined && !isNonEmptyString(j.deliverTo)) {
    console.error(`[cron] skipping job ${j.id}: deliverTo must be a non-empty string`);
    return null;
  }

  try {
    // eslint-disable-next-line no-new
    new Cron(j.cron);
  } catch (err) {
    console.error(`[cron] skipping job ${j.id}: invalid cron expression "${j.cron}": ${(err as Error).message}`);
    return null;
  }

  seenIds.add(j.id);
  return {
    id: j.id,
    cron: j.cron,
    prompt: j.prompt,
    dir: j.dir,
    tools: j.tools as string[] | undefined,
    deliverTo: j.deliverTo as string | undefined,
  };
};

/** Loads and validates cron job specs. Missing file -> []; any other read/parse error rethrows. */
export const loadCronJobs = async (path: string = DEFAULT_CRON_PATH): Promise<JobSpec[]> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const parsed = JSON.parse(raw) as RawFile;
  const jobsRaw = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const seenIds = new Set<string>();
  const jobs: JobSpec[] = [];
  for (const rawJob of jobsRaw) {
    const job = validateJob(rawJob, seenIds);
    if (job) jobs.push(job);
  }
  return jobs;
};
