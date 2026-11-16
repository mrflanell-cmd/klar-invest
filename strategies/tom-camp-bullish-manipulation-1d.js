/**
 * Tom Camp-inspired bullish manipulation candle, adapted to daily OHLC.
 * This is a standalone signal detector; it does not place orders.
 * Candle order: oldest to newest. Only pass completed daily candles.
 * Rule: latest low sweeps prior low, latest close reclaims above prior high.
 */
export function findBullishManipulationDaily(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const prior = candles[candles.length - 2];
  const signal = candles[candles.length - 1];
  const valid = [prior?.high, prior?.low, signal?.open, signal?.high, signal?.low, signal?.close]
    .every(value => typeof value === "number" && Number.isFinite(value));
  if (!valid || prior.high < prior.low || signal.high < signal.low ||
      signal.open > signal.high || signal.open < signal.low ||
      signal.close > signal.high || signal.close < signal.low) return null;
  if (!(signal.low < prior.low && signal.close > prior.high)) return null;
  return {
    strategy: "tom-camp-bullish-manipulation-1d",
    direction: "LONG",
    timeframe: "1D",
    status: "confirmed",
    signalDate: signal.date ?? null,
    previousHigh: prior.high,
    previousLow: prior.low,
    sweepLow: signal.low,
    confirmationClose: signal.close,
  };
}
