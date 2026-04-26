/// screens/portfolio_screen.dart
/// ================================
/// Detailed portfolio analysis screen.
///
/// SECTIONS:
///   1. Pie chart — holdings + cash as colored segments
///   2. All-time portfolio value line chart (from Firestore snapshots)
///   3. Holdings list with:
///        - Avg buy price vs current price comparison bar
///        - Stop-loss level indicator
///        - Target level indicator
///        - Unrealized P&L (color coded)
///   4. Portfolio stats summary (total invested, realized P&L, etc.)

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';

import '../models/portfolio.dart';
import '../services/firestore_service.dart';
import '../widgets/portfolio_chart.dart';
import 'dashboard_screen.dart' show portfolioProvider, snapshotsProvider;

// Realized P&L future provider
final realizedPnlProvider = FutureProvider<double>((ref) {
  return ref.read(firestoreServiceProvider).getTotalRealizedPnL();
});

// ─────────────────────────────────────────────────────────────
// PortfolioScreen
// ─────────────────────────────────────────────────────────────
class PortfolioScreen extends ConsumerWidget {
  const PortfolioScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final portfolioAsync  = ref.watch(portfolioProvider);
    final snapshotsAsync  = ref.watch(snapshotsProvider);
    final realizedAsync   = ref.watch(realizedPnlProvider);

    final portfolio  = portfolioAsync.valueOrNull ?? Portfolio.empty();
    final snapshots  = snapshotsAsync.valueOrNull ?? [];
    final realizedPnl = realizedAsync.valueOrNull ?? 0;

    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0D1117),
        title: Text(
          'Portfolio',
          style: GoogleFonts.jetBrainsMono(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          // ── Portfolio stats summary ────────────────────────
          _StatsSummary(
            portfolio:    portfolio,
            realizedPnl:  realizedPnl,
          ),

          const SizedBox(height: 20),

          // ── Pie chart ─────────────────────────────────────
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              'ALLOCATION',
              style: GoogleFonts.jetBrainsMono(
                color: Colors.grey.shade500,
                fontSize: 11,
                letterSpacing: 1.5,
              ),
            ),
          ),
          const SizedBox(height: 12),
          _AllocationPieChart(portfolio: portfolio),

          const SizedBox(height: 24),

          // ── All-time chart ────────────────────────────────
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              'ALL-TIME PERFORMANCE',
              style: GoogleFonts.jetBrainsMono(
                color: Colors.grey.shade500,
                fontSize: 11,
                letterSpacing: 1.5,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: PortfolioChart(
              snapshots:       snapshots,
              startingCapital: portfolio.startingCapital,
              isIntraday:      false,
              height:          200,
            ),
          ),

          const SizedBox(height: 24),

          // ── Holdings detail ────────────────────────────────
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              'POSITIONS',
              style: GoogleFonts.jetBrainsMono(
                color: Colors.grey.shade500,
                fontSize: 11,
                letterSpacing: 1.5,
              ),
            ),
          ),
          const SizedBox(height: 10),

          if (portfolio.holdings.isEmpty)
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 16),
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: const Color(0xFF161B22),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.white.withOpacity(0.06)),
              ),
              child: Center(
                child: Text(
                  'No open positions',
                  style: TextStyle(color: Colors.grey.shade500),
                ),
              ),
            )
          else
            ...portfolio.holdings.map((h) => _HoldingDetail(holding: h)),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Stats summary row
// ─────────────────────────────────────────────────────────────
class _StatsSummary extends StatelessWidget {
  final Portfolio portfolio;
  final double realizedPnl;

  const _StatsSummary({required this.portfolio, required this.realizedPnl});

