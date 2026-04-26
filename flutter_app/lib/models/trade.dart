/// models/trade.dart
/// =================
/// Data model representing a single executed trade (BUY or SELL).
///
/// Maps directly to a document in the Firestore `trades` collection.
/// Each BUY or SELL action by ARJUN creates one Trade document.
///
/// Fields:
///   id              → Firestore document ID (auto-generated)
///   timestampMs     → Unix epoch ms when the trade was executed
///   symbol          → NSE stock symbol (e.g. "RELIANCE")
///   companyName     → Full company name (e.g. "Reliance Industries Ltd")
///   sector          → Market sector (e.g. "Energy")
///   action          → "BUY" or "SELL"
///   quantity        → Number of shares traded
///   price           → Price per share at execution
///   totalAmount     → quantity × price
///   pnl             → Realized P&L (SELL only; 0 for BUY)
///   pnlPct          → P&L as percentage (SELL only)
///   reason          → Claude's explanation for the trade decision
///   confidence      → "HIGH" | "MEDIUM" | "LOW"
///   stopLoss        → Stop-loss price set at buy time
///   target          → Take-profit price set at buy time
///   tradeType       → "MOMENTUM" | "REVERSAL" | "STOP_LOSS" | "TAKE_PROFIT" | "DEFENSIVE"
///   marketSentiment → Market sentiment at time of trade
///   portfolioValueAfter → Total portfolio value immediately after trade

import 'package:cloud_firestore/cloud_firestore.dart';

class Trade {
  final String id;
  final int timestampMs;
  final String symbol;
  final String companyName;
  final String sector;
  final String action;    // "BUY" | "SELL"
  final int quantity;
  final double price;
  final double totalAmount;
  final double pnl;
  final double pnlPct;
  final String reason;
  final String confidence; // "HIGH" | "MEDIUM" | "LOW"
  final double stopLoss;
  final double target;
  final String tradeType;
  final String marketSentiment;
  final double portfolioValueAfter;

  const Trade({
    required this.id,
    required this.timestampMs,
    required this.symbol,
    required this.companyName,
    required this.sector,
    required this.action,
    required this.quantity,
    required this.price,
    required this.totalAmount,
    required this.pnl,
    required this.pnlPct,
    required this.reason,
    required this.confidence,
    required this.stopLoss,
    required this.target,
    required this.tradeType,
    required this.marketSentiment,
    required this.portfolioValueAfter,
  });

  /// Whether this trade was profitable (only meaningful for SELL)
  bool get isProfit => pnl >= 0;

  /// Formatted P&L string (e.g. "+₹1,234.50")
  String get pnlFormatted {
    final prefix = pnl >= 0 ? '+' : '';
    return '$prefix${_formatINR(pnl)}';
  }

  /// Formatted P&L percentage string (e.g. "+12.34%")
  String get pnlPctFormatted {
    final prefix = pnlPct >= 0 ? '+' : '';
    return '$prefix${pnlPct.toStringAsFixed(2)}%';
  }

  DateTime get timestamp => DateTime.fromMillisecondsSinceEpoch(timestampMs);

  /// Constructs a Trade from a Firestore document snapshot
  factory Trade.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return Trade(
      id:                   doc.id,
      timestampMs:          (d['timestampMs'] as num?)?.toInt() ??
                            (d['timestamp'] as Timestamp?)?.millisecondsSinceEpoch ??
                            0,
      symbol:               d['symbol']          as String? ?? '',
      companyName:          d['companyName']      as String? ?? '',
      sector:               d['sector']           as String? ?? '',
      action:               d['action']           as String? ?? '',
      quantity:             (d['quantity']        as num?)?.toInt()    ?? 0,
      price:                (d['price']           as num?)?.toDouble() ?? 0,
      totalAmount:          (d['totalAmount']     as num?)?.toDouble() ?? 0,
      pnl:                  (d['pnl']             as num?)?.toDouble() ?? 0,
      pnlPct:               (d['pnlPct']          as num?)?.toDouble() ?? 0,
      reason:               d['reason']           as String? ?? '',
      confidence:           d['confidence']       as String? ?? 'LOW',
      stopLoss:             (d['stopLoss']        as num?)?.toDouble() ?? 0,
      target:               (d['target']          as num?)?.toDouble() ?? 0,
      tradeType:            d['tradeType']        as String? ?? 'MOMENTUM',
      marketSentiment:      d['marketSentiment']  as String? ?? 'NEUTRAL',
      portfolioValueAfter:  (d['portfolioValueAfter'] as num?)?.toDouble() ?? 0,
    );
  }

  Map<String, dynamic> toMap() => {
    'symbol':              symbol,
    'companyName':         companyName,
    'sector':              sector,
    'action':              action,
    'quantity':            quantity,
    'price':               price,
    'totalAmount':         totalAmount,
    'pnl':                 pnl,
    'pnlPct':              pnlPct,
    'reason':              reason,
    'confidence':          confidence,
    'stopLoss':            stopLoss,
    'target':              target,
    'tradeType':           tradeType,
    'marketSentiment':     marketSentiment,
    'portfolioValueAfter': portfolioValueAfter,
  };
}

// ─────────────────────────────────────────────────────────────
// Indian number formatting helper (₹1,23,456.78)
// ─────────────────────────────────────────────────────────────
String _formatINR(double amount) {
  final abs = amount.abs();
  final prefix = amount < 0 ? '-' : '';

  // Split integer and decimal
  final intPart  = abs.truncate();
  final decPart  = ((abs - intPart) * 100).round();
  final decStr   = decPart.toString().padLeft(2, '0');

  // Indian grouping: last 3 digits, then groups of 2
  final intStr = intPart.toString();
  if (intStr.length <= 3) {
    return '${prefix}₹$intStr.$decStr';
  }

  final last3   = intStr.substring(intStr.length - 3);
  final rest    = intStr.substring(0, intStr.length - 3);
  final grouped = rest.replaceAllMapped(
    RegExp(r'(\d{1,2})(?=(\d{2})+$)'),
    (m) => '${m[1]},',
  );
  return '$prefix₹$grouped,$last3.$decStr';
}
