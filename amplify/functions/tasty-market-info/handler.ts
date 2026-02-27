import { execFileSync } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import TastytradeClient from "@tastytrade/api";
import WebSocket from "ws";

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

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type TastyConnectionStatus = {
  connected: boolean;
  reason?: string;
  detail?: string;
};

const ssmClient = new SSMClient();

Reflect.set(globalThis, "WebSocket", WebSocket);
Reflect.set(globalThis, "window", {
  WebSocket,
  setTimeout,
  clearTimeout,
});

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
};

let cachedCredentials:
  | {
      clientId: string;
      clientSecret: string;
      sessionSecret: string;
    }
  | null = null;

function getRequiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function describeUnknownError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return `Non-Error object: ${Object.prototype.toString.call(error)}`;
    }
  }

  return String(error);
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

function htmlResponse(
  statusCode: number,
  body: string,
  headers?: Record<string, string>,
  cookies?: string[],
) {
  return {
    statusCode,
    headers: {
      ...HTML_HEADERS,
      ...headers,
    },
    cookies,
    body,
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

async function getTastyCredentials() {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const clientIdParameter = getRequiredEnvironment("TASTY_CLIENT_ID_PARAMETER_NAME");
  const clientSecretParameter = getRequiredEnvironment("TASTY_CLIENT_SECRET_PARAMETER_NAME");
  const sessionSecretParameter = getRequiredEnvironment("TASTY_SESSION_SECRET_PARAMETER_NAME");

  const [clientId, clientSecret, sessionSecret] = await Promise.all([
    getParameterValue(clientIdParameter),
    getParameterValue(clientSecretParameter),
    getParameterValue(sessionSecretParameter),
  ]);

  cachedCredentials = { clientId, clientSecret, sessionSecret };
  return cachedCredentials;
}

function getTastyBaseUrl() {
  return (process.env.TASTY_ENV ?? "prod").toLowerCase() === "sandbox"
    ? getRequiredEnvironment("TASTY_SANDBOX_BASE_URL")
    : getRequiredEnvironment("TASTY_PROD_BASE_URL");
}

function getTastyTokenUrl() {
  return new URL(getRequiredEnvironment("TASTY_TOKEN_PATH"), getTastyBaseUrl()).toString();
}

function getTastyMarketUrl() {
  return new URL(getRequiredEnvironment("TASTY_MARKET_PATH"), getTastyBaseUrl()).toString();
}

function getTastySdkConfig() {
  return (process.env.TASTY_ENV ?? "prod").toLowerCase() === "sandbox"
    ? TastytradeClient.SandboxConfig
    : TastytradeClient.ProdConfig;
}

function getTastyAccountStreamerUrl() {
  const sdkConfig = getTastySdkConfig();
  if (!sdkConfig.accountStreamerUrl) {
    throw new Error("TastyTrade SDK config did not provide an account streamer URL.");
  }

  return sdkConfig.accountStreamerUrl;
}

function getTastyApiBaseUrl() {
  const sdkConfig = getTastySdkConfig();
  if (!sdkConfig.baseUrl) {
    throw new Error("TastyTrade SDK config did not provide a base URL.");
  }

  return sdkConfig.baseUrl;
}

function getRequestHeader(event: ApiGatewayEvent, name: string) {
  if (!event.headers) {
    return undefined;
  }

  const exact = event.headers[name];
  if (exact) {
    return exact;
  }

  const lowerKey = Object.keys(event.headers).find((key) => key.toLowerCase() === name);
  return lowerKey ? event.headers[lowerKey] : undefined;
}

function getRedirectUri(event: ApiGatewayEvent) {
  const host = getRequestHeader(event, "host");
  if (!host) {
    throw new Error("Missing request host header.");
  }

  const protocolHeader = getRequestHeader(event, "x-forwarded-proto") ?? "https";
  const protocol = protocolHeader.split(",")[0]?.trim() || "https";
  return `${protocol}://${host}/tasty/callback`;
}

function getQueryValue(event: ApiGatewayEvent, name: string) {
  return event.queryStringParameters?.[name];
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

function signValue(value: string, sessionSecret: string) {
  return createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function createSignedState(returnTo: string, sessionSecret: string) {
  const payload = JSON.stringify({
    nonce: randomUUID(),
    returnTo,
    issuedAt: Date.now(),
  });
  const encodedPayload = toBase64Url(payload);
  const signature = signValue(encodedPayload, sessionSecret);
  return `${encodedPayload}.${signature}`;
}

function parseSignedState(value: string | undefined, sessionSecret: string) {
  if (!value) {
    return null;
  }

  const separator = value.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const encodedPayload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signValue(encodedPayload, sessionSecret);

  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as {
      nonce?: string;
      returnTo?: string;
      issuedAt?: number;
    };

    if (typeof parsed.returnTo !== "string" || !parsed.returnTo) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function createAuthorizeResponse(event: ApiGatewayEvent) {
  const { clientId, sessionSecret } = await getTastyCredentials();
  const redirectUri = getRedirectUri(event);
  const authorizeUrl = getRequiredEnvironment("TASTY_AUTHORIZE_URL");
  const scope = getRequiredEnvironment("TASTY_OAUTH_SCOPES");
  const returnTo = getQueryValue(event, "return_to") ?? "";
  const signedState = createSignedState(returnTo, sessionSecret);

  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", signedState);

  return {
    statusCode: 302,
    headers: {
      Location: url.toString(),
    },
  };
}

function extractTokenPayload(payload: unknown): TokenPayload {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }

  const root = payload as Record<string, unknown>;
  const nestedData =
    typeof root.data === "object" && root.data !== null
      ? (root.data as Record<string, unknown>)
      : null;
  const source = nestedData ?? root;

  return {
    access_token: typeof source.access_token === "string" ? source.access_token : undefined,
    refresh_token: typeof source.refresh_token === "string" ? source.refresh_token : undefined,
    expires_in: typeof source.expires_in === "number" ? source.expires_in : undefined,
  };
}

function buildTokenRecord(tokenPayload: TokenPayload, existingRefreshToken?: string) {
  if (!tokenPayload.access_token || !tokenPayload.expires_in) {
    throw new Error("Tasty token response did not include access_token/expires_in.");
  }

  return {
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token ?? existingRefreshToken ?? "",
    expiresAt: new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString(),
  };
}

async function saveTokens(tokens: TokenRecord) {
  const parameterName = getRequiredEnvironment("TASTY_TOKEN_PARAMETER_NAME");
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
  const parameterName = getRequiredEnvironment("TASTY_TOKEN_PARAMETER_NAME");
  let result;

  try {
    result = await ssmClient.send(
      new GetParameterCommand({
        Name: parameterName,
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

async function requestToken(params: URLSearchParams) {
  const { clientId, clientSecret } = await getTastyCredentials();
  const tokenUrl = getTastyTokenUrl();
  const raw = execFileSync(
    "curl",
    [
      "-sS",
      "-i",
      "-X",
      "POST",
      tokenUrl,
      "-H",
      "Content-Type: application/x-www-form-urlencoded",
      "-H",
      "Accept: application/json",
      "--data-urlencode",
      `client_id=${clientId}`,
      "--data-urlencode",
      `client_secret=${clientSecret}`,
      ...Array.from(params.entries()).flatMap(([key, value]) => [
        "--data-urlencode",
        `${key}=${value}`,
      ]),
    ],
    { encoding: "utf8" },
  );

  const parts = raw.split(/\r?\n\r?\n/);
  let headerIdx = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].startsWith("HTTP/")) {
      headerIdx = index;
    }
  }

  if (headerIdx === -1) {
    throw new Error(`Tasty token request failed (no HTTP response): ${raw.slice(0, 300)}`);
  }

  const headerBlock = parts[headerIdx];
  const body = parts.slice(headerIdx + 1).join("\n\n");
  const statusMatch = headerBlock.match(/^HTTP\/\S+\s+(\d+)/m);
  const contentTypeMatch = headerBlock.match(/^content-type:\s*(.+)$/im);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const contentType = contentTypeMatch?.[1]?.trim() ?? "unknown";
  const responsePayload = contentType.includes("application/json") ? JSON.parse(body) : body;
  const tokenPayload = extractTokenPayload(responsePayload);

  if (status < 200 || status >= 300 || !tokenPayload.access_token || !tokenPayload.expires_in) {
    const payloadMessage =
      typeof responsePayload === "object" && responsePayload !== null
        ? JSON.stringify(responsePayload)
        : String(responsePayload).slice(0, 300);

    throw new Error(
      `Tasty token request failed (status ${status}, content-type ${contentType}): ${payloadMessage}`,
    );
  }

  return tokenPayload;
}

async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
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

  const tokenPayload = await requestToken(params);
  const refreshedTokens = buildTokenRecord(tokenPayload, tokens.refreshToken);
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
  if (!storedTokens?.refreshToken) {
    return null;
  }

  if (storedTokens.accessToken && !isExpired(storedTokens.expiresAt)) {
    return storedTokens.accessToken;
  }

  const refreshedTokens = await refreshAccessToken(storedTokens);
  return refreshedTokens.accessToken;
}

async function getConnectionStatus() {
  try {
    const accessToken = await getValidAccessToken();
    return { connected: Boolean(accessToken) };
  } catch (error) {
    const message = describeUnknownError(error);

    if (message.includes("Missing SSM parameter: /amplify/tasty/credentials/client-id")) {
      return { connected: false, reason: "missing_client_id", detail: message } satisfies TastyConnectionStatus;
    }

    if (message.includes("Missing SSM parameter: /amplify/tasty/credentials/client-secret")) {
      return { connected: false, reason: "missing_client_secret", detail: message } satisfies TastyConnectionStatus;
    }

    if (message.includes("Missing SSM parameter: /amplify/tasty/credentials/session-secret")) {
      return { connected: false, reason: "missing_session_secret", detail: message } satisfies TastyConnectionStatus;
    }

    if (message.includes("status 401")) {
      return { connected: false, reason: "invalid_client_or_refresh_token", detail: message } satisfies TastyConnectionStatus;
    }

    return { connected: false, reason: "unexpected_error", detail: message } satisfies TastyConnectionStatus;
  }
}

async function createTastySdkClient(refreshToken: string) {
  const { clientSecret } = await getTastyCredentials();
  return new TastytradeClient({
    baseUrl: getTastyApiBaseUrl(),
    accountStreamerUrl: getTastyAccountStreamerUrl(),
    clientSecret,
    refreshToken,
    oauthScopes: [getRequiredEnvironment("TASTY_OAUTH_SCOPES")],
  });
}

function extractQuoteData(event: unknown) {
  if (typeof event !== "object" || event === null) {
    return null;
  }

  const source = event as Record<string, unknown>;
  const numericKeys = ["lastPrice", "last", "price", "bidPrice", "bid", "askPrice", "ask"];
  const hasQuoteField = numericKeys.some((key) => typeof source[key] === "number");
  return hasQuoteField ? source : null;
}

async function getMarketInfo(symbol: string, refreshToken: string) {
  const tasty = await createTastySdkClient(refreshToken);
  const quoteStreamer = tasty.quoteStreamer;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;

    const cleanup = async () => {
      try {
        quoteStreamer.unsubscribe?.([symbol]);
      } catch {}

      try {
        await quoteStreamer.disconnect?.();
      } catch {}
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      quoteStreamer.removeEventListener(handler);
      void cleanup().finally(callback);
    };

    const handler = (events: unknown[]) => {
      for (const event of events) {
        const quote = extractQuoteData(event);
        if (!quote) {
          continue;
        }

        finish(() => resolve(quote));
        return;
      }
    };

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for TastyTrade quote for ${symbol}.`)));
    }, 15000);

    quoteStreamer.addEventListener(handler);

    void (async () => {
      try {
        await quoteStreamer.connect();
        quoteStreamer.subscribe([symbol]);
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();
  });
}

async function getDebugInfo(event: ApiGatewayEvent) {
  const { clientId, clientSecret, sessionSecret } = await getTastyCredentials();
  const redirectUri = getRedirectUri(event);
  const tokenUrl = getTastyTokenUrl();
  const marketUrl = getTastyMarketUrl();
  const authorizeUrl = getRequiredEnvironment("TASTY_AUTHORIZE_URL");
  const code = getQueryValue(event, "code") ?? "";
  const state = getQueryValue(event, "state") ?? "";
  const parsedState = parseSignedState(state || undefined, sessionSecret);

  return {
    environment: process.env.TASTY_ENV ?? "prod",
    authorizeUrl,
    tokenUrl,
    marketUrl,
    redirectUri,
    hasClientId: Boolean(clientId),
    hasClientSecret: Boolean(clientSecret),
    hasSessionSecret: Boolean(sessionSecret),
    clientIdLength: clientId.length,
    clientSecretLength: clientSecret.length,
    stateLength: state.length,
    codeLength: code.length,
    parsedStateReturnTo: parsedState?.returnTo ?? null,
  };
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/tasty/authorize")) {
      return createAuthorizeResponse(event);
    }

    if (path.endsWith("/tasty/callback")) {
      const code = query.code;
      const { sessionSecret } = await getTastyCredentials();
      const parsedState = parseSignedState(query.state, sessionSecret);
      const returnTo = parsedState?.returnTo || "/tasty-auth-popup";

      if (
        !code ||
        !parsedState
      ) {
        return {
          statusCode: 302,
          headers: {
            Location: `${returnTo}?oauth=error&message=${encodeURIComponent("State validation failed.")}`,
          },
        };
      }

      await exchangeCodeForTokens(code, getRedirectUri(event));
      return {
        statusCode: 302,
        headers: {
          Location: `${returnTo}?oauth=success`,
        },
      };
    }

    if (path.endsWith("/tasty/status")) {
      return jsonResponse(200, await getConnectionStatus());
    }

    if (path.endsWith("/tasty/debug")) {
      return jsonResponse(200, await getDebugInfo(event));
    }

    if (path.endsWith("/tasty/market-info")) {
      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, { error: "Query parameter 'symbol' is required." });
      }

      const storedTokens = await getStoredTokens();
      if (!storedTokens?.refreshToken) {
        return jsonResponse(401, {
          error: "TastyTrade is not connected yet. Start OAuth first.",
        });
      }

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        data: await getMarketInfo(symbol.toUpperCase(), storedTokens.refreshToken),
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: describeUnknownError(error),
    });
  }
};
