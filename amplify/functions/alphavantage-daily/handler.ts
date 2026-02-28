import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getAuthenticatedUserSub } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type AlphaVantageDailyPoint = {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. volume"?: string;
};

type AlphaVantageResponse = {
  "Meta Data"?: Record<string, string>;
  "Time Series (Daily)"?: Record<string, AlphaVantageDailyPoint>;
  Information?: string;
  Note?: string;
  "Error Message"?: string;
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

  const parameterName = getRequiredEnvironment("ALPHAVANTAGE_API_KEY_PARAMETER_NAME");
  cachedApiKey = await getParameterValue(parameterName);
  return cachedApiKey;
}

async function getAlphaVantageStatus() {
  await getApiKey();

  return {
    connected: true,
    detail: "Alpha Vantage API key is configured.",
  };
}

async function getDailySeries(symbol: string) {
  const apiKey = await getApiKey();
  const url = new URL(getRequiredEnvironment("ALPHAVANTAGE_DAILY_URL"));
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", symbol.toUpperCase());
  url.searchParams.set("outputsize", "compact");
  url.searchParams.set("datatype", "json");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const payload = (await response.json()) as AlphaVantageResponse;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload,
    };
  }

  if (payload["Error Message"] || payload.Note || payload.Information) {
    return {
      ok: false,
      status: 400,
      payload,
    };
  }

  if (!payload["Time Series (Daily)"]) {
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

    if (path.endsWith("/alphavantage/status")) {
      await getAuthenticatedUserSub(event);
      return jsonResponse(200, await getAlphaVantageStatus());
    }

    if (path.endsWith("/alphavantage/daily")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const result = await getDailySeries(symbol);
      if (!result.ok) {
        return jsonResponse(result.status, {
          error: "Failed to retrieve daily time series from Alpha Vantage.",
          details: result.payload,
        });
      }

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data: result.payload,
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
