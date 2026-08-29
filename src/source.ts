import { lookup } from "node:dns/promises";
import { realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { MediaIntelError } from "./errors.js";

export type SourceKind = "file" | "url";

export interface ResolvedSource {
  kind: SourceKind;
  /** Absolute, symlink-resolved file path or the original URL. */
  location: string;
  /** Size in bytes for local files; undefined for URLs. */
  sizeBytes: number | undefined;
}

export interface ResolveOptions {
  cwd?: string;
  /** Allow http(s) sources that resolve to private or loopback addresses (tests, LAN). */
  allowPrivateHosts?: boolean;
  /** Skip DNS resolution (offline tests). */
  skipDns?: boolean;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:", "file:"]);

/**
 * Is this IP address in a range that must never be fetched on behalf of a
 * model (loopback, private, link-local incl. cloud metadata, ULA, CGNAT)?
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP at all: refuse
}

/** Reject URLs whose host resolves to a private address (SSRF guard). */
export async function assertPublicHost(url: URL, options: ResolveOptions = {}): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    if (!options.allowPrivateHosts) throw privateHostError(host);
    return;
  }
  const addresses = isIP(host) ? [{ address: host }] : options.skipDns ? [] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0 && !isIP(host) && !options.skipDns) {
    throw new MediaIntelError("source_unresolvable", `Could not resolve host ${host}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address) && !options.allowPrivateHosts) throw privateHostError(host);
  }
}

function privateHostError(host: string): MediaIntelError {
  return new MediaIntelError(
    "source_private_host",
    `${host} resolves to a private or local address; refusing to fetch it`,
    "media-intel only fetches public http(s) URLs. Download the file first and pass a local path.",
  );
}

/**
 * Turn a user-supplied `source` string into something ffprobe can open.
 * Only http, https and file schemes (or bare paths) are accepted. Local
 * files are symlink-resolved and checked so the error is precise instead of
 * a generic ffprobe exit code.
 */
export async function resolveSource(source: string, options: ResolveOptions = {}): Promise<ResolvedSource> {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new MediaIntelError("invalid_source", "source must not be empty");

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const looksLikeUrl = schemeMatch !== null && !/^[a-zA-Z]:[\\/]/.test(trimmed); // not a Windows drive
  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new MediaIntelError("invalid_source", `Not a valid URL: ${trimmed}`);
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
      throw new MediaIntelError("invalid_source", `Scheme ${url.protocol} is not allowed`, "Use http(s) URLs, file:// URLs, or plain paths.");
    }
    if (url.protocol === "file:") {
      return resolveLocal(decodeURIComponent(url.pathname), options);
    }
    if (url.username || url.password) {
      throw new MediaIntelError("invalid_source", "Credentials in URLs are not accepted");
    }
    await assertPublicHost(url, options);
    return { kind: "url", location: url.toString(), sizeBytes: undefined };
  }

  return resolveLocal(trimmed, options);
}

async function resolveLocal(rawPath: string, options: ResolveOptions): Promise<ResolvedSource> {
  const cwd = options.cwd ?? process.cwd();
  const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new MediaIntelError(
      "source_not_found",
      `No file at ${path}`,
      "Pass an absolute path to an existing file, or an http(s) URL. Remote platform pages (YouTube etc.) need fetch_media first.",
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new MediaIntelError("invalid_source", `${path} is not a regular file`);
  return { kind: "file", location: real, sizeBytes: info.size };
}
