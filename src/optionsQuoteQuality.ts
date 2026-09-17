export const QUOTE_FLAG_LABELS = ["Invalid quote", "No bid", "Crossed quote", "APR outlier", "Wide spread", "Low volume", "Low open interest", "Old last trade"] as const;
export type QuoteFlagLabel = typeof QUOTE_FLAG_LABELS[number];
export const DEFAULT_EXCLUDED_FLAGS: QuoteFlagLabel[] = ["Invalid quote", "No bid", "Crossed quote", "APR outlier"];
export type QuoteFlag = { label: QuoteFlagLabel; detail: string; exclude: boolean };
type Quote = {
  bid: number | null;
  ask: number | null;
  volume?: number | null;
  openInterest?: number | null;
  lastTradeDate?: string | null;
};

export function hasUsableQuote(quote: Quote) {
  return quote.bid !== null && Number.isFinite(quote.bid) && quote.bid > 0 &&
    quote.ask !== null && Number.isFinite(quote.ask) && quote.ask >= quote.bid;
}

export function quoteQualityFlags(quote: Quote, marketDataDate: string | null): QuoteFlag[] {
  const flags: QuoteFlag[] = [];
  const bidValid = quote.bid !== null && Number.isFinite(quote.bid) && quote.bid >= 0;
  const askValid = quote.ask !== null && Number.isFinite(quote.ask) && quote.ask > 0;
  if (!bidValid || !askValid) flags.push({ label: "Invalid quote", detail: "Bid or ask is missing, nonfinite, or invalid (bid must be nonnegative; ask must be positive).", exclude: true });
  if (quote.bid === 0) flags.push({ label: "No bid", detail: "No positive displayed bid supports the midpoint premium.", exclude: true });
  if (bidValid && askValid && quote.ask! < quote.bid!) flags.push({ label: "Crossed quote", detail: "Ask is below bid.", exclude: true });
  if (bidValid && askValid && quote.ask! >= quote.bid!) {
    const spread = (quote.ask! - quote.bid!) / ((quote.ask! + quote.bid!) / 2);
    if (spread > 0.5) flags.push({ label: "Wide spread", detail: `Bid/ask spread is ${(spread * 100).toFixed(1)}% of midpoint (over 50%). A small absolute spread can still be reasonable.`, exclude: false });
  }
  if (quote.volume != null && Number.isFinite(quote.volume) && quote.volume >= 0 && quote.volume < 10) {
    flags.push({ label: "Low volume", detail: `Reported volume is ${quote.volume} contracts (below 10). Activity alone does not establish quote quality.`, exclude: false });
  }
  if (quote.openInterest != null && Number.isFinite(quote.openInterest) && quote.openInterest >= 0 && quote.openInterest < 100) {
    flags.push({ label: "Low open interest", detail: `Reported open interest is ${quote.openInterest} contracts (below 100).`, exclude: false });
  }
  if (quote.lastTradeDate && marketDataDate) {
    const age = (Date.parse(`${marketDataDate}T00:00:00Z`) - Date.parse(quote.lastTradeDate)) / 86_400_000;
    if (age > 7) flags.push({ label: "Old last trade", detail: `Last trade: ${quote.lastTradeDate.slice(0, 10)}, over 7 days before the market-data date. This is not the quote timestamp.`, exclude: false });
  }
  return flags;
}
