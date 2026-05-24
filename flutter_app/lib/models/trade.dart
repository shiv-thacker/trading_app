/// models/trade.dart
/// =================
/// Data model representing a single executed trade (BUY or SELL).
///
/// Supports both old India-only trades and new global multi-market trades.
///
/// Fields:
///   id              → Firestore document ID (auto-generated)
///   timestampMs     → Unix epoch ms when the trade was executed
///   symbol          → Stock ticker (e.g. "RELIANCE.NSE" or "AAPL.US")
///   companyName     → Full company name (may be empty for global trades)
///   sector          → Market sector (may be empty for global trades)
///   action          → "BUY" or "SELL"
///   quantity        → Number of shares traded
///   price           → Price per share in native currency
///   totalAmount     → quantity × price in native currency
///   pnl             → Realized P&L in native currency (SELL only)
///   pnlPct          → P&L as percentage (SELL only)
///   pnlINR          → Realized P&L converted to INR (global trades)
///   reason          → Claude's explanation for the trade decision
///   confidence      → "HIGH" | "MEDIUM" | "LOW"
///   stopLoss        → Stop-loss price (native currency)
///   target          → Take-profit price (native currency)
///   tradeType       → "MOMENTUM" | "REVERSAL" | "STOP_LOSS" | "TAKE_PROFIT" | "DEFENSIVE"
///   marketSentiment → Market sentiment at time of trade
///   market          → Exchange: "NSE" | "US" | "XETRA" | "T"
///   country         → Country: "India" | "USA" | "Germany" | "Japan"
///   currency        → Native currency: "INR" | "USD" | "EUR" | "JPY"
///   portfolioValueAfter → Total portfolio value (INR) after trade

import 'package:cloud_firestore/cloud_firestore.dart';

class Trade {
  final String id;
  final int timestampMs;
  final String symbol;
  final String companyName;
  final String sector;
  final String action;
  final int quantity;
  final double price;
  final double totalAmount;
  final double pnl;
  final double pnlPct;
  final double pnlINR;     // P&L in INR (global trades)
  final String reason;
  final String confidence;
  final double stopLoss;
  final double target;
  final String tradeType;
  final String marketSentiment;
  final double portfolioValueAfter;
  // ── Global swing fields ────────────────────────────────────
  final String market;     // "NSE" | "US" | "XETRA" | "T"
  final String country;    // "India" | "USA" | "Germany" | "Japan"
  final String currency;   // "INR" | "USD" | "EUR" | "JPY"

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
    this.pnlINR  = 0,
    this.market  = 'NSE',
    this.country = 'India',
    this.currency = 'INR',
  });

  bool get isProfit => pnl >= 0;

  bool get isForeign => currency != 'INR';

  /// Country flag emoji
  String get countryFlag {
    switch (country) {
      case 'India':   return '🇮🇳';
      case 'USA':     return '🇺🇸';
      case 'Germany': return '🇩🇪';
      case 'Japan':   return '🇯🇵';
      default:        return '🌐';
    }
  }

  /// P&L in INR for unified display (uses pnlINR for foreign, pnl for INR trades)
  double get pnlDisplayINR => isForeign ? pnlINR : pnl;

  /// Currency symbol for display
  String get currencySymbol {
    switch (currency) {
      case 'USD': return '\$';
      case 'EUR': return '€';
      case 'JPY': return '¥';
      default:    return '₹';
    }
  }

  /// Formatted P&L in native currency (e.g. "+₹1,234.50" or "+\$12.50")
  String get pnlFormatted {
    final prefix = pnl >= 0 ? '+' : '';
    if (currency == 'INR') return '$prefix${_formatINR(pnl)}';
    return '$prefix$currencySymbol${pnl.abs().toStringAsFixed(2)}';
  }

  String get pnlPctFormatted {
    final prefix = pnlPct >= 0 ? '+' : '';
    return '$prefix${pnlPct.toStringAsFixed(2)}%';
  }

  DateTime get timestamp => DateTime.fromMillisecondsSinceEpoch(timestampMs);

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
      pnlINR:               (d['pnlINR']          as num?)?.toDouble() ?? 0,
      reason:               d['reason']           as String? ?? '',
      confidence:           d['confidence']       as String? ?? 'LOW',
      stopLoss:             (d['stopLoss']        as num?)?.toDouble() ?? 0,
      target:               (d['target']          as num?)?.toDouble() ?? 0,
      tradeType:            d['tradeType']        as String? ?? 'MOMENTUM',
      marketSentiment:      d['marketSentiment']  as String? ?? 'NEUTRAL',
      portfolioValueAfter:  (d['portfolioValueAfter'] as num?)?.toDouble() ?? 0,
      market:               d['market']           as String? ?? 'NSE',
      country:              d['country']          as String? ?? 'India',
      currency:             d['currency']         as String? ?? 'INR',
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
    'pnlINR':              pnlINR,
    'reason':              reason,
    'confidence':          confidence,
    'stopLoss':            stopLoss,
    'target':              target,
    'tradeType':           tradeType,
    'marketSentiment':     marketSentiment,
    'portfolioValueAfter': portfolioValueAfter,
    'market':              market,
    'country':             country,
    'currency':            currency,
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
