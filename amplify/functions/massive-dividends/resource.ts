import { defineFunction } from "@aws-amplify/backend";

export const massiveDividends = defineFunction({
  name: "massive-dividends",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    MASSIVE_API_KEY_PARAMETER_NAME: "/amplify/massive/credentials/api-key",
    MASSIVE_DIVIDENDS_URL: "https://api.massive.com/stocks/v1/dividends",
  },
});
