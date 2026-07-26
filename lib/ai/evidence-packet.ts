/**
 * Deterministic evidence packets for advisory AI — numbers ground proposals.
 */
import { buildQuantLaneReport } from "../research/options/quant-lanes.ts";
import { buildShadowSoakAggregate } from "../research/options/shadow-outcomes.ts";
import { weeklyContextConfig } from "./weekly.ts";
import { listProposalsOnDb } from "./store.ts";

type PacketDb = {
  prepare: (sql: string) => {
    run: (...a: unknown[]) => unknown;
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
};

function hasTable(db: PacketDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface EvidencePacket {
  id: string;
  periodStartMs: number;
  periodEndMs: number;
  lanes: ReturnType<typeof buildQuantLaneReport>["lanes"];
  shadowSoak: ReturnType<typeof buildShadowSoakAggregate>;
  config: Record<string, unknown>;
  missingData: string[];
  rejectedProposals: Array<{ id: number; title: string; status: string }>;
  generatedAtMs: number;
}

export function buildEvidencePacket(
  db: PacketDb,
  input: { periodStartMs: number; periodEndMs: number; env?: NodeJS.ProcessEnv },
): EvidencePacket {
  const env = input.env ?? process.env;
  const quant = buildQuantLaneReport(db, env);
  const shadowSoak = buildShadowSoakAggregate(db, env, 14);
  const missingData: string[] = [];
  for (const lane of quant.lanes) {
    if (lane.insufficientEvidence) missingData.push(`lane:${lane.lane}:insufficient_sample`);
    if (lane.completenessPct < 50) missingData.push(`lane:${lane.lane}:low_completeness`);
  }
  const rejected = listProposalsOnDb(db as any, 30)
    .filter((p) => p.status === "REJECTED")
    .map((p) => ({ id: p.id, title: p.title, status: p.status }));

  return {
    id: `pkt_${input.periodEndMs}`,
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    lanes: quant.lanes,
    shadowSoak,
    config: weeklyContextConfig(env),
    missingData,
    rejectedProposals: rejected,
    generatedAtMs: Date.now(),
  };
}

export function persistEvidencePacketOnDb(db: PacketDb, packet: EvidencePacket): number | null {
  if (!hasTable(db, "ai_evidence_packets")) return null;
  try {
    const existing = db.prepare("SELECT id FROM ai_evidence_packets WHERE packet_id=?").get(packet.id) as { id?: number } | undefined;
    if (existing?.id) return Number(existing.id);
    const info = db.prepare(
      `INSERT INTO ai_evidence_packets (packet_id, period_start_ms, period_end_ms, packet_json, created_at_ms)
       VALUES (?,?,?,?,?)`,
    ).run(packet.id, packet.periodStartMs, packet.periodEndMs, JSON.stringify(packet), packet.generatedAtMs) as { lastInsertRowid?: number | bigint };
    return Number(info.lastInsertRowid ?? 0) || null;
  } catch {
    return null;
  }
}

export function loadEvidencePacketOnDb(db: PacketDb, packetId: string): EvidencePacket | null {
  if (!hasTable(db, "ai_evidence_packets")) return null;
  try {
    const row = db.prepare("SELECT packet_json FROM ai_evidence_packets WHERE packet_id=?").get(packetId) as { packet_json?: string } | undefined;
    if (!row?.packet_json) return null;
    return JSON.parse(row.packet_json) as EvidencePacket;
  } catch {
    return null;
  }
}
