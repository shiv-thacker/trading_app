/// screens/portfolio_screen.dart
/// ================================
/// Detailed portfolio analysis screen — two tabs:
///
///   ⚡ INTRADAY  — intraday portfolio (5-min cycles, same-day)
///   📈 SWING     — swing portfolio (hourly cycles, multi-day holds)
///
/// Each tab shows:
///   1. Stats summary (starting capital, P&L breakdown)
///   2. Allocation pie chart (holdings + cash)
///   3. Performance line chart (all-time for intraday, multi-day for swing)
///   4. Position detail cards (with SL/target bar)

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';

import '../models/portfolio.dart';
import '../services/firestore_service.dart';
import '../widgets/portfolio_chart.dart';
import 'dashboard_screen.dart' show portfolioProvider, snapshotsProvider;

// ─────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────

final realizedPnlProvider = FutureProvider<double>((ref) {
  return ref.read(firestoreServiceProvider).getTotalRealizedPnL();
});

final swingPortfolioProvider = StreamProvider<Portfolio>((ref) {
  return ref.read(firestoreServiceProvider).swingPortfolioStream();
});

final swingSnapshotsProvider = StreamProvider<List<Snapshot>>((ref) {
  return ref.read(firestoreServiceProvider).swingSnapshotsStream();
});

final swingRealizedPnlProvider = FutureProvider<double>((ref) {
  return ref.read(firestoreServiceProvider).getSwingRealizedPnL();
});