  @override
  Widget build(BuildContext context) {
    final unrealized = portfolio.unrealizedPnlTotal;
    final totalPnl   = portfolio.totalPnl;

    return Container(
      margin: const EdgeInsets.all(16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Column(
        children: [
          _StatRow('Starting Capital', portfolio.startingCapital),
          _StatRow('Current Value',    portfolio.totalValue,
              highlight: true, isProfit: portfolio.isProfit),
          const Divider(color: Color(0x14FFFFFF), height: 20),
          _StatRow('Realized P&L',  realizedPnl,  showSign: true),
          _StatRow('Unrealized P&L', unrealized,   showSign: true),
          _StatRow('Total P&L',      totalPnl,     showSign: true, bold: true),
          const Divider(color: Color(0x14FFFFFF), height: 20),
          _StatRow('Available Cash',  portfolio.cash),
          _StatRow('Invested',
              portfolio.totalValue - portfolio.cash),
        ],
      ),
    );
  }
}

class _StatRow extends StatelessWidget {
  final String label;
  final double value;
  final bool highlight;
  final bool? isProfit;
  final bool showSign;
  final bool bold;

  const _StatRow(this.label, this.value, {
    this.highlight = false,
    this.isProfit,
    this.showSign = false,
    this.bold = false,
  });

