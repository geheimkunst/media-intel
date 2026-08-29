import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport, originValidation } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";

export interface HttpOptions {
  port: number;
  /** Bind address. Default 127.0.0.1; anything else requires allowedHosts. */
  host?: string;
  /** Hostnames accepted in the Host header when not bound to loopback. */
  allowedHosts?: string[];
  /** Static bearer token; when set every request must carry it. The VPS bridge does OAuth in front of this. */
  bearerToken?: string;
  path?: string;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stateless Streamable HTTP endpoint (spec 2026-07-28): one transport per
 * request, no session ids, Host and Origin guards, loopback by default.
 * Auth is a static bearer token at most; real OAuth lives in the hosting bridge.
 */
export function startHttp(server: McpServer, options: HttpOptions): Promise<{ close: () => Promise<void>; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const validateHost = loopback ? localhostHostValidation() : hostHeaderValidation(options.allowedHosts ?? []);
  const validateOrigin = loopback ? localhostOriginValidation() : originValidation(options.allowedHosts ?? []);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (options.bearerToken && !tokenMatches(req.headers.authorization, options.bearerToken)) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="media-intel"' }).end();
      return;
    }
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(`http error: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      await transport.close().catch(() => undefined);
    }
  };

  const httpServer = createHttpServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : options.port;
      resolve({
        url: `http://${host}:${port}${path}`,
        close: () => new Promise<void>((r) => httpServer.close(() => r())),
      });
    });
  });
}
