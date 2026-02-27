import { defineFunction } from "@aws-amplify/backend";

export const tastyMarketInfo = defineFunction({
  name: "tasty-market-info",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    TASTY_ENV: "prod",
    TASTY_CLIENT_ID_PARAMETER_NAME: "/amplify/tasty/credentials/client-id",
    TASTY_CLIENT_SECRET_PARAMETER_NAME: "/amplify/tasty/credentials/client-secret",
    TASTY_SESSION_SECRET_PARAMETER_NAME: "/amplify/tasty/credentials/session-secret",
    TASTY_PROD_BASE_URL: "https://api.tastyworks.com",
    TASTY_SANDBOX_BASE_URL: "https://api.cert.tastyworks.com",
    TASTY_TOKEN_PATH: "/oauth/token",
    TASTY_MARKET_PATH: "/market-data/by-type",
    TASTY_AUTHORIZE_URL: "https://my.tastytrade.com/auth.html",
    TASTY_OAUTH_SCOPES: "read",
    TASTY_TOKEN_PARAMETER_NAME: "/amplify/tasty/oauth/tokens",
    TASTY_MARKET_TYPE: "Equity",
  },
});
