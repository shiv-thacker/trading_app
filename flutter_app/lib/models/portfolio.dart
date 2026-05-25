/// models/portfolio.dart
/// ======================
/// Data models for the portfolio state and individual stock holdings.
///
/// Supports both the old India-only swing portfolio AND the new
/// global multi-market portfolio (global_swing_portfolio/state).
///
/// MODELS:
///   Holding      → A single stock position (now includes market/currency fields)
///   Portfolio    → Full portfolio state (now supports multi-currency wallets)
///   Snapshot     → Historical portfolio value at a point in time
///
/// BACKWARDS COMPATIBILITY:
///   Old portfolio doc has: cash, totalValue, startingCapital
///   New global doc has:    inrCash, usdCash, totalValueINR, startingCapital
///   Portfolio.fromFirestore() handles both formats automatically.

import 'package:cloud_firestore/cloud_firestore.dart';

// ─────────────────────────────────────────────────────────────
// Holding — one stock position in the portfolio
// ─────────────────────────────────────────────────────────────
class Holding {
  final String symbol;
  final String companyName;
  final String sector;
  final int quantity;
  final double avgBuyPrice;
  final double currentPrice;
  final double unrealizedPnl;
  final double unrealizedPnlPct;
  final int buyTimestamp;
  final double stopLoss;
  final double target;
  final int cyclesHeld;

  // ── Global swing fields (new) ──────────────────────────────
  /// Exchange code: "NSE" | "US" | "XETRA" | "T"
  final String market;
  /// Country name: "India" | "USA" | "Germany" | "Japan"
  final String country;
  /// Position currency: "INR" | "USD" | "EUR" | "JPY"
  final String currency;
  /// Unrealized P&L converted to INR (for unified display)
  final double unrealizedPnlINR;
  /// How many calendar days held (directly from backend for global swing)
  final int daysHeldDirect;

  const Holding({
    required this.symbol,
    required this.companyName,
    required this.sector,
    required this.quantity,
    required this.avgBuyPrice,
    required this.currentPrice,
    required this.unrealizedPnl,
    required this.unrealizedPnlPct,
    required this.buyTimestamp,
    required this.stopLoss,
    required this.target,
    required this.cyclesHeld,
    this.market            = 'NSE',
    this.country           = 'India',
    this.currency          = 'INR',
    this.unrealizedPnlINR  = 0,
    this.daysHeldDirect    = 0,
  });

  /// Current market value of this position
  double get currentValue => currentPrice * quantity;

  /// Cost basis of this position
  double get costBasis => avgBuyPrice * quantity;

  /// Whether this holding is currently profitable
  bool get isProfit => unrealizedPnl >= 0;

  double get stopLossPct =>
      avgBuyPrice > 0 ? ((stopLoss - avgBuyPrice) / avgBuyPrice) * 100 : 0;

  double get targetPct =>
      avgBuyPrice > 0 ? ((target - avgBuyPrice) / avgBuyPrice) * 100 : 0;

  int get minutesHeld => cyclesHeld * 5;

  /// Days held: prefer direct field (global swing sets it), fallback to timestamp calc
  int get daysHeld => daysHeldDirect > 0
      ? daysHeldDirect
      : DateTime.now().difference(buyTime).inDays;

  DateTime get buyTime => DateTime.fromMillisecondsSinceEpoch(buyTimestamp);

  /// Country flag emoji for display
  String get countryFlag {
    switch (country) {
      case 'India':   return '🇮🇳';
      case 'USA':     return '🇺🇸';
      case 'Germany': return '🇩🇪';
      case 'Japan':   return '🇯🇵';
      default:        return '🌐';
    }
  }

  /// Whether this is a non-India (foreign) position
  bool get isForeign => currency != 'INR';

  /// P&L in INR (use unrealizedPnlINR if available, else unrealizedPnl for INR positions)
  double get pnlInINR =>
      unrealizedPnlINR != 0 ? unrealizedPnlINR : (currency == 'INR' ? unrealizedPnl : 0);

