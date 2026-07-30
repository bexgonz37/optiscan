/** Read-only aggregation over the existing exit and loss-protection replays. */
import { analyzeExitPolicies, type ExitResearchTrade } from "./exit-policy-research.ts";
import { analyzeLossProtection, type LossTrade } from "./loss-protection-research.ts";

export type PolicyVerdict = "PROFITABLE_SUPPORTED" | "LESS_BAD_THAN_CURRENT" | "INCONCLUSIVE" | "WORSE_THAN_CURRENT" | "INSUFFICIENT_SAMPLE";
type Row = { tradeId: number; side: string; dte: number | null; canonical: number | null; policy: string; result: number | null };
const median=(xs:number[])=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2};
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;

export function aggregateLossProtection(input: { exitTrades: ExitResearchTrade[]; lossTrades: LossTrade[]; minimumSupportedSample?: number }) {
  const minimum=input.minimumSupportedSample??30;
  const exit=analyzeExitPolicies(input.exitTrades,{minimumSupportedSample:minimum});
  const loss=analyzeLossProtection(input.lossTrades);
  const rows:Row[]=[];
  for(const t of exit.trades){const src=input.exitTrades.find(x=>x.tradeId===t.tradeId);for(const p of t.policies)rows.push({tradeId:t.tradeId,side:String(src?.side??"unknown"),dte:src?.dte??null,canonical:t.finalResultPct,policy:`Exit: ${p.policy}`,result:p.returnPct});}
  for(const t of loss.trades){const src=input.lossTrades.find(x=>x.tradeId===t.tradeId);for(const p of t.policies)rows.push({tradeId:t.tradeId,side:String(src?.side??"unknown"),dte:src?.dte??null,canonical:src?.canonicalReturnPct??null,policy:`Loss: ${p.policy}`,result:p.returnPct});}
  const policies=[...new Set(rows.map(r=>r.policy))].map(policy=>{const rs=rows.filter((r):r is Row & {canonical:number;result:number}=>r.policy===policy&&r.result!=null&&r.canonical!=null);const returns=rs.map(r=>r.result),improvements=rs.map(r=>r.result-r.canonical),gains=returns.filter(x=>x>0),losses=returns.filter(x=>x<0);const avg=mean(returns),improve=mean(improvements);const verdict:PolicyVerdict=rs.length<minimum?"INSUFFICIENT_SAMPLE":avg!=null&&avg>0?"PROFITABLE_SUPPORTED":improve!=null&&improve>0?"LESS_BAD_THAN_CURRENT":improve!=null&&improve<0?"WORSE_THAN_CURRENT":"INCONCLUSIVE";return {policy,eligibleSample:rs.length,excludedSample:0,callCount:rs.filter(r=>r.side==="call").length,putCount:rs.filter(r=>r.side==="put").length,zeroDteCount:rs.filter(r=>r.dte===0).length,nonZeroDteCount:rs.filter(r=>r.dte!=null&&r.dte>0).length,winRatePct:rs.length?gains.length/rs.length*100:null,averageReturnPct:avg,medianReturnPct:median(returns),totalPnlPoints:returns.reduce((a,b)=>a+b,0),profitFactor:losses.length?gains.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0)):null,largestLossPct:losses.length?Math.min(...losses):null,averageImprovementPct:improve,medianImprovementPct:median(improvements),savedBelow40:rs.filter(r=>r.canonical<-40&&r.result>-40).length,savedBelow30:rs.filter(r=>r.canonical<-30&&r.result>-30).length,winnersCutEarly:rs.filter(r=>r.canonical>r.result&&r.canonical>0).length,verdict};});
  const best=policies.filter(p=>p.verdict==="PROFITABLE_SUPPORTED"||p.verdict==="LESS_BAD_THAN_CURRENT").sort((a,b)=>(b.averageImprovementPct??-Infinity)-(a.averageImprovementPct??-Infinity))[0]??null;
  return {advisoryOnly:true as const,productionBehaviorChanged:false as const,exit,loss,policies,bestSupportedPolicy:best?.policy??null,limitations:["Policies reuse existing pure replays.","Negative average return is never labeled profitable.","No result changes canonical outcomes."]};
}
