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
 * CANDIDATE DISCOVERY (how ARJUN finds stocks each cycle):
 *   India : NSE free API → scans full Nifty 500 (500 stocks) every cycle, zero EODHD cost.
 *   US/DE/JP : EODHD Screener API (included in $29.99 plan) → scans full exchange
 *              every cycle, ranked by % change + volume + market cap filter.
 *
 *   The `watchlist` array below is now a FALLBACK ONLY — used when the primary
 *   scanner (NSE API / EODHD Screener) is temporarily unavailable.
 *   ARJUN is NOT limited to these symbols during normal operation.
 *
 * EODHD SYMBOL FORMAT: {TICKER}.{EXCHANGE_CODE}
 *   India NSE : TCS.NSE   | RELIANCE.NSE
 *   USA       : AAPL.US   | NVDA.US
 *   Germany   : SAP.XETRA | SIE.XETRA
 *   Japan     : 7203.T    | 6758.T
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
    // FALLBACK ONLY — primary scanner uses NSE free API (full Nifty 500, 500 stocks)
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
    // FALLBACK ONLY — primary scanner uses EODHD Screener (full US market)
    // Covers S&P 100 + key NASDAQ names across all major sectors
    watchlist: [
      // Mega-cap tech
      "AAPL.US",  "MSFT.US",  "NVDA.US",  "AMZN.US",  "META.US",
      "GOOGL.US", "GOOG.US",  "TSLA.US",  "AVGO.US",  "ORCL.US",
      // Semiconductors & hardware
      "AMD.US",   "INTC.US",  "QCOM.US",  "TXN.US",   "MU.US",
      "AMAT.US",  "LRCX.US",  "KLAC.US",  "ADI.US",   "ON.US",
      // Software & cloud
      "ADBE.US",  "CRM.US",   "NOW.US",   "SNOW.US",  "PLTR.US",
      "PANW.US",  "CRWD.US",  "ZS.US",    "FTNT.US",  "NET.US",
      // Financials
      "JPM.US",   "BAC.US",   "GS.US",    "MS.US",    "WFC.US",
      "V.US",     "MA.US",    "AXP.US",   "BLK.US",   "SCHW.US",
      // Healthcare & pharma
      "LLY.US",   "UNH.US",   "JNJ.US",   "ABT.US",   "TMO.US",
      "MRK.US",   "ABBV.US",  "PFE.US",   "BMY.US",   "AMGN.US",
      // Consumer
      "COST.US",  "HD.US",    "WMT.US",   "TGT.US",   "LOW.US",
      "MCD.US",   "SBUX.US",  "NKE.US",   "BKNG.US",  "ABNB.US",
      // Energy & industrials
      "XOM.US",   "CVX.US",   "COP.US",   "SLB.US",   "EOG.US",
      "GE.US",    "CAT.US",   "HON.US",   "RTX.US",   "LMT.US",
      // Staples & utilities
      "PG.US",    "KO.US",    "PEP.US",   "PM.US",    "MO.US",
      "NEE.US",   "DUK.US",   "SO.US",    "D.US",     "SRE.US",
      // Media & telecom
      "NFLX.US",  "DIS.US",   "CMCSA.US", "T.US",     "VZ.US",
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
    // FALLBACK ONLY — primary scanner uses EODHD Screener (full XETRA market)
    // Full DAX 40 + key MDAX names
    watchlist: [
      // DAX 40
      "SAP.XETRA",   "SIE.XETRA",   "ALV.XETRA",   "MRK.XETRA",   "BMW.XETRA",
      "DTE.XETRA",   "DBK.XETRA",   "BAS.XETRA",   "ADS.XETRA",   "RWE.XETRA",
      "EOAN.XETRA",  "HEI.XETRA",   "MUV2.XETRA",  "FRE.XETRA",   "VOW3.XETRA",
      "MBG.XETRA",   "BAYN.XETRA",  "IFX.XETRA",   "LIN.XETRA",   "MTX.XETRA",
      "RHM.XETRA",   "BEI.XETRA",   "CON.XETRA",   "DB1.XETRA",   "DHL.XETRA",
      "FME.XETRA",   "HEN3.XETRA",  "PAH3.XETRA",  "P911.XETRA",  "SRT3.XETRA",
      "SY1.XETRA",   "VNA.XETRA",   "ZAL.XETRA",   "ENR.XETRA",   "HNR1.XETRA",
      "CBK.XETRA",   "PUM.XETRA",   "QIA.XETRA",   "1COV.XETRA",  "RXS.XETRA",
      // MDAX key names
      "BOSS.XETRA",  "DHER.XETRA",  "AIXA.XETRA",  "BC8.XETRA",   "EVD.XETRA",
      "GXI.XETRA",   "KGX.XETRA",   "LEO.XETRA",   "PSM.XETRA",   "SMHN.XETRA",
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
    // FALLBACK ONLY — primary scanner uses EODHD Screener (full TSE market)
    // Top Nikkei 225 stocks across all major sectors
    watchlist: [
      // Auto & manufacturing
      "7203.T",  "7267.T",  "7269.T",  "7270.T",  "6902.T",
      // Electronics & tech
      "6758.T",  "6752.T",  "6971.T",  "6724.T",  "6702.T",
      // Semiconductors & precision
      "8035.T",  "6861.T",  "7741.T",  "6954.T",  "6367.T",
      // Telecom & internet
      "9984.T",  "9432.T",  "9433.T",  "9434.T",  "4689.T",
      // Gaming & entertainment
      "7974.T",  "9602.T",  "4661.T",  "3659.T",  "2432.T",
      // Financials & banking
      "8306.T",  "8316.T",  "8411.T",  "8766.T",  "8630.T",
      // Trading & conglomerates
      "8058.T",  "8031.T",  "8001.T",  "8002.T",  "8053.T",
      // Pharma & healthcare
      "4502.T",  "4519.T",  "4568.T",  "4543.T",  "4578.T",
      // Chemical & materials
      "4063.T",  "4183.T",  "3407.T",  "5401.T",  "5108.T",
      // Consumer & retail
      "9983.T",  "8267.T",  "3382.T",  "2914.T",  "2503.T",
      // Industrial & engineering
      "6501.T",  "6301.T",  "6326.T",  "7011.T",  "1925.T",
      // Railways & infrastructure
      "9022.T",  "9020.T",  "9021.T",  "8801.T",  "8031.T",
    ],
  },

};

// Preferred evaluation order (by IST open time — earliest first)
// The cycle evaluates markets in this order each hour.
const MARKET_ORDER = ["T", "NSE", "XETRA", "US"];

module.exports = { MARKETS, MARKET_ORDER };
