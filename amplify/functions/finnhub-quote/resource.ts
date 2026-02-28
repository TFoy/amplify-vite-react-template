import { defineFunction } from "@aws-amplify/backend";

export const finnhubQuote = defineFunction({
  name: "finnhub-quote",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    FINNHUB_API_KEY_PARAMETER_NAME: "/amplify/finnhub/credentials/api-key",
    FINNHUB_QUOTE_URL: "https://finnhub.io/api/v1/quote",
  },
});
