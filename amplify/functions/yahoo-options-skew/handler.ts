import YahooFinance from "yahoo-finance2";
import type { CallOrPut, OptionsResult } from "yahoo-finance2/modules/options";
import { getAuthenticatedUserSub } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type OptionLegSummary = {
  contractSymbol: string;
  strike: number;
  impliedVolatility: number;
  bid?: number;
  ask?: number;
  lastPrice: number;
  volume?: number;
  openInterest?: number;
};

const DEFAULT_MAX_EXPIRATIONS = 12;
const HARD_MAX_EXPIRATIONS = 18;
const DEFAULT_YAHOO_DELAY_MS = 800;
const MIN_YAHOO_DELAY_MS = 500;
const MAX_YAHOO_DELAY_MS = 3_000;

const yahooFinance = new YahooFinance();

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

function parseExpiration(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Expiration must be a date in YYYY-MM-DD format.");
  }

  return date;
}

function parseBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimumValue: number,
  maximumValue: number,
) {
  if (!value) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedValue)) {
    return defaultValue;
  }

  return Math.min(Math.max(parsedValue, minimumValue), maximumValue);
}

function sleep(delayMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getUnderlyingPrice(result: OptionsResult) {
  const quote = result.quote as Record<string, unknown>;
  return (
    getFiniteNumber(quote.regularMarketPrice) ??
    getFiniteNumber(quote.postMarketPrice) ??
    getFiniteNumber(quote.preMarketPrice)
  );
}

function getCompanyName(result: OptionsResult) {
  const quote = result.quote as Record<string, unknown>;
  for (const field of ["longName", "shortName", "displayName"]) {
    const value = quote[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function standardNormalCdf(value: number) {
  const absoluteValue = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absoluteValue);
  const density = Math.exp(-(absoluteValue * absoluteValue) / 2) / Math.sqrt(2 * Math.PI);
  const polynomial =
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positiveCdf = 1 - density * polynomial;
  return value >= 0 ? positiveCdf : 1 - positiveCdf;
}

function probabilityExpiresWorthless(
  optionType: "call" | "put",
  underlyingPrice: number,
  strike: number,
  impliedVolatility: number,
  yearsToExpiration: number,
) {
  if (
    underlyingPrice <= 0 ||
    strike <= 0 ||
    impliedVolatility <= 0 ||
    yearsToExpiration <= 0
  ) {
    return null;
  }

  // Black-Scholes N(d2), using zero rates and dividend yield. This is an
  // implied risk-neutral estimate, not a forecast of the real-world outcome.
  const volatilityOverTerm = impliedVolatility * Math.sqrt(yearsToExpiration);
  const d2 =
    (Math.log(underlyingPrice / strike) -
      0.5 * impliedVolatility * impliedVolatility * yearsToExpiration) /
    volatilityOverTerm;
  return optionType === "call" ? standardNormalCdf(-d2) : standardNormalCdf(d2);
}

function calendarDaysToExpiration(expiration: Date) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(1, Math.round((expiration.getTime() - todayUtc) / 86_400_000));
}

function summarizeAprOption(
  option: CallOrPut,
  optionType: "call" | "put",
  underlyingPrice: number,
  daysToExpiration: number,
) {
  const bid = getFiniteNumber(option.bid);
  const ask = getFiniteNumber(option.ask);
  const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const collateral = optionType === "put" ? option.strike : underlyingPrice;
  const simpleApr =
    midpoint !== null && collateral > 0
      ? (midpoint / collateral) * (365 / daysToExpiration)
      : null;

  return {
    contractSymbol: option.contractSymbol,
    optionType,
    strike: option.strike,
    bid,
    ask,
    midpoint,
    simpleApr,
    impliedVolatility: getFiniteNumber(option.impliedVolatility),
    probabilityExpiresWorthless: probabilityExpiresWorthless(
      optionType,
      underlyingPrice,
      option.strike,
      option.impliedVolatility,
      daysToExpiration / 365,
    ),
  };
}

function buildAprChain(
  result: OptionsResult,
  requestedOptionType: "both" | "call" | "put",
  requestedStrikeRange: "otm" | "all",
) {
  const chain = result.options[0];
  const underlyingPrice = getUnderlyingPrice(result);
  if (!chain || underlyingPrice === null) {
    throw new Error("Yahoo did not return a usable option chain or underlying price.");
  }

  const daysToExpiration = calendarDaysToExpiration(chain.expirationDate);
  return {
    companyName: getCompanyName(result),
    underlyingPrice,
    expirationDate: toDateOnly(chain.expirationDate),
    daysToExpiration,
    calls:
      requestedOptionType === "put"
        ? []
        : chain.calls
            .filter(
              (option) =>
                Number.isFinite(option.strike) &&
                (requestedStrikeRange === "all" || option.strike >= underlyingPrice),
            )
            .sort((left, right) => left.strike - right.strike)
            .map((option) =>
              summarizeAprOption(option, "call", underlyingPrice, daysToExpiration),
            ),
    puts:
      requestedOptionType === "call"
        ? []
        : chain.puts
            .filter(
              (option) =>
                Number.isFinite(option.strike) &&
                (requestedStrikeRange === "all" || option.strike <= underlyingPrice),
            )
            .sort((left, right) => left.strike - right.strike)
            .map((option) =>
              summarizeAprOption(option, "put", underlyingPrice, daysToExpiration),
            ),
  };
}

function summarizeLeg(option: CallOrPut): OptionLegSummary {
  return {
    contractSymbol: option.contractSymbol,
    strike: option.strike,
    impliedVolatility: option.impliedVolatility,
    bid: option.bid,
    ask: option.ask,
    lastPrice: option.lastPrice,
    volume: option.volume,
    openInterest: option.openInterest,
  };
}

function isLiquidEnough(option: CallOrPut) {
  return (
    Number.isFinite(option.strike) &&
    Number.isFinite(option.impliedVolatility) &&
    option.impliedVolatility > 0 &&
    (option.bid === undefined || option.bid >= 0) &&
    (option.ask === undefined || option.ask >= 0)
  );
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function findNearestByStrike(options: CallOrPut[], targetStrike: number) {
  return options.reduce<CallOrPut | null>((nearest, option) => {
    if (!nearest) {
      return option;
    }

    return Math.abs(option.strike - targetStrike) < Math.abs(nearest.strike - targetStrike)
      ? option
      : nearest;
  }, null);
}

function calculateSkew(result: OptionsResult) {
  const chain = result.options[0];
  const underlyingPrice = getUnderlyingPrice(result);

  if (!chain || underlyingPrice === null) {
    throw new Error("Yahoo did not return a usable option chain or underlying price.");
  }

  const calls = chain.calls.filter(isLiquidEnough).sort((left, right) => left.strike - right.strike);
  const puts = chain.puts.filter(isLiquidEnough).sort((left, right) => left.strike - right.strike);
  const otmCalls = calls.filter((option) => option.strike > underlyingPrice);
  const otmPuts = puts.filter((option) => option.strike < underlyingPrice);
  const targetCall = findNearestByStrike(otmCalls, underlyingPrice * 1.1);
  const targetPut = findNearestByStrike(otmPuts, underlyingPrice * 0.9);
  const atmCall = findNearestByStrike(calls, underlyingPrice);
  const atmPut = findNearestByStrike(puts, underlyingPrice);
  const averageOtmCallIv = average(otmCalls.map((option) => option.impliedVolatility));
  const averageOtmPutIv = average(otmPuts.map((option) => option.impliedVolatility));

  return {
    underlyingPrice,
    expirationDate: toDateOnly(chain.expirationDate),
    expirationDates: result.expirationDates.map(toDateOnly),
    callCount: calls.length,
    putCount: puts.length,
    skew: {
      tenPercentOtm:
        targetPut && targetCall
          ? {
              value: targetPut.impliedVolatility - targetCall.impliedVolatility,
              put: summarizeLeg(targetPut),
              call: summarizeLeg(targetCall),
            }
          : null,
      averageOtm:
        averageOtmPutIv !== null && averageOtmCallIv !== null
          ? {
              value: averageOtmPutIv - averageOtmCallIv,
              putImpliedVolatility: averageOtmPutIv,
              callImpliedVolatility: averageOtmCallIv,
              putCount: otmPuts.length,
              callCount: otmCalls.length,
            }
          : null,
      atTheMoney:
        atmPut && atmCall
          ? {
              value: atmPut.impliedVolatility - atmCall.impliedVolatility,
              put: summarizeLeg(atmPut),
              call: summarizeLeg(atmCall),
            }
          : null,
    },
  };
}

function calculateTermSkewPoint(result: OptionsResult) {
  const skewData = calculateSkew(result);

  return {
    expirationDate: skewData.expirationDate,
    underlyingPrice: skewData.underlyingPrice,
    callCount: skewData.callCount,
    putCount: skewData.putCount,
    tenPercentOtmSkew: skewData.skew.tenPercentOtm?.value ?? null,
    averageOtmSkew: skewData.skew.averageOtm?.value ?? null,
    atTheMoneySkew: skewData.skew.atTheMoney?.value ?? null,
  };
}

async function getOptionsSkew(symbol: string, expiration?: Date) {
  const options = await yahooFinance.options(
    symbol.toUpperCase(),
    expiration ? { date: expiration } : undefined,
  );

  return calculateSkew(options);
}

async function getOptionsTermSkew(symbol: string, maxExpirations: number, delayMs: number) {
  const normalizedSymbol = symbol.toUpperCase();
  const firstOptions = await yahooFinance.options(normalizedSymbol);
  const expirationDates = firstOptions.expirationDates.slice(0, maxExpirations);
  const points = [calculateTermSkewPoint(firstOptions)];

  for (const expirationDate of expirationDates.slice(1)) {
    await sleep(delayMs);
    const options = await yahooFinance.options(normalizedSymbol, {
      date: expirationDate,
    });
    points.push(calculateTermSkewPoint(options));
  }

  return {
    underlyingPrice: getUnderlyingPrice(firstOptions),
    expirationDates: firstOptions.expirationDates.map(toDateOnly),
    requestedExpirations: expirationDates.length,
    yahooDelayMs: delayMs,
    points,
  };
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/yahoo-options-skew/status")) {
      await getAuthenticatedUserSub(event);
      return jsonResponse(200, {
        connected: true,
        detail: "Yahoo Finance option-chain access is configured.",
      });
    }

    if (path.endsWith("/yahoo-options-apr/expirations")) {
      await getAuthenticatedUserSub(event);
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, { error: "Query parameter 'symbol' is required." });
      }

      const options = await yahooFinance.options(symbol.toUpperCase());
      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        companyName: getCompanyName(options),
        underlyingPrice: getUnderlyingPrice(options),
        expirationDates: options.expirationDates.map(toDateOnly),
      });
    }

    if (path.endsWith("/yahoo-options-apr/chain")) {
      await getAuthenticatedUserSub(event);
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, { error: "Query parameter 'symbol' is required." });
      }

      const expiration = parseExpiration(query.expiration);
      if (!expiration) {
        return jsonResponse(400, { error: "Query parameter 'expiration' is required." });
      }

      const optionType = query.optionType ?? "both";
      if (optionType !== "both" && optionType !== "call" && optionType !== "put") {
        return jsonResponse(400, {
          error: "Query parameter 'optionType' must be 'both', 'call', or 'put'.",
        });
      }

      const strikeRange = query.strikeRange ?? "otm";
      if (strikeRange !== "otm" && strikeRange !== "all") {
        return jsonResponse(400, {
          error: "Query parameter 'strikeRange' must be 'otm' or 'all'.",
        });
      }

      const options = await yahooFinance.options(symbol.toUpperCase(), { date: expiration });
      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data: buildAprChain(options, optionType, strikeRange),
      });
    }

    if (path.endsWith("/yahoo-options-skew/skew")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const expiration = parseExpiration(query.expiration);
      const data = await getOptionsSkew(symbol, expiration);

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data,
      });
    }

    if (path.endsWith("/yahoo-options-skew/term-skew")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const maxExpirations = parseBoundedInteger(
        query.maxExpirations,
        DEFAULT_MAX_EXPIRATIONS,
        1,
        HARD_MAX_EXPIRATIONS,
      );
      const delayMs = parseBoundedInteger(
        query.delayMs,
        DEFAULT_YAHOO_DELAY_MS,
        MIN_YAHOO_DELAY_MS,
        MAX_YAHOO_DELAY_MS,
      );
      const data = await getOptionsTermSkew(symbol, maxExpirations, delayMs);

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data,
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
