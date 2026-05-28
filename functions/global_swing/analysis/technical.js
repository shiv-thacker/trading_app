/**
 * global_swing/analysis/technical.js
 * =====================================
 * Computes technical indicators from real 30-day OHLCV candles.
 *
 * COMPUTED LOCALLY (no extra API calls):
 *   RSI 14         — momentum oscillator (0–100)
 *   EMA 9          — fast moving average (price vs short trend)
 *   EMA 20         — slow moving average (price vs medium trend)
 *   52W high/low   — from available candle window (≤50 days here)
 *   % below 52W high — THE KEY: large gap = room to run; small gap = near resistance
 *   20-day avg volume — baseline for volume confirmation
 *   Volume ratio   — today's volume / 20d avg (≥1.3x = confirmed breakout)
 *   10-day support — lowest close in 10 days (stop-loss reference)
 *   Trend          — UPTREND | DOWNTREND | SIDEWAYS
 *
 * WHY NOT USE EODHD'S TECHNICAL API:
 *   It costs extra API calls and has plan restrictions.
 *   With 30-day candles already fetched for history, computing locally
 *   is free, instant, and works for all 4 markets identically.
 *
 * INPUT: candles array from eodhd_history.getHistoricalCandles()
 *   Each candle: { date, open, high, low, close, adjusted_close, volume }
 */

/**
 * Compute RSI (Relative Strength Index) using Wilder's smoothing.
 * Standard 14-period RSI.
 *
 * @param {number[]} closes - Close prices, oldest first
 * @param {number}   period - Default 14
 * @returns {number} RSI value 0–100
 */
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50; // Not enough data → return neutral

  // Use the most recent `period` price changes
  let gains = 0;
  let losses = 0;

  const startIdx = closes.length - period;
  for (let i = startIdx; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }

  const avgGain = gains  / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

/**
 * Compute EMA (Exponential Moving Average).
 * Seeds with simple average of first `period` values, then applies
 * the standard EMA multiplier k = 2/(period+1).
 *
 * @param {number[]} closes - Close prices, oldest first
 * @param {number}   period
 * @returns {number} Latest EMA value
 */
function computeEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;

  const k   = 2 / (period + 1);
  let   ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return Math.round(ema * 100) / 100;
}

/**
 * Compute all technical indicators for one stock from its OHLCV candles.
 *
 * @param {Array}  candles      - OHLCV candles from eodhd_history, oldest first
 * @param {number} todayVolume  - Today's live volume (from eodhd_live quote)
 * @returns {Object} Full technical snapshot
 */