  @override
  Widget build(BuildContext context) {
    Color color = Colors.white70;
    if (highlight && isProfit != null) {
      color = isProfit! ? const Color(0xFF00C853) : const Color(0xFFFF3B30);
    } else if (showSign) {
      color = value >= 0 ? const Color(0xFF00C853) : const Color(0xFFFF3B30);
    }

    final prefix = showSign && value >= 0 ? '+' : '';
    final fmt    = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(color: Colors.grey.shade500, fontSize: 13)),
          Text(
            '$prefix${fmt.format(value)}',
            style: GoogleFonts.jetBrainsMono(
              color: color,
              fontSize: 13,
              fontWeight: bold ? FontWeight.bold : FontWeight.normal,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Allocation Pie Chart
// ─────────────────────────────────────────────────────────────
class _AllocationPieChart extends StatefulWidget {
  final Portfolio portfolio;
  const _AllocationPieChart({required this.portfolio});

  @override
  State<_AllocationPieChart> createState() => _AllocationPieChartState();
}

class _AllocationPieChartState extends State<_AllocationPieChart> {
  int _touchedIndex = -1;

  static const List<Color> _palette = [
    Color(0xFF00C853), Color(0xFF1D6FEB), Color(0xFFFFA726),
    Color(0xFFAB47BC), Color(0xFF26C6DA), Color(0xFF78909C),
  ];

  @override
  Widget build(BuildContext context) {
    final portfolio = widget.portfolio;

    // Build pie sections: one per holding + cash
    final sections = <PieChartSectionData>[];
    final legends  = <_LegendItem>[];

    // Cash section (always first)
    final cashPct = portfolio.cashPct;
    sections.add(PieChartSectionData(
      value:     cashPct,
      color:     const Color(0xFF78909C),
      title:     cashPct > 8 ? '${cashPct.toStringAsFixed(0)}%' : '',
      titleStyle: const TextStyle(fontSize: 10, color: Colors.white, fontWeight: FontWeight.bold),
      radius:    _touchedIndex == 0 ? 90.0 : 80.0,
    ));
    legends.add(_LegendItem(label: 'Cash', color: const Color(0xFF78909C),
        value: '${cashPct.toStringAsFixed(1)}%'));

    // Holdings sections
    for (int i = 0; i < portfolio.holdings.length; i++) {
      final h   = portfolio.holdings[i];
      final pct = portfolio.totalValue > 0
          ? (h.currentValue / portfolio.totalValue * 100)
          : 0.0;
      final color = _palette[i % (_palette.length - 1)]; // skip grey
      sections.add(PieChartSectionData(
        value:     pct,
        color:     color,
        title:     pct > 8 ? '${pct.toStringAsFixed(0)}%' : '',
        titleStyle: const TextStyle(fontSize: 10, color: Colors.white, fontWeight: FontWeight.bold),
        radius:    _touchedIndex == i + 1 ? 90.0 : 80.0,
      ));
      legends.add(_LegendItem(
        label: h.symbol,
        color: color,
        value: '${pct.toStringAsFixed(1)}%',
      ));
    }

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 150,
            height: 150,
            child: PieChart(
              PieChartData(
                sections: sections,
                pieTouchData: PieTouchData(
                  touchCallback: (event, response) {
                    if (event is FlTapUpEvent || event is FlPointerExitEvent) {
                      setState(() => _touchedIndex = -1);
                    } else if (response?.touchedSection != null) {
                      setState(() {
                        _touchedIndex = response!.touchedSection!.touchedSectionIndex;
                      });
                    }
                  },
                ),
                centerSpaceRadius: 30,
                sectionsSpace: 2,
              ),
            ),
          ),
          const SizedBox(width: 20),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: legends.map((l) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: l.color,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        l.label,
                        style: GoogleFonts.jetBrainsMono(
                          color: Colors.white70,
                          fontSize: 11,
                        ),
                      ),
                    ),
                    Text(
                      l.value,
                      style: GoogleFonts.jetBrainsMono(
                        color: Colors.grey.shade500,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              )).toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class _LegendItem {
  final String label;
  final Color color;
  final String value;
  const _LegendItem({required this.label, required this.color, required this.value});
}

// ─────────────────────────────────────────────────────────────
// Holding Detail Card (with price bar + SL/target indicators)
// ─────────────────────────────────────────────────────────────
class _HoldingDetail extends StatelessWidget {
  final Holding holding;
  const _HoldingDetail({required this.holding});

  @override
  Widget build(BuildContext context) {
    final isProfit = holding.isProfit;
    final pnlColor = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    // Progress: 0 = at stop loss, 0.5 = at buy price, 1 = at target
    final range    = holding.target - holding.stopLoss;
    final progress = range > 0
        ? ((holding.currentPrice - holding.stopLoss) / range).clamp(0.0, 1.0)
        : 0.5;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF161B22),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.06)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Symbol + P&L
          Row(
            children: [
              Text(
                holding.symbol,
                style: GoogleFonts.jetBrainsMono(
                  color: Colors.white,
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                holding.sector,
                style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
              ),
              const Spacer(),
              Text(
                '${isProfit ? '+' : ''}${holding.unrealizedPnlPct.toStringAsFixed(2)}%',
                style: GoogleFonts.jetBrainsMono(
                  color: pnlColor,
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${holding.quantity} shares @ avg ₹${holding.avgBuyPrice.toStringAsFixed(2)} → now ₹${holding.currentPrice.toStringAsFixed(2)}',
            style: GoogleFonts.jetBrainsMono(
              color: Colors.grey.shade400,
              fontSize: 11,
            ),
          ),

          const SizedBox(height: 12),

          // SL ←───────●───────→ TGT progress bar
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('SL ₹${holding.stopLoss.toStringAsFixed(1)}',
                      style: TextStyle(color: const Color(0xFFFF3B30).withOpacity(0.7), fontSize: 9)),
                  Text('TGT ₹${holding.target.toStringAsFixed(1)}',
                      style: TextStyle(color: const Color(0xFF00C853).withOpacity(0.7), fontSize: 9)),
                ],
              ),
              const SizedBox(height: 4),
              Stack(
                alignment: Alignment.centerLeft,
                children: [
                  // Background track
                  Container(
                    height: 4,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(2),
                      gradient: const LinearGradient(
                        colors: [Color(0xFFFF3B30), Color(0xFFFFA726), Color(0xFF00C853)],
                      ),
                    ),
                  ),
                  // Current price indicator
                  FractionallySizedBox(
                    widthFactor: progress,
                    child: Container(),
                  ),
                  Positioned(
                    left: progress * (MediaQuery.of(context).size.width - 76) - 6,
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: pnlColor,
                        border: Border.all(color: Colors.black, width: 2),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),

          const SizedBox(height: 8),
          Text(
            'Value: ₹${(holding.currentPrice * holding.quantity).toStringAsFixed(2)} · Held ${holding.minutesHeld} min',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
          ),
        ],
      ),
    );
  }
}
