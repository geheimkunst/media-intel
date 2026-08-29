import { execa, type Options as ExecaOptions } from "execa";
import type { Config } from "./config.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
  /** The binary itself could not be started (ENOENT). */
  missing: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Bytes for stdout instead of text (frames, images). */
  binary?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /** Cap on captured output; ffmpeg can be chatty on stderr. */
  maxBuffer?: number;
}

function isEnoent(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { code?: string }).code === "ENOENT";
}

/**
 * Run an external binary with an argument array (never a shell), a hard
 * timeout, and process-group termination on timeout so ffmpeg children
 * spawned by yt-dlp do not outlive their parent.
 */
export async function runBinary(
  config: Config,
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult & { stdoutBuffer: Buffer | undefined }> {
  const timeoutMs = options.timeoutMs ?? config.processTimeoutMs;
  const execaOptions: ExecaOptions = {
    reject: false,
    detached: process.platform !== "win32",
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdin: "ignore",
    ...(options.binary ? { encoding: "buffer" as const } : {}),
  };

  const subprocess = execa(bin, args, execaOptions);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const pid = subprocess.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        /* fall through to plain kill */
      }
    }
    subprocess.kill("SIGKILL");
  }, timeoutMs);

  try {
    const result = await subprocess;
    if (isEnoent(result)) {
      return { stdout: "", stderr: "", exitCode: undefined, timedOut: false, missing: true, stdoutBuffer: undefined };
    }
    // With encoding:"buffer", execa hands back Uint8Array (not necessarily Buffer) for both streams.
    const stdoutRaw = result.stdout as unknown;
    const stderrRaw = result.stderr as unknown;
    const stdoutBuffer = stdoutRaw instanceof Uint8Array ? Buffer.from(stdoutRaw.buffer, stdoutRaw.byteOffset, stdoutRaw.byteLength) : undefined;
    return {
      stdout: stdoutBuffer ? "" : String(stdoutRaw ?? ""),
      stderr: stderrRaw instanceof Uint8Array ? Buffer.from(stderrRaw).toString("utf8") : String(stderrRaw ?? ""),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
      timedOut,
      missing: false,
      stdoutBuffer,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return { stdout: "", stderr: "", exitCode: undefined, timedOut: false, missing: true, stdoutBuffer: undefined };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Replace known secret values in a string before it reaches a tool result or stderr. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 12) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) continue;
    out = out.split(value).join("***");
  }
  return out;
}
