/**
 * global_swing/config/markets.js
 * ================================
 * Single source of truth for all supported global markets.
 *
 * WHY THESE 4 MARKETS:
 *   Indians can legally trade all of them via LRS (Liberalised Remittance
 *   Scheme — up to $250,000/year). Together they cover all major time zones:
 *     🇯🇵 Japan  → IST 05:30–12:00  (Asian early session)
 *     🇮🇳 India  → IST 09:15–15:30  (Asian main session)
 *     🇩🇪 Germany→ IST 13:30–22:00  (European session, overlaps India afternoon)
 *     🇺🇸 USA    → IST 19:30–01:30  (US evening session from India)
 *
 * ADDING A NEW MARKET:
 *   Copy any market block below, fill in the fields, add symbols to watchlist.
 *   No other file needs changing — the cycle automatically picks it up.
 *
 * EODHD SYMBOL FORMAT: {TICKER}.{EXCHANGE_CODE}
 *   India NSE : TCS.NSE   | RELIANCE.NSE
 *   USA       : AAPL.US   | NVDA.US
 *   Germany   : SAP.XETRA | SIE.XETRA
 *   Japan     : 7203.T    | 6758.T
 *
 * LIVE API USED PER MARKET:
 *   India: NSE free API (real-time) → EODHD fallback (~15 min delayed)
 *   US:    EODHD real-time (WebSocket on $29.99 plan)
 *   DE/JP: EODHD ~15 min delayed (swing hourly — acceptable delay)
 *
 * CAPITAL (paper trading):
 *   Single unified pool: capitalINR ₹1,00,000
 *   ARJUN picks which country to invest in each cycle based on mood score + stock setup.
 *   No fixed per-country allocation.
 */

const MARKETS = {

  // ── 🇮🇳 India (NSE) ───────────────────────────────────────────────
  NSE: {
    code:             "NSE",
    name:             "NSE India",
    country:          "India",
    flag:             "🇮🇳",
    currency:         "INR",
    timezone:         "Asia/Kolkata",
    openTimeLocal:    "09:15",      // Market open in exchange local time
    closeTimeLocal:   "15:30",      // Market close in exchange local time
    indexSymbol:      "NSEI.INDX",  // Nifty 50 — confirmed working on EODHD
    useNSELiveFallback: true,       // Try NSE free API first; EODHD if NSE fails
    // Curated Nifty 50 universe — most liquid, covers all major sectors
    watchlist: [
      "RELIANCE.NSE",  "TCS.NSE",       "HDFCBANK.NSE",  "INFY.NSE",      "ICICIBANK.NSE",
      "HINDUNILVR.NSE","SBIN.NSE",      "BAJFINANCE.NSE","KOTAKBANK.NSE", "BHARTIARTL.NSE",
      "ITC.NSE",       "AXISBANK.NSE",  "LT.NSE",        "ASIANPAINT.NSE","MARUTI.NSE",
      "TITAN.NSE",     "SUNPHARMA.NSE", "WIPRO.NSE",     "HCLTECH.NSE",   "TECHM.NSE",
      "NESTLEIND.NSE", "DRREDDY.NSE",   "ONGC.NSE",      "COALINDIA.NSE", "TATAMOTORS.NSE",
      "POWERGRID.NSE", "NTPC.NSE",      "ULTRACEMCO.NSE","BAJAJFINSV.NSE","DIVISLAB.NSE",
    ],
  },

  // ── 🇺🇸 USA (NYSE / NASDAQ) ────────────────────────────────────────
  US: {
    code:             "US",
    name:             "NYSE / NASDAQ",
    country:          "USA",
    flag:             "🇺🇸",
    currency:         "USD",
    timezone:         "America/New_York",
    openTimeLocal:    "09:30",      // ET 09:30
    closeTimeLocal:   "16:00",      // ET 16:00 = IST ~01:30 next morning
    indexSymbol:      "GSPC.INDX",  // S&P 500 index on EODHD
    useNSELiveFallback: false,
    // Top 30 S&P 500 stocks by daily volume + sector diversity
    watchlist: [
      "AAPL.US",  "MSFT.US",  "NVDA.US",  "AMZN.US",  "META.US",
      "GOOGL.US", "TSLA.US",  "AVGO.US",  "JPM.US",   "LLY.US",
      "V.US",     "UNH.US",   "XOM.US",   "MA.US",    "JNJ.US",
      "HD.US",    "PG.US",    "COST.US",  "ABBV.US",  "MRK.US",
      "NFLX.US",  "AMD.US",   "ADBE.US",  "CRM.US",   "ORCL.US",
      "BAC.US",   "KO.US",    "PEP.US",   "DIS.US",   "GE.US",
    ],
  },

  // ── 🇩🇪 Germany (XETRA) ──────────────────────────────────────────
  XETRA: {
    code:             "XETRA",
    name:             "XETRA Germany",
    country:          "Germany",
    flag:             "🇩🇪",
    currency:         "EUR",
    timezone:         "Europe/Berlin",
    openTimeLocal:    "09:00",      // CET/CEST 09:00
    closeTimeLocal:   "17:30",      // CET/CEST 17:30
    indexSymbol:      "GDAXI.INDX", // DAX index on EODHD
    useNSELiveFallback: false,
    // Top DAX stocks + large-caps
    watchlist: [
      "SAP.XETRA",   "SIE.XETRA",   "ALV.XETRA",   "MRK.XETRA",   "BMW.XETRA",
      "DTE.XETRA",   "DBK.XETRA",   "BAS.XETRA",   "ADS.XETRA",   "RWE.XETRA",
      "EOAN.XETRA",  "HEI.XETRA",   "MUV2.XETRA",  "FRE.XETRA",   "VOW3.XETRA",
    ],
  },

  // ── 🇯🇵 Japan (TSE — Tokyo Stock Exchange) ────────────────────────
  // EODHD exchange code for Tokyo is "T" (e.g. 7203.T = Toyota)
  // Symbols are 4-digit numeric codes used on TSE.
  T: {
    code:             "T",
    name:             "Tokyo Stock Exchange",
    country:          "Japan",
    flag:             "🇯🇵",
    currency:         "JPY",
    timezone:         "Asia/Tokyo",
    openTimeLocal:    "09:00",      // JST 09:00 = IST 05:30
    closeTimeLocal:   "15:30",      // JST 15:30 = IST 12:00 (includes lunch 11:30–12:30)
    indexSymbol:      "N225.INDX",  // Nikkei 225 on EODHD
    useNSELiveFallback: false,
    // Top Nikkei 225 stocks by international recognition + liquidity
    watchlist: [
      "7203.T",  "6758.T",  "7974.T",  "8306.T",  "8316.T",
      "7267.T",  "6501.T",  "9984.T",  "8058.T",  "4502.T",
      "6954.T",  "9432.T",  "8411.T",  "6702.T",  "3382.T",
    ],
  },

};

// Preferred evaluation order (by IST open time — earliest first)
// The cycle evaluates markets in this order each hour.
const MARKET_ORDER = ["T", "NSE", "XETRA", "US"];

module.exports = { MARKETS, MARKET_ORDER };
