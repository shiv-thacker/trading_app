/// widgets/portfolio_chart.dart
/// ==============================
/// Reusable portfolio value line chart widget.
///
/// USES: fl_chart (LineChart)
///
/// TWO VARIANTS:
///   PortfolioChart.intraday   → Today's value only (9:15 AM–3:30 PM)
///                               Used on Dashboard screen
///   PortfolioChart.allTime    → Full history since day 1
///                               Used on Portfolio screen
///
/// CHART FEATURES:
///   - Dark background (trading terminal aesthetic)
///   - Green line if currently profitable, red if at loss
///   - Gradient fill under the line
///   - Starting capital reference line (dashed, grey)
///   - Touch tooltip showing date/time + portfolio value
///   - X-axis: time labels (HH:MM for intraday, DD/MM for all-time)
///   - Y-axis: ₹ values with Indian formatting

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';

import '../models/portfolio.dart';

class PortfolioChart extends StatelessWidget {
  final List<Snapshot> snapshots;
  final double startingCapital;
  final bool isIntraday;
  final double height;

  const PortfolioChart({
    super.key,
    required this.snapshots,
    required this.startingCapital,
    this.isIntraday = true,
    this.height = 180,
  });

  @override
  Widget build(BuildContext context) {
    if (snapshots.isEmpty) {
      return SizedBox(
        height: height,
        child: Center(
          child: Text(
            'No data yet — ARJUN will chart once trading begins',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
          ),
        ),
      );
    }

    final spots = _buildSpots();
    if (spots.isEmpty) return const SizedBox.shrink();

    final latestValue = snapshots.last.totalValue;
    final isProfit    = latestValue >= startingCapital;
    final lineColor   = isProfit ? const Color(0xFF00C853) : const Color(0xFFFF3B30);

    final minY = (spots.map((s) => s.y).reduce((a, b) => a < b ? a : b) * 0.995)
        .floorToDouble();
    final maxY = (spots.map((s) => s.y).reduce((a, b) => a > b ? a : b) * 1.005)
        .ceilToDouble();

    return SizedBox(
      height: height,
      child: LineChart(
        LineChartData(
          backgroundColor: Colors.transparent,
          gridData: FlGridData(
            show: true,
            drawVerticalLine: false,
            horizontalInterval: (maxY - minY) / 4,
            getDrawingHorizontalLine: (_) => FlLine(
              color: Colors.white.withOpacity(0.05),
              strokeWidth: 1,
            ),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles:    const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            rightTitles:  const AxisTitles(sideTitles: SideTitles(showTitles: false)),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 60,
                getTitlesWidget: (val, meta) => Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Text(
                    _formatINRShort(val),
                    style: GoogleFonts.jetBrainsMono(
                      color: Colors.grey.shade600,
                      fontSize: 9,
                    ),
                  ),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 22,
                getTitlesWidget: (val, meta) {
                  final idx = val.toInt();
                  if (idx < 0 || idx >= snapshots.length) {
                    return const SizedBox.shrink();
                  }
                  // Show label every ~5 points
                  if (idx % 5 != 0 && idx != snapshots.length - 1) {
                    return const SizedBox.shrink();
                  }
                  final ts = snapshots[idx].timestamp;
                  final label = isIntraday
                      ? DateFormat('HH:mm').format(ts)
                      : DateFormat('dd/MM').format(ts);
                  return Text(
                    label,
                    style: GoogleFonts.jetBrainsMono(
                      color: Colors.grey.shade600,
                      fontSize: 9,
                    ),
                  );
                },
              ),
            ),
          ),
          minX: 0,
          maxX: (spots.length - 1).toDouble(),
          minY: minY,
          maxY: maxY,
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => const Color(0xFF21262D),
              getTooltipItems: (spots) {
                return spots.map((spot) {
                  final idx = spot.x.toInt();
                  if (idx < 0 || idx >= snapshots.length) return null;
                  final snap = snapshots[idx];
                  final fmt = isIntraday
                      ? DateFormat('HH:mm').format(snap.timestamp)
                      : DateFormat('dd MMM').format(snap.timestamp);
                  return LineTooltipItem(
                    '$fmt\n₹${_formatINRShort(snap.totalValue)}',
                    GoogleFonts.jetBrainsMono(
                      color: lineColor,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  );
                }).toList();
              },
            ),
          ),
          extraLinesData: ExtraLinesData(
            horizontalLines: [
              HorizontalLine(
                y: startingCapital,
                color: Colors.grey.withOpacity(0.3),
                strokeWidth: 1,
                dashArray: [4, 6],
                label: HorizontalLineLabel(
                  show: true,
                  alignment: Alignment.topRight,
                  labelResolver: (_) => '₹${_formatINRShort(startingCapital)}',
                  style: GoogleFonts.jetBrainsMono(
                    color: Colors.grey.shade600,
                    fontSize: 9,
                  ),
                ),
              ),
            ],
          ),
          lineBarsData: [
            LineChartBarData(
              spots:               spots,
              isCurved:            true,
              curveSmoothness:     0.25,
              color:               lineColor,
              barWidth:            2,
              isStrokeCapRound:    true,
              dotData:             const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end:   Alignment.bottomCenter,
                  colors: [
                    lineColor.withOpacity(0.25),
                    lineColor.withOpacity(0.0),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<FlSpot> _buildSpots() {
    final spots = <FlSpot>[];
    for (int i = 0; i < snapshots.length; i++) {
      final val = snapshots[i].totalValue;
      if (val > 0) {
        spots.add(FlSpot(i.toDouble(), val));
      }
    }
    return spots;
  }

  /// Format ₹ value in short Indian format (e.g. ₹10.2K, ₹1.23L)
  String _formatINRShort(double val) {
    if (val >= 100000) {
      return '₹${(val / 100000).toStringAsFixed(2)}L';
    } else if (val >= 1000) {
      return '₹${(val / 1000).toStringAsFixed(1)}K';
    }
    return '₹${val.toStringAsFixed(0)}';
  }
}
