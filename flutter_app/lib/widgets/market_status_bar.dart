/// widgets/market_status_bar.dart
/// ================================
/// Animated status bar showing ARJUN's live trading status.
///
/// DISPLAYS:
///   - Animated pulsing dot: green when market is open, grey when closed
///   - Status text: "ARJUN is scanning 500 NSE stocks..." or "Market closed"
///   - Countdown timer: MM:SS until next trading cycle
///
/// The pulsing animation uses an AnimationController with a sine-wave
/// opacity curve to create the heartbeat effect.
///
/// Market hours check is done client-side (same logic as Cloud Functions):
///   Open: Monday–Friday, 09:15–15:30 IST

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
    // Next 5-min boundary
    final nextCycle = now.add(
      Duration(seconds: 300 - (now.second + now.minute * 60) % 300),
    );
    setState(() {
      _secondsUntilNext = nextCycle.difference(now).inSeconds.clamp(0, 300);
    });
  }

  bool get _isMarketOpen {
    final now = DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30));
    if (now.weekday == DateTime.saturday || now.weekday == DateTime.sunday) {
      return false;
    }
    final mins = now.hour * 60 + now.minute;
    return mins >= 555 && mins < 930; // 09:15 to 15:30
  }

  String get _statusText {
    if (!_isMarketOpen) return 'Market closed — opens Mon 09:15 IST';
    switch (widget.cycleStatus) {
      case 'TRADED':
        return 'ARJUN executed trades this cycle';
      case 'WAITED':
        return 'ARJUN scanning 500 NSE stocks live...';
      default:
        return 'ARJUN monitoring market live...';
    }
  }

  String get _countdownText {
    final mins = _secondsUntilNext ~/ 60;
    final secs = _secondsUntilNext % 60;
    return 'Next cycle: ${mins.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _countdownTimer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isOpen = _isMarketOpen;

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
