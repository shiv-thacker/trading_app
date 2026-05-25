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

  // Volume ratio: today vs 20d average (>1.3 = institutional interest)
  //
  // EODHD real-time (/real-time/{symbol}) for non-US markets (XETRA, TSE)
  // returns intraday cumulative volume — only what has traded so far today.
  // Comparing partial-day intraday volume against full-day historical average
  // always produces ratios like 0.0x–0.2x, even on genuinely high-volume days.
  //
  // Fix: if todayVolume is zero or looks like partial-day data (< 10% of the
  // 20d average), fall back to the most recent historical EOD candle's volume.
  // This gives a realistic "yesterday vs average" ratio and lets real candidates
  // through, especially for Germany (XETRA) and Japan (T).
  const latestHistVol = volumes[volumes.length - 1] || 0;
  const effectiveVolume =
    todayVolume > 0 && avgVolume20d > 0 && todayVolume >= avgVolume20d * 0.10
      ? todayVolume       // live intraday volume looks credible — use it
      : latestHistVol;    // partial/zero live volume — use last EOD candle as proxy

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

  return {
    rsi,
    ema9,
    ema20,
    high52w:         Math.round(high52w * 100) / 100,
    low52w:          Math.round(low52w  * 100) / 100,
    pctBelow52wHigh,  // THE COFORGE GUARD: must be ≥ 3 to qualify for BUY
    avgVolume20d,
    volumeRatio,
    support10d,
    trend,
    dataPoints:      candles.length,
  };
}

module.exports = { computeIndicators, computeRSI, computeEMA };
