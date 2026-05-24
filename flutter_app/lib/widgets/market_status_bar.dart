/// widgets/market_status_bar.dart
/// ================================
/// Animated status bar showing ARJUN's live global trading status.
///
/// DISPLAYS:
///   - Animated pulsing dot: green when any market is open, grey when all closed
///   - Status text: shows which markets are open or "All markets closed"
///   - Countdown timer: MM:SS until next hourly cycle
///
/// Global market hours (UTC):
///   India  (NSE):   Mon–Fri 03:45–10:00 UTC
///   USA    (NYSE):  Mon–Fri 13:30–20:00 UTC
///   Germany (XETRA):Mon–Fri 07:00–15:30 UTC
///   Japan  (TSE):   Mon–Fri 00:00–06:30 UTC

import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class MarketStatusBar extends StatefulWidget {
  /// Latest cycle status from AI log ("TRADED" | "WAITED" | "MARKET_CLOSED")
  final String? cycleStatus;

  const MarketStatusBar({super.key, this.cycleStatus});

  @override
  State<MarketStatusBar> createState() => _MarketStatusBarState();
}

class _MarketStatusBarState extends State<MarketStatusBar>
    with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;
  late Timer _countdownTimer;
  int _secondsUntilNext = 0;

  @override
  void initState() {
    super.initState();
    // Pulse animation — 1.5 second cycle
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat();

    _updateCountdown();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) _updateCountdown();
    });
  }

  void _updateCountdown() {
    final now = DateTime.now();
    // Next hourly boundary
    final nextCycle = DateTime(now.year, now.month, now.day, now.hour + 1, 0, 0);
    setState(() {
      _secondsUntilNext = nextCycle.difference(now).inSeconds.clamp(0, 3600);
    });
  }

  /// Returns list of currently-open market flags (UTC-based check)
  List<String> get _openMarkets {
    final now = DateTime.now().toUtc();
    if (now.weekday == DateTime.saturday || now.weekday == DateTime.sunday) return [];
    final mins = now.hour * 60 + now.minute;
    final open = <String>[];
    if (mins >= 225 && mins < 600)  open.add('🇮🇳');  // India  03:45–10:00 UTC
    if (mins >= 420 && mins < 930)  open.add('🇩🇪');  // Germany 07:00–15:30 UTC
    if (mins >= 810 && mins < 1200) open.add('🇺🇸');  // USA    13:30–20:00 UTC
    if (mins >= 0   && mins < 390)  open.add('🇯🇵');  // Japan  00:00–06:30 UTC
    return open;
  }

  bool get _isAnyMarketOpen => _openMarkets.isNotEmpty;

  String get _statusText {
    final open = _openMarkets;
    if (open.isEmpty) {
      return 'All markets closed — next cycle at next hour';
    }
    final marketsStr = open.join(' ');
    switch (widget.cycleStatus) {
      case 'TRADED':
        return 'ARJUN executed trades  $marketsStr';
      case 'ALL_MARKETS_CLOSED':
        return 'All markets closed — next cycle at next hour';
      default:
        return 'ARJUN scanning $marketsStr live...';
    }
  }

  String get _countdownText {
    final mins = _secondsUntilNext ~/ 60;
    final secs = _secondsUntilNext % 60;
    return 'Next: ${mins.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _countdownTimer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isOpen = _isAnyMarketOpen;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF0D1117),
        border: Border(
          bottom: BorderSide(color: Colors.white.withOpacity(0.08)),
        ),
      ),
      child: Row(
        children: [
          // Pulsing status dot
          AnimatedBuilder(
            animation: _pulseController,
            builder: (_, __) {
              final pulse = isOpen
                  ? ((sin(_pulseController.value * 2 * pi) + 1) / 2)
                  : 0.3;
              return Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isOpen
                      ? Color.lerp(
                          const Color(0xFF00FF88),
                          const Color(0xFF00CC66),
                          pulse,
                        )
                      : Colors.grey.shade700,
                  boxShadow: isOpen
                      ? [
                          BoxShadow(
                            color: const Color(0xFF00FF88).withOpacity(pulse * 0.6),
                            blurRadius: 8,
                            spreadRadius: 2,
                          )
                        ]
                      : null,
                ),
              );
            },
          ),
          const SizedBox(width: 10),

          // Status text
          Expanded(
            child: Text(
              _statusText,
              style: GoogleFonts.jetBrainsMono(
                color: isOpen
                    ? const Color(0xFF00FF88)
                    : Colors.grey.shade500,
                fontSize: 11,
                fontWeight: FontWeight.w500,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),

          // Countdown timer
          if (isOpen)
            Text(
              _countdownText,
              style: GoogleFonts.jetBrainsMono(
                color: Colors.grey.shade500,
                fontSize: 10,
              ),
            ),
        ],
      ),
    );
  }
}
