import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** "npm:pi-invisible-continue" -> "pi-invisible-continue", "git:github.com/x/pi-llm-wiki" -> "pi-llm-wiki" */
const packageName = (spec: string): string => {
  const withoutSourcePrefix = spec.replace(/^(npm|git):/, "");
  const segments = withoutSourcePrefix.split("/");
  return segments[segments.length - 1] ?? withoutSourcePrefix;
};

/** Reads the `packages` list from a pi settings.json. Missing/unreadable/malformed file -> empty set. */
export const loadInstalledPiPackages = async (settingsPath: string = DEFAULT_SETTINGS_PATH): Promise<Set<string>> => {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { packages?: unknown };
    const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
    return new Set(packages.filter((entry): entry is string => typeof entry === "string").map(packageName));
  } catch {
    return new Set();
  }
};

/** Gate: is `name` (bare package name, e.g. "pi-invisible-continue") installed per the given set? */
export const hasPiPackage = (installed: Set<string>, name: string): boolean => installed.has(name);

/** Convenience one-shot: reads settings.json fresh and checks for `name`. */
export const isPiPackageInstalled = async (name: string, settingsPath?: string): Promise<boolean> =>
  hasPiPackage(await loadInstalledPiPackages(settingsPath), name);
