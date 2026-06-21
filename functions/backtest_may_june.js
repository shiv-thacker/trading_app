#!/usr/bin/env node
/**
 * backtest_may_june.js
 * Rule-based daily backtest: 2026-05-01 → 2026-06-19 (EOD simulation).
 * Uses same entry/exit rules as global_swing (no Claude — top technical score).
 *
 * Usage: EODHD_API_KEY=xxx node backtest_may_june.js
 */

process.env.EODHD_API_KEY = process.env.EODHD_API_KEY || "6a0bdd186fca12.67468049";

const axios = require("axios");
const R     = require("./global_swing/config/trading_rules");
const { MARKETS } = require("./global_swing/config/markets");
const { computeIndicators } = require("./global_swing/analysis/technical");
const { passesEntryFilter } = require("./global_swing/analysis/news_rules");

const START = "2026-05-01";
const END   = "2026-06-19";
const START_CAPITAL_INR = 100000;
const FX = { USD: 94.31, EUR: 108.19, JPY: 0.5846 };

const INDEX = {
  NSE:   "NSEI.INDX",
  US:    "GSPC.INDX",
  XETRA: "GDAXI.INDX",
  T:     "N225.INDX",
};

const WATCHLIST_LIMIT = 18;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toYahooNs(sym) { return sym.replace(/\.NSE$/i, ".NS"); }

function isWeekday(dateStr, tz) {
  const d = new Date(`${dateStr}T12:00:00`);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return wd !== "Sat" && wd !== "Sun";
}

