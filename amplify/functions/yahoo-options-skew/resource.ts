import { defineFunction } from "@aws-amplify/backend";

export const yahooOptionsSkew = defineFunction({
  name: "yahoo-options-skew",
  entry: "./handler.ts",
  timeoutSeconds: 30,
});
