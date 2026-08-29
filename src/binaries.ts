import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Config } from "./config.js";
import { runBinary } from "./process.js";

/** Directories launchers often forget; searched after PATH. */
const EXTRA_DIRS = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a binary name to an absolute path, or undefined if not found. */
export async function findBinary(nameOrPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (isAbsolute(nameOrPath) || nameOrPath.includes("/")) {
    return (await isExecutable(nameOrPath)) ? nameOrPath : undefined;
  }
  const pathDirs = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  for (const dir of [...pathDirs, ...EXTRA_DIRS]) {
    const candidate = join(dir, nameOrPath);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface BinaryInfo {
  name: string;
  configured: string;
  path: string | undefined;
  version: string | undefined;
}

const VERSION_ARGS: Record<string, string[]> = {
  ffmpeg: ["-version"],
  ffprobe: ["-version"],
  "yt-dlp": ["--version"],
  "whisper-cli": ["--help"],
  tesseract: ["--version"],
};

function firstVersionLine(name: string, stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`;
  if (name === "whisper-cli") {
    // whisper-cli has no --version; presence of the usage banner is enough.
    return /usage:/i.test(text) ? "present" : undefined;
  }
  const line = text.split("\n").find((l) => /\d+\.\d+/.test(l));
  if (!line) return undefined;
  const match = line.match(/(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)/);
  return match?.[1] ?? line.trim();
}

/** Locate a binary and ask it for its version (short timeout, never throws). */
export async function inspectBinary(config: Config, name: string, configured: string): Promise<BinaryInfo> {
  const path = await findBinary(configured);
  if (!path) return { name, configured, path: undefined, version: undefined };
  const args = VERSION_ARGS[name] ?? ["--version"];
  try {
    const r = await runBinary(config, path, args, { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
    return { name, configured, path, version: firstVersionLine(name, r.stdout, r.stderr) };
  } catch {
    return { name, configured, path, version: undefined };
  }
}

/** Names of filters the installed ffmpeg supports (empty set if ffmpeg is missing). */
export async function ffmpegFilters(config: Config): Promise<Set<string>> {
  const path = await findBinary(config.ffmpegBin);
  if (!path) return new Set();
  const r = await runBinary(config, path, ["-hide_banner", "-filters"], { timeoutMs: 10_000 });
  const names = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    // Format: " T.C scdet             V->V       Detect video scene change"
    const m = line.match(/^\s*[TSC.]*\s+([a-z0-9_]+)\s+[A-Z|]+->[A-Z|]+/);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

/** Languages the installed tesseract can OCR (empty if missing). */
export async function tesseractLanguages(config: Config): Promise<string[]> {
  const path = await findBinary(config.tesseractBin);
  if (!path) return [];
  const r = await runBinary(config, path, ["--list-langs"], { timeoutMs: 10_000 });
  return `${r.stdout}\n${r.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]{3,}$/i.test(l) && l !== "osd");
}
