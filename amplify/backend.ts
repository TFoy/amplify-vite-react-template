import { defineBackend } from "@aws-amplify/backend";
import { CfnOutput } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { schwabMarketInfo } from "./functions/schwab-market-info/resource";
import { tastyMarketInfo } from "./functions/tasty-market-info/resource";

const backend = defineBackend({
  auth,
  data,
  schwabMarketInfo,
  tastyMarketInfo,
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
const tastyIntegration = new HttpLambdaIntegration(
  "TastyMarketInfoIntegration",
  backend.tastyMarketInfo.resources.lambda,
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

schwabHttpApi.addRoutes({
  path: "/tasty/authorize",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty/callback",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty/market-info",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty/status",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty/debug",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
});

const apiBaseUrl = schwabHttpApi.url ?? "";
const callbackUrl = `${apiBaseUrl}schwab/callback`;
const tastyCallbackUrl = `${apiBaseUrl}tasty/callback`;

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
backend.tastyMarketInfo.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter", "ssm:PutParameter"],
    resources: [
      schwabApiStack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: "amplify/tasty/*",
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
    tasty: {
      api_url: apiBaseUrl,
      callback_url: tastyCallbackUrl,
      authorize_url: `${apiBaseUrl}tasty/authorize`,
      market_info_url: `${apiBaseUrl}tasty/market-info`,
      status_url: `${apiBaseUrl}tasty/status`,
      debug_url: `${apiBaseUrl}tasty/debug`,
    },
  },
});

new CfnOutput(schwabApiStack, "SchwabApiUrl", {
  value: apiBaseUrl,
});

new CfnOutput(schwabApiStack, "SchwabCallbackUrl", {
  value: callbackUrl,
});

new CfnOutput(schwabApiStack, "TastyCallbackUrl", {
  value: tastyCallbackUrl,
});
