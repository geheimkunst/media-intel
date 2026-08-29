#!/usr/bin/env node
/** Merge candidate entries from patch JSONs into a base results JSON. Usage: node bench/merge.mjs base.json patch.json [patch2.json ...] > merged.json */
import { readFile } from "node:fs/promises";
const [base, ...patches] = process.argv.slice(2);
const out = JSON.parse(await readFile(base, "utf8"));
for (const p of patches) {
  const j = JSON.parse(await readFile(p, "utf8"));
  for (const c of j.candidates) {
    const i = out.candidates.findIndex((x) => x.name === c.name);
    if (i >= 0) out.candidates[i] = c; else out.candidates.push(c);
  }
  out.meta.merged_from = [...(out.meta.merged_from ?? []), p.split("/").pop()];
}
process.stdout.write(JSON.stringify(out, null, 2));
