import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ResolvedSource } from "./source.js";

/**
 * Content-addressed cache (architecture A8).
 *
 * Layout: <cacheDir>/entries/<hash[0..2]>/<hash>/<sidecar files>
 * The hash never contains user-supplied strings, so paths cannot be steered.
 * Every entry directory carries a `meta.json` with the origin for humans.
 */

const SAMPLE_BYTES = 64 * 1024;

async function sampleFile(path: string, size: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
    await fh.read(head, 0, head.length, 0);
    if (size <= SAMPLE_BYTES * 2) return head;
    const tail = Buffer.alloc(SAMPLE_BYTES);
    await fh.read(tail, 0, tail.length, size - SAMPLE_BYTES);
    return Buffer.concat([head, tail]);
  } finally {
    await fh.close();
  }
}

/**
 * Fingerprint of a source. Files: size + mtime + first/last 64 KiB
 * (fast even for multi-GB files). URLs: the normalized URL itself.
 */
export async function fingerprint(source: ResolvedSource): Promise<string> {
  const h = createHash("sha256");
  if (source.kind === "url") {
    h.update("url:");
    h.update(source.location);
    return h.digest("hex");
  }
  const info = await stat(source.location);
  h.update("file:");
  h.update(String(info.size));
  h.update(":");
  h.update(String(Math.floor(info.mtimeMs)));
  h.update(":");
  h.update(await sampleFile(source.location, info.size));
  return h.digest("hex");
}

export interface CacheEntry {
  hash: string;
  dir: string;
}

export interface CacheMeta {
  origin: string;
  kind: "file" | "url";
  created_at: string;
}

/** Get (and create) the entry directory for a source. Mode 0700 throughout. */
export async function cacheEntry(config: Config, source: ResolvedSource): Promise<CacheEntry> {
  const hash = await fingerprint(source);
  const dir = join(config.cacheDir, "entries", hash.slice(0, 2), hash);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const metaPath = join(dir, "meta.json");
  try {
    await stat(metaPath);
  } catch {
    const meta: CacheMeta = { origin: source.location, kind: source.kind, created_at: new Date().toISOString() };
    await writeJsonAtomic(metaPath, meta);
  }
  return { hash, dir };
}

/** Sidecar path inside an entry. `name` must be a plain file name we control. */
export function sidecarPath(entry: CacheEntry, name: string): string {
  if (!/^[\w.+-]+$/.test(name)) throw new Error(`invalid sidecar name: ${name}`);
  return join(entry.dir, name);
}

export async function readSidecarJson<T>(entry: CacheEntry, name: string): Promise<T | undefined> {
  try {
    const raw = await readFile(sidecarPath(entry, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function writeSidecarJson(entry: CacheEntry, name: string, value: unknown): Promise<string> {
  const path = sidecarPath(entry, name);
  await writeJsonAtomic(path, value);
  return path;
}

export async function writeSidecarBytes(entry: CacheEntry, name: string, bytes: Buffer): Promise<string> {
  const path = sidecarPath(entry, name);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

export async function sidecarExists(entry: CacheEntry, name: string): Promise<boolean> {
  try {
    await stat(sidecarPath(entry, name));
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/** Per-server scratch space for temporary transcodes; cleaned by the sweep. */
export async function tmpDir(config: Config): Promise<string> {
  const dir = join(config.cacheDir, "tmp");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface CacheStats {
  dir: string;
  entries: number;
  bytes: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const item of items) {
    const p = join(dir, item.name);
    if (item.isDirectory()) total += await dirSize(p);
    else if (item.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

async function listEntries(config: Config): Promise<Array<{ dir: string; mtimeMs: number; bytes: number }>> {
  const root = join(config.cacheDir, "entries");
  const out: Array<{ dir: string; mtimeMs: number; bytes: number }> = [];
  let shards;
  try {
    shards = await readdir(root);
  } catch {
    return out;
  }
  for (const shard of shards) {
    let hashes;
    try {
      hashes = await readdir(join(root, shard));
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const dir = join(root, shard, hash);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
        out.push({ dir, mtimeMs: info.mtimeMs, bytes: await dirSize(dir) });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

export async function cacheStats(config: Config): Promise<CacheStats> {
  const entries = await listEntries(config);
  return { dir: config.cacheDir, entries: entries.length, bytes: entries.reduce((a, e) => a + e.bytes, 0) };
}

/**
 * Enforce TTL and size cap: drop entries older than the TTL, then drop
 * oldest-first until under the cap. Also empties the tmp dir. Returns what
 * was removed. Safe to call at every startup.
 */
export async function sweepCache(config: Config, now: number = Date.now()): Promise<{ removed: number; freed_bytes: number }> {
  let removed = 0;
  let freed = 0;
  const ttlMs = config.cacheTtlDays * 24 * 3600 * 1000;
  const entries = (await listEntries(config)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  for (const e of entries) {
    const expired = now - e.mtimeMs > ttlMs;
    const overCap = total > config.cacheMaxBytes;
    if (!expired && !overCap) continue;
    await rm(e.dir, { recursive: true, force: true });
    removed += 1;
    freed += e.bytes;
    total -= e.bytes;
  }
  await rm(join(config.cacheDir, "tmp"), { recursive: true, force: true });
  return { removed, freed_bytes: freed };
}