function computeIndicators(candles, todayVolume = 0) {
  if (!candles || candles.length < 5) {
    return {
      rsi:              50,
      ema9:             0,
      ema20:            0,
      high52w:          0,
      low52w:           0,
      pctBelow52wHigh:  100,  // 100 = very far from resistance
      avgVolume20d:     0,
      volumeRatio:      0,
      support10d:       0,
      trend:            "UNKNOWN",
      dataPoints:       candles?.length || 0,
    };
  }

  // Use adjusted_close if available (splits/dividends adjusted), else close
  const closes  = candles.map(c => Number(c.adjusted_close || c.close));
  const highs   = candles.map(c => Number(c.high));
  const lows    = candles.map(c => Number(c.low));
  const volumes = candles.map(c => Number(c.volume));

  const latestClose = closes[closes.length - 1];

  // ── RSI (14-period) ────────────────────────────────────────
  const rsi = computeRSI(closes, 14);

  // ── EMAs ──────────────────────────────────────────────────
  const ema9  = computeEMA(closes, 9);
  const ema20 = computeEMA(closes, 20);

  // ── 52-week high/low (within available candle window) ─────
  const high52w = Math.max(...highs);
  const low52w  = Math.min(...lows);

  // % gap from 52W high — POSITIVE means room to run; NEGATIVE never happens
  // Example: stock at 97 and 52W high = 100 → pctBelow52wHigh = 3.0%
  // Rule: if < 3% below 52W high → DON'T BUY (near resistance)
  const pctBelow52wHigh = high52w > 0
    ? Math.round(((high52w - latestClose) / high52w) * 100 * 100) / 100
    : 100;

  // ── 20-day average volume ──────────────────────────────────
  const vol20       = volumes.slice(-20);
  const avgVolume20d = vol20.length > 0
    ? Math.round(vol20.reduce((s, v) => s + v, 0) / vol20.length)
    : 0;

  // Volume ratio: today vs 20d average
  //
  // Problem: non-US markets (XETRA, TSE via Yahoo) report intraday cumulative
  // volume. Early in the session (e.g. 1 hour into a 6.5-hour TSE day) the
  // live volume is naturally 10-30% of the full-day average — not because
  // volume is actually low but because the day isn't over yet.
  //
  // Fix: treat live intraday volume as "credible" ONLY when it already equals
  // 75% or more of the 20d average (meaning the market is near close and the
  // reading reflects almost the full day). Otherwise fall back to the most
  // recent COMPLETED trading day's EOD volume from the historical candles.
  // Note: yahoo_japan.js explicitly excludes today's partial candle from the
  // historical array, so latestHistVol is always yesterday's full-day EOD.
  const latestHistVol = volumes[volumes.length - 1] || 0;
  const effectiveVolume =
    todayVolume > 0 && avgVolume20d > 0 && todayVolume >= avgVolume20d * 0.75
      ? todayVolume       // market near/after close — full-day volume is credible
      : latestHistVol;    // use previous EOD for early/mid-session partial data

  const volumeRatio = avgVolume20d > 0 && effectiveVolume > 0
    ? Math.round((effectiveVolume / avgVolume20d) * 100) / 100
    : 0;

  // ── 10-day support (lowest close = where buyers stepped in) ─
  const closes10d  = closes.slice(-10);
  const support10d = Math.round(Math.min(...closes10d) * 100) / 100;

  // ── Trend classification ────────────────────────────────────
  // UPTREND:   EMA9 > EMA20 AND price above EMA9
  // DOWNTREND: EMA9 < EMA20 AND price below EMA9
  // SIDEWAYS:  neither
  let trend;
  if (ema9 > ema20 && latestClose > ema9) {
    trend = "UPTREND";
  } else if (ema9 < ema20 && latestClose < ema9) {
    trend = "DOWNTREND";
  } else {
    trend = "SIDEWAYS";
  }

  // ── EMA crossover age ────────────────────────────────────────
  // How many trading days ago did EMA9 cross above EMA20?
  // Returns: 0 = crossover today, 1 = yesterday, ..., 10 = 10 days ago
  // Returns: null = no bullish crossover in last 10 days (stale or not in uptrend)
  // Rule: crossover must be within 10 days for entry to qualify (fresh momentum).
  let emaCrossoverDaysAgo = null;
  if (trend === "UPTREND" && closes.length >= 25) {
    for (let daysBack = 1; daysBack <= 10; daysBack++) {
      const prevCloses = closes.slice(0, closes.length - daysBack);
      if (prevCloses.length < 20) break;
      const prevEma9  = computeEMA(prevCloses, 9);
      const prevEma20 = computeEMA(prevCloses, 20);
      if (prevEma9 <= prevEma20) {
        // Found the day before the crossover — crossover was `daysBack` days ago
        emaCrossoverDaysAgo = daysBack;
        break;
      }
    }
    // If EMA9 was already above EMA20 for all 10 days back, crossover is stale (> 10 days)
    if (emaCrossoverDaysAgo === null) emaCrossoverDaysAgo = 11;
  }

  return {
    rsi,
    ema9,
    ema20,
    high52w:             Math.round(high52w * 100) / 100,
    low52w:              Math.round(low52w  * 100) / 100,
    pctBelow52wHigh,     // must be ≥ 8% to qualify for BUY (master rules v2)
    avgVolume20d,
    volumeRatio,
    support10d,
    trend,
    emaCrossoverDaysAgo, // null = no crossover; 1–10 = fresh; 11 = stale (>10 days)
    dataPoints:          candles.length,
  };
}

module.exports = { computeIndicators, computeRSI, computeEMA };