  factory Holding.fromMap(Map<String, dynamic> d) {
    return Holding(
      symbol:            d['symbol']             as String? ?? '',
      companyName:       d['companyName']         as String? ?? '',
      sector:            d['sector']              as String? ?? '',
      quantity:          (d['quantity']           as num?)?.toInt()    ?? 0,
      avgBuyPrice:       (d['avgBuyPrice']        as num?)?.toDouble() ?? 0,
      currentPrice:      (d['currentPrice']       as num?)?.toDouble() ?? 0,
      unrealizedPnl:     (d['unrealizedPnl']      as num?)?.toDouble() ?? 0,
      unrealizedPnlPct:  (d['unrealizedPnlPct']   as num?)?.toDouble() ?? 0,
      buyTimestamp:      (d['buyTimestamp']       as num?)?.toInt()    ?? 0,
      stopLoss:          (d['stopLoss']           as num?)?.toDouble() ?? 0,
      target:            (d['target']             as num?)?.toDouble() ?? 0,
      cyclesHeld:        (d['cyclesHeld']         as num?)?.toInt()    ?? 0,
      market:            d['market']              as String? ?? 'NSE',
      country:           d['country']             as String? ?? 'India',
      currency:          d['currency']            as String? ?? 'INR',
      unrealizedPnlINR:  (d['unrealizedPnlINR']   as num?)?.toDouble() ?? 0,
      daysHeldDirect:    (d['daysHeld']           as num?)?.toInt()    ?? 0,
    );
  }

  Map<String, dynamic> toMap() => {
    'symbol':           symbol,
    'companyName':      companyName,
    'sector':           sector,
    'quantity':         quantity,
    'avgBuyPrice':      avgBuyPrice,
    'currentPrice':     currentPrice,
    'unrealizedPnl':    unrealizedPnl,
    'unrealizedPnlPct': unrealizedPnlPct,
    'buyTimestamp':     buyTimestamp,
    'stopLoss':         stopLoss,
    'target':           target,
    'cyclesHeld':       cyclesHeld,
    'market':           market,
    'country':          country,
    'currency':         currency,
    'unrealizedPnlINR': unrealizedPnlINR,
  };
}

// ─────────────────────────────────────────────────────────────
// Portfolio — full portfolio state document
// ─────────────────────────────────────────────────────────────
class Portfolio {
  final double cash;        // legacy INR cash (old swing/intraday)
  final double totalValue;  // legacy total value in INR
  final double startingCapital;
  final List<Holding> holdings;
  final DateTime lastUpdated;

  // ── Global swing fields (new — unified capital) ────────────
  /// Available cash in ₹ (single pool across all markets)
  final double capitalINR;
  /// Total portfolio value in ₹ (capitalINR + all open positions)
  final double totalValueINR;
  /// Live USD/INR rate (updated each cycle from EODHD)
  final double usdInrRate;
  /// Live EUR/INR rate (for XETRA positions)
  final double eurInrRate;
  /// Live JPY/INR rate (for Japan TSE positions)
  final double jpyInrRate;
  /// True if this portfolio doc came from global_swing_portfolio
  final bool isGlobal;

  const Portfolio({
    required this.cash,
    required this.totalValue,
    required this.startingCapital,
    required this.holdings,
    required this.lastUpdated,
    this.capitalINR    = 0,
    this.totalValueINR = 0,
    this.usdInrRate    = 84.0,
    this.eurInrRate    = 90.0,
    this.jpyInrRate    = 0.58,
    this.isGlobal      = false,
  });

  double get unrealizedPnlTotal =>
      holdings.fold(0.0, (acc, h) => acc + h.unrealizedPnl);

  double get totalPnl => displayValueINR - startingCapital;

  double get totalPnlPct =>
      startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

  bool get isProfit => totalPnl >= 0;

