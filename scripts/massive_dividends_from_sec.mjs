#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const MASSIVE_DIVIDENDS_URL = "https://api.massive.com/stocks/v1/dividends";
const REQUESTS_PER_MINUTE = 5;
const MIN_DELAY_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE);
const TICKERS_PER_BATCH = 100;
const MASSIVE_LIMIT = 400;
const YAHOO_QUOTE_FIELDS = [
  "symbol",
  "regularMarketPrice",
  "volume",
  "averageDailyVolume3Month",
  "averageDailyVolume10Day",
  "trailingPE",
  "forwardPE",
  "trailingAnnualDividendRate",
  "trailingAnnualDividendYield",
  "dividendRate",
  "dividendYield",
  "beta",
];

let yahooFinanceClient = null;

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=");
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = "true";
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYahooFinanceClient() {
  if (yahooFinanceClient) {
    return yahooFinanceClient;
  }

  try {
    const module = await import("yahoo-finance2");
    const YahooFinance = module.default;
    yahooFinanceClient = new YahooFinance();
    return yahooFinanceClient;
  } catch (error) {
    throw new Error(
      `Unable to load yahoo-finance2. Install it with: npm install yahoo-finance2 (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null
        ? JSON.stringify(payload)
        : String(payload);
    throw new Error(`HTTP ${response.status} for ${url}: ${message}`);
  }

  return payload;
}

async function getSecTickers(userAgent) {
  const payload = await fetchJson(SEC_TICKERS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent,
    },
  });

  return Object.values(payload)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      cik_str: item.cik_str,
      ticker: String(item.ticker ?? "").trim().toUpperCase(),
      title: String(item.title ?? "").trim(),
    }))
    .filter((item) => item.ticker);
}

function toIsoDate(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function isMoreRecent(candidate, existing) {
  const candidateDate = toIsoDate(
    candidate?.ex_dividend_date ?? candidate?.declaration_date ?? candidate?.pay_date,
  );
  const existingDate = toIsoDate(
    existing?.ex_dividend_date ?? existing?.declaration_date ?? existing?.pay_date,
  );

  if (!candidateDate) {
    return false;
  }

  if (!existingDate) {
    return true;
  }

  return candidateDate > existingDate;
}

function getFrequencyMultiplier(frequencyValue) {
  if (typeof frequencyValue === "number" && Number.isFinite(frequencyValue)) {
    return frequencyValue;
  }

  if (typeof frequencyValue !== "string") {
    return null;
  }

  const normalized = frequencyValue.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber;
  }

  const map = {
    annual: 1,
    annually: 1,
    yearly: 1,
    semiannual: 2,
    "semi-annual": 2,
    biannual: 2,
    quarterly: 4,
    bimonthly: 6,
    monthly: 12,
    weekly: 52,
  };

  return map[normalized] ?? null;
}

function formatComputedValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "NO VALUE";
  }

  return String(value);
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function getMostRecentDividendsForBatch(tickers, apiKey) {
  const url = new URL(MASSIVE_DIVIDENDS_URL);
  url.searchParams.set("ticker.any_of", tickers.join(", "));
  url.searchParams.set("limit", String(MASSIVE_LIMIT));
  url.searchParams.set("sort", "ex_dividend_date.desc");
  url.searchParams.set("apiKey", apiKey);

  const payload = await fetchJson(url.toString(), {
    headers: {
      Accept: "application/json",
    },
  });

  const results = Array.isArray(payload.results) ? payload.results : [];
  const mostRecentByTicker = new Map();

  for (const dividend of results) {
    const ticker = String(dividend?.ticker ?? "").trim().toUpperCase();
    if (!ticker || !tickers.includes(ticker)) {
      continue;
    }

    const existing = mostRecentByTicker.get(ticker);
    if (!existing || isMoreRecent(dividend, existing)) {
      mostRecentByTicker.set(ticker, dividend);
    }
  }

  return mostRecentByTicker;
}

async function getYahooMetricsForBatch(tickers) {
  const client = await getYahooFinanceClient();
  const quoteResult = await client.quote(tickers, {
    fields: YAHOO_QUOTE_FIELDS,
    return: "array",
  });

  const quoteArray = Array.isArray(quoteResult)
    ? quoteResult
    : Array.isArray(quoteResult?.quotes)
      ? quoteResult.quotes
      : quoteResult
        ? [quoteResult]
        : [];

  const metricsByTicker = new Map();
  for (const quote of quoteArray) {
    const ticker = String(quote?.symbol ?? "").trim().toUpperCase();
    const regularMarketPrice = quote?.regularMarketPrice;
    const volume =
      quote?.volume ??
      quote?.regularMarketVolume ??
      quote?.averageDailyVolume3Month ??
      quote?.averageDailyVolume10Day;
    const trailingPE = quote?.trailingPE;
    const forwardPE = quote?.forwardPE;
    const trailingAnnualDividendRate = quote?.trailingAnnualDividendRate;
    const trailingAnnualDividendYield = quote?.trailingAnnualDividendYield;
    const dividendRate = quote?.dividendRate;
    const dividendYield = quote?.dividendYield;
    const beta = quote?.beta;

    if (!ticker || !tickers.includes(ticker)) {
      continue;
    }

    metricsByTicker.set(ticker, {
      latestPrice: toFiniteNumber(regularMarketPrice),
      volume: toFiniteNumber(volume),
      trailingPE: toFiniteNumber(trailingPE),
      forwardPE: toFiniteNumber(forwardPE),
      trailingAnnualDividendRate: toFiniteNumber(trailingAnnualDividendRate),
      trailingAnnualDividendYield: toFiniteNumber(trailingAnnualDividendYield),
      fiveYearAvgDividendYield: toFiniteNumber(dividendYield),
      dividendRate: toFiniteNumber(dividendRate),
      beta: toFiniteNumber(beta),
    });
  }

  return metricsByTicker;
}

function buildOutputRow(ticker, dividend, yahooMetrics) {
  const metrics = yahooMetrics ?? {
    latestPrice: null,
    volume: null,
    trailingPE: null,
    forwardPE: null,
    trailingAnnualDividendRate: null,
    trailingAnnualDividendYield: null,
    fiveYearAvgDividendYield: null,
    dividendRate: null,
    beta: null,
  };

  const latestPriceText =
    typeof metrics.latestPrice === "number" ? String(metrics.latestPrice) : "NO PRICE";
  const volumeText = typeof metrics.volume === "number" ? String(metrics.volume) : "NO VOLUME";
  const trailingPEText =
    typeof metrics.trailingPE === "number" ? String(metrics.trailingPE) : "NO PE";
  const forwardPEText =
    typeof metrics.forwardPE === "number" ? String(metrics.forwardPE) : "NO PE";
  const trailingAnnualDividendRateText = formatComputedValue(
    metrics.trailingAnnualDividendRate,
  );
  const trailingAnnualDividendYieldText = formatComputedValue(
    metrics.trailingAnnualDividendYield,
  );
  const fiveYearAvgDividendYieldText = formatComputedValue(
    metrics.fiveYearAvgDividendYield,
  );
  const dividendRateText = formatComputedValue(metrics.dividendRate);
  const betaText = formatComputedValue(metrics.beta);

  const cashAmountValue =
    typeof dividend?.cash_amount === "number" && Number.isFinite(dividend.cash_amount)
      ? dividend.cash_amount
      : null;
  const frequencyMultiplier = getFrequencyMultiplier(dividend?.frequency);
  const annualDividend =
    cashAmountValue !== null && frequencyMultiplier !== null
      ? cashAmountValue * frequencyMultiplier
      : null;
  const dividendYield =
    annualDividend !== null &&
    typeof metrics.latestPrice === "number" &&
    metrics.latestPrice > 0
      ? annualDividend / metrics.latestPrice
      : null;
  const valueFactor =
    dividendYield !== null &&
    typeof metrics.forwardPE === "number" &&
    metrics.forwardPE > 0
      ? (dividendYield * 100) / metrics.forwardPE
      : null;
  const annualDividendText = formatComputedValue(annualDividend);
  const dividendYieldText = formatComputedValue(dividendYield);
  const valueFactorText = formatComputedValue(valueFactor);

  if (!dividend) {
    return `${ticker}\tNO DIVIDEND\tNO DIVIDEND\tNO DIVIDEND\tNO DIVIDEND\t${latestPriceText}\t${volumeText}\t${trailingPEText}\t${forwardPEText}\t${annualDividendText}\t${dividendYieldText}\t${valueFactorText}\t${trailingAnnualDividendRateText}\t${trailingAnnualDividendYieldText}\t${fiveYearAvgDividendYieldText}\t${dividendRateText}\t${betaText}`;
  }

  const cashAmount = dividend.cash_amount ?? "";
  const frequency = dividend.frequency ?? "";
  const distributionType = dividend.distribution_type ?? "";
  const payDate = dividend.pay_date ?? "";
  return `${ticker}\t${cashAmount}\t${frequency}\t${distributionType}\t${payDate}\t${latestPriceText}\t${volumeText}\t${trailingPEText}\t${forwardPEText}\t${annualDividendText}\t${dividendYieldText}\t${valueFactorText}\t${trailingAnnualDividendRateText}\t${trailingAnnualDividendYieldText}\t${fiveYearAvgDividendYieldText}\t${dividendRateText}\t${betaText}`;
}

async function runBatch(batchTickers, apiKey, throttleState) {
  const now = Date.now();
  const elapsed = now - throttleState.lastRequestStartedAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }

  throttleState.lastRequestStartedAt = Date.now();

  let mostRecentByTicker = new Map();
  let yahooMetricsByTicker = new Map();
  const errors = [];

  try {
    mostRecentByTicker = await getMostRecentDividendsForBatch(batchTickers, apiKey);
  } catch (error) {
    errors.push(
      `massive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    yahooMetricsByTicker = await getYahooMetricsForBatch(batchTickers);
  } catch (error) {
    errors.push(`yahoo: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error: errors.join(" | "),
    };
  }

  return {
    ok: true,
    rows: batchTickers.map((ticker) =>
      buildOutputRow(ticker, mostRecentByTicker.get(ticker), yahooMetricsByTicker.get(ticker)),
    ),
  };
}

function addFailureReason(failureReasons, tickers, reason) {
  for (const ticker of tickers) {
    const existing = failureReasons.get(ticker) ?? [];
    existing.push(reason);
    failureReasons.set(ticker, existing);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args["api-key"] || process.env.MASSIVE_API_KEY;
  const userAgent =
    args["sec-user-agent"] ||
    process.env.SEC_USER_AGENT ||
    "ExampleScript/1.0 (your-email@example.com)";
  const maxTickers = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;
  const startIndex = args["start-index"] ? Number(args["start-index"]) : 0;

  if (!apiKey) {
    throw new Error("Missing Massive API key. Use --api-key or MASSIVE_API_KEY.");
  }

  if (!Number.isFinite(maxTickers) || maxTickers <= 0) {
    throw new Error("--limit must be a positive number.");
  }

  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error("--start-index must be an integer >= 0.");
  }

  const tickers = await getSecTickers(userAgent);
  const distinctTickerList = Array.from(new Set(tickers.map((item) => item.ticker)));
  const distinctTickerCount = distinctTickerList.length;
  const upperBound = Math.min(distinctTickerCount, startIndex + maxTickers);
  const throttleState = { lastRequestStartedAt: 0 };
  const failureReasons = new Map();

  console.error(
    `Loaded ${tickers.length} SEC rows (${distinctTickerCount} distinct tickers). Processing index ${startIndex}..${upperBound - 1} at max ${REQUESTS_PER_MINUTE}/min.`,
  );
  console.log(`Distinct tickers found: ${distinctTickerCount}`);
  console.log(
    "ticker\tcash_amount\tfrequency\tdistribution_type\tpay_date\tlatest_price\tvolume\ttrailing_pe\tforward_pe\tannual_dividend\tdividend_yield\tvalue_factor\ttrailing_annual_dividend_rate\ttrailing_annual_dividend_yield\tfive_year_avg_dividend_yield\tdividend_rate\tbeta",
  );

  let failedTickers = [];
  const initialTickers = distinctTickerList.slice(startIndex, upperBound);
  const initialBatches = chunkArray(initialTickers, TICKERS_PER_BATCH);

  for (let batchIndex = 0; batchIndex < initialBatches.length; batchIndex += 1) {
    const batchTickers = initialBatches[batchIndex];
    const batchStart = startIndex + batchIndex * TICKERS_PER_BATCH;
    const batchEnd = Math.min(batchStart + batchTickers.length - 1, upperBound - 1);
    const batchNumber = batchIndex + 1;
    const totalBatches = initialBatches.length;
    console.error(
      `Processing batch ${batchNumber}/${totalBatches} (index ${batchStart}-${batchEnd}, count ${batchTickers.length})...`,
    );

    const result = await runBatch(batchTickers, apiKey, throttleState);
    if (!result.ok) {
      failedTickers.push(...batchTickers);
      addFailureReason(
        failureReasons,
        batchTickers,
        `initial batch ${batchNumber}/${totalBatches}: ${result.error}`,
      );
      console.error(
        `Batch ${batchNumber}/${totalBatches} failed and queued for retry: ${result.error}`,
      );
    } else {
      for (const row of result.rows) {
        console.log(row);
      }
    }

    console.error(
      `Completed batch ${batchNumber}/${totalBatches} (index ${batchStart}-${batchEnd}).`,
    );
  }

  let retryBatchSize = Math.max(Math.floor(TICKERS_PER_BATCH / 2), 1);
  while (failedTickers.length > 0) {
    const uniqueFailedTickers = Array.from(new Set(failedTickers));
    failedTickers = [];
    const retryBatches = chunkArray(uniqueFailedTickers, retryBatchSize);

    console.error(
      `Retry pass with batch size ${retryBatchSize}. Remaining failed tickers: ${uniqueFailedTickers.length}.`,
    );

    for (let retryIndex = 0; retryIndex < retryBatches.length; retryIndex += 1) {
      const batchTickers = retryBatches[retryIndex];
      const retryLabel = `retry size=${retryBatchSize} batch ${retryIndex + 1}/${retryBatches.length}`;
      console.error(
        `Processing ${retryLabel} (${batchTickers.length} tickers)...`,
      );

      const result = await runBatch(batchTickers, apiKey, throttleState);
      if (!result.ok) {
        failedTickers.push(...batchTickers);
        addFailureReason(
          failureReasons,
          batchTickers,
          `${retryLabel}: ${result.error}`,
        );
        console.error(`${retryLabel} failed: ${result.error}`);
      } else {
        for (const row of result.rows) {
          console.log(row);
        }
      }
    }

    if (retryBatchSize === 1) {
      break;
    }

    retryBatchSize = Math.max(Math.floor(retryBatchSize / 2), 1);
  }

  const finalFailedTickers = Array.from(new Set(failedTickers));
  if (finalFailedTickers.length > 0) {
    const failLines = finalFailedTickers.map((ticker) => {
      const reasons = failureReasons.get(ticker) ?? [];
      return `${ticker}\t${reasons.join(" || ")}`;
    });
    await writeFile("fail.txt", `${failLines.join("\n")}\n`, "utf8");
    console.error(
      `Final failures after batch size 1: ${finalFailedTickers.length}. Wrote fail.txt.`,
    );
  } else {
    console.error("No final failures after retries.");
  }

  console.error("Done.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
