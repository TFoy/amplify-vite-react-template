import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ChainResult } from "./OptionsAprPage";
import { DEFAULT_SCREENER_SETTINGS, parseScreenerSettings } from "./optionsScreenerSettings";
import { chainRows, createScreenerRequest, parseTickers, promoteSort, scanOptions, selectRows, validTicker, waitForYahoo, type Progress, type RequestJson, type ScreenerRow } from "./optionsScreener";

function chain(expirationDate = "2027-01-15"): ChainResult {
  const option = { contractSymbol: "TEST-C", optionType: "call" as const, strike: 100, bid: 1, ask: 3, midpoint: 2, simpleApr: 0.25, impliedVolatility: 0.3, probabilityExpiresWorthless: 0.9 };
  return { companyName: "Test", underlyingPrice: 100, expirationDate, daysToExpiration: 30, marketDataDate: "2026-12-16", calls: [option], puts: [{ ...option, contractSymbol: "TEST-P", optionType: "put", simpleApr: 0.5 }] };
}

test("Run preferences round-trip all controls, preserve false, and exclude ticker lists", () => {
  const settings = { minimumApr: "40", minimumProbability: "85", minimumDistance: "3", maximumDistance: "15", excludeOutliers: false, firstExpirations: "5", optionType: "put", strikeRange: "all" };
  assert.deepEqual(parseScreenerSettings(JSON.stringify({ ...settings, tickers: ["OTHER"] })), settings);
  assert.deepEqual(parseScreenerSettings(undefined), DEFAULT_SCREENER_SETTINGS);
  assert.deepEqual(parseScreenerSettings("broken"), DEFAULT_SCREENER_SETTINGS);
  assert.deepEqual(parseScreenerSettings("null"), DEFAULT_SCREENER_SETTINGS);
  assert.equal(parseScreenerSettings('{"minimumApr":"40"}').minimumDistance, "0");
  assert.equal(parseScreenerSettings('{"minimumDistance":"-1"}').minimumDistance, "0");
  assert.equal(parseScreenerSettings('{"minimumDistance":"3"}').maximumDistance, "");
  assert.equal(parseScreenerSettings('{"maximumDistance":"-1"}').maximumDistance, "");
  assert.equal(parseScreenerSettings('{"maximumDistance":"0"}').maximumDistance, "0");
  assert.deepEqual(parseScreenerSettings(JSON.stringify({ minimumApr: "-1", minimumProbability: "101", firstExpirations: "0", optionType: "invalid" })), DEFAULT_SCREENER_SETTINGS);
});

test("tickers normalize and deduplicate without silently rewriting invalid symbols", () => {
  assert.deepEqual(parseTickers("intc, AMZN; googl\nINTC"), ["INTC", "AMZN", "GOOGL"]);
  assert.equal(validTicker("BRK-B"), true);
  assert.equal(validTicker("BAD/TICKER"), false);
});

test("thresholds are inclusive percentages, displayed probability matches the filter, and every column sorts", () => {
  const rows = chainRows("TEST", chain());
  assert.equal(rows[0].probabilityWorthless, 0.9);
  assert.equal(selectRows(rows, 25, 90, [{ column: "apr", descending: true }]).length, 2);
  assert.equal(selectRows(rows, 26, 90, [{ column: "apr", descending: true }])[0].type, "put");
  assert.equal(selectRows(rows, 0, 91, [{ column: "apr", descending: true }]).length, 0);
  assert.equal(selectRows([...rows, { ...rows[0], apr: null }, { ...rows[0], probabilityWorthless: null }], 0, 0, [{ column: "apr", descending: true }]).length, 2);
  const higher = { ...rows[0], ticker: "ZZZ", type: "put" as const, expiration: "2028-01-01", strike: 200, currentPrice: 150, distance: 1 / 3, apr: 0.8, bidApr: 0.5, flagCount: 5, probabilityWorthless: 0.95, midpoint: 10 };
  for (const column of ["ticker", "type", "expiration", "strike", "currentPrice", "distance", "apr", "bidApr", "flagCount", "probabilityWorthless", "midpoint"] as const) {
    assert.equal(selectRows([rows[0], higher], 0, 0, [{ column, descending: true }])[0], higher);
    assert.equal(selectRows([rows[0], higher], 0, 0, [{ column, descending: false }])[0], rows[0]);
  }
  assert.equal(rows[0].type, "call", "sorting must not mutate retrieved rows");
});