  /// Returns the INR value of 1 unit of the given currency using live rates.
  double fxRateFor(String currency) {
    switch (currency) {
      case 'INR': return 1.0;
      case 'EUR': return eurInrRate > 0 ? eurInrRate : 90.0;
      case 'JPY': return jpyInrRate > 0 ? jpyInrRate : 0.58;
      default:    return usdInrRate > 0 ? usdInrRate : 84.0; // USD + unknown
    }
  }

  double get _fxRate => usdInrRate > 0 ? usdInrRate : 84.0;

  /// True when this is the global multi-market portfolio
  bool get usesGlobalWallets =>
      isGlobal || capitalINR > 0 || totalValueINR > 0;

  /// Available cash in ₹ — unified pool for global portfolio
  double get availableCashINR {
    if (!usesGlobalWallets) return cash;
    if (capitalINR > 0) return capitalINR;
    return startingCapital > 0 ? startingCapital : cash;
  }

  /// Best total portfolio value to show in INR
  double get displayValueINR {
    if (!usesGlobalWallets) return totalValue;
    if (totalValueINR > 0) return totalValueINR;
    return availableCashINR + holdingsValueINR;
  }

  /// Current market value of all open positions in INR (correct per-currency FX)
  double get holdingsValueINR {
    return holdings.fold(0.0, (acc, h) {
      return acc + h.currentValue * fxRateFor(h.currency);
    });
  }

  /// Amount currently deployed in open stock positions
  double get investedValueINR =>
      usesGlobalWallets ? holdingsValueINR : holdings.fold(0.0, (acc, h) => acc + h.currentValue);

  double get cashPct {
    final tv = displayValueINR;
    final c  = availableCashINR;
    return tv > 0 ? (c / tv) * 100 : 100;
  }

  int get holdingsCount => holdings.length;

  bool get canBuyMore => holdings.length < 5;

