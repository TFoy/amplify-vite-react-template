import { defineFunction } from "@aws-amplify/backend";

export const schwabMarketInfo = defineFunction({
  name: "schwab-market-info",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    SCHWAB_APP_KEY_PARAMETER_NAME: "/amplify/schwab/credentials/app-key",
    SCHWAB_APP_SECRET_PARAMETER_NAME: "/amplify/schwab/credentials/app-secret",
    SCHWAB_AUTH_URL: "https://api.schwabapi.com/v1/oauth/authorize",
    SCHWAB_TOKEN_URL: "https://api.schwabapi.com/v1/oauth/token",
    SCHWAB_LEVELONE_EQUITIES_URL: "https://api.schwabapi.com/marketdata/v1/quotes",
    SCHWAB_TOKEN_PARAMETER_NAME: "/amplify/schwab/oauth/tokens",
  },
});
