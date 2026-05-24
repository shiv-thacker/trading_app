/// widgets/trade_card.dart
/// ========================
/// Displays a single executed trade in the History screen.
/// Supports both India-only and multi-market global trades.
///
/// LAYOUT:
///   ┌──────────────────────────────────────────────┐
///   │ [BUY] 🇺🇸 AAPL.US · Apple Inc        2h ago │
///   │ $182.50 × 5 shares = $912.50 [US] [HIGH]    │
///   │ P&L: +$18.25 (+2.0%) = +₹1,520 INR [SELL]  │
///   │ "ARJUN's reasoning..."                       │
///   │ [MOMENTUM] [HIGH] [USA]                      │
///   └──────────────────────────────────────────────┘

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../models/trade.dart';

class TradeCard extends StatelessWidget {
  final Trade trade;

  const TradeCard({super.key, required this.trade});

  @override
  Widget build(BuildContext context) {
    final isBuy     = trade.action == 'BUY';
    final isSell    = trade.action == 'SELL';
    final hasProfit = isSell && trade.pnl >= 0;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isBuy
              ? const Color(0xFF1D6FEB).withOpacity(0.3)
              : hasProfit
                  ? const Color(0xFF00C853).withOpacity(0.3)
                  : const Color(0xFFFF3B30).withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header row ──────────────────────────────────
            Row(
              children: [
                // BUY/SELL badge
                _Badge(
                  label: trade.action,
                  color: isBuy
                      ? const Color(0xFF1D6FEB)
                      : hasProfit
                          ? const Color(0xFF00C853)
                          : const Color(0xFFFF3B30),
                ),
                const SizedBox(width: 8),

                // Country flag (for global trades)
                if (trade.isForeign) ...[
                  Text(
                    trade.countryFlag,
                    style: const TextStyle(fontSize: 14),
                  ),
                  const SizedBox(width: 6),
                ],

                // Symbol + company
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        trade.symbol,
                        style: GoogleFonts.jetBrainsMono(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      if (trade.companyName.isNotEmpty)
                        Text(
                          trade.companyName,
                          style: TextStyle(
                            color: Colors.grey.shade500,
                            fontSize: 11,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),

                // Timestamp
                Text(
                  timeago.format(trade.timestamp),
                  style: TextStyle(
                    color: Colors.grey.shade600,
                    fontSize: 11,
                  ),
                ),
              ],
            ),

            const SizedBox(height: 10),
            Divider(color: Colors.white.withOpacity(0.06), height: 1),
            const SizedBox(height: 10),

            // ── Price row ────────────────────────────────────
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${trade.currencySymbol}${_fmt(trade.price)} × ${trade.quantity} shares = ${trade.currencySymbol}${_fmt(trade.totalAmount)}',
                    style: GoogleFonts.jetBrainsMono(
                      color: Colors.white70,
                      fontSize: 12,
                    ),
                  ),
                ),
                // Market badge (foreign trades)
                if (trade.isForeign)
                  _Badge(
                    label: trade.market,
                    color: const Color(0xFF00BCD4),
                    small: true,
                  ),
              ],
            ),

            // ── P&L row (SELL only) ──────────────────────────
            if (isSell) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  Text(
                    'P&L: ',
                    style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                  ),
                  Text(
                    trade.pnlFormatted,
                    style: GoogleFonts.jetBrainsMono(
                      color: hasProfit
                          ? const Color(0xFF00C853)
                          : const Color(0xFFFF3B30),
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '(${trade.pnlPctFormatted})',
                    style: TextStyle(
                      color: hasProfit
                          ? const Color(0xFF00C853).withOpacity(0.7)
                          : const Color(0xFFFF3B30).withOpacity(0.7),
                      fontSize: 12,
                    ),
                  ),
                  // Show INR equivalent for foreign trades
                  if (trade.isForeign && trade.pnlINR != 0) ...[
                    const SizedBox(width: 8),
                    Text(
                      '≈ ${trade.pnlINR >= 0 ? '+' : ''}₹${trade.pnlINR.abs().toStringAsFixed(0)} INR',
                      style: TextStyle(
                        color: Colors.grey.shade600,
                        fontSize: 10,
                      ),
                    ),
                  ],
                ],
              ),
            ],

            // ── AI Reason ────────────────────────────────────
            if (trade.reason.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.03),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: Colors.white.withOpacity(0.05),
                  ),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '🤖 ',
                      style: const TextStyle(fontSize: 12),
                    ),
                    Expanded(
                      child: Text(
                        trade.reason,
                        style: TextStyle(
                          color: Colors.grey.shade400,
                          fontSize: 12,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 10),

            // ── Footer badges ────────────────────────────────
            Row(
              children: [
                _Badge(
                  label: trade.tradeType,
                  color: const Color(0xFF6B7280),
                  small: true,
                ),
                const SizedBox(width: 6),
                _Badge(
                  label: trade.confidence,
                  color: _confidenceColor(trade.confidence),
                  small: true,
                ),
                if (trade.isForeign) ...[
                  const SizedBox(width: 6),
                  Text(
                    '${trade.countryFlag} ${trade.country}',
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
                  ),
                ],
                const Spacer(),
                if (trade.sector.isNotEmpty)
                  Text(
                    trade.sector,
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Format a number with Indian comma grouping (no ₹ prefix)
  String _fmt(double val) {
    return val.toStringAsFixed(2).replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+\.)', ),
      (m) => '${m[1]},',
    );
  }

  Color _confidenceColor(String c) {
    switch (c) {
      case 'HIGH':   return const Color(0xFF00C853);
      case 'MEDIUM': return const Color(0xFFFFA726);
      default:       return const Color(0xFFEF5350);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// _Badge — small colored label chip
// ─────────────────────────────────────────────────────────────
class _Badge extends StatelessWidget {
  final String label;
  final Color color;
  final bool small;

  const _Badge({required this.label, required this.color, this.small = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: small ? 6 : 8,
        vertical: small ? 2 : 4,
      ),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(
        label,
        style: GoogleFonts.jetBrainsMono(
          color: color,
          fontSize: small ? 9 : 11,
          fontWeight: FontWeight.bold,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
