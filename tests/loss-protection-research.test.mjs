import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLossProtection } from "../lib/research/options/loss-protection-research.ts";
const START=Date.parse("2026-07-30T14:00:00Z");
const m=(min,bid,weakening=false,age=500)=>({atMs:START+min*60000,bid,ask:bid+.04,quoteAgeMs:age,weakening});
test("hard-loss exits are shadow-only and early weakness needs two confirmations",()=>{
 const input={tradeId:1,side:"call",dte:1,strategyFamily:"x",timeOfDay:"morning",entryAsk:1,enteredAtMs:START,canonicalReturnPct:-30,marks:[m(1,.94,true),m(2,.94,false),m(3,.88,true),m(4,.87,true)]};
 const before=structuredClone(input),out=analyzeLossProtection([input]),t=out.trades[0];
 assert.equal(t.policies.find(p=>p.policy==="Weakness exit -5%").evidenceValid,true,"two later weakening ticks confirm the exit");
 assert.equal(t.policies.find(p=>p.policy==="Weakness exit -10%").evidenceValid,true);
 assert.equal(t.policies.find(p=>p.policy==="Hard loss -10%").returnPct,-12);
 const oneTick=analyzeLossProtection([{...input,tradeId:3,marks:[m(1,.94,true)]}]);
 assert.equal(oneTick.trades[0].policies.find(p=>p.policy==="Weakness exit -5%").evidenceValid,false,"one negative/weak tick is insufficient");
 assert.equal(out.productionBehaviorChanged,false); assert.deepEqual(input,before);
});
test("stale and after-hours marks cannot trigger a loss policy",()=>{
 const out=analyzeLossProtection([{tradeId:2,side:"put",dte:0,strategyFamily:"x",timeOfDay:"late",entryAsk:1,enteredAtMs:Date.parse("2026-07-30T20:05:00Z"),canonicalReturnPct:null,marks:[{atMs:Date.parse("2026-07-30T20:10:00Z"),bid:.1,ask:.2,quoteAgeMs:0,weakening:true}]}]);
 assert.equal(out.trades[0].classification,"LIQUIDITY_OR_MARK_ERROR"); assert.equal(out.trades[0].policies.find(p=>p.policy==="Hard loss -10%").evidenceValid,false);
});
