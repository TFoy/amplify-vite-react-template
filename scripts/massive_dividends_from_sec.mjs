#!/usr/bin/env node

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const MASSIVE_DIVIDENDS_URL = "https://api.massive.com/stocks/v1/dividends";
const REQUESTS_PER_MINUTE = 5;
const MIN_DELAY_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE);
const TICKERS_PER_BATCH = 100;
const MASSIVE_LIMIT = 400;
const YAHOO_QUOTE_FIELDS = [
  "symbol",
  "regularMarketPrice",
  "regularMarketVolume",
  "trailingPE",
  "forwardPE",
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
    const regularMarketVolume = quote?.regularMarketVolume;
    const trailingPE = quote?.trailingPE;
    const forwardPE = quote?.forwardPE;

    if (!ticker || !tickers.includes(ticker)) {
      continue;
    }

    metricsByTicker.set(ticker, {
      latestPrice:
        typeof regularMarketPrice === "number" && Number.isFinite(regularMarketPrice)
          ? regularMarketPrice
          : null,
      volume:
        typeof regularMarketVolume === "number" && Number.isFinite(regularMarketVolume)
          ? regularMarketVolume
          : null,
      trailingPE:
        typeof trailingPE === "number" && Number.isFinite(trailingPE)
          ? trailingPE
          : null,
      forwardPE:
        typeof forwardPE === "number" && Number.isFinite(forwardPE)
          ? forwardPE
          : null,
    });
  }

  return metricsByTicker;
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
  let lastRequestStartedAt = 0;

  console.error(
    `Loaded ${tickers.length} SEC rows (${distinctTickerCount} distinct tickers). Processing index ${startIndex}..${upperBound - 1} at max ${REQUESTS_PER_MINUTE}/min.`,
  );
  console.log(`Distinct tickers found: ${distinctTickerCount}`);
  console.log(
    "ticker\tcash_amount\tfrequency\tdistribution_type\tpay_date\tlatest_price\tvolume\ttrailing_pe\tforward_pe\tannual_dividend\tdividend_yield\tvalue_factor",
  );

  for (let i = startIndex; i < upperBound; i += TICKERS_PER_BATCH) {
    const batchTickers = distinctTickerList.slice(i, Math.min(i + TICKERS_PER_BATCH, upperBound));
    const batchStart = i;
    const batchEnd = Math.min(i + batchTickers.length - 1, upperBound - 1);
    const batchNumber = Math.floor((i - startIndex) / TICKERS_PER_BATCH) + 1;
    const totalBatches = Math.ceil((upperBound - startIndex) / TICKERS_PER_BATCH);
    console.error(
      `Processing batch ${batchNumber}/${totalBatches} (index ${batchStart}-${batchEnd}, count ${batchTickers.length})...`,
    );

    const now = Date.now();
    const elapsed = now - lastRequestStartedAt;
    if (elapsed < MIN_DELAY_MS) {
      await sleep(MIN_DELAY_MS - elapsed);
    }

    lastRequestStartedAt = Date.now();

    let mostRecentByTicker = new Map();
    let yahooMetricsByTicker = new Map();

    try {
      mostRecentByTicker = await getMostRecentDividendsForBatch(batchTickers, apiKey);
    } catch (error) {
      console.error(
        `[${i}-${Math.min(i + batchTickers.length - 1, upperBound - 1)}] massive batch failed (${batchTickers.join(",")}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      yahooMetricsByTicker = await getYahooMetricsForBatch(batchTickers);
    } catch (error) {
      console.error(
        `[${i}-${Math.min(i + batchTickers.length - 1, upperBound - 1)}] yahoo batch failed (${batchTickers.join(",")}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const ticker of batchTickers) {
      const dividend = mostRecentByTicker.get(ticker);
      const yahooMetrics = yahooMetricsByTicker.get(ticker) ?? {
        latestPrice: null,
        volume: null,
        trailingPE: null,
        forwardPE: null,
      };
      const latestPriceText =
        typeof yahooMetrics.latestPrice === "number"
          ? String(yahooMetrics.latestPrice)
          : "NO PRICE";
      const volumeText =
        typeof yahooMetrics.volume === "number" ? String(yahooMetrics.volume) : "NO VOLUME";
      const trailingPEText =
        typeof yahooMetrics.trailingPE === "number"
          ? String(yahooMetrics.trailingPE)
          : "NO PE";
      const forwardPEText =
        typeof yahooMetrics.forwardPE === "number"
          ? String(yahooMetrics.forwardPE)
          : "NO PE";

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
        typeof yahooMetrics.latestPrice === "number" &&
        yahooMetrics.latestPrice > 0
          ? annualDividend / yahooMetrics.latestPrice
          : null;
      const valueFactor =
        dividendYield !== null &&
        typeof yahooMetrics.forwardPE === "number" &&
        yahooMetrics.forwardPE > 0
          ? (dividendYield * 100) / yahooMetrics.forwardPE
          : null;
      const annualDividendText = formatComputedValue(annualDividend);
      const dividendYieldText = formatComputedValue(dividendYield);
      const valueFactorText = formatComputedValue(valueFactor);

      if (!dividend) {
        console.log(
          `${ticker}\tNO DIVIDEND\tNO DIVIDEND\tNO DIVIDEND\tNO DIVIDEND\t${latestPriceText}\t${volumeText}\t${trailingPEText}\t${forwardPEText}\t${annualDividendText}\t${dividendYieldText}\t${valueFactorText}`,
        );
        continue;
      }

      const cashAmount = dividend.cash_amount ?? "";
      const frequency = dividend.frequency ?? "";
      const distributionType = dividend.distribution_type ?? "";
      const payDate = dividend.pay_date ?? "";
      console.log(
        `${ticker}\t${cashAmount}\t${frequency}\t${distributionType}\t${payDate}\t${latestPriceText}\t${volumeText}\t${trailingPEText}\t${forwardPEText}\t${annualDividendText}\t${dividendYieldText}\t${valueFactorText}`,
      );
    }

    console.error(
      `Completed batch ${batchNumber}/${totalBatches} (index ${batchStart}-${batchEnd}).`,
    );
  }

  console.error("Done.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
