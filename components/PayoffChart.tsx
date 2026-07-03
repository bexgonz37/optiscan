"use client";

import { useEffect, useRef } from "react";
import type { OptionContract } from "@/lib/types";
import { payoffCurve } from "@/lib/economics";

export function PayoffChart({
  contract,
  underlyingPrice,
}: {
  contract: OptionContract | null;
  underlyingPrice: number | null;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const data = payoffCurve(contract, underlyingPrice);
    const W = (cv.width = cv.clientWidth * 2);
    const H = (cv.height = 300);
    ctx.scale(1, 1);
    ctx.clearRect(0, 0, W, H);
    if (!data) return;

    const pad = 16;
    const maxAbs = Math.max(...data.pnl.map((v) => Math.abs(v)), 1);
    const zeroY = H / 2;
    const px = (i: number) => pad + (i / (data.pnl.length - 1)) * (W - 2 * pad);
    const py = (v: number) => zeroY - (v / maxAbs) * (H / 2 - pad);

    // zero line
    ctx.strokeStyle = "rgba(120,140,160,.25)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(pad, zeroY);
    ctx.lineTo(W - pad, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // profit/loss gradient fill under the curve
    ctx.beginPath();
    data.pnl.forEach((v, i) => {
      const X = px(i);
      const Y = py(v);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.lineTo(px(data.pnl.length - 1), zeroY);
    ctx.lineTo(px(0), zeroY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(0,214,143,.35)");
    grad.addColorStop(0.5, "rgba(0,214,143,.04)");
    grad.addColorStop(0.5, "rgba(255,90,114,.04)");
    grad.addColorStop(1, "rgba(255,90,114,.3)");
    ctx.fillStyle = grad;
    ctx.fill();

    // curve
    ctx.beginPath();
    data.pnl.forEach((v, i) => {
      const X = px(i);
      const Y = py(v);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.strokeStyle = "#00d68f";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.stroke();

    // breakeven marker (where pnl crosses zero)
    for (let i = 1; i < data.pnl.length; i++) {
      if ((data.pnl[i - 1] < 0) !== (data.pnl[i] < 0)) {
        ctx.beginPath();
        ctx.arc(px(i), zeroY, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "#0b0f14";
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    // current underlying price marker
    if (underlyingPrice && underlyingPrice > 0 && underlyingPrice >= data.minPrice && underlyingPrice <= data.maxPrice) {
      const frac = (underlyingPrice - data.minPrice) / (data.maxPrice - data.minPrice);
      const X = pad + frac * (W - 2 * pad);
      ctx.strokeStyle = "rgba(58,208,255,.6)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X, pad);
      ctx.lineTo(X, H - pad);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [contract, underlyingPrice]);

  return <canvas ref={ref} className="payoff" style={{ width: "100%", height: 150 }} />;
}
