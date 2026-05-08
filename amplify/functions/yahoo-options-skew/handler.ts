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

function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
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

async function getOptionsSkew(symbol: string, expiration?: Date) {
  const options = await yahooFinance.options(
    symbol.toUpperCase(),
    expiration ? { date: expiration } : undefined,
  );

  return calculateSkew(options);
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

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
