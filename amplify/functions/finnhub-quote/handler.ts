import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getAuthenticatedUserSub } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type FinnhubQuotePayload = {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t?: number;
};

const ssmClient = new SSMClient();

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

let cachedApiKey: string | null = null;

function getRequiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

async function getParameterValue(name: string) {
  let result;

  try {
    result = await ssmClient.send(
      new GetParameterCommand({
        Name: name,
        WithDecryption: true,
      }),
    );
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String(error.name)
        : "";

    if (errorName === "ParameterNotFound") {
      throw new Error(`Missing SSM parameter: ${name}`);
    }

    throw error;
  }

  if (!result.Parameter?.Value) {
    throw new Error(`Missing SSM parameter value for: ${name}`);
  }

  return result.Parameter.Value;
}

async function getApiKey() {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const parameterName = getRequiredEnvironment("FINNHUB_API_KEY_PARAMETER_NAME");
  cachedApiKey = await getParameterValue(parameterName);
  return cachedApiKey;
}

async function getFinnhubStatus() {
  await getApiKey();

  return {
    connected: true,
    detail: "Finnhub API key is configured.",
  };
}

function isValidQuotePayload(value: unknown): value is FinnhubQuotePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return ["c", "d", "dp", "h", "l", "o", "pc"].every(
    (key) => typeof payload[key] === "number",
  );
}

async function getQuote(symbol: string) {
  const apiKey = await getApiKey();
  const quoteUrl = new URL(getRequiredEnvironment("FINNHUB_QUOTE_URL"));
  quoteUrl.searchParams.set("symbol", symbol.toUpperCase());
  quoteUrl.searchParams.set("token", apiKey);

  const response = await fetch(quoteUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let payload: unknown = null;

  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload,
    };
  }

  if (!isValidQuotePayload(payload)) {
    return {
      ok: false,
      status: 502,
      payload,
    };
  }

  return {
    ok: true,
    status: 200,
    payload,
  };
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/finnhub/status")) {
      await getAuthenticatedUserSub(event);
      return jsonResponse(200, await getFinnhubStatus());
    }

    if (path.endsWith("/finnhub/quote")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const quote = await getQuote(symbol);
      if (!quote.ok) {
        return jsonResponse(quote.status, {
          error: "Failed to retrieve quote from Finnhub.",
          details: quote.payload,
        });
      }

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data: quote.payload,
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
