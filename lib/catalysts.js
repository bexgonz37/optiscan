/**
 * catalysts.js — pure catalyst classification from real news headlines.
 *
 * Data source: Polygon/Massive's news endpoint (/v2/reference/news, included
 * with the existing API key — see fetchNews in polygon-provider.js). Headlines
 * are classified by keyword tables below. NOTHING here is fabricated: if no
 * news exists for a ticker, the catalyst is "no_clear_catalyst" with quality
 * "unknown" (or "social_momentum"/weak when volume alone is screaming).
 *
 * Known limitation, on purpose: headline keywords are decent for earnings /
 * analyst / FDA-style events and weak for vibes-based moves. Social momentum
 * is INFERRED (high relative volume + zero news), never claimed from data we
 * don't have. Sympathy categories (crypto / AI-semis / macro) are keyword
 * matches on headlines, not a statistical correlation engine.
 *
 * Pure functions, no network — safe to unit test.
 */

export const CATALYST_TYPES = [
  "earnings",
  "guidance",
  "analyst",
  "fda_biotech",
  "partnership",
  "product_launch",
  "legal_regulatory",
  "sec_filing",
  "ma_acquisition",
  "macro_sector",
  "crypto_sympathy",
  "ai_semiconductor_sympathy",
  "social_momentum",
  "no_clear_catalyst",
];

/**
 * Keyword table. Each entry: [regex, strength 1-3].
 * Strength: 3 = the event itself ("FDA approval"), 2 = strong signal wording,
 * 1 = weak/ambient mention. Highest-strength match wins; ties break by table
 * order (earnings first — it's the most common and most specific).
 */
const RULES = {
  earnings: [
    [/\b(earnings|eps|q[1-4]\s*(results|revenue)|quarterly results|beats? (estimates|expectations)|miss(es|ed)? (estimates|expectations)|revenue (up|down|rose|fell))\b/i, 3],
    [/\b(reports? (fiscal|financial|record)|pre-?announc|earnings call)\b/i, 2],
  ],
  guidance: [
    [/\b((raises?|cuts?|lowers?|boosts?|hikes?) (full[- ]year |fy |annual )?(guidance|outlook|forecast)|guidance (raised|cut|lowered))\b/i, 3],
    [/\bguidance\b/i, 1],
  ],
  analyst: [
    [/\b(upgrad(e|es|ed)|downgrad(e|es|ed)|initiat(es|ed) coverage|price target (raised|cut|lowered|hiked|boosted))\b/i, 3],
    [/\b(overweight|underweight|outperform|underperform|buy rating|sell rating|neutral rating)\b/i, 2],
    [/\b(analyst|price target)\b/i, 1],
  ],
  fda_biotech: [
    [/\b(fda (approval|approves|approved|clearance|clears|cleared)|breakthrough (therapy|device)|phase (1|2|3|i{1,3})\b.*(topline|results|data|met|failed)|crl\b|complete response letter|priority review|fast track)/i, 3],
    [/\b(clinical trial|fda|nda|bla|ind\b|pdufa)\b/i, 2],
    [/\b(biotech|drug candidate)\b/i, 1],
  ],
  ma_acquisition: [
    [/\b(acqui(re|res|red|sition)|merger|buyout|takeover|to acquire|tender offer|go(es|ing) private)\b/i, 3],
  ],
  partnership: [
    [/\b(strategic (partnership|investment)|joint venture)\b/i, 3],
    [/\b(partnership|collaborat|teams? up|signs? (deal|agreement|contract))\b/i, 2],
  ],
  sec_filing: [
    [/\b(8-k|10-q|10-k|13[df]\b|s-1|424b|prospectus|registered direct|secondary offering|share (offering|dilution)|files? (with the sec|form))\b/i, 3],
    [/\b(sec filing|proxy statement)\b/i, 2],
  ],
  product_launch: [
    [/\b(launch(es|ed)?|unveil(s|ed)?|debuts?|introduc(es|ed)|announces? new)\b.*\b(product|platform|chip|model|device|service|feature|ai)\b/i, 3],
    [/\b(new product|product line|rollout|ships?)\b/i, 2],
  ],
  legal_regulatory: [
    [/\b(lawsuit|sues?|settlement|doj|ftc|sec (probe|investigation|charges)|antitrust|fined?|court rul|injunction|recall)\b/i, 3],
    [/\b(investigation|regulator|probe|subpoena|compliance)\b/i, 2],
  ],
  macro_sector: [
    [/\b(fed|fomc|rate (cut|hike|decision)|cpi|inflation|jobs report|tariff|opec|oil price|sector rally|treasury yield)\b/i, 2],
    [/\b(macro|sector|peers?|sympathy)\b/i, 1],
  ],
  crypto_sympathy: [
    [/\b(bitcoin|btc\b|ethereum|crypto(currency)? (rally|surge|slump|price)|digital asset)\b/i, 2],
  ],
  ai_semiconductor_sympathy: [
    [/\b(ai (demand|boom|spending|chips?)|semiconductor (rally|demand|cycle)|data center (demand|buildout)|gpu demand|chip (stocks?|sector|demand))\b/i, 2],
  ],
  social_momentum: [
    [/\b(meme stock|short squeeze|reddit|wallstreetbets|retail (frenzy|traders)|trending)\b/i, 3],
    [/\b(momentum|surge[sd]?|soar(s|ed)?|rocket)\b/i, 1],
  ],
};

