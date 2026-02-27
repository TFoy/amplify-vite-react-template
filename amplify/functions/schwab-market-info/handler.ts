import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";

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

const ssmClient = new SSMClient();

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
};
let cachedCredentials: { appKey: string; appSecret: string } | null = null;

function getRequiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function getParameterValue(name: string) {
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );

  if (!result.Parameter?.Value) {
    throw new Error(`Missing SSM parameter value for: ${name}`);
  }

  return result.Parameter.Value;
}

async function getSchwabCredentials() {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const appKeyParameter = getRequiredEnvironment("SCHWAB_APP_KEY_PARAMETER_NAME");
  const appSecretParameter = getRequiredEnvironment("SCHWAB_APP_SECRET_PARAMETER_NAME");

  const [appKey, appSecret] = await Promise.all([
    getParameterValue(appKeyParameter),
    getParameterValue(appSecretParameter),
  ]);

  cachedCredentials = { appKey, appSecret };
  return cachedCredentials;
}

function getRedirectUri(event: ApiGatewayEvent) {
  const host = event.headers?.host;
  if (!host) {
    throw new Error("Missing request host header.");
  }

  const protocolHeader = event.headers?.["x-forwarded-proto"] ?? "https";
  const protocol = protocolHeader.split(",")[0]?.trim() || "https";
  return `${protocol}://${host}/schwab/callback`;
}

async function createAuthUrl(redirectUri: string) {
  const { appKey } = await getSchwabCredentials();
  const authUrl = getRequiredEnvironment("SCHWAB_AUTH_URL");
  const scope = process.env.SCHWAB_OAUTH_SCOPE;

  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("redirect_uri", redirectUri);
  if (scope) {
    url.searchParams.set("scope", scope);
  }

  return url.toString();
}

async function saveTokens(tokens: TokenRecord) {
  const parameterName = getRequiredEnvironment("SCHWAB_TOKEN_PARAMETER_NAME");
  await ssmClient.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: JSON.stringify(tokens),
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

async function getStoredTokens() {
  const parameterName = getRequiredEnvironment("SCHWAB_TOKEN_PARAMETER_NAME");
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }),
  );

  if (!result.Parameter?.Value) {
    return null;
  }

  return JSON.parse(result.Parameter.Value) as TokenRecord;
}

function buildTokenRecord(tokenPayload: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}, existingRefreshToken?: string) {
  return {
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token ?? existingRefreshToken ?? "",
    expiresAt: new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString(),
  };
}

async function requestToken(params: URLSearchParams) {
  const { appKey, appSecret } = await getSchwabCredentials();
  const tokenUrl = getRequiredEnvironment("SCHWAB_TOKEN_URL");

  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const tokenPayload = (await tokenResponse.json()) as {
    error?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenResponse.ok || !tokenPayload.access_token || !tokenPayload.expires_in) {
    throw new Error(tokenPayload.error ?? "Schwab token request failed.");
  }

  return tokenPayload as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

async function exchangeAuthorizationCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const tokenPayload = await requestToken(params);
  const tokens = buildTokenRecord(tokenPayload);

  if (!tokens.refreshToken) {
    throw new Error("Token exchange succeeded but no refresh token was returned.");
  }

  await saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(tokens: TokenRecord) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  const refreshedPayload = await requestToken(params);
  const refreshedTokens = buildTokenRecord(refreshedPayload, tokens.refreshToken);
  await saveTokens(refreshedTokens);
  return refreshedTokens;
}

function isExpired(expiresAt: string) {
  const expirationMs = new Date(expiresAt).getTime();
  const bufferMs = 60 * 1000;
  return Number.isNaN(expirationMs) || expirationMs - bufferMs <= Date.now();
}

async function getValidAccessToken() {
  const storedTokens = await getStoredTokens();
  if (!storedTokens?.accessToken || !storedTokens.refreshToken) {
    return null;
  }

  if (!isExpired(storedTokens.expiresAt)) {
    return storedTokens.accessToken;
  }

  const refreshedTokens = await refreshAccessToken(storedTokens);
  return refreshedTokens.accessToken;
}

async function getLevelOneEquities(symbol: string, accessToken: string) {
  const marketDataUrl = getRequiredEnvironment("SCHWAB_LEVELONE_EQUITIES_URL");
  const url = new URL(marketDataUrl);
  url.searchParams.set("symbols", symbol.toUpperCase());
  url.searchParams.set("fields", "quote");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json();
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/schwab/authorize")) {
      const redirectUri = getRedirectUri(event);
      return {
        statusCode: 302,
        headers: {
          Location: await createAuthUrl(redirectUri),
        },
      };
    }

    if (path.endsWith("/schwab/callback")) {
      const code = query.code;
      if (!code) {
        return {
          statusCode: 400,
          headers: HTML_HEADERS,
          body: "<html><body><h1>Missing authorization code.</h1></body></html>",
        };
      }

      const redirectUri = getRedirectUri(event);
      await exchangeAuthorizationCode(code, redirectUri);
      return {
        statusCode: 200,
        headers: HTML_HEADERS,
        body: "<html><body><h1>Schwab OAuth connected.</h1><p>You can close this tab.</p></body></html>",
      };
    }

    if (path.endsWith("/schwab/market-info")) {
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, { error: "Query parameter 'symbol' is required." });
      }

      let accessToken = await getValidAccessToken();
      if (!accessToken) {
        return jsonResponse(401, {
          error: "Schwab is not connected yet. Open /schwab/authorize first.",
        });
      }

      let marketData = await getLevelOneEquities(symbol, accessToken);
      if (marketData.status === 401) {
        const storedTokens = await getStoredTokens();
        if (!storedTokens) {
          return jsonResponse(401, {
            error: "Schwab authorization expired. Reconnect using /schwab/authorize.",
          });
        }

        const refreshedTokens = await refreshAccessToken(storedTokens);
        accessToken = refreshedTokens.accessToken;
        marketData = await getLevelOneEquities(symbol, accessToken);
      }

      if (!marketData.ok) {
        return jsonResponse(marketData.status, {
          error: "Failed to retrieve market data from Schwab.",
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