test("distance is absolute and relative to current price for both option types", () => {
  const data = chain();
  data.calls[0].strike = 103;
  data.puts[0].strike = 90;
  const rows = chainRows("TEST", data);
  assert.equal(rows[0].currentPrice, 100);
  assert.equal(rows[0].distance, 0.03);
  assert.equal(rows[1].distance, 0.1);
  assert.equal(chainRows("TEST", chain())[0].distance, 0);
  for (const underlyingPrice of [0, -1, NaN, Infinity]) {
    assert.equal(chainRows("TEST", { ...data, underlyingPrice })[0].distance, null);
  }
});

test("minimum distance uses inclusive percentages and zero leaves distance unrestricted", () => {
  const base = chainRows("TEST", chain())[0];
  const rows = [0, 0.03, 0.1, 1.5, null].map((distance) => ({ ...base, distance }));
  const rules = [{ column: "distance" as const, descending: false }];
  assert.deepEqual(selectRows(rows, 0, 0, rules, false, 3).map((row) => row.distance), [0.03, 0.1, 1.5]);
  assert.deepEqual(selectRows(rows, 0, 0, rules, false, 10).map((row) => row.distance), [0.1, 1.5]);
  assert.equal(selectRows(rows, 0, 0, rules, false, 0).length, 5);
  assert.equal(rows.length, 5);
});

test("maximum distance is inclusive and combines with the minimum, including exact zero", () => {
  const base = chainRows("TEST", chain())[0];
  const rows = [0, 0.03, 0.1, 1.5, null].map((distance) => ({ ...base, distance }));
  assert.deepEqual(selectRows(rows, 0, 0, [], false, 3, 10).map((row) => row.distance), [0.03, 0.1]);
  assert.deepEqual(selectRows(rows, 0, 0, [], false, 0, 0).map((row) => row.distance), [0]);
  assert.equal(selectRows(rows, 0, 0, [], false, 0, Infinity).length, 5);
  assert.equal(selectRows(rows, 0, 0, [], false, 10, 3).length, 0);
});

test("bid APR uses put strike and call share-price collateral, including zero and missing bids", () => {
  const data = chain();
  data.calls[0].strike = 110;
  data.puts[0].strike = 90;
  const rows = chainRows("TEST", data);
  assert.equal(rows[0].bidApr, (1 / 100) * (365 / 30));
  assert.equal(rows[1].bidApr, (1 / 90) * (365 / 30));
  data.calls[0].bid = 0;
  data.puts[0].bid = null;
  const invalid = chainRows("TEST", data);
  assert.equal(invalid[0].bidApr, 0);
  assert.equal(invalid[1].bidApr, null);
  assert.equal(chainRows("TEST", { ...data, daysToExpiration: 0 })[0].bidApr, null);
});

test("zero bids and malformed quotes are excluded, warnings alone remain, and unchecking restores rows", () => {
  const data = chain();
  const base = data.calls[0];
  data.calls = [
    { ...base, contractSymbol: "zero", bid: 0, ask: 0.05, volume: 203 },
    { ...base, contractSymbol: "missing", bid: null },
    { ...base, contractSymbol: "crossed", bid: 4, ask: 3 },
    { ...base, contractSymbol: "negative", bid: -1 },
    { ...base, contractSymbol: "warnings", bid: 0.05, ask: 0.1, volume: 2, openInterest: 10, lastTradeDate: "2026-11-01T12:00:00Z" },
    { ...base, contractSymbol: "healthy", bid: 1, ask: 1.05 },
  ];
  data.puts = [];
  const rows = chainRows("TEST", data);
  assert.ok(rows[0].flags.some((flag) => flag.label === "No bid" && flag.exclude));
  assert.ok(rows[4].flags.some((flag) => flag.label === "Old last trade"));
  assert.equal(rows[4].flagCount, 4);
  assert.equal(rows[5].flagCount, 0, "missing activity should not create low-activity warnings");
  assert.deepEqual(selectRows(rows, 0, 0, [], true).map((row) => row.contractSymbol), ["warnings", "healthy"]);
  assert.equal(selectRows(rows, 0, 0, [], false).length, 6);
  assert.equal(data.calls.length, 6);
});

test("unusable and zero-APR quotes cannot cause valid points to be labeled APR outliers", () => {
  const data = chain();
  const base = data.puts[0];
  data.calls = [];
  data.puts = [
    { ...base, contractSymbol: "valid", strike: 80, simpleApr: 1 },
    { ...base, contractSymbol: "zero-apr", strike: 85, simpleApr: 0 },
    { ...base, contractSymbol: "no-bid", strike: 90, bid: 0, simpleApr: 0.01 },
    { ...base, contractSymbol: "crossed", strike: 95, bid: 4, ask: 3, simpleApr: 0.01 },
  ];
  const rows = chainRows("TEST", data);
  assert.equal(rows[0].isOutlier, false);
  assert.equal(rows[0].excludeFromResults, false);
});

