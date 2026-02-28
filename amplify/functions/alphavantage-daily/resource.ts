import { defineFunction } from "@aws-amplify/backend";

export const alphaVantageDaily = defineFunction({
  name: "alphavantage-daily",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    ALPHAVANTAGE_API_KEY_PARAMETER_NAME: "/amplify/alphavantage/credentials/api-key",
    ALPHAVANTAGE_DAILY_URL: "https://www.alphavantage.co/query",
  },
});
