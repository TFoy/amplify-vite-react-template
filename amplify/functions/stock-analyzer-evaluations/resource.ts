import { defineFunction } from "@aws-amplify/backend";

export const stockAnalyzerEvaluations = defineFunction({
  name: "stock-analyzer-evaluations",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    STOCK_ANALYZER_EVALUATIONS_TABLE_NAME: "stock-analyzer-evaluations",
    STOCK_ANALYZER_APP_CONFIG_PARAMETER_NAME: "/stock-analyzer/app-config",
  },
});
