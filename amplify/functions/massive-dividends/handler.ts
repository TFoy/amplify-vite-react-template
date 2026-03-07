import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getAuthenticatedUserSub } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type MassiveDividend = {
  ticker?: string;
  ex_dividend_date?: string;
  pay_date?: string;
  declaration_date?: string;
  record_date?: string;
  cash_amount?: number;
  currency?: string;
  frequency?: number | string;
  dividend_type?: string;
  distribution_type?: string;
};

type MassiveDividendsResponse = {
  results?: MassiveDividend[];
  status?: string;
  error?: string;
  request_id?: string;
  next_url?: string;
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

  const parameterName = getRequiredEnvironment("MASSIVE_API_KEY_PARAMETER_NAME");
  cachedApiKey = await getParameterValue(parameterName);
  return cachedApiKey;
}

async function getMassiveStatus() {
  await getApiKey();

  return {
    connected: true,
    detail: "Massive API key is configured.",
  };
}

function normalizeLimit(rawLimit: string | undefined) {
  if (!rawLimit) {
    return 100;
  }

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 100;
  }

  return Math.min(Math.trunc(parsed), 1000);
}

async function getDividendHistory(symbol: string, limit: number) {
  const apiKey = await getApiKey();
  const url = new URL(getRequiredEnvironment("MASSIVE_DIVIDENDS_URL"));
  url.searchParams.set("ticker", symbol.toUpperCase());
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "ex_dividend_date.asc");
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const payload = (await response.json()) as MassiveDividendsResponse;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload,
    };
  }

  if (payload.status === "ERROR" || payload.error) {
    return {
      ok: false,
      status: 400,
      payload,
    };
  }

  if (!Array.isArray(payload.results)) {
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

    if (path.endsWith("/massive/status")) {
      await getAuthenticatedUserSub(event);
      return jsonResponse(200, await getMassiveStatus());
    }

    if (path.endsWith("/massive/dividends")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const limit = normalizeLimit(query.limit);
      const result = await getDividendHistory(symbol, limit);
      if (!result.ok) {
        return jsonResponse(result.status, {
          error: "Failed to retrieve dividend history from Massive.",
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
