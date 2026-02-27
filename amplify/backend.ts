import { defineBackend } from "@aws-amplify/backend";
import { CfnOutput } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { schwabMarketInfo } from "./functions/schwab-market-info/resource";

const backend = defineBackend({
  auth,
  data,
  schwabMarketInfo,
});

const schwabApiStack = backend.createStack("schwab-api");

const schwabHttpApi = new HttpApi(schwabApiStack, "SchwabHttpApi", {
  corsPreflight: {
    allowOrigins: ["*"],
    allowHeaders: ["*"],
    allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.OPTIONS],
  },
});

const schwabIntegration = new HttpLambdaIntegration(
  "SchwabMarketInfoIntegration",
  backend.schwabMarketInfo.resources.lambda,
);

schwabHttpApi.addRoutes({
  path: "/schwab/authorize",
  methods: [HttpMethod.GET],
  integration: schwabIntegration,
});

schwabHttpApi.addRoutes({
  path: "/schwab/callback",
  methods: [HttpMethod.GET],
  integration: schwabIntegration,
});

schwabHttpApi.addRoutes({
  path: "/schwab/market-info",
  methods: [HttpMethod.GET],
  integration: schwabIntegration,
});

const apiBaseUrl = schwabHttpApi.url ?? "";
const callbackUrl = `${apiBaseUrl}schwab/callback`;

backend.schwabMarketInfo.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter", "ssm:PutParameter"],
    resources: [
      schwabApiStack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: "amplify/schwab/*",
      }),
    ],
  }),
);

backend.addOutput({
  custom: {
    schwab: {
      api_url: apiBaseUrl,
      callback_url: callbackUrl,
      authorize_url: `${apiBaseUrl}schwab/authorize`,
      market_info_url: `${apiBaseUrl}schwab/market-info`,
    },
  },
});

new CfnOutput(schwabApiStack, "SchwabApiUrl", {
  value: apiBaseUrl,
});

new CfnOutput(schwabApiStack, "SchwabCallbackUrl", {
  value: callbackUrl,
});