/** Classify one headline: best {type, strength, keyword} or null. */
export function classifyHeadline(title) {
  const text = String(title || "");
  if (!text) return null;
  let best = null;
  for (const type of Object.keys(RULES)) {
    for (const [re, strength] of RULES[type]) {
      const m = text.match(re);
      if (m && (!best || strength > best.strength)) {
        best = { type, strength, keyword: m[0].toLowerCase() };
      }
    }
  }
  return best;
}

const DAY_MS = 86400000;

/**
 * Classify a ticker's catalyst from its recent news items.
 *
 * Quality rules (documented so the numbers aren't magic):
 *   strong  — a strength-3 headline published within the last 36h
 *   medium  — strength-3 older than 36h (≤3d), or strength-2 within 36h
 *   weak    — any other match within 3 days
 *   stale   — best match is older than 3 days (old news, fresh move)
 *   unknown — no classifiable news
 * No news at all + relVol >= 3 -> social_momentum / weak ("volume with no
 * story" is itself a recognizable, low-quality catalyst).
 *
 * @param {Array} items [{ title, publishedAt (ms or ISO), publisher, url }]
 * @param {object} opts { nowMs, relVol }
 */
export function classifyCatalyst(items = [], opts = {}) {
  const nowMs = Number(opts.nowMs ?? Date.now());
  const relVol = Number(opts.relVol ?? 0);

  const scored = [];
  for (const it of items || []) {
    const cls = classifyHeadline(it?.title);
    if (!cls) continue;
    const ts = typeof it.publishedAt === "number" ? it.publishedAt : Date.parse(it.publishedAt ?? "");
    const ageMs = Number.isFinite(ts) ? nowMs - ts : Infinity;
    if (ageMs > 7 * DAY_MS || ageMs < -DAY_MS) continue; // too old to matter, or bogus timestamp
    scored.push({ ...cls, item: it, ageMs });
  }

  if (!scored.length) {
    if (relVol >= 3) {
      return {
        type: "social_momentum",
        quality: "weak",
        summary: `No news found; inferred from ${relVol}x relative volume`,
        source: "inferred",
        records: [],
      };
    }
    return { type: "no_clear_catalyst", quality: "unknown", summary: "No recent news found", source: "polygon-news", records: [] };
  }

  // Best = highest strength, then freshest.
  scored.sort((a, b) => b.strength - a.strength || a.ageMs - b.ageMs);
  const best = scored[0];
  const fresh = best.ageMs <= 36 * 3600 * 1000;
  const stale = best.ageMs > 3 * DAY_MS; // matched, but old news vs today's move
  const quality = stale
    ? "stale"
    : best.strength >= 3 ? (fresh ? "strong" : "medium") : best.strength === 2 ? (fresh ? "medium" : "weak") : "weak";

  return {
    type: best.type,
    quality,
    summary: String(best.item.title).slice(0, 200),
    source: best.item.publisher || "polygon-news",
    records: scored.slice(0, 5).map((s) => ({
      headline: String(s.item.title).slice(0, 300),
      publisher: s.item.publisher ?? null,
      publishedAt: typeof s.item.publishedAt === "number" ? new Date(s.item.publishedAt).toISOString() : s.item.publishedAt ?? null,
      url: s.item.url ?? null,
      catalystType: s.type,
      quality: s.strength >= 3 ? "strong" : s.strength === 2 ? "medium" : "weak",
      matchedKeywords: s.keyword,
    })),
  };
}
