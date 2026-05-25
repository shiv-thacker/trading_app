/**
 * test_force_buy.js
 * ==================
 * Manual paper-trade test — runs the full data + indicator pipeline and
 * force-executes one paper BUY per market (India, USA, Germany, Japan).
 *
 * Uses the exact same data modules as the production hourly cycle:
 *   India   → NSE free API  (Nifty 500 live scan)
 *   USA     → EODHD watchlist
 *   Germany → EODHD watchlist
 *   Japan   → Yahoo Finance (EODHD plan doesn't cover TSE stocks)
 *
 * Firestore writes use the firebase-tools OAuth token directly via REST API
 * (no service account needed — the CLI token has project-owner access).
 *
 * Run:   node test_force_buy.js
 * Reset: Flutter app → Settings → Reset Portfolio
 */

"use strict";
process.env.EODHD_API_KEY = "6a0bdd186fca12.67468049";

// ── Mock firebase-functions/logger ────────────────────────────────────────────
const Module = require("module");
const _orig  = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === "firebase-functions/logger" || req === "firebase-functions") {
    return {
      info:  (...a) => console.log (`  ℹ️  ${a.join(" ")}`),
      warn:  (...a) => console.warn(`  ⚠️  ${a.join(" ")}`),
      error: (...a) => console.error(`  ❌  ${a.join(" ")}`),
      debug: () => {},
    };
  }
  return _orig.apply(this, arguments);
};

// ── Lightweight Firestore REST client ─────────────────────────────────────────
const https   = require("https");
const fs      = require("fs");
const PROJECT = "trading-app-4ab30";

const _fbCfgPath = `${process.env.HOME}/.config/configstore/firebase-tools.json`;
const _fbCfg     = JSON.parse(fs.readFileSync(_fbCfgPath, "utf8"));
let _token       = _fbCfg.tokens.access_token;

// Convert JS value → Firestore REST field value
function toFSVal(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean")          return { booleanValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { integerValue: String(val) }
      : { doubleValue:  val };
  }
  if (typeof val === "string")           return { stringValue: val };
  if (Array.isArray(val))                return { arrayValue:  { values: val.map(toFSVal) } };
  if (val instanceof Date)               return { timestampValue: val.toISOString() };
  if (typeof val === "object")           return { mapValue: { fields: toFSFields(val) } };
  return { stringValue: String(val) };
}
function toFSFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFSVal(v);
  return fields;
}

// Convert Firestore REST field value → JS value
function fromFSVal(fv) {
  if (!fv) return null;
  if ("nullValue"      in fv) return null;
  if ("booleanValue"   in fv) return fv.booleanValue;
  if ("integerValue"   in fv) return Number(fv.integerValue);
  if ("doubleValue"    in fv) return fv.doubleValue;
  if ("stringValue"    in fv) return fv.stringValue;
  if ("timestampValue" in fv) return fv.timestampValue;
  if ("arrayValue"     in fv) return (fv.arrayValue.values || []).map(fromFSVal);
  if ("mapValue"       in fv) return fromFSFields(fv.mapValue.fields || {});
  return null;
}
function fromFSFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = fromFSVal(v);
  return obj;
}

function fsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify({ fields: toFSFields(body) }) : null;
    const opts    = {
      hostname: "firestore.googleapis.com",
      path:     `/v1/projects/${PROJECT}/databases/(default)/documents/${path}`,
      method,
      headers:  {
        Authorization:  `Bearer ${_token}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data",  d => data += d);
      res.on("end",   () => {
        try {
          const d = JSON.parse(data);
          if (d.error) return reject(new Error(`Firestore ${d.error.code}: ${d.error.message}`));
          resolve(d);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fsGet(collection, docId) {
  const res = await fsRequest("GET", `${collection}/${docId}`);
  return fromFSFields(res.fields || {});
}

async function fsPatch(collection, docId, data) {
  await fsRequest("PATCH", `${collection}/${docId}`, data);
}

async function fsAdd(collection, data) {
  const res = await fsRequest("POST", collection, data);
  return res.name?.split("/").pop();
}

// ── Portfolio helpers (mirrors firestore_db.js) ───────────────────────────────
const DEFAULT_PORTFOLIO = {
  baseCurrency: "INR", startingCapital: 100000, capitalINR: 100000,
  usdInrRate: 84.0, totalValueINR: 100000, holdings: [], recentSells: [],
  lastDaysHeldDate: null, lastUpdated: null,
};

async function getPortfolio() {
  try {
    const data = await fsGet("global_swing_portfolio", "state");
    return { ...DEFAULT_PORTFOLIO, ...data };
  } catch (e) {
    console.warn("  ⚠️  Portfolio doc not found — using defaults");
    return { ...DEFAULT_PORTFOLIO };
  }
}

function fxToINR(amount, currency, portfolio) {
  if (currency === "INR") return amount;
  if (currency === "EUR") return amount * (portfolio.eurInrRate || 90.0);
  if (currency === "JPY") return amount * (portfolio.jpyInrRate || 0.58);
  return amount * (portfolio.usdInrRate || 84.0);  // USD + unknown
}

function calcTotalValueINR(portfolio) {
  const holdingsValue = (portfolio.holdings || []).reduce((sum, h) => {
    const val = (h.currentPrice || h.avgBuyPrice || 0) * (h.quantity || 0);
    return sum + fxToINR(val, h.currency || "USD", portfolio);
  }, 0);
  return (portfolio.capitalINR || 0) + holdingsValue;
}

async function savePortfolio(portfolio) {
  portfolio.lastUpdated   = new Date().toISOString();
  portfolio.totalValueINR = calcTotalValueINR(portfolio);
  // Always persist current FX rates so Flutter app can display them correctly
  const toPersist = { ...portfolio };
  await fsPatch("global_swing_portfolio", "state", toPersist);
}

async function recordTrade(trade) {
  await fsAdd("global_swing_trades", {
    ...trade,
    timestamp:   { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    timestampMs: Date.now(),
  });
}

async function recordAILog(log) {
  await fsAdd("global_swing_ai_logs", {
    ...log,
    timestamp:   { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    timestampMs: Date.now(),
  });
}

async function recordSnapshot(portfolio) {
  await fsAdd("global_swing_portfolio/state/snapshots", {
    totalValueINR:  portfolio.totalValueINR,
    capitalINR:     portfolio.capitalINR,
    holdingsCount:  portfolio.holdings.length,
    timestamp:      { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    timestampMs:    Date.now(),
  });
}

// ── Trading modules ───────────────────────────────────────────────────────────
const { getLiveQuotes, getTopMovers, getLiveUsdInrRate, getLiveAllFxRates } = require("./global_swing/data/eodhd_live");
const { getBatchHistoricalCandles }                      = require("./global_swing/data/eodhd_history");
const { getNSEBroadMovers }                              = require("./global_swing/data/nse_live");
const { getJapanBroadMovers, getJapanBatchHistoricalCandles } = require("./global_swing/data/yahoo_japan");
const { computeIndicators }                             = require("./global_swing/analysis/technical");
const { MARKETS }                                       = require("./global_swing/config/markets");
const R                                                 = require("./global_swing/config/trading_rules");

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n, d = 2) { return (+(n || 0)).toFixed(d); }
function banner(s) { console.log(`\n${"─".repeat(55)}\n  ${s}\n${"─".repeat(55)}`); }

function pickBest(movers, candleMap) {
  const withInd = movers.map(m => ({
    ...m,
    indicators: computeIndicators(candleMap[m.symbol] || [], m.volume || 0),
  }));

  const valid = withInd.filter(m => {
    const i = m.indicators;
    return i.rsi >= R.MIN_RSI_ENTRY && i.rsi <= R.MAX_RSI_ENTRY && i.pctBelow52wHigh >= R.MAX_52W_HIGH_DIST_PCT;
  }).sort((a, b) => {
    // Rank: changePct 50% + pctBelow52wHigh 30% + volumeRatio 20%
    const s = m => m.changePct * 0.5 + m.indicators.pctBelow52wHigh * 0.3 + (m.indicators.volumeRatio * 10) * 0.2;
    return s(b) - s(a);
  });

  return { best: valid[0] || null, all: withInd };
}

// ── Market definitions ────────────────────────────────────────────────────────
const MARKET_DEFS = [
  {
    code: "NSE", label: "🇮🇳 India (NSE)", currency: "INR", country: "India",
    fetchMovers: async () => {
      let m = await getNSEBroadMovers(R.MIN_CHANGE_PCT, 200000, 30);
      if (m.length === 0) {
        console.log("    NSE API returned 0 → watchlist fallback");
        m = await getTopMovers(MARKETS.NSE.watchlist, R.MIN_CHANGE_PCT, 15);
      }
      return m;
    },
    fetchCandles: async (syms) => getBatchHistoricalCandles(syms),
  },
  {
    code: "US", label: "🇺🇸 USA (NYSE/NASDAQ)", currency: "USD", country: "USA",
    fetchMovers: async () => getTopMovers(MARKETS.US.watchlist, R.MIN_CHANGE_PCT, 20),
    fetchCandles: async (syms) => getBatchHistoricalCandles(syms),
  },
  {
    code: "XETRA", label: "🇩🇪 Germany (XETRA)", currency: "EUR", country: "Germany",
    fetchMovers: async () => getTopMovers(MARKETS.XETRA.watchlist, 0.3, 20),
    fetchCandles: async (syms) => getBatchHistoricalCandles(syms),
  },
  {
    code: "T", label: "🇯🇵 Japan (TSE via Yahoo Finance)", currency: "JPY", country: "Japan",
    fetchMovers: async () => getJapanBroadMovers(MARKETS.T.watchlist, R.MIN_CHANGE_PCT, 25),
    fetchCandles: async (syms) => getJapanBatchHistoricalCandles(syms),
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  ARJUN Global Swing — FORCE BUY TEST (Paper Trading)║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Time: ${new Date().toISOString().replace("T"," ").slice(0,19)} UTC`);

  // ── Load portfolio ─────────────────────────────────────────
  const portfolio = await getPortfolio();
  const fxRates   = await getLiveAllFxRates();
  portfolio.usdInrRate = fxRates.USD;
  portfolio.eurInrRate = fxRates.EUR;
  portfolio.jpyInrRate = fxRates.JPY;
  portfolio.totalValueINR = calcTotalValueINR(portfolio);

  console.log(`\n  💼 Portfolio loaded:`);
  console.log(`     Cash      : ₹${fmt(portfolio.capitalINR, 0)}`);
  console.log(`     Holdings  : ${portfolio.holdings.length}/${R.MAX_TOTAL_HOLDINGS}`);
  console.log(`     Total     : ₹${fmt(portfolio.totalValueINR, 0)}`);
  console.log(`     USD/INR   : ₹${fxRates.USD} | EUR/INR: ₹${fxRates.EUR} | JPY/INR: ₹${fxRates.JPY}`);

  const executed = [];
  const skipped  = [];

  for (const mkt of MARKET_DEFS) {
    banner(`${mkt.label}`);

    // Portfolio limit checks
    if (portfolio.holdings.length >= R.MAX_TOTAL_HOLDINGS) {
      console.log(`  ⛔ Portfolio full (${R.MAX_TOTAL_HOLDINGS} positions max)`);
      skipped.push({ market: mkt.code, reason: "Portfolio full" });
      continue;
    }
    const inMkt = portfolio.holdings.filter(h => h.market === mkt.code).length;
    if (inMkt >= R.MAX_HOLDINGS_PER_MARKET) {
      console.log(`  ⛔ Already ${R.MAX_HOLDINGS_PER_MARKET} positions in ${mkt.code}`);
      skipped.push({ market: mkt.code, reason: "Market limit reached" });
      continue;
    }

    // ── Step 1: Live movers ─────────────────────────────────
    console.log(`\n  📡 STEP 1 — Fetching live movers...`);
    let movers;
    try {
      movers = await mkt.fetchMovers();
    } catch (err) {
      console.error(`  ❌ Movers fetch failed: ${err.message}`);
      skipped.push({ market: mkt.code, reason: err.message });
      continue;
    }

    if (!movers.length) {
      console.log(`  ⚠️  0 movers returned (market closed or API unavailable)`);
      skipped.push({ market: mkt.code, reason: "0 movers returned" });
      continue;
    }
    console.log(`  ✅ ${movers.length} movers found`);
    console.log(`     Top 5: ${movers.slice(0,5).map(m => `${m.symbol}(+${fmt(m.changePct)}%)`).join(", ")}`);

    // ── Step 2: Historical OHLCV (60-day) ──────────────────
    const scanSymbols = movers.slice(0, 15).map(m => m.symbol);
    console.log(`\n  📈 STEP 2 — Fetching 60-day OHLCV for ${scanSymbols.length} stocks...`);
    let candleMap;
    try {
      candleMap = await mkt.fetchCandles(scanSymbols);
    } catch (err) {
      console.error(`  ❌ Candles fetch failed: ${err.message}`);
      skipped.push({ market: mkt.code, reason: err.message });
      continue;
    }
    const withCandles = Object.keys(candleMap).filter(s => (candleMap[s]||[]).length > 10).length;
    console.log(`  ✅ Candles received for ${withCandles}/${scanSymbols.length} symbols`);

    // ── Step 3: Compute indicators + rank ───────────────────
    console.log(`\n  🔢 STEP 3 — Computing RSI / EMA / 52W / Volume indicators...`);
    const { best, all } = pickBest(movers.slice(0, 15), candleMap);

    console.log(`\n     Candidate breakdown:`);
    console.log(`     ${"Symbol".padEnd(14)} ${"Chg%".padStart(6)} ${"RSI".padStart(4)} ${"52wBel%".padStart(8)} ${"VolRat".padStart(7)} ${"Trend".padEnd(9)} ${"Pass?"}`);
    console.log(`     ${"-".repeat(60)}`);
    for (const s of all.slice(0, 10)) {
      const i   = s.indicators;
      const ok  = i.rsi >= R.MIN_RSI_ENTRY && i.rsi <= R.MAX_RSI_ENTRY && i.pctBelow52wHigh >= R.MAX_52W_HIGH_DIST_PCT;
      const row = [
        s.symbol.padEnd(14),
        `+${fmt(s.changePct)}%`.padStart(6),
        String(i.rsi).padStart(4),
        `${fmt(i.pctBelow52wHigh)}%`.padStart(8),
        `${i.volumeRatio}x`.padStart(7),
        (i.trend || "?").padEnd(9),
        ok ? "✅ PASS" : "❌ fail",
      ];
      console.log(`     ${row.join(" ")}`);
    }

    if (!best) {
      console.log(`\n  ⚠️  No candidate passed RSI (${R.MIN_RSI_ENTRY}–${R.MAX_RSI_ENTRY}) + 52W (≥${R.MAX_52W_HIGH_DIST_PCT}%) filters`);
      console.log(`     Market may be overextended (stocks near 52W highs)`);
      skipped.push({ market: mkt.code, reason: "No candidate passed RSI/52W filters" });
      continue;
    }

    console.log(`\n  ⭐ Best: ${best.symbol} | +${fmt(best.changePct)}% today | RSI=${best.indicators.rsi} | ${fmt(best.indicators.pctBelow52wHigh)}% below 52wHigh | Vol ratio=${best.indicators.volumeRatio}x`);

    // ── Step 4: Size position ───────────────────────────────
    const budgetINR = Math.min(
      portfolio.capitalINR * 0.22,                                     // 22% of cash
      portfolio.totalValueINR * R.MAX_POSITION_PCT - 1,               // max position size cap
      portfolio.capitalINR - R.MIN_CASH_RESERVE_INR                   // keep reserve
    );

    if (budgetINR < 1000) {
      console.log(`  ⛔ Insufficient capital (budget: ₹${fmt(budgetINR, 0)})`);
      skipped.push({ market: mkt.code, reason: "Insufficient capital" });
      continue;
    }

    const priceInINR = fxToINR(best.price, mkt.currency, portfolio);
    const quantity   = Math.max(1, Math.floor(budgetINR / priceInINR));
    const totalAmt   = best.price * quantity;
    const totalINR   = fxToINR(totalAmt, mkt.currency, portfolio);
    const stopLoss   = Math.round(best.price * (1 + R.STOP_LOSS_PCT / 100) * 100) / 100;
    const target     = Math.round(best.price * (1 + R.TAKE_PROFIT_FULL_PCT / 100) * 100) / 100;

    // ── Step 5: Execute paper BUY ───────────────────────────
    console.log(`\n  🛒 STEP 4 — Executing paper BUY:`);
    console.log(`     Symbol   : ${best.symbol}  (${mkt.country})`);
    console.log(`     Price    : ${best.price} ${mkt.currency}  (= ₹${fmt(priceInINR, 2)})`);
    console.log(`     Quantity : ${quantity} shares`);
    console.log(`     Total    : ${fmt(totalAmt, 2)} ${mkt.currency}  (= ₹${fmt(totalINR, 0)})`);
    console.log(`     Stop     : ${stopLoss} ${mkt.currency}  (-${Math.abs(R.STOP_LOSS_PCT)}%)`);
    console.log(`     Target   : ${target} ${mkt.currency}  (+${R.TAKE_PROFIT_FULL_PCT}%)`);

    // Deduct from portfolio cash using correct FX rate
    portfolio.capitalINR -= fxToINR(totalAmt, mkt.currency, portfolio);
    const holding = {
      symbol: best.symbol, market: mkt.code, country: mkt.country,
      currency: mkt.currency, quantity, avgBuyPrice: best.price,
      currentPrice: best.price, unrealizedPnl: 0, unrealizedPnlPct: 0, unrealizedPnlINR: 0,
      stopLoss, target, buyTimestamp: Date.now(), daysHeld: 0, cyclesHeld: 0,
      marketMoodAtEntry: "BULLISH", tradeType: "SWING_BUY",
    };
    portfolio.holdings.push(holding);
    portfolio.totalValueINR = calcTotalValueINR(portfolio);

    // Write trade to Firestore
    try {
      await recordTrade({
        symbol: best.symbol, market: mkt.code, country: mkt.country,
        currency: mkt.currency, action: "BUY", quantity, price: best.price,
        totalAmount: totalAmt, tradeType: "SWING_BUY",
        stopLoss, target, pnl: 0, pnlPct: 0, pnlINR: 0, daysHeld: 0,
        marketMoodAtEntry: "BULLISH",
        reason: `Test buy — +${fmt(best.changePct)}% today | RSI=${best.indicators.rsi} | ${fmt(best.indicators.pctBelow52wHigh)}% below 52wHigh`,
        portfolioValueAfter: portfolio.totalValueINR,
      });
      executed.push({ market: mkt.code, symbol: best.symbol, price: best.price, quantity, totalINR,
        changePct: best.changePct, rsi: best.indicators.rsi, pctBelow: best.indicators.pctBelow52wHigh });
      console.log(`\n  ✅ BUY written to Firestore → global_swing_trades`);
      console.log(`     Cash remaining: ₹${fmt(portfolio.capitalINR, 0)} | Portfolio: ₹${fmt(portfolio.totalValueINR, 0)}`);
    } catch (err) {
      console.error(`  ❌ Firestore write failed: ${err.message}`);
      // Roll back in-memory changes
      portfolio.holdings.pop();
      portfolio.capitalINR += totalINR;
      skipped.push({ market: mkt.code, reason: `Firestore error: ${err.message}` });
    }
  }

  // ── Persist portfolio ──────────────────────────────────────
  banner("Saving portfolio state...");
  try {
    portfolio.totalValueINR = calcTotalValueINR(portfolio);
    await savePortfolio(portfolio);
    await recordSnapshot(portfolio);
    await recordAILog({
      cycleStatus:     executed.length > 0 ? "TRADED" : "WAITED",
      tradeCount:      executed.length,
      marketsAnalyzed: ["NSE", "US", "XETRA", "T"],
      bullishMarkets:  executed.map(t => t.market),
      openMarkets:     ["NSE", "US", "XETRA", "T"],
      portfolioHealth: "STRONG",
      marketAnalysis:  `Force-buy test: ${executed.length} paper trades executed across [${executed.map(t=>t.market).join(", ")||"none"}].`,
      thoughts:        executed.map(t => `TEST BUY ${t.market}: ${t.symbol} @ ${t.price} | +${fmt(t.changePct)}% today | RSI=${t.rsi} | ${fmt(t.pctBelow)}% below 52wHigh`),
      nextFocus:       "Reset portfolio in Flutter app after verifying trades appear.",
    });
    console.log("  ✅ Portfolio, snapshot and AI log saved to Firestore");
  } catch (err) {
    console.error(`  ❌ Save failed: ${err.message}`);
  }

  // ── Final summary ──────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║                      RESULTS                        ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Trades executed : ${String(executed.length).padEnd(33)}║`);
  console.log(`║  Markets skipped : ${String(skipped.length).padEnd(33)}║`);
  console.log("╠══════════════════════════════════════════════════════╣");

  if (executed.length > 0) {
    console.log("║  ✅ Bought:                                          ║");
    for (const t of executed) {
      const line = `  ${t.market.padEnd(6)} ${t.symbol.padEnd(14)} ${t.quantity}× @ ${t.price}  ₹${fmt(t.totalINR, 0)}`;
      console.log(`║ ${line.padEnd(52)}║`);
    }
  }
  if (skipped.length > 0) {
    console.log("║  ⏭️  Skipped:                                        ║");
    for (const s of skipped) {
      const line = `  ${s.market.padEnd(6)} ${s.reason.slice(0,44)}`;
      console.log(`║ ${line.padEnd(52)}║`);
    }
  }
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Final value  : ₹${fmt(portfolio.totalValueINR, 0).padEnd(35)}║`);
  console.log(`║  Cash left    : ₹${fmt(portfolio.capitalINR, 0).padEnd(35)}║`);
  console.log(`║  Open pos     : ${String(portfolio.holdings.length).padEnd(36)}║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  Check Flutter → Portfolio + Trade History screens  ║");
  console.log("║  Reset via Settings → Reset Portfolio when done     ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  process.exit(0);
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  console.error(err.stack);
  process.exit(1);
});
