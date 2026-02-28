import { defineFunction } from "@aws-amplify/backend";

export const tastyRestMarketInfo = defineFunction({
  name: "tasty-rest-market-info",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    TASTY_ENV: "prod",
    TASTY_CLIENT_SECRET_PARAMETER_NAME: "/amplify/tasty/credentials/client-secret",
    TASTY_TOKEN_PARAMETER_NAME: "/amplify/tasty/oauth/tokens",
    TASTY_OAUTH_SCOPES: "read",
    TASTY_MARKET_PATH: "/market-data/by-type",
    TASTY_MARKET_TYPE: "Equity",
  },
});
