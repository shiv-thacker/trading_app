/**
 * global_swing/config/trading_rules.js
 * =======================================
 * All trading constants — one file, one place to change.
 * Updated to master rules v2 — target 40–80% annual return.
 *
 * These rules apply identically across India, US, Germany, Japan.
 * The Claude prompt, validators, pre-filters, and auto-stops all read from here.
 */

module.exports = {

  // ── Portfolio limits ────────────────────────────────────────
  MAX_TOTAL_HOLDINGS:        5,     // Max open positions across ALL markets
  MAX_HOLDINGS_PER_MARKET:   2,     // Max positions within any single market
  MIN_CASH_RESERVE_INR:  20000,     // Always keep ₹20,000 INR as emergency buffer
  MIN_CASH_RESERVE_USD:     50,     // Always keep $50 USD untouched as buffer
  MAX_POSITION_PCT:         0.25,   // Max 25% of total portfolio per position

  // ── Position sizing by confidence score ─────────────────────
  POSITION_SIZE_BASE:      15000,   // Score 8–10 → ₹15,000
  POSITION_SIZE_MID:       20000,   // Score 11–13 → ₹20,000
  POSITION_SIZE_HIGH:      25000,   // Score 14+ → ₹25,000
  MIN_CONFIDENCE_SCORE:        8,   // Minimum score to buy (out of 15)
  SCORE_MID_THRESHOLD:        11,   // Score ≥ 11 → ₹20,000
  SCORE_HIGH_THRESHOLD:       14,   // Score ≥ 14 → ₹25,000

  // ── Entry rules ──────────────────────────────────────────────
  MIN_CHANGE_PCT:            1.5,   // Stock must be up ≥1.5% today (real momentum)
  MAX_CHANGE_PCT:            6.0,   // Stock must not be up >6% today (avoid chasing spikes)
  MAX_52W_HIGH_DIST_PCT:     8.0,   // Price must be ≥8% BELOW the 52-week high (real room to run)
  MIN_VOLUME_RATIO:          1.2,   // Volume must be ≥1.2x 20-day average (institutional confirmation)
  MIN_RSI_ENTRY:            52,     // RSI below 52 = no momentum yet
  MAX_RSI_ENTRY:            65,     // RSI above 65 = getting overbought
  EMA_CROSSOVER_MAX_DAYS:   10,     // EMA9/EMA20 bullish crossover must be within last 10 days
  REQUIRED_TREND:       "UPTREND", // UPTREND only (EMA9 > EMA20 and price > EMA9)

  // ── Market mood thresholds (new formula) ────────────────────
  // score = (today% × 2) + (5-day% × 1) + sentiment_score
  BULLISH_SCORE_THRESHOLD:   2.0,   // score ≥ 2.0 → BULLISH (can buy)
  NEUTRAL_SCORE_THRESHOLD:   1.0,   // score 1.0–1.99 → NEUTRAL (no new buys)
  // score < 1.0 → BEARISH (no new buys, monitor stops)

  // Legacy mood thresholds (kept for backward compat with any old references)
  BULLISH_INDEX_5D_PCT:      1.5,
  BEARISH_INDEX_5D_PCT:     -1.5,
  BULLISH_TODAY_PCT:         0.4,
  BEARISH_TODAY_PCT:        -0.4,

  // ── News sentiment thresholds (EODHD /api/sentiments) ───────
  SENTIMENT_BULLISH_THRESHOLD:  0.15,
  SENTIMENT_BEARISH_THRESHOLD: -0.15,
  MOOD_WEIGHT_5D_OPEN:          0.50,
  MOOD_WEIGHT_TODAY_OPEN:       0.30,
  MOOD_WEIGHT_SENTIMENT_OPEN:   0.20,
  MOOD_WEIGHT_5D_CLOSED:        0.65,
  MOOD_WEIGHT_SENTIMENT_CLOSED: 0.35,

  // ── Exit rules ──────────────────────────────────────────────
  STOP_LOSS_PCT:            -7.0,   // HARD stop: sell 100% immediately if down 7%
  TAKE_PROFIT_HALF_PCT:     10.0,   // Sell 50% at +10% gain (lock in half)
  TAKE_PROFIT_FULL_PCT:     20.0,   // Sell remaining 100% at +20% (full target)
  TRAILING_STOP_PCT:         5.0,   // After partial sell: trailing stop at entry + 5%

  // ── RSI / ceiling exit rules ─────────────────────────────────
  EXIT_RSI_OVERBOUGHT:      70,     // Exit 50% if RSI ≥ 70 AND near 52W high
  EXIT_52W_HIGH_DANGER:      5.0,   // Exit 50% if within 5% of 52W high AND RSI overbought
  EXIT_DOWNTREND:           true,   // Auto-exit 100% if trend flips to DOWNTREND

  // ── Time-stop rules (prevents dead money) ────────────────────
  TIME_STOP_STAGE1_DAYS:    7,
  TIME_STOP_STAGE1_MIN_PCT: 3.0,   // Must have ≥3% gain by Day 7 or sell
  TIME_STOP_STAGE2_DAYS:   14,
  TIME_STOP_STAGE2_MIN_PCT: 7.0,   // Must have ≥7% gain by Day 14 or sell (tightened from 5%)

  // ── Rotation / re-entry rules ───────────────────────────────
  MAX_ROTATIONS_PER_CYCLE:   1,    // Max 1 rotation (1 SELL + 1 BUY) per hour
  NO_REBUY_DAYS:             5,    // Cannot re-buy same symbol for 5 days after selling

  // ── IBKR live trading ────────────────────────────────────────
  TRADING_MODE:         "PAPER",   // "PAPER" | "LIVE"
};
