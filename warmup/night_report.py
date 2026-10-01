#!/usr/bin/env python3
"""Crayon Kid warmup — nightly report (run by the 9:00 PM ET cron).

Read-only: summarizes today's shared-table stats for brand='crayonkid'
and computes tomorrow's planned Fibonacci volume. Prints a chat-ready
summary. Never sends anything.
"""
from __future__ import annotations
import sys
from zoneinfo import ZoneInfo
import datetime

sys.path.insert(0, "/home/hatch/workspace/build/crayonkid-mvp/warmup")
from send_day import (cf_d1, fib_volume, BREVO_DAILY_CAP, BRAND,
                      BOUNCE_PAUSE_RATE, BOUNCE_MIN_SAMPLE, COMPLAINT_PAUSE)

NY = ZoneInfo("America/New_York")


def main() -> int:
    today = datetime.datetime.now(NY).date().isoformat()
    rows = cf_d1(
        "SELECT * FROM warmup_campaign_daily WHERE brand=? ORDER BY campaign_day",
        [BRAND])
    day = (rows[-1]["campaign_day"] + 1) if rows else 1
    tmr_vol = min(fib_volume(day), BREVO_DAILY_CAP)

    today_row = next((r for r in rows if r["date"] == today), None)
    trail = rows[-3:]
    t_sent = sum(r["sent_count"] or 0 for r in trail)
    t_bounce = sum(r["bounce_count"] or 0 for r in trail)
    t_complaint = sum(r.get("complaint_count") or 0 for r in trail)

    lines = ["Crayon Kid warmup — night report"]
    if today_row:
        d = today_row
        lines.append(
            f"Day {d['campaign_day']} ({today}): planned {d['planned_volume']}, "
            f"sent {d['sent_count']}, delivered {d['delivered_count']}, "
            f"opens {d['open_count']}, clicks {d['click_count']}, "
            f"bounces {d['bounce_count']}, unsubs {d['unsub_count']}, "
            f"complaints {d.get('complaint_count') or 0}.")
    else:
        lines.append(f"No send today ({today}) — day {day} has not run.")
    br = (t_bounce / t_sent) if t_sent else 0.0
    lines.append(
        f"Trailing {len(trail)}-day: {t_sent} sent, bounce {br:.2%}, "
        f"{t_complaint} complaints.")
    gate = ("PAUSED"
            if (t_sent >= BOUNCE_MIN_SAMPLE and br >= BOUNCE_PAUSE_RATE)
               or t_complaint >= COMPLAINT_PAUSE
            else "ramping")
    lines.append(f"Scale rule: {gate}. Tomorrow (day {day}): {tmr_vol} emails.")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
