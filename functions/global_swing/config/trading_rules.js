/**
 * global_swing/config/trading_rules.js
 * =======================================
 * All trading constants — one file, one place to change.
 *
 * These rules apply identically across India, US, Germany, Japan.
 * The Claude prompt, validators, and auto-stop all read from here.
 *
 * ── HOW TO ADJUST ─────────────────────────────────────────────
 * Change a number here → it propagates to all 3 layers:
 *   1. trade_validator.js (code-level gate)
 *   2. swing_brain.js     (Claude's prompt instructions)
 *   3. global_swing/index (auto stop-loss enforcement)
 */

module.exports = {

  // ── Portfolio limits ────────────────────────────────────────
  MAX_TOTAL_HOLDINGS:        5,     // Max open positions across ALL markets
  MAX_HOLDINGS_PER_MARKET:   2,     // Max positions within any single market
  MIN_CASH_RESERVE_INR:   2000,     // Always keep ₹2,000 INR untouched as buffer
  MIN_CASH_RESERVE_USD:     50,     // Always keep $50 USD untouched as buffer
  MAX_POSITION_PCT:         0.25,   // Max 25% of total portfolio per position

  // ── Entry rules ──────────────────────────────────────────────
  MIN_CHANGE_PCT:           1.0,    // Stock must be up >1.0% today to qualify
  // *** THE COFORGE RULE: never buy near resistance ***
  MAX_52W_HIGH_DIST_PCT:    3.0,    // Price must be ≥3% BELOW the 52-week high
  MIN_VOLUME_RATIO:         1.3,    // Today's volume ≥ 1.3× the 20-day average
  MAX_RSI_ENTRY:           68,      // Skip if RSI > 68 (overbought)
  MIN_RSI_ENTRY:           40,      // Skip if RSI < 40 (falling knife)

  // ── Exit rules ──────────────────────────────────────────────
  STOP_LOSS_PCT:           -7.0,    // HARD stop: sell immediately if down 7%
  TAKE_PROFIT_HALF_PCT:     8.0,    // Sell half position at +8% gain
  TAKE_PROFIT_FULL_PCT:    15.0,    // Sell full position at +15% gain (target)

  // ── Time-stop rules (prevents dead money) ────────────────────
  // Stage 1: gentle push — sell if flat/red on Day 7
  TIME_STOP_STAGE1_DAYS:    7,
  TIME_STOP_STAGE1_MIN_PCT: 3.0,   // Must have ≥3% gain to survive Stage 1

  // Stage 2: unconditional — sell on Day 14 regardless
  TIME_STOP_STAGE2_DAYS:   14,
  TIME_STOP_STAGE2_MIN_PCT: 5.0,   // Must have ≥5% gain to survive Stage 2

  // ── Rotation / re-entry rules ───────────────────────────────
  MAX_ROTATIONS_PER_CYCLE:  1,     // Max 1 rotation (1 SELL + 1 BUY) per hour
  NO_REBUY_DAYS:            5,     // Cannot re-buy same symbol for 5 days after selling

  // ── Market mood thresholds ──────────────────────────────────
  BULLISH_INDEX_5D_PCT:    1.5,    // 5-day index change > +1.5% → BULLISH
  BEARISH_INDEX_5D_PCT:   -1.5,    // 5-day index change < -1.5% → BEARISH
  BULLISH_TODAY_PCT:       0.4,    // Today's change > +0.4% helps tilt to BULLISH
  BEARISH_TODAY_PCT:      -0.4,    // Today's change < -0.4% helps tilt to BEARISH

  // ── IBKR live trading ────────────────────────────────────────
  // Set to "LIVE" + configure IBKR API keys in Firebase config to go live.
  // Currently "PAPER" — all trades simulate in Firestore only.
  TRADING_MODE:            "PAPER",   // "PAPER" | "LIVE"
};
