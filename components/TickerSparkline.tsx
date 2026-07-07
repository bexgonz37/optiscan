"use client";

import { TickerIcon, Sparkline } from "@/components/ui";
import { fmtPrice } from "@/lib/format";

export function TickerSparkline({
  closes,
  direction,
  width = 72,
  height = 28,
}: {
  closes?: number[] | null;
  direction?: string | null;
  width?: number;
  height?: number;
}) {
  const color =
    direction === "bearish" ? "#ff5a72" : direction === "bullish" ? "#00d68f" : "#8798a8";
  if (!closes || closes.length < 2) {
    return <span className="sparkline-placeholder" style={{ width, height }} aria-hidden />;
  }
  return (
    <span className="ticker-sparkline" title="Today (5m)">
      <Sparkline values={closes} color={color} width={width} height={height} />
    </span>
  );
}

export function TickerWithSparkline({
  symbol,
  price,
  closes,
  direction,
  sub,
}: {
  symbol: string;
  price?: number | null;
  closes?: number[] | null;
  direction?: string | null;
  sub?: React.ReactNode;
}) {
  return (
    <div className="tkr tkr-with-spark">
      <TickerIcon symbol={symbol} />
      <div className="tkr-text">
        <div className="tname">{symbol}</div>
        <div className="tsub">{sub ?? fmtPrice(price)}</div>
      </div>
      <TickerSparkline closes={closes} direction={direction} />
    </div>
  );
}
