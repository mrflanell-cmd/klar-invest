"""Deterministic daily-candle Piercing scanner. No live/incomplete candles."""
from dataclasses import dataclass
from math import floor, isfinite

@dataclass(frozen=True)
class Candle:
    date: str
    open: float
    high: float
    low: float
    close: float

def scan_three(c1: Candle, c2: Candle, c3: Candle, *, max_loss_sek=150.0, max_purchase_sek=2000.0):
    """Return a confirmed setup or None. Prices are SEK; use adjusted, completed daily OHLC.
    
    Candle 1 red; candle 2 green with a gap below c1 close, then closes
    above c1 close and below c1 open; candle 3 (either color) closes
    above c1 open. Classic requires c2 close strictly above midpoint.
    Both variants use c1 open as entry, c2 low as stop, and 2R target.
    """
    candles = (c1, c2, c3)
    if not all(isfinite(v) and v > 0 for c in candles for v in (c.open, c.high, c.low, c.close)):
        return None
    if not all(c.low <= min(c.open, c.close) <= max(c.open, c.close) <= c.high for c in candles):
        return None
    if not (c1.date < c2.date < c3.date):
        return None
    if not (c1.close < c1.open and c2.close > c2.open):
        return None
    if not (c2.open < c1.close < c2.close < c1.open):
        return None
    if not c3.close > c1.open:
        return None
    entry, stop = c1.open, c2.low
    risk_per_share = entry - stop
    if risk_per_share <= 0 or max_loss_sek <= 0 or max_purchase_sek <= 0:
        return None
    quantity = min(floor(max_loss_sek / risk_per_share), floor(max_purchase_sek / entry))
    midpoint = (c1.open + c1.close) / 2
    return {
        "variant": "classic" if c2.close > midpoint else "mild",
        "confirmed_on": c3.date,
        "entry_limit": entry,
        "stop_loss": stop,
        "take_profit_2r": entry + 2 * risk_per_share,
        "risk_per_share": risk_per_share,
        "risk_percent": 100 * risk_per_share / entry,
        "quantity": max(0, quantity),
        "planned_loss_sek": max(0, quantity) * risk_per_share,
        "purchase_sek": max(0, quantity) * entry,
        "tradable": quantity >= 1,
    }

def scan_series(candles, **kwargs):
    """Return all confirmed signals from consecutive completed daily candles."""
    return [result for i in range(2, len(candles))
            if (result := scan_three(*candles[i-2:i+1], **kwargs)) is not None]
