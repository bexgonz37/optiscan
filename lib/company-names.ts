/**
 * company-names.ts — instant, zero-API-call names for the common universe.
 * Anything not here is resolved from Polygon's reference endpoint (cached ~24h)
 * in scan-core, so we avoid burning rate limit on names that never change.
 */

export const STATIC_NAMES: Record<string, string> = {
  // ETFs
  SPY: "S&P 500 ETF", QQQ: "Nasdaq 100 ETF", IWM: "Russell 2000 ETF", DIA: "Dow Jones ETF",
  VTI: "Total Market ETF", VOO: "Vanguard S&P 500", MDY: "S&P MidCap ETF", RSP: "S&P Equal Weight",
  XLK: "Technology Sector", XLF: "Financials Sector", XLE: "Energy Sector", XLV: "Health Care Sector",
  XLI: "Industrials Sector", XLY: "Cons. Discretionary", XLP: "Cons. Staples", XLU: "Utilities Sector",
  XLB: "Materials Sector", XLRE: "Real Estate Sector", XLC: "Communication Svcs",
  SMH: "Semiconductor ETF", SOXX: "iShares Semis", XBI: "Biotech ETF", IBB: "Nasdaq Biotech",
  ARKK: "ARK Innovation", XOP: "Oil & Gas E&P", XME: "Metals & Mining", XRT: "Retail ETF",
  KRE: "Regional Banks", KWEB: "China Internet", FXI: "China Large-Cap",
  GLD: "Gold Trust", SLV: "Silver Trust", USO: "US Oil Fund", UNG: "US Natural Gas",
  TLT: "20+ Yr Treasury", HYG: "High Yield Bond", GDX: "Gold Miners", GDXJ: "Jr Gold Miners",
  TQQQ: "3x Nasdaq Bull", SQQQ: "3x Nasdaq Bear", SOXL: "3x Semis Bull", SOXS: "3x Semis Bear",
  SPXL: "3x S&P Bull", SPXS: "3x S&P Bear", TNA: "3x Small Cap Bull", TZA: "3x Small Cap Bear",
  UVXY: "1.5x VIX Futures", VXX: "VIX Short-Term",
  // Mega / large caps
  AAPL: "Apple", MSFT: "Microsoft", NVDA: "NVIDIA", GOOGL: "Alphabet (A)", GOOG: "Alphabet (C)",
  AMZN: "Amazon", META: "Meta Platforms", TSLA: "Tesla", AVGO: "Broadcom", "BRK.B": "Berkshire (B)",
  LLY: "Eli Lilly", JPM: "JPMorgan", V: "Visa", MA: "Mastercard", UNH: "UnitedHealth",
  XOM: "Exxon Mobil", COST: "Costco", HD: "Home Depot", PG: "Procter & Gamble", JNJ: "Johnson & Johnson",
  ABBV: "AbbVie", NFLX: "Netflix", CRM: "Salesforce", BAC: "Bank of America", WMT: "Walmart",
  KO: "Coca-Cola", PEP: "PepsiCo", MRK: "Merck", AMD: "Adv. Micro Devices", ADBE: "Adobe",
  ORCL: "Oracle", CSCO: "Cisco", ACN: "Accenture", MCD: "McDonald's", DIS: "Disney",
  WFC: "Wells Fargo", TMO: "Thermo Fisher", ABT: "Abbott", INTC: "Intel", QCOM: "Qualcomm",
  TXN: "Texas Instruments", IBM: "IBM", GE: "GE Aerospace", CAT: "Caterpillar", NOW: "ServiceNow",
  INTU: "Intuit", AMAT: "Applied Materials", MU: "Micron", LRCX: "Lam Research", KLAC: "KLA Corp",
  PANW: "Palo Alto Networks", SNPS: "Synopsys", CDNS: "Cadence", ANET: "Arista Networks",
  MRVL: "Marvell", DELL: "Dell", SMCI: "Super Micro", ARM: "Arm Holdings", PLTR: "Palantir",
  CRWD: "CrowdStrike", GS: "Goldman Sachs", MS: "Morgan Stanley", AXP: "American Express",
  BLK: "BlackRock", SCHW: "Charles Schwab", C: "Citigroup", SPGI: "S&P Global", BX: "Blackstone",
  PYPL: "PayPal", SQ: "Block", BA: "Boeing", HON: "Honeywell", UNP: "Union Pacific",
  LMT: "Lockheed Martin", RTX: "RTX Corp", DE: "Deere", UPS: "UPS", FDX: "FedEx",
  GM: "General Motors", F: "Ford", NKE: "Nike", SBUX: "Starbucks", LOW: "Lowe's",
  TGT: "Target", BKNG: "Booking", MAR: "Marriott", ABNB: "Airbnb", UBER: "Uber",
  LYFT: "Lyft", DASH: "DoorDash", PFE: "Pfizer", BMY: "Bristol Myers", AMGN: "Amgen",
  GILD: "Gilead", CVS: "CVS Health", MDT: "Medtronic", ISRG: "Intuitive Surgical",
  VRTX: "Vertex Pharma", REGN: "Regeneron", MRNA: "Moderna", CVX: "Chevron", COP: "ConocoPhillips",
  SLB: "Schlumberger", EOG: "EOG Resources", OXY: "Occidental", PSX: "Phillips 66",
  MPC: "Marathon Petroleum", VLO: "Valero", WMB: "Williams Cos", KMI: "Kinder Morgan",
  T: "AT&T", VZ: "Verizon", TMUS: "T-Mobile", CMCSA: "Comcast", CHTR: "Charter",
  // Momentum names
  COIN: "Coinbase", MSTR: "MicroStrategy", HOOD: "Robinhood", SOFI: "SoFi", RIVN: "Rivian",
  LCID: "Lucid", NIO: "NIO", XPEV: "XPeng", LI: "Li Auto", BABA: "Alibaba",
  PDD: "PDD Holdings", JD: "JD.com", SHOP: "Shopify", SNAP: "Snap", PINS: "Pinterest",
  RBLX: "Roblox", U: "Unity", NET: "Cloudflare", DDOG: "Datadog", SNOW: "Snowflake",
  ZS: "Zscaler", MDB: "MongoDB", OKTA: "Okta", TTD: "Trade Desk", ROKU: "Roku",
  DOCU: "DocuSign", TWLO: "Twilio", AFRM: "Affirm", UPST: "Upstart", DKNG: "DraftKings",
  CVNA: "Carvana", CHWY: "Chewy", ETSY: "Etsy", W: "Wayfair", PLUG: "Plug Power",
  FCEL: "FuelCell", RUN: "Sunrun", ENPH: "Enphase", FSLR: "First Solar", SEDG: "SolarEdge",
  AI: "C3.ai", PATH: "UiPath", IONQ: "IonQ", RGTI: "Rigetti", SOUN: "SoundHound",
  BBAI: "BigBear.ai", TSM: "TSMC", ASML: "ASML", MPWR: "Monolithic Power", ON: "ON Semi",
  WDC: "Western Digital", STX: "Seagate", GME: "GameStop", AMC: "AMC Ent.", BB: "BlackBerry",
  DNA: "Ginkgo Bio", RKLB: "Rocket Lab", ACHR: "Archer Aviation", JOBY: "Joby Aviation",
  LUNR: "Intuitive Machines", TLRY: "Tilray", CGC: "Canopy Growth", RIOT: "Riot Platforms",
  MARA: "MARA Holdings", CLSK: "CleanSpark", HUT: "Hut 8", BITF: "Bitfarms", WULF: "TeraWulf",
  APP: "AppLovin", HIMS: "Hims & Hers", CELH: "Celsius", ELF: "e.l.f. Beauty", DUOL: "Duolingo",
  TOST: "Toast", GTLB: "GitLab", S: "SentinelOne", FUBO: "fuboTV", DJT: "Trump Media",
  SMR: "NuScale Power", OKLO: "Oklo",
};

export function companyName(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  return STATIC_NAMES[symbol.toUpperCase()] ?? null;
}