test("new primary sort preserves previous priorities and directions within each group", () => {
  const base = chainRows("TEST", chain())[0];
  const rows = [
    { ...base, contractSymbol: "put-low", type: "put" as const, apr: 0.3 },
    { ...base, contractSymbol: "call-low", apr: 0.2 },
    { ...base, contractSymbol: "put-high", type: "put" as const, apr: 0.8 },
    { ...base, contractSymbol: "call-high", apr: 0.6 },
  ];
  const rules = promoteSort([{ column: "apr", descending: true }], "type");
  assert.deepEqual(rules, [{ column: "type", descending: false }, { column: "apr", descending: true }]);
  assert.deepEqual(selectRows(rows, 0, 0, rules).map((row) => row.contractSymbol), ["call-high", "call-low", "put-high", "put-low"]);
  const reversed = promoteSort(rules, "type");
  assert.deepEqual(selectRows(rows, 0, 0, reversed).map((row) => row.contractSymbol), ["put-high", "put-low", "call-high", "call-low"]);
  const third = promoteSort(reversed, "ticker");
  assert.deepEqual(third.map((rule) => rule.column), ["ticker", "type", "apr"]);
  assert.deepEqual(promoteSort(third, "apr"), [
    { column: "apr", descending: true }, { column: "ticker", descending: false }, { column: "type", descending: true },
  ]);
  assert.equal(rows[0].contractSymbol, "put-low");
});

test("missing primary values use secondary sorting and stay last in either direction", () => {
  const base = chainRows("TEST", chain())[0];
  const rows = [{ ...base, midpoint: null, apr: 0.2 }, { ...base, midpoint: 5 }, { ...base, midpoint: null, apr: 0.8 }];
  for (const descending of [true, false]) {
    assert.deepEqual(selectRows(rows, 0, 0, [{ column: "midpoint", descending }, { column: "apr", descending: true }]), [rows[1], rows[2], rows[0]]);
  }
});

test("scan retrieves all expirations sequentially, pauses across ticker boundaries, and reports completion", async () => {
  const paths: string[] = [];
  const waits: number[] = [];
  const rows: ScreenerRow[] = [];
  const reports: Progress[] = [];
  // More than the skew endpoint's 18-expiration cap.
  const dates = Array.from({ length: 20 }, (_, i) => `2027-01-${String(i + 1).padStart(2, "0")}`);
  let active = 0;
  const request: RequestJson = async <T>(path: string) => {
    assert.equal(active++, 0);
    paths.push(path);
    await Promise.resolve();
    active--;
    const url = new URL(path, "http://test");
    if (url.pathname.endsWith("expirations")) return { expirationDates: dates } as T;
    assert.equal(url.searchParams.get("optionType"), "both");
    assert.equal(url.searchParams.get("strikeRange"), "all");
    return { data: chain(url.searchParams.get("expiration")!) } as T;
  };
  const result = await scanOptions({ tickers: ["INTC", "AMZN"], request, signal: new AbortController().signal,
    wait: async (ms) => { waits.push(ms); }, onRows: (added) => rows.push(...added), onProgress: (p) => reports.push(p), onError: assert.fail });
  assert.equal(paths.length, 42);
  assert.equal(waits.length, 41);
  assert.ok(waits.every((ms) => ms === 800));
  assert.equal(rows.length, 80);
  assert.equal(result.processed, 2);
  assert.equal(result.retrieved, 2);
  assert.equal(reports[0].processed, 0);
});

test("failed chains and tickers retain partial data and continue through remaining work", async () => {
  const errors: string[] = [];
  const rows: ScreenerRow[] = [];
  const request: RequestJson = async <T>(path: string) => {
    if (path.includes("BAD")) throw new Error("Unavailable");
    if (path.includes("expirations")) return { expirationDates: ["2027-01-15", "2027-02-19"] } as T;
    if (path.includes("2027-01-15")) throw new Error("Chain failed");
    return { data: chain("2027-02-19") } as T;
  };
  const result = await scanOptions({ tickers: ["BAD", "INTC"], request, signal: new AbortController().signal,
    wait: async () => {}, onRows: (added) => rows.push(...added), onProgress: () => {}, onError: (error) => errors.push(error) });
  assert.equal(errors.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.retrieved, 0);
});