// ─────────────────────────────────────────────────────────────
// PortfolioScreen — tabbed Intraday | Swing
// ─────────────────────────────────────────────────────────────
class PortfolioScreen extends StatelessWidget {
  const PortfolioScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
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
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(44),
            child: Container(
              margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              height: 36,
              decoration: BoxDecoration(
                color: const Color(0xFF161B22),
                borderRadius: BorderRadius.circular(8),
              ),
              child: TabBar(
                indicator: BoxDecoration(
                  color: const Color(0xFF00FF88).withOpacity(0.12),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFF00FF88).withOpacity(0.35)),
                ),
                indicatorSize: TabBarIndicatorSize.tab,
                dividerColor: Colors.transparent,
                splashFactory: NoSplash.splashFactory,
                labelColor: const Color(0xFF00FF88),
                unselectedLabelColor: Colors.grey.shade500,
                labelStyle: GoogleFonts.jetBrainsMono(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                ),
                unselectedLabelStyle: GoogleFonts.jetBrainsMono(fontSize: 11),
                tabs: const [
                  Tab(text: '⚡  INTRADAY'),
                  Tab(text: '📈  SWING'),
                ],
              ),
            ),
          ),
        ),
        body: const TabBarView(
          children: [
            _IntradayPortfolioTab(),
            _SwingPortfolioTab(),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Intraday Portfolio Tab
// ─────────────────────────────────────────────────────────────
class _IntradayPortfolioTab extends ConsumerWidget {
  const _IntradayPortfolioTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final portfolio    = ref.watch(portfolioProvider).valueOrNull ?? Portfolio.empty();
    final snapshots    = ref.watch(snapshotsProvider).valueOrNull ?? [];
    final realizedPnl  = ref.watch(realizedPnlProvider).valueOrNull ?? 0;

    return _PortfolioTabContent(
      portfolio:   portfolio,
      snapshots:   snapshots,
      realizedPnl: realizedPnl,
      isSwing:     false,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Swing Portfolio Tab
// ─────────────────────────────────────────────────────────────
class _SwingPortfolioTab extends ConsumerWidget {
  const _SwingPortfolioTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final portfolio   = ref.watch(swingPortfolioProvider).valueOrNull ?? Portfolio.empty();
    final snapshots   = ref.watch(swingSnapshotsProvider).valueOrNull ?? [];
    final realizedPnl = ref.watch(swingRealizedPnlProvider).valueOrNull ?? 0;

    return _PortfolioTabContent(
      portfolio:   portfolio,
      snapshots:   snapshots,
      realizedPnl: realizedPnl,
      isSwing:     true,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Shared tab content (used by both tabs)
// ─────────────────────────────────────────────────────────────
class _PortfolioTabContent extends StatelessWidget {
  final Portfolio portfolio;
  final List<Snapshot> snapshots;
  final double realizedPnl;
  final bool isSwing;

  const _PortfolioTabContent({
    required this.portfolio,
    required this.snapshots,
    required this.realizedPnl,
    required this.isSwing,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        // ── Mode description banner ────────────────────────
        _ModeBanner(isSwing: isSwing),

        // ── Stats summary ──────────────────────────────────
        _StatsSummary(portfolio: portfolio, realizedPnl: realizedPnl),

        const SizedBox(height: 20),

        // ── Allocation pie chart ───────────────────────────
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

        // ── Performance chart ──────────────────────────────
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(
            isSwing ? 'MULTI-DAY PERFORMANCE' : 'ALL-TIME PERFORMANCE',
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

        // ── Positions ──────────────────────────────────────
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
          ...portfolio.holdings.map((h) => _HoldingDetail(holding: h, isSwing: isSwing)),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Mode banner
// ─────────────────────────────────────────────────────────────
class _ModeBanner extends StatelessWidget {
  final bool isSwing;
  const _ModeBanner({required this.isSwing});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: (isSwing ? const Color(0xFF7C4DFF) : const Color(0xFF00FF88)).withOpacity(0.06),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: (isSwing ? const Color(0xFF7C4DFF) : const Color(0xFF00FF88)).withOpacity(0.15),
        ),
      ),
      child: Row(
        children: [
          Text(isSwing ? '📈' : '⚡', style: const TextStyle(fontSize: 14)),
          const SizedBox(width: 8),
          Text(
            isSwing
                ? 'Swing portfolio — multi-day positions, web search powered'
                : 'Intraday portfolio — same-day positions, 5-min cycles',
            style: TextStyle(
              color: Colors.grey.shade400,
              fontSize: 11,
              height: 1.3,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Stats summary
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
          _StatRow('Available Cash', portfolio.cash),
          _StatRow('Invested',       portfolio.totalValue - portfolio.cash),
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
    final sections  = <PieChartSectionData>[];
    final legends   = <_LegendItem>[];

    // Cash section
    final cashPct = portfolio.cashPct;
    sections.add(PieChartSectionData(
      value:     cashPct,
      color:     const Color(0xFF78909C),
      title:     cashPct > 8 ? '${cashPct.toStringAsFixed(0)}%' : '',
      titleStyle: const TextStyle(fontSize: 10, color: Colors.white, fontWeight: FontWeight.bold),
      radius:    _touchedIndex == 0 ? 90.0 : 80.0,
    ));
    legends.add(_LegendItem(
      label: 'Cash',
      color: const Color(0xFF78909C),
      value: '${cashPct.toStringAsFixed(1)}%',
    ));

    for (int i = 0; i < portfolio.holdings.length; i++) {
      final h   = portfolio.holdings[i];
      final pct = portfolio.totalValue > 0
          ? (h.currentValue / portfolio.totalValue * 100)
          : 0.0;
      final color = _palette[i % (_palette.length - 1)];
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
// Holding Detail Card
// ─────────────────────────────────────────────────────────────
class _HoldingDetail extends StatelessWidget {
  final Holding holding;
  final bool isSwing;
  const _HoldingDetail({required this.holding, required this.isSwing});

  @override
  Widget build(BuildContext context) {
    final isProfit = holding.isProfit;
    final pnlColor = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    final range    = holding.target - holding.stopLoss;
    final progress = range > 0
        ? ((holding.currentPrice - holding.stopLoss) / range).clamp(0.0, 1.0)
        : 0.5;

    // Duration label: intraday uses minutes, swing uses days
    final durationLabel = isSwing
        ? '${holding.daysHeld} day${holding.daysHeld != 1 ? 's' : ''} held'
        : '${holding.minutesHeld} min held';

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
              if (isSwing) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(
                    color: const Color(0xFF7C4DFF).withOpacity(0.1),
                    borderRadius: BorderRadius.circular(3),
                    border: Border.all(color: const Color(0xFF7C4DFF).withOpacity(0.3)),
                  ),
                  child: Text(
                    'SWING',
                    style: GoogleFonts.jetBrainsMono(
                      color: const Color(0xFF7C4DFF),
                      fontSize: 8,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
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

          // SL → TGT progress bar
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
                  Container(
                    height: 4,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(2),
                      gradient: const LinearGradient(
                        colors: [Color(0xFFFF3B30), Color(0xFFFFA726), Color(0xFF00C853)],
                      ),
                    ),
                  ),
                  FractionallySizedBox(widthFactor: progress, child: Container()),
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
            'Value: ₹${(holding.currentPrice * holding.quantity).toStringAsFixed(2)} · $durationLabel',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 10),
          ),
        ],
      ),
    );
  }
}
