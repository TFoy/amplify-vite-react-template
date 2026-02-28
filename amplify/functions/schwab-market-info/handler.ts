import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
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

type SchwabConnectionStatus = {
  connected: boolean;
  reason?: string;
  detail?: string;
};

type SignedStatePayload = {
  nonce: string;
  userSub: string;
  issuedAt: number;
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

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
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

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function signValue(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

async function createSignedState(userSub: string) {
  const { appSecret } = await getSchwabCredentials();
  const payload = JSON.stringify({
    nonce: randomUUID(),
    userSub,
    issuedAt: Date.now(),
  } satisfies SignedStatePayload);
  const encodedPayload = toBase64Url(payload);
  return `${encodedPayload}.${signValue(encodedPayload, appSecret)}`;
}

async function parseSignedState(value: string | undefined) {
  if (!value) {
    return null;
  }

  const separator = value.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const encodedPayload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const { appSecret } = await getSchwabCredentials();
  const expected = signValue(encodedPayload, appSecret);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as SignedStatePayload;
    return typeof parsed.userSub === "string" && parsed.userSub ? parsed : null;
  } catch {
    return null;
  }
}

async function createAuthUrl(redirectUri: string, userSub: string) {
  const { appKey } = await getSchwabCredentials();
  const authUrl = getRequiredEnvironment("SCHWAB_AUTH_URL");
  const scope = process.env.SCHWAB_OAUTH_SCOPE;

  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", await createSignedState(userSub));
  if (scope) {
    url.searchParams.set("scope", scope);
  }

  return url.toString();
}

async function saveTokens(tokens: TokenRecord, userSub: string) {
  const parameterPrefix = getRequiredEnvironment("SCHWAB_TOKEN_PARAMETER_NAME");
  await ssmClient.send(
    new PutParameterCommand({
      Name: getUserScopedParameterName(parameterPrefix, userSub),
      Value: JSON.stringify(tokens),
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

async function getStoredTokens(userSub: string) {
  const parameterPrefix = getRequiredEnvironment("SCHWAB_TOKEN_PARAMETER_NAME");

  try {
    const result = await ssmClient.send(
      new GetParameterCommand({
        Name: getUserScopedParameterName(parameterPrefix, userSub),
        WithDecryption: true,
      }),
    );

    if (!result.Parameter?.Value) {
      return null;
    }

    return JSON.parse(result.Parameter.Value) as TokenRecord;
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
}

function buildTokenRecord(
  tokenPayload: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  },
  existingRefreshToken?: string,
) {
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

async function exchangeAuthorizationCode(code: string, redirectUri: string, userSub: string) {
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

  await saveTokens(tokens, userSub);
  return tokens;
}

async function refreshAccessToken(tokens: TokenRecord, userSub: string) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  const refreshedPayload = await requestToken(params);
  const refreshedTokens = buildTokenRecord(refreshedPayload, tokens.refreshToken);
  await saveTokens(refreshedTokens, userSub);
  return refreshedTokens;
}

function isExpired(expiresAt: string) {
  const expirationMs = new Date(expiresAt).getTime();
  const bufferMs = 60 * 1000;
  return Number.isNaN(expirationMs) || expirationMs - bufferMs <= Date.now();
}

async function getValidAccessToken(userSub: string) {
  const storedTokens = await getStoredTokens(userSub);
  if (!storedTokens?.accessToken || !storedTokens.refreshToken) {
    return null;
  }

  if (!isExpired(storedTokens.expiresAt)) {
    return storedTokens.accessToken;
  }

  const refreshedTokens = await refreshAccessToken(storedTokens, userSub);
  return refreshedTokens.accessToken;
}

async function getConnectionStatus(userSub: string) {
  try {
    const accessToken = await getValidAccessToken(userSub);
    return { connected: Boolean(accessToken) } satisfies SchwabConnectionStatus;
  } catch (error) {
    return {
      connected: false,
      reason: "unexpected_error",
      detail: error instanceof Error ? error.message : "Unexpected server error.",
    } satisfies SchwabConnectionStatus;
  }
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

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/schwab/authorize-url")) {
      const userSub = await getAuthenticatedUserSub(event);
      const redirectUri = getRedirectUri(event);
      return jsonResponse(200, {
        authorizeUrl: await createAuthUrl(redirectUri, userSub),
      });
    }

    if (path.endsWith("/schwab/authorize")) {
      const userSub = await getAuthenticatedUserSub(event);
      const redirectUri = getRedirectUri(event);
      return {
        statusCode: 302,
        headers: {
          Location: await createAuthUrl(redirectUri, userSub),
        },
      };
    }

    if (path.endsWith("/schwab/callback")) {
      const code = query.code;
      const state = await parseSignedState(query.state);
      if (!code || !state) {
        return {
          statusCode: 400,
          headers: HTML_HEADERS,
          body: "<html><body><h1>Missing authorization code or state.</h1></body></html>",
        };
      }

      const redirectUri = getRedirectUri(event);
      await exchangeAuthorizationCode(code, redirectUri, state.userSub);
      return {
        statusCode: 200,
        headers: HTML_HEADERS,
        body: "<html><body><h1>Schwab OAuth connected.</h1><p>You can close this tab.</p></body></html>",
      };
    }

    if (path.endsWith("/schwab/status")) {
      const userSub = await getAuthenticatedUserSub(event);
      return jsonResponse(200, await getConnectionStatus(userSub));
    }

    if (path.endsWith("/schwab/market-info")) {
      const userSub = await getAuthenticatedUserSub(event);
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, { error: "Query parameter 'symbol' is required." });
      }

      let accessToken = await getValidAccessToken(userSub);
      if (!accessToken) {
        return jsonResponse(401, {
          error: "Schwab is not connected yet. Connect OAuth first.",
        });
      }

      let marketData = await getLevelOneEquities(symbol, accessToken);
      if (marketData.status === 401) {
        const storedTokens = await getStoredTokens(userSub);
        if (!storedTokens) {
          return jsonResponse(401, {
            error: "Schwab authorization expired. Reconnect OAuth.",
          });
        }

        const refreshedTokens = await refreshAccessToken(storedTokens, userSub);
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
