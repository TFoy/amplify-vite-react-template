# OWL option quality review — September 17, 2026

Focus: puts expiring September 18, 2026. No production filtering logic was changed during this review.

## Evidence

Retrieved Yahoo data through the installed yahoo-finance2 client, using the same APR calculation and outlier helper as the app. OWL's snapshot was fetched at 14:40:19 UTC (07:40:19 PDT); underlying price was $10.1597. INTC, AMZN, and GOOGL comparison snapshots were fetched around 14:41:45–47 UTC for the same expiration. These are individual observations, not a backtest or independently verified executable quotes.

Raw snapshots and calculated rows are saved in `output/owl-quality/` and `output/control-options-quality/`. The reproducible analysis is `scripts/analyze-options-quality.ts` (`--cached` reuses OWL data; `--controls` fetches the three comparison chains; `--controls --cached` reuses those snapshots). The control expiration is intentionally fixed to September 18 for this investigation. The initial OWL fetch includes all 15 expirations, but the findings here concern tomorrow's puts only.

OWL had 11 OTM puts, of which ten had zero bids. The $10 strike was the only OTM put with a positive bid ($0.05 bid / $0.10 ask).

| Strike | Bid | Ask | Midpoint APR | Current rule |
|---|---:|---:|---:|---|
| $1 | $0 | $0.05 | 912.50% | Kept |
| $2 | $0 | $0.15 | 1,368.75% | Excluded |
| $3 | $0 | $0.05 | 304.17% | Kept |
| $9 | $0 | $0.05 | 101.39% | Kept |
| $9.50 | $0 | $0.05 | 96.05% | Kept |
| $10 | $0.05 | $0.10 | 273.75% | Kept |

The ten zero-bid puts all passed the default 25% APR / 90% expires-without-exercise thresholds before outlier exclusion. The current rule excluded only the $2 strike, leaving nine. The $10 put's estimated probability was 69.97%, so it did not pass the 90% threshold.

## Why the current rule misses these quotes

The app averages a zero bid and a $0.05 ask into a $0.025 midpoint. For a one-day $1 put, it calculates `0.025 / 1 × 365 × 100 = 912.5%`. No positive displayed bid supports that hypothetical premium. A zero bid is not necessarily a corrupted record; it is unsuitable evidence for a sellable midpoint premium.

Most of these strikes share the same ask floor. The put APR formula divides that constant midpoint by strike, making APR decrease as strike rises. The $1 APR is only 9.5 times the $9.50 APR, just below the 10× exclusion rule. Reducing the ratio would address a symptom and still leave many zero-bid quotes.

The helper also accepts zero APR comparison points: any positive candidate can exceed ten times zero. Future comparisons should use valid, positive, two-sided quotes rather than allowing a bad quote to invalidate a good one.

## Comparison impact

All counts below use OTM puts for September 18, APR ≥25%, estimated expires-without-exercise ≥90%, no distance restriction, and the existing outlier rule.

| Ticker | Current matches | With additional bid > 0 requirement |
|---|---:|---:|
| OWL | 9 | 0 |
| INTC | 6 | 6 |
| AMZN | 1 | 1 |
| GOOGL | 2 | 2 |

All retained control matches had relative spreads below 29%. This supports adding a quote-validity layer while retaining the existing rule initially. It does not establish a universal false-positive rate or guarantee that these quotes can be filled.

## Recommendations

1. **First change: require usable bid/ask quotes when exclusion is enabled.** Flag missing/nonfinite/negative values, crossed quotes, and no positive bid. Keep the original data and explain each exclusion. For the premium-selling screener, hide zero-bid options from ranked results by default; users can still reveal them. Apply quote-quality checks to either option type; retain the current shape rule's OTM-only scope.
2. **Treat spread as a confidence signal before imposing a hard cutoff.** Compute `(ask − bid) / midpoint`. OWL's zero-bid quotes have 200% spreads. A configurable 50% warning is a reasonable starting experiment, not a calibrated universal rule. Combine relative and absolute spread: a blanket 50% exclusion also rejects OWL's $0.05/$0.10 quote (66.7%) despite its positive bid and only five-cent spread. Initially warn rather than hide every wide-spread quote.
3. **Keep the current 10× rule initially, but compare only usable positive quotes.** Do not fit a mandatory exponential curve. Premium should generally be nondecreasing with strike for puts and nonincreasing for calls of the same expiration and contract terms; the shape need not be exponential. APR further divides premium by collateral, so raw premium is the better cross-strike quality test. A future warning can flag a lower-strike put bid above a higher-strike put ask, or a higher-strike call bid above a lower-strike call ask, allowing a tick tolerance. Attribute the inconsistency to the pair unless other evidence identifies the faulty quote.
4. **Use volume, open interest, and last-trade date as supporting signals.** OWL's $9.50 put had reported volume 203 and open interest 253 despite its zero bid. The $3 put had open interest 1,033 and a last trade on August 6. Neither activity field certifies quote quality. An old last trade does not prove that the current quote is old; Yahoo's contract last-trade timestamp is not a quote timestamp. Avoid a default hard minimum-volume filter.
5. **Expose bid-based APR alongside midpoint APR for selling comparisons.** A zero bid produces zero bid-based APR rather than a compelling hypothetical yield. Label both clearly; a bid is still only a displayed quote, not an execution guarantee. Preserve bid, ask, volume, open interest, and last-trade date in the screener data so users can inspect the evidence. The current backend summary drops the latter three fields.

The displayed probability also relies on Yahoo implied volatility. Suspicious quotes can therefore appear to satisfy both high APR and high probability; the probability is not independent confirmation that the premium is reliable.

## External references

- [OIC General Information FAQ](https://www.optionseducation.org/referencelibrary/faq/general-information): explains why activity and open interest alone do not establish liquidity, how spreads matter, and why far-OTM near-expiration options can legitimately have zero bids.
- [OIC Options Pricing](https://prd-web.optionseducation.org/optionsoverview/options-pricing): explains the components of premium and pricing inputs.
- [Cboe Option Quote Intervals](https://datashop.cboe.com/option-quote-intervals): distinguishes quote snapshots, sizes, volume, and optional open interest. This review uses Yahoo data, not that Cboe product.
