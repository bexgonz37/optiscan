import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { checkApiToken, unauthorized } from "@/lib/auth";
import { parseRobinhoodCsv } from "@/lib/robinhood-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/trade-journal/import — Robinhood Activity CSV (multipart). */
export async function POST(req: Request) {
  if (!checkApiToken(req)) return unauthorized();
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ ok: false, error: "Missing file upload" }, { status: 400 });
    }
    const filename = (file as File).name ?? "robinhood.csv";
    if (!filename.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ ok: false, error: "CSV files only" }, { status: 400 });
    }

    const text = await file.text();
    const { rows, errors } = parseRobinhoodCsv(text);
    if (!rows.length) {
      return NextResponse.json({ ok: false, error: errors[0] ?? "No trades parsed", errors }, { status: 400 });
    }

    const dir = path.join(process.env.ALERT_DB_DIR || path.join(process.cwd(), "data"), "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${stamp}-${filename}`), text, "utf8");

    const {
      insertBrokerImport,
      journalDedupExists,
      insertJournal,
      findAlertForJournal,
    } = await import("@/lib/alert-store");

    const dates = rows.map((r) => r.openedAt ?? r.closedAt).filter(Boolean).sort() as string[];
    const batchId = insertBrokerImport({
      broker: "robinhood",
      filename,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      rowCount: 0,
    });

    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      if (journalDedupExists(r.dedupKey)) {
        skipped++;
        continue;
      }
      const alertId = findAlertForJournal(r.ticker, r.openedAt ?? r.closedAt);
      insertJournal({
        ticker: r.ticker,
        side: r.side,
        contract: r.contract,
        quantity: r.quantity,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        pnl: r.pnl,
        notes: r.notes,
        source: "robinhood_import",
        importBatchId: batchId,
        dedupKey: r.dedupKey,
        alertId: alertId ?? undefined,
      });
      inserted++;
    }

    const db = (await import("@/lib/db")).getDb();
    db.prepare("UPDATE broker_imports SET row_count=? WHERE id=?").run(inserted, batchId);

    return NextResponse.json({
      ok: true,
      inserted,
      skipped,
      batchId,
      warnings: errors,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "import failed" }, { status: 500 });
  }
}
