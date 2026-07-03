import type { Grade } from "@/lib/types";
import { gradeClasses, sideClasses } from "@/lib/format";

export function GradeChip({ grade }: { grade: Grade | string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${gradeClasses(grade)}`}
    >
      {grade}
    </span>
  );
}

export function SideBadge({ side }: { side: string | null | undefined }) {
  const label = side === "call" ? "CALL" : side === "put" ? "PUT" : "—";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${sideClasses(side)}`}
    >
      {label}
    </span>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const color =
    score >= 80 ? "bg-emerald-400" : score >= 65 ? "bg-sky-400" : score >= 50 ? "bg-amber-400" : "bg-zinc-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular w-7 text-right text-xs text-zinc-300">{Math.round(score)}</span>
    </div>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`tabular mt-0.5 text-sm font-semibold ${accent ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}
