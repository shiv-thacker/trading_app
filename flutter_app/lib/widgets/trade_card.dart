/// widgets/trade_card.dart
/// ========================
/// Displays a single executed trade in the History screen.
///
/// LAYOUT:
///   ┌─────────────────────────────────────────┐
///   │ [BUY] RELIANCE · Reliance Industries    │
///   │        2 minutes ago                    │
///   │ ₹2,847.50 × 10 shares = ₹28,475.00     │
///   │ P&L: +₹1,234.50 (+4.34%)  [SELL only]  │
///   │ "ARJUN's reasoning paragraph..."        │
///   │ [MOMENTUM] [HIGH confidence]            │
///   └─────────────────────────────────────────┘
///
/// Color coding:
///   BUY  badge → blue
///   SELL badge → green (profit) or red (loss)
///   P&L        → green positive, red negative

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../models/trade.dart';

class TradeCard extends StatelessWidget {
  final Trade trade;

  const TradeCard({super.key, required this.trade});

  @override
  Widget build(BuildContext context) {
    final isBuy  = trade.action == 'BUY';
    final isSell = trade.action == 'SELL';
    final hasProfit = isSell && trade.pnl >= 0;
    final hasLoss   = isSell && trade.pnl < 0;

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
                const SizedBox(width: 10),

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
                Text(
                  '₹${_fmt(trade.price)} × ${trade.quantity} shares = ₹${_fmt(trade.totalAmount)}',
                  style: GoogleFonts.jetBrainsMono(
                    color: Colors.white70,
                    fontSize: 12,
                  ),
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
                    style: TextStyle(
                      color: Colors.grey.shade500,
                      fontSize: 12,
                    ),
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
                const Spacer(),
                if (trade.sector.isNotEmpty)
                  Text(
                    trade.sector,
                    style: TextStyle(
                      color: Colors.grey.shade600,
                      fontSize: 10,
                    ),
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
