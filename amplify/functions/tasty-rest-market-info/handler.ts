import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import TastytradeClient from "@tastytrade/api";
import { getAuthenticatedUserSub, getUserScopedParameterName } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

type TastyRestConnectionStatus = {
  connected: boolean;
  reason?: string;
  detail?: string;
};

type AxiosLikeError = {
  response?: {
    status?: number;
    data?: unknown;
  };
  message?: string;
};

const ssmClient = new SSMClient();

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

let cachedClientSecret: string | null = null;

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

async function getStoredTokens(userSub: string) {
  const parameterPrefix = getRequiredEnvironment("TASTY_TOKEN_PARAMETER_NAME");
  let result;

  try {
    result = await ssmClient.send(
      new GetParameterCommand({
        Name: getUserScopedParameterName(parameterPrefix, userSub),
        WithDecryption: true,
      }),
    );
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String(error.name)
        : "";

    if (errorName === "ParameterNotFound") {
      return null;
    }

    throw error;
  }

  if (!result.Parameter?.Value) {
    return null;
  }

  return JSON.parse(result.Parameter.Value) as TokenRecord;
}

async function getClientSecret() {
  if (cachedClientSecret) {
    return cachedClientSecret;
  }

  const clientSecretParameter = getRequiredEnvironment("TASTY_CLIENT_SECRET_PARAMETER_NAME");
  cachedClientSecret = await getParameterValue(clientSecretParameter);
  return cachedClientSecret;
}

function getTastySdkConfig() {
  return (process.env.TASTY_ENV ?? "prod").toLowerCase() === "sandbox"
    ? TastytradeClient.SandboxConfig
    : TastytradeClient.ProdConfig;
}

function getTastyApiBaseUrl() {
  const config = getTastySdkConfig();
  if (!config.baseUrl) {
    throw new Error("TastyTrade SDK config did not provide a base URL.");
  }

  return config.baseUrl;
}

function getTastyAccountStreamerUrl() {
  const config = getTastySdkConfig();
  if (!config.accountStreamerUrl) {
    throw new Error("TastyTrade SDK config did not provide an account streamer URL.");
  }

  return config.accountStreamerUrl;
}

async function createTastyClient(refreshToken: string) {
  const clientSecret = await getClientSecret();
  return new TastytradeClient({
    baseUrl: getTastyApiBaseUrl(),
    accountStreamerUrl: getTastyAccountStreamerUrl(),
    clientSecret,
    refreshToken,
    oauthScopes: [getRequiredEnvironment("TASTY_OAUTH_SCOPES")],
  });
}

function extractAxiosErrorDetails(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const axiosError = error as AxiosLikeError;
    const responseData = axiosError.response?.data;
    return {
      status: axiosError.response?.status,
      details: responseData ?? axiosError.message ?? "Unexpected REST error.",
    };
  }

  return {
    status: undefined,
    details: String(error),
  };
}

async function getConnectionStatus(userSub: string) {
  try {
    const storedTokens = await getStoredTokens(userSub);
    if (!storedTokens?.refreshToken) {
      return {
        connected: false,
        reason: "not_connected",
        detail: "TastyTrade OAuth has not completed yet.",
      } satisfies TastyRestConnectionStatus;
    }

    const client = await createTastyClient(storedTokens.refreshToken);
    await client.httpClient.generateAccessToken();
    return { connected: true } satisfies TastyRestConnectionStatus;
  } catch (error) {
    const details = extractAxiosErrorDetails(error).details;
    return {
      connected: false,
      reason: "unexpected_error",
      detail: typeof details === "string" ? details : JSON.stringify(details),
    } satisfies TastyRestConnectionStatus;
  }
}

async function getRestMarketInfo(symbol: string, userSub: string) {
  const storedTokens = await getStoredTokens(userSub);
  if (!storedTokens?.refreshToken) {
    return {
      ok: false,
      status: 401,
      payload: {
        error: "TastyTrade is not connected yet. Start OAuth first.",
      },
    };
  }

  try {
    const client = await createTastyClient(storedTokens.refreshToken);
    const marketType = getRequiredEnvironment("TASTY_MARKET_TYPE").toLowerCase();
    const response = await client.httpClient.getData(getRequiredEnvironment("TASTY_MARKET_PATH"), {}, {
      [marketType]: symbol.toUpperCase(),
    });

    return {
      ok: true,
      status: 200,
      payload: response.data,
    };
  } catch (error) {
    const details = extractAxiosErrorDetails(error);
    return {
      ok: false,
      status: details.status ?? 500,
      payload: details.details,
    };
  }
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/tasty-rest/status")) {
      const userSub = await getAuthenticatedUserSub(event);
      return jsonResponse(200, await getConnectionStatus(userSub));
    }

    if (path.endsWith("/tasty-rest/market-info")) {
      const userSub = await getAuthenticatedUserSub(event);
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const marketData = await getRestMarketInfo(symbol, userSub);
      if (!marketData.ok) {
        return jsonResponse(marketData.status, {
          error: "Failed to retrieve market data from TastyTrade REST endpoint.",
          details: marketData.payload,
        });
      }

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data: marketData.payload,
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