function tradingDays(from, to) {
  const days = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function fetchEodhdEod(symbol, from, to) {
  const key = process.env.EODHD_API_KEY;
  const url = `https://eodhd.com/api/eod/${symbol}`;
  const { data } = await axios.get(url, {
    params: { api_token: key, fmt: "json", from, to },
    timeout: 15000,
  });
  if (!Array.isArray(data)) return [];
  return data.filter(c => c.date && c.close).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchYahooEod(yahooSym, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}`;
  const { data } = await axios.get(url, {
    params: { interval: "1d", range, includePrePost: false },
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Backtest/1.0)" },
    timeout: 15000,
  });
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const q  = result.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split("T")[0],
    open: Number(q.open?.[i] || 0),
    high: Number(q.high?.[i] || 0),
    low:  Number(q.low?.[i] || 0),
    close: Number(q.close?.[i] || 0),
    adjusted_close: Number(q.close?.[i] || 0),
    volume: Number(q.volume?.[i] || 0),
  })).filter(c => c.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

function candlesUpTo(all, dateStr) {
  return all.filter(c => c.date <= dateStr);
}

function candleOn(all, dateStr) {
  return all.find(c => c.date === dateStr);
}

function prevCandle(all, dateStr) {
  const idx = all.findIndex(c => c.date === dateStr);
  if (idx <= 0) return null;
  return all[idx - 1];
}

function changePctOnDay(all, dateStr) {
  const cur = candleOn(all, dateStr);
  const prev = prevCandle(all, dateStr);
  if (!cur || !prev || !prev.close) return null;
  return Math.round(((cur.close - prev.close) / prev.close) * 10000) / 100;
}

function moodOnDay(indexCandles, dateStr) {
  const todayPct = changePctOnDay(indexCandles, dateStr) ?? 0;
  const hist = candlesUpTo(indexCandles, dateStr);
  let fiveDay = 0;
  if (hist.length >= 6) {
    const slice = hist.slice(-6);
    const oldest = slice[0].close;
    const newest = slice[slice.length - 1].close;
    if (oldest > 0) fiveDay = Math.round(((newest - oldest) / oldest) * 10000) / 100;
  }
  const score = Math.round((todayPct * 2 + fiveDay * 1) * 100) / 100;
  let mood = "BEARISH";
  if (score >= R.BULLISH_SCORE_THRESHOLD) mood = "BULLISH";
  else if (score >= R.NEUTRAL_SCORE_THRESHOLD) mood = "NEUTRAL";
  return { mood, score, todayPct, fiveDay };
}

function toINR(amount, currency) {
  if (currency === "INR") return amount;
  if (currency === "USD") return amount * FX.USD;
  if (currency === "EUR") return amount * FX.EUR;
  if (currency === "JPY") return amount * FX.JPY;
  return amount * FX.USD;
}

function portfolioValue(portfolio) {
  let v = portfolio.capitalINR;
  for (const h of portfolio.holdings) {
    v += toINR(h.quantity * (h.currentPrice || h.avgBuyPrice), h.currency);
  }
  return v;
}

function calcConfidence(ind, changePct) {
  let s = 8;
  if (ind.rsi >= 52 && ind.rsi <= 62) s += 2;
  if (ind.volumeRatio >= 1.4) s += 2;
  if (changePct >= 2.5 && changePct <= 5) s += 1;
  if (ind.pctBelow52wHigh >= 8) s += 1;
  if (ind.trend === "UPTREND") s += 1;
  return Math.min(15, s);
}

function positionSizeINR(score) {
  if (score >= R.SCORE_HIGH_THRESHOLD) return R.POSITION_SIZE_HIGH;
  if (score >= R.SCORE_MID_THRESHOLD) return R.POSITION_SIZE_MID;
  return R.POSITION_SIZE_BASE;
}

function canBuy(portfolio, trade, totalValue) {
  if (portfolio.holdings.length >= R.MAX_TOTAL_HOLDINGS) return false;
  if (portfolio.holdings.filter(h => h.market === trade.market).length >= R.MAX_HOLDINGS_PER_MARKET) return false;
  if (portfolio.holdings.some(h => h.symbol === trade.symbol)) return false;
  const cost = toINR(trade.totalAmount, trade.currency);
  if (portfolio.capitalINR - cost < R.MIN_CASH_RESERVE_INR) return false;
  if (cost > totalValue * R.MAX_POSITION_PCT) return false;
  return true;
}

async function loadHistory() {
  const from = "2026-03-01";
  const to   = END;
  console.log("Loading index history...");
  const indexHist = {};
  for (const [code, sym] of Object.entries(INDEX)) {
    indexHist[code] = await fetchEodhdEod(sym, from, to);
    await sleep(250);
  }

  console.log("Loading stock history (watchlists)...");
  const stockHist = {};
  for (const [code, market] of Object.entries(MARKETS)) {
    const syms = market.watchlist.slice(0, WATCHLIST_LIMIT);
    for (const sym of syms) {
      if (sym.endsWith(".NSE")) {
        stockHist[sym] = await fetchYahooEod(toYahooNs(sym));
      } else if (sym.endsWith(".T")) {
        stockHist[sym] = await fetchYahooEod(sym);
      } else {
        stockHist[sym] = await fetchEodhdEod(sym, from, to);
      }
      await sleep(200);
    }
    console.log(`  ${code}: ${syms.length} symbols loaded`);
  }
  return { indexHist, stockHist };
}

function processExits(portfolio, dateStr, stockHist, trades) {
  for (const h of [...portfolio.holdings]) {
    const candles = stockHist[h.symbol];
    const c = candleOn(candles, dateStr);
    if (!c) continue;
    h.currentPrice = c.close;
    h.unrealizedPnlPct = Math.round(((c.close - h.avgBuyPrice) / h.avgBuyPrice) * 10000) / 100;

    let sellQty = 0;
    let reason = null;

    if (h.unrealizedPnlPct <= R.STOP_LOSS_PCT) {
      sellQty = h.quantity; reason = "STOP_LOSS";
    } else if (h.unrealizedPnlPct >= R.TAKE_PROFIT_FULL_PCT) {
      sellQty = h.quantity; reason = "TAKE_PROFIT_FULL";
    } else if (h.daysHeld >= R.TIME_STOP_STAGE2_DAYS && h.unrealizedPnlPct < R.TIME_STOP_STAGE2_MIN_PCT) {
      sellQty = h.quantity; reason = "TIME_STOP_14";
    } else if (h.daysHeld >= R.TIME_STOP_STAGE1_DAYS && h.unrealizedPnlPct < R.TIME_STOP_STAGE1_MIN_PCT) {
      sellQty = h.quantity; reason = "TIME_STOP_7";
    } else {
      const ind = computeIndicators(candlesUpTo(candles, dateStr), c.volume);
      if (R.EXIT_DOWNTREND && ind.trend === "DOWNTREND") {
        sellQty = h.quantity; reason = "DOWNTREND";
      }
    }

    if (sellQty > 0) {
      const proceeds = toINR(sellQty * c.close, h.currency);
      const costBasis = toINR(sellQty * h.avgBuyPrice, h.currency);
      const pnlINR = proceeds - costBasis;
      portfolio.capitalINR += proceeds;
      h.quantity -= sellQty;
      if (h.quantity <= 0) {
        portfolio.holdings = portfolio.holdings.filter(x => x !== h);
      }
      trades.push({
        date: dateStr, action: "SELL", symbol: h.symbol, market: h.market,
        price: c.close, currency: h.currency, qty: sellQty,
        pnlPct: h.unrealizedPnlPct, pnlINR: Math.round(pnlINR), reason,
      });
    }
  }
}

async function main() {
  console.log(`\nARJUN Global Swing Backtest: ${START} → ${END}\n`);
  const { indexHist, stockHist } = await loadHistory();

  const portfolio = {
    capitalINR: START_CAPITAL_INR,
    holdings: [],
    recentSells: [],
  };
  const trades = [];
  const days = tradingDays(START, END);

  for (const dateStr of days) {
    for (const h of portfolio.holdings) h.daysHeld = (h.daysHeld || 0) + 1;

    processExits(portfolio, dateStr, stockHist, trades);

    const openMarkets = [];
    for (const code of ["T", "NSE", "XETRA", "US"]) {
      const m = MARKETS[code];
      if (!isWeekday(dateStr, m.timezone)) continue;
      const idx = indexHist[code];
      if (!candleOn(idx, dateStr)) continue;
      const mood = moodOnDay(idx, dateStr);
      if (mood.mood === "BULLISH") {
        openMarkets.push({ code, mood, market: m });
      }
    }
    openMarkets.sort((a, b) => b.mood.score - a.mood.score);

    let boughtToday = false;
    for (const { code, mood, market } of openMarkets) {
      if (boughtToday) break;

      const candidates = [];
      for (const sym of market.watchlist.slice(0, WATCHLIST_LIMIT)) {
        const candles = stockHist[sym];
        if (!candles || !candleOn(candles, dateStr)) continue;
        const chg = changePctOnDay(candles, dateStr);
        if (chg === null) continue;
        const dayCandle = candleOn(candles, dateStr);
        const hist = candlesUpTo(candles, dateStr).slice(0, -1);
        const ind = computeIndicators(hist.length ? hist : candlesUpTo(candles, dateStr), dayCandle.volume);
        if (!passesEntryFilter(ind, chg, mood.todayPct, null)) continue;
        const score = calcConfidence(ind, chg);
        if (score < R.MIN_CONFIDENCE_SCORE) continue;
        candidates.push({ sym, chg, ind, score, price: dayCandle.close });
      }

      candidates.sort((a, b) =>
        (b.chg * 0.5 + b.ind.pctBelow52wHigh * 0.3 + b.ind.volumeRatio * 2) -
        (a.chg * 0.5 + a.ind.pctBelow52wHigh * 0.3 + a.ind.volumeRatio * 2)
      );

      const best = candidates[0];
      if (!best) continue;

      const sizeINR = positionSizeINR(best.score);
      const qty = Math.max(1, Math.floor(sizeINR / toINR(best.price, market.currency)));
      const totalAmount = qty * best.price;
      const trade = {
        symbol: best.sym, market: code, country: market.country,
        currency: market.currency, quantity: qty, price: best.price, totalAmount,
      };

      const tv = portfolioValue(portfolio);
      if (!canBuy(portfolio, trade, tv)) continue;

      portfolio.capitalINR -= toINR(totalAmount, market.currency);
      portfolio.holdings.push({
        symbol: best.sym, market: code, currency: market.currency,
        quantity: qty, avgBuyPrice: best.price, currentPrice: best.price,
        unrealizedPnlPct: 0, daysHeld: 0, buyDate: dateStr,
      });
      trades.push({
        date: dateStr, action: "BUY", symbol: best.sym, market: code,
        price: best.price, currency: market.currency, qty,
        score: best.score, changePct: best.chg, moodScore: mood.score,
      });
      boughtToday = true;
    }
  }

  // Mark remaining at last day close
  for (const h of portfolio.holdings) {
    const candles = stockHist[h.symbol];
    const c = candleOn(candles, END) || candles[candles.length - 1];
    if (c) {
      h.currentPrice = c.close;
      h.unrealizedPnlPct = Math.round(((c.close - h.avgBuyPrice) / h.avgBuyPrice) * 10000) / 100;
    }
  }

  const finalValue = Math.round(portfolioValue(portfolio));
  const pnl = finalValue - START_CAPITAL_INR;
  const pnlPct = Math.round((pnl / START_CAPITAL_INR) * 10000) / 100;
  const buys = trades.filter(t => t.action === "BUY");
  const sells = trades.filter(t => t.action === "SELL");
  const realized = sells.reduce((s, t) => s + (t.pnlINR || 0), 0);

  console.log("\n══════════════════════════════════════════");
  console.log(" BACKTEST RESULTS");
  console.log("══════════════════════════════════════════");
  console.log(`Period:        ${START} → ${END}`);
  console.log(`Start capital: ₹${START_CAPITAL_INR.toLocaleString()}`);
  console.log(`Final value:   ₹${finalValue.toLocaleString()}`);
  console.log(`Total P&L:     ₹${pnl.toLocaleString()} (${pnlPct > 0 ? "+" : ""}${pnlPct}%)`);
  console.log(`Realized P&L:  ₹${Math.round(realized).toLocaleString()} (closed trades)`);
  console.log(`Buys: ${buys.length} | Sells: ${sells.length}`);
  console.log(`Open positions: ${portfolio.holdings.length}`);

  console.log("\n── STOCKS BOUGHT ──");
  if (buys.length === 0) {
    console.log("(no buys — markets rarely BULLISH or filters blocked entries)");
  } else {
    for (const t of buys) {
      const sell = sells.find(s => s.symbol === t.symbol && s.date >= t.date);
      const outcome = sell
        ? `→ sold ${sell.date} @ ${sell.price} (${sell.pnlPct > 0 ? "+" : ""}${sell.pnlPct}%, ₹${sell.pnlINR})`
        : (portfolio.holdings.find(h => h.symbol === t.symbol)
          ? `→ still open (${portfolio.holdings.find(h => h.symbol === t.symbol).unrealizedPnlPct}%)`
          : "");
      console.log(`  ${t.date} | ${t.market} | ${t.symbol} | qty ${t.qty} @ ${t.price} ${t.currency} | score ${t.score} ${outcome}`);
    }
  }

  if (portfolio.holdings.length) {
    console.log("\n── OPEN HOLDINGS (marked to market) ──");
    for (const h of portfolio.holdings) {
      const val = Math.round(toINR(h.quantity * h.currentPrice, h.currency));
      console.log(`  ${h.symbol} | ${h.market} | ${h.quantity} @ avg ${h.avgBuyPrice} → ${h.currentPrice} | ${h.unrealizedPnlPct > 0 ? "+" : ""}${h.unrealizedPnlPct}% | ₹${val}`);
    }
  }

  console.log("\n── ALL SELLS ──");
  for (const t of sells) {
    console.log(`  ${t.date} | ${t.symbol} | ${t.reason} | ${t.pnlPct > 0 ? "+" : ""}${t.pnlPct}% | ₹${t.pnlINR}`);
  }

  console.log("\nNote: Rule-based daily backtest (no Claude). Watchlist-only scan.\n");
}

main().catch(err => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
