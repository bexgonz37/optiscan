#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTerminologyMarkdown } from "../lib/terminology.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "brain", "02 Components", "CANONICAL_TERMINOLOGY.md");
const rendered = renderTerminologyMarkdown();
if (process.argv.includes("--check")) {
  const existing = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
  if (existing !== rendered) {
    console.error(`[terminology] generated Obsidian glossary is stale: ${output}`);
    process.exitCode = 1;
  } else {
    console.log(`[terminology] current: ${output}`);
  }
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, rendered, "utf8");
  console.log(`[terminology] generated: ${output}`);
}
