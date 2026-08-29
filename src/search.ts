import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Config } from "./config.js";
import { round3 } from "./contracts.js";

/**
 * Full-text index over transcripts and OCR text living in the cache
 * (architecture A19: introspection, not a second knowledge base).
 * node:sqlite with FTS5 is built into Node 22.13+, no native module needed.
 */

export interface IndexedSegment {
  start_s: number;
  end_s: number;
  text: string;
}

export interface IndexDocument {
  hash: string;
  origin: string;
  kind: "transcript" | "ocr";
  language: string | undefined;
  backend: string | undefined;
  segments: IndexedSegment[];
}

export interface SearchHit {
  hash: string;
  origin: string;
  kind: "transcript" | "ocr";
  language: string | undefined;
  start_s: number;
  end_s: number;
  snippet: string;
  score: number;
}

let opened: { path: string; db: DatabaseSync } | undefined;

function indexPath(config: Config): string {
  return join(config.cacheDir, "index.db");
}

export async function openIndex(config: Config): Promise<DatabaseSync> {
  const path = indexPath(config);
  if (opened && opened.path === path) return opened.db;
  if (opened) opened.db.close();
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      language TEXT,
      backend TEXT,
      indexed_at TEXT NOT NULL,
      UNIQUE(hash, kind, backend, language)
    );
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      start_s REAL NOT NULL,
      end_s REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS segments_doc ON segments(doc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
      text, content='segments', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
      INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
      INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
  `);
  opened = { path, db };
  return db;
}

export function closeIndex(): void {
  if (opened) {
    opened.db.close();
    opened = undefined;
  }
}

/** Insert or replace a document's segments. Idempotent per (hash, kind, backend, language). */
export async function indexDocument(config: Config, doc: IndexDocument): Promise<{ doc_id: number; segments: number }> {
  const db = await openIndex(config);
  const existing = db
    .prepare("SELECT id FROM docs WHERE hash = ? AND kind = ? AND backend IS ? AND language IS ?")
    .get(doc.hash, doc.kind, doc.backend ?? null, doc.language ?? null) as { id: number } | undefined;
  db.exec("BEGIN");
  try {
    let docId: number;
    if (existing) {
      docId = existing.id;
      db.prepare("DELETE FROM segments WHERE doc_id = ?").run(docId);
      db.prepare("UPDATE docs SET origin = ?, indexed_at = ? WHERE id = ?").run(doc.origin, new Date().toISOString(), docId);
    } else {
      const r = db
        .prepare("INSERT INTO docs (hash, kind, origin, language, backend, indexed_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(doc.hash, doc.kind, doc.origin, doc.language ?? null, doc.backend ?? null, new Date().toISOString());
      docId = Number(r.lastInsertRowid);
    }
    const ins = db.prepare("INSERT INTO segments (doc_id, start_s, end_s, text) VALUES (?, ?, ?, ?)");
    let n = 0;
    for (const s of doc.segments) {
      const text = s.text.trim();
      if (text.length === 0) continue;
      ins.run(docId, s.start_s, s.end_s, text);
      n += 1;
    }
    db.exec("COMMIT");
    return { doc_id: docId, segments: n };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Escape a user query for FTS5: quote each term, keep it a plain AND of tokens. */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" ");
}

export async function searchIndex(
  config: Config,
  query: string,
  options: { hash?: string; kind?: "transcript" | "ocr"; limit?: number } = {},
): Promise<SearchHit[]> {
  const db = await openIndex(config);
  const limit = options.limit ?? 10;
  const where = ["segments_fts MATCH ?"];
  const params: Array<string | number> = [toFtsQuery(query)];
  if (options.hash) {
    where.push("d.hash = ?");
    params.push(options.hash);
  }
  if (options.kind) {
    where.push("d.kind = ?");
    params.push(options.kind);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT d.hash AS hash, d.origin AS origin, d.kind AS kind, d.language AS language,
              s.start_s AS start_s, s.end_s AS end_s,
              snippet(segments_fts, 0, '[', ']', '…', 12) AS snippet,
              bm25(segments_fts) AS score
       FROM segments_fts
       JOIN segments s ON s.id = segments_fts.rowid
       JOIN docs d ON d.id = s.doc_id
       WHERE ${where.join(" AND ")}
       ORDER BY score
       LIMIT ?`,
    )
    .all(...params) as Array<{ hash: string; origin: string; kind: "transcript" | "ocr"; language: string | null; start_s: number; end_s: number; snippet: string; score: number }>;
  return rows.map((r) => ({
    hash: r.hash,
    origin: r.origin,
    kind: r.kind,
    language: r.language ?? undefined,
    start_s: round3(r.start_s),
    end_s: round3(r.end_s),
    snippet: r.snippet,
    score: round3(-r.score),
  }));
}

export async function indexStats(config: Config): Promise<{ documents: number; segments: number; path: string }> {
  const db = await openIndex(config);
  const d = db.prepare("SELECT count(*) AS c FROM docs").get() as { c: number };
  const s = db.prepare("SELECT count(*) AS c FROM segments").get() as { c: number };
  return { documents: d.c, segments: s.c, path: indexPath(config) };
}
