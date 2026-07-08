"use client";

export function ConvictionRing({
  value,
  label = "CONVICTION",
  size = 200,
  bear = false,
}: {
  value: number;
  label?: string;
  size?: number;
  bear?: boolean;
}) {
  const r = 88;
  const c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, value));
  const offset = c * (1 - v / 100);

  return (
    <div className="ringwrap" style={{ width: size, height: size }}>
      <svg className="ring" viewBox="0 0 200 200" aria-hidden style={{ width: size, height: size }}>
        <circle className="ringbg" cx="100" cy="100" r={r} />
        <circle
          className="ringfg"
          cx="100"
          cy="100"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={bear ? { stroke: "#ff5162" } : undefined}
        />
      </svg>
      <div className="ringctr">
        <div className={`ringnum${bear ? " bear" : ""}`}>{Math.round(v)}</div>
        <div className="ringlbl">{label}</div>
      </div>
    </div>
  );
}
