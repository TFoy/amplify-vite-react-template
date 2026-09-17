import { mkdir, readFile, writeFile } from "node:fs/promises";
import YahooFinance from "yahoo-finance2";
import type { OptionsResult } from "yahoo-finance2/modules/options";
import { buildAprChain } from "../amplify/functions/yahoo-options-skew/handler";
import { excludeAprOutliers } from "../src/optionsAprOutliers";
import { chainRows, selectRows } from "../src/optionsScreener";

const controls = process.argv.includes("--controls");
const directory = controls ? "output/control-options-quality" : "output/owl-quality";
await mkdir(directory, { recursive: true });
const snapshots: { fetchedAt: string; result: OptionsResult }[] = [];
if (process.argv.includes("--cached")) {
  const raw = await readFile(`${directory}/snapshot.json`, "utf8");
  snapshots.push(...JSON.parse(raw, (key, value) =>
    ["expirationDate", "lastTradeDate", "regularMarketTime", "postMarketTime", "preMarketTime"].includes(key) && typeof value === "string"
      ? new Date(value) : key === "expirationDates" && Array.isArray(value) ? value.map((date) => new Date(date)) : value));
} else if (controls) {
  const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  for (const symbol of ["INTC", "AMZN", "GOOGL"]) {
    if (snapshots.length) await new Promise((resolve) => setTimeout(resolve, 800));
    const result = await yahoo.options(symbol, { date: new Date("2026-09-18T00:00:00Z") });
    snapshots.push({ fetchedAt: new Date().toISOString(), result });
  }
  await writeFile(`${directory}/snapshot.json`, JSON.stringify(snapshots, null, 2));
} else {
  const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const first = await yahoo.options("OWL");
  snapshots.push({ fetchedAt: new Date().toISOString(), result: first });
  const firstDate = first.options[0]?.expirationDate.getTime();
  for (const date of first.expirationDates) {
    if (date.getTime() === firstDate) continue;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const result = await yahoo.options("OWL", { date });
    snapshots.push({ fetchedAt: new Date().toISOString(), result });
    console.log(`Retrieved ${snapshots.length}/${first.expirationDates.length}: ${date.toISOString().slice(0, 10)}`);
  }
  await writeFile(`${directory}/snapshot.json`, JSON.stringify(snapshots, null, 2));
}

const rows = snapshots.flatMap(({ result, fetchedAt }) => {
  const chain = buildAprChain(result, "both", "all");
  return (["put", "call"] as const).flatMap((type) => {
    const options = type === "put" ? chain.puts : chain.calls;
    const raw = type === "put" ? result.options[0].puts : result.options[0].calls;
    const points = options.filter((option) => option.simpleApr !== null).map((option) => ({ x: option.strike, y: option.simpleApr!, id: option.contractSymbol }));
    const retained = new Set(excludeAprOutliers(points, type, chain.underlyingPrice).map((point) => point.id));
    return options.map((option) => {
      const original = raw.find((item) => item.contractSymbol === option.contractSymbol)!;
      const bid = option.bid; const ask = option.ask; const mid = option.midpoint;
      const otm = type === "put" ? option.strike < chain.underlyingPrice : option.strike > chain.underlyingPrice;
      return { ticker: result.quote.symbol, type, expiration: chain.expirationDate, price: chain.underlyingPrice, days: chain.daysToExpiration,
        strike: option.strike, bid, ask, mid, apr: option.simpleApr === null ? null : option.simpleApr * 100,
        probability: option.probabilityExpiresWorthless === null ? null : option.probabilityExpiresWorthless * 100,
        iv: option.impliedVolatility, volume: original.volume ?? null, oi: original.openInterest ?? null,
        lastTrade: original.lastTradeDate.toISOString(), fetchedAt, marketDataDate: chain.marketDataDate,
        relativeSpread: mid !== null && mid > 0 && bid !== null && ask !== null ? (ask - bid) / mid : null,
        otm, excluded: !retained.has(option.contractSymbol), contract: option.contractSymbol };
    });
  });
});
await writeFile(`${directory}/rows.json`, JSON.stringify(rows, null, 2));
const summaries = ["put", "call"].map((type) => {
  const all = rows.filter((row) => row.type === type && row.otm);
  const matches = all.filter((row) => row.apr !== null && row.apr >= 25 && row.probability !== null && row.probability >= 90);
  const count = (items: typeof rows) => ({ total: items.length, excluded: items.filter((r) => r.excluded).length,
    zeroBid: items.filter((r) => r.bid === 0).length, crossed: items.filter((r) => r.bid !== null && r.ask !== null && r.ask < r.bid).length,
    wide50: items.filter((r) => r.relativeSpread !== null && r.relativeSpread > 0.5).length,
    lowVolume: items.filter((r) => r.volume !== null && r.volume < 10).length,
    missingVolume: items.filter((r) => r.volume === null).length });
  return { type, otm: count(all), matches: count(matches), matchesAfterCurrentFilter: count(matches.filter((r) => !r.excluded)) };
});
const screenerComparison = snapshots.filter(({ result }) => result.options[0].expirationDate.toISOString().slice(0, 10) === "2026-09-18").map(({ result }) => {
  const chain = buildAprChain(result, "both", "all");
  const puts = chainRows(String(result.quote.symbol), chain).filter((row) => row.type === "put" && row.strike < chain.underlyingPrice);
  const before = selectRows(puts, 25, 90, [], false);
  const after = selectRows(puts, 25, 90, [], true);
  return { ticker: result.quote.symbol, beforeExclusion: before.length, afterExclusion: after.length,
    zeroBidFlagged: before.filter((row) => row.flags.some((flag) => flag.label === "No bid")).length,
    survivingStrikes: after.map((row) => row.strike) };
});
console.log(JSON.stringify({ fetchedAt: snapshots[0].fetchedAt, expirations: snapshots.length, rows: rows.length, summaries, screenerComparison,
  topSurvivingPuts: rows.filter((r) => r.type === "put" && r.otm && !r.excluded && r.apr !== null && r.apr >= 25 && r.probability !== null && r.probability >= 90).sort((a,b) => b.apr! - a.apr!).slice(0, 20) }, null, 2));
