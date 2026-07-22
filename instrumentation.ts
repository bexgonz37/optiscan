/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Background loops are started from lib/server-boot.ts on first API hit so dev
 * webpack does not try to bundle better-sqlite3 into the instrumentation graph.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function register() {
  // Production VPS/Docker: start scanner + tracker immediately (no browser hit needed).
  if (process.env.NODE_ENV !== "production") return;
  try {
    // webpackIgnore keeps better-sqlite3 out of the instrumentation bundle graph.
    // In standalone output, instrumentation runs from .next/server while traced
    // source files live under process.cwd()/lib, so resolve from cwd explicitly.
    const bootUrl = pathToFileURL(path.join(process.cwd(), "lib", "server-boot.ts")).href;
    const { ensureServerBoot } = await import(/* webpackIgnore: true */ bootUrl);
    ensureServerBoot();
    console.info("[optiscan] scanner + alert tracker started at process boot");
  } catch (err) {
    console.warn("[optiscan] server boot skipped:", (err as Error)?.message);
  }
}