test("cancellation stops before subsequent requests and interrupts pacing", async () => {
  const controller = new AbortController();
  let requests = 0;
  const request: RequestJson = async <T>() => { requests++; return { expirationDates: ["2027-01-15"] } as T; };
  await assert.rejects(scanOptions({ tickers: ["INTC", "AMZN"], request, signal: controller.signal,
    wait: async () => { controller.abort(); controller.signal.throwIfAborted(); },
    onRows: () => assert.fail("Cancelled scan must not emit rows"), onProgress: () => {}, onError: assert.fail }), { name: "AbortError" });
  assert.equal(requests, 1);
  const pending = new AbortController();
  const waiting = waitForYahoo(800, pending.signal);
  pending.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("cloud-wrapped Yahoo rate limits retry and preserve authentication headers", async () => {
  let attempts = 0;
  const mockedFetch = mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.deepEqual(options.headers, { Authorization: "Bearer test" });
    attempts++;
    return attempts === 1 ? new Response(JSON.stringify({ error: "Yahoo returned 429 Too Many Requests" }), { status: 500 })
      : new Response(JSON.stringify({ expirationDates: [] }));
  });
  try {
    const request = createScreenerRequest("http://test/", async () => ({ Authorization: "Bearer test" }));
    assert.deepEqual(await request("/expirations", new AbortController().signal), { expirationDates: [] });
    assert.equal(attempts, 2);
  } finally { mockedFetch.mock.restore(); }
});

test("non-JSON successful responses produce a useful error", async () => {
  const mockedFetch = mock.method(globalThis, "fetch", async () => new Response("<html>Wrong route</html>"));
  try {
    const request = createScreenerRequest("http://test", async () => ({}));
    await assert.rejects(request("/expirations", new AbortController().signal), /invalid JSON/);
  } finally { mockedFetch.mock.restore(); }
});

test("first N uses nearest unique dates per ticker and forwards retrieval selectors", async () => {
  const paths: URL[] = [];
  const request: RequestJson = async <T>(path: string) => {
    const url = new URL(path, "http://test");
    if (path.includes("expirations")) return { expirationDates: ["2027-03-19", "2027-01-15", "2027-02-19", "2027-01-15"] } as T;
    paths.push(url);
    return { data: chain(url.searchParams.get("expiration")!) } as T;
  };
  const result = await scanOptions({ tickers: ["INTC", "AMZN"], request, signal: new AbortController().signal,
    firstExpirations: 2, optionType: "put", strikeRange: "otm", wait: async () => {},
    onRows: () => {}, onProgress: () => {}, onError: assert.fail });
  assert.deepEqual(paths.map((url) => url.searchParams.get("expiration")), ["2027-01-15", "2027-02-19", "2027-01-15", "2027-02-19"]);
  assert.ok(paths.every((url) => url.searchParams.get("optionType") === "put" && url.searchParams.get("strikeRange") === "otm"));
  assert.equal(result.chains, 2);
  assert.equal(result.retrieved, 2);
  for (const firstExpirations of [0, -1, 1.5, NaN]) {
    await assert.rejects(scanOptions({ tickers: [], request, signal: new AbortController().signal,
      firstExpirations, onRows: () => {}, onProgress: () => {}, onError: assert.fail }), /positive whole number/);
  }
});

test("outliers use OTM-only directional comparisons before thresholds, without discarding stored rows", () => {
  const data = chain();
  const base = data.calls[0];
  data.calls = [
    { ...base, contractSymbol: "CALL-REF", strike: 110, simpleApr: 0.01, probabilityExpiresWorthless: 0.5 },
    { ...base, contractSymbol: "CALL-OUTLIER", strike: 120, simpleApr: 1 },
    { ...base, contractSymbol: "CALL-ITM", strike: 90, simpleApr: 10 },
  ];
  data.puts = [
    { ...base, optionType: "put", contractSymbol: "PUT-OUTLIER", strike: 80, simpleApr: 1 },
    { ...base, optionType: "put", contractSymbol: "PUT-REF", strike: 90, simpleApr: 0.01, probabilityExpiresWorthless: 0.5 },
    { ...base, optionType: "put", contractSymbol: "PUT-ATM", strike: 100, simpleApr: 10 },
  ];
  const rows = chainRows("INTC", data);
  assert.deepEqual(rows.filter((row) => row.isOutlier).map((row) => row.contractSymbol), ["CALL-OUTLIER", "PUT-OUTLIER"]);
  assert.equal(selectRows(rows, 25, 90, [{ column: "apr", descending: true }], true).length, 2);
  assert.equal(selectRows(rows, 25, 90, [{ column: "apr", descending: true }], false).length, 4);
  assert.equal(rows.length, 6);
  // Separate ticker/expiration chains never become comparison points.
  const isolated = { ...data, calls: [data.calls[1]], puts: [] };
  assert.equal(chainRows("AMZN", isolated)[0].isOutlier, false);
  assert.equal(chainRows("INTC", { ...isolated, expirationDate: "2028-01-21" })[0].isOutlier, false);
});
