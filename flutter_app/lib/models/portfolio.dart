/// models/portfolio.dart
/// ======================
/// Data models for the portfolio state and individual stock holdings.
///
/// Maps to Firestore document: portfolio/state
///
/// MODELS:
///   Holding      → A single stock position ARJUN currently holds
///   Portfolio    → Full portfolio state (cash + all holdings)
///   Snapshot     → Historical portfolio value at a point in time
///                  (from portfolio/state/snapshots sub-collection)

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
  });

  /// Current market value of this position
  double get currentValue => currentPrice * quantity;

  /// Cost basis of this position
  double get costBasis => avgBuyPrice * quantity;

  /// Whether this holding is currently profitable
  bool get isProfit => unrealizedPnl >= 0;

  /// Stop-loss percentage from avg buy price
  double get stopLossPct =>
      ((stopLoss - avgBuyPrice) / avgBuyPrice) * 100;

  /// Target percentage from avg buy price
  double get targetPct =>
      ((target - avgBuyPrice) / avgBuyPrice) * 100;

  /// How many minutes this position has been held (each cycle = 5 min)
  int get minutesHeld => cyclesHeld * 5;

  DateTime get buyTime => DateTime.fromMillisecondsSinceEpoch(buyTimestamp);

  factory Holding.fromMap(Map<String, dynamic> d) {
    return Holding(
      symbol:           d['symbol']          as String? ?? '',
      companyName:      d['companyName']      as String? ?? '',
      sector:           d['sector']           as String? ?? '',
      quantity:         (d['quantity']        as num?)?.toInt()    ?? 0,
      avgBuyPrice:      (d['avgBuyPrice']     as num?)?.toDouble() ?? 0,
      currentPrice:     (d['currentPrice']    as num?)?.toDouble() ?? 0,
      unrealizedPnl:    (d['unrealizedPnl']   as num?)?.toDouble() ?? 0,
      unrealizedPnlPct: (d['unrealizedPnlPct']as num?)?.toDouble() ?? 0,
      buyTimestamp:     (d['buyTimestamp']    as num?)?.toInt()    ?? 0,
      stopLoss:         (d['stopLoss']        as num?)?.toDouble() ?? 0,
      target:           (d['target']          as num?)?.toDouble() ?? 0,
      cyclesHeld:       (d['cyclesHeld']      as num?)?.toInt()    ?? 0,
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
  };
}

// ─────────────────────────────────────────────────────────────
// Portfolio — full portfolio state document
// ─────────────────────────────────────────────────────────────
class Portfolio {
  final double cash;
  final double totalValue;
  final double startingCapital;
  final List<Holding> holdings;
  final DateTime lastUpdated;

  const Portfolio({
    required this.cash,
    required this.totalValue,
    required this.startingCapital,
    required this.holdings,
    required this.lastUpdated,
  });

  /// Total unrealized P&L across all holdings
  double get unrealizedPnlTotal =>
      holdings.fold(0.0, (sum, h) => sum + h.unrealizedPnl);

  /// Total P&L since inception (realized + unrealized)
  double get totalPnl => totalValue - startingCapital;

  /// Total P&L as percentage
  double get totalPnlPct =>
      startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

  /// True if portfolio is in profit overall
  bool get isProfit => totalPnl >= 0;

  /// Cash as percentage of total portfolio
  double get cashPct =>
      totalValue > 0 ? (cash / totalValue) * 100 : 100;

  /// Number of current holdings
  int get holdingsCount => holdings.length;

  /// Whether portfolio has capacity for more holdings (max 5)
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

    return Portfolio(
      cash:            (d['cash']            as num?)?.toDouble() ?? 10000,
      totalValue:      (d['totalValue']      as num?)?.toDouble() ?? 10000,
      startingCapital: (d['startingCapital'] as num?)?.toDouble() ?? 10000,
      holdings:        holdings,
      lastUpdated:     lastUpdated,
    );
  }

  /// Returns an empty default portfolio (used before Firestore loads)
  factory Portfolio.empty() => Portfolio(
    cash:            10000,
    totalValue:      10000,
    startingCapital: 10000,
    holdings:        [],
    lastUpdated:     DateTime.now(),
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

    return Snapshot(
      timestamp:     ts,
      totalValue:    (d['totalValue']   as num?)?.toDouble() ?? 0,
      cash:          (d['cash']         as num?)?.toDouble() ?? 0,
      holdingsCount: (d['holdingsCount']as num?)?.toInt()    ?? 0,
      pnlTotal:      (d['pnlTotal']     as num?)?.toDouble() ?? 0,
    );
  }
}