  factory Portfolio.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};

    final holdingsRaw = d['holdings'] as List<dynamic>? ?? [];
    final holdings = holdingsRaw
        .map((h) => Holding.fromMap(h as Map<String, dynamic>))
        .toList();

    DateTime lastUpdated;
    try {
      lastUpdated = (d['lastUpdated'] as Timestamp?)?.toDate() ?? DateTime.now();
    } catch (_) {
      lastUpdated = DateTime.now();
    }

    final usdInrRate     = (d['usdInrRate'] as num?)?.toDouble() ?? 84.0;
    final eurInrRate     = (d['eurInrRate'] as num?)?.toDouble() ?? 90.0;
    final jpyInrRate     = (d['jpyInrRate'] as num?)?.toDouble() ?? 0.58;
    final startingCapital =
        (d['startingCapital'] as num?)?.toDouble() ?? 100000;

    final isGlobal = d.containsKey('capitalINR') ||
        d.containsKey('inrCash') ||
        d.containsKey('totalValueINR') ||
        d.containsKey('baseCurrency');

    final resolvedCapitalINR = _resolveCapitalINR(d, isGlobal, startingCapital, usdInrRate);
    final holdingsValue = _holdingsValueINR(
      holdings, usdInrRate,
      eurInrRate: eurInrRate,
      jpyInrRate: jpyInrRate,
    );
    final resolvedTotalValueINR =
        _resolveTotalValueINR(d, isGlobal, resolvedCapitalINR, holdingsValue);

    return Portfolio(
      cash:            resolvedCapitalINR,
      totalValue:      resolvedTotalValueINR,
      startingCapital: startingCapital,
      holdings:        holdings,
      lastUpdated:     lastUpdated,
      capitalINR:      resolvedCapitalINR,
      totalValueINR:   resolvedTotalValueINR,
      usdInrRate:      usdInrRate,
      eurInrRate:      eurInrRate,
      jpyInrRate:      jpyInrRate,
      isGlobal:        isGlobal,
    );
  }

  static double _holdingsValueINR(
    List<Holding> holdings,
    double usdInrRate, {
    double eurInrRate = 90.0,
    double jpyInrRate = 0.58,
  }) {
    double rateFor(String c) {
      switch (c) {
        case 'INR': return 1.0;
        case 'EUR': return eurInrRate > 0 ? eurInrRate : 90.0;
        case 'JPY': return jpyInrRate > 0 ? jpyInrRate : 0.58;
        default:    return usdInrRate > 0 ? usdInrRate : 84.0;
      }
    }
    return holdings.fold(0.0, (acc, h) => acc + h.currentValue * rateFor(h.currency));
  }

  /// Migrate legacy cash / dual-wallet fields into unified capitalINR
  static double _resolveCapitalINR(
    Map<String, dynamic> d,
    bool isGlobal,
    double startingCapital,
    double usdInrRate,
  ) {
    final capital = (d['capitalINR'] as num?)?.toDouble() ?? 0;
    if (capital > 0) return capital;

    final inrCash = (d['inrCash'] as num?)?.toDouble() ?? 0;
    final usdCash = (d['usdCash'] as num?)?.toDouble() ?? 0;
    final rate = usdInrRate > 0 ? usdInrRate : 84.0;
    if (inrCash > 0 || usdCash > 0) return inrCash + usdCash * rate;

    final legacyCash = (d['cash'] as num?)?.toDouble() ?? 0;
    // Stale ₹10k cash with ₹1L starting — ignore legacy field
    if (isGlobal &&
        legacyCash > 0 &&
        startingCapital >= 50000 &&
        legacyCash < startingCapital * 0.5) {
      return startingCapital;
    }
    if (legacyCash > 0) return legacyCash;
    return isGlobal ? startingCapital : legacyCash;
  }

  static double _resolveTotalValueINR(
    Map<String, dynamic> d,
    bool isGlobal,
    double capitalINR,
    double holdingsValueINR,
  ) {
    final totalValueINR = (d['totalValueINR'] as num?)?.toDouble() ?? 0;
    if (totalValueINR > 0) return totalValueINR;
    if (isGlobal) return capitalINR + holdingsValueINR;
    return (d['totalValue'] as num?)?.toDouble() ?? capitalINR;
  }

  /// Default placeholder before Firestore loads (global multi-currency)
  factory Portfolio.empty() => Portfolio.emptyGlobal();

  factory Portfolio.emptyGlobal() => Portfolio(
    cash:            100000,
    totalValue:      100000,
    startingCapital: 100000,
    holdings:        [],
    lastUpdated:     DateTime.now(),
    capitalINR:      100000,
    totalValueINR:   100000,
    usdInrRate:      84.0,
    eurInrRate:      90.0,
    jpyInrRate:      0.58,
    isGlobal:        true,
  );
}

// ─────────────────────────────────────────────────────────────
// Snapshot — historical portfolio value data point
// ─────────────────────────────────────────────────────────────
class Snapshot {
  final DateTime timestamp;
  final double totalValue;
  final double cash;
  final int holdingsCount;
  final double pnlTotal;

  const Snapshot({
    required this.timestamp,
    required this.totalValue,
    required this.cash,
    required this.holdingsCount,
    required this.pnlTotal,
  });

  factory Snapshot.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};

    DateTime ts;
    try {
      ts = (d['timestamp'] as Timestamp?)?.toDate() ??
           DateTime.fromMillisecondsSinceEpoch(
             (d['timestampMs'] as num?)?.toInt() ?? 0);
    } catch (_) {
      ts = DateTime.now();
    }

    // Global swing snapshots store totalValueINR; fall back to totalValue for old format
    final totalValue = (d['totalValueINR'] as num?)?.toDouble()
                    ?? (d['totalValue']    as num?)?.toDouble()
                    ?? 0;
    final cash       = (d['inrCash']  as num?)?.toDouble()
                    ?? (d['cash']     as num?)?.toDouble()
                    ?? 0;

    return Snapshot(
      timestamp:     ts,
      totalValue:    totalValue,
      cash:          cash,
      holdingsCount: (d['holdingsCount'] as num?)?.toInt()    ?? 0,
      pnlTotal:      (d['pnlTotal']      as num?)?.toDouble() ?? 0,
    );
  }
}
