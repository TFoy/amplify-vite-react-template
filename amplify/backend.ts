import { defineBackend } from "@aws-amplify/backend";
import { CfnOutput } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { finnhubQuote } from "./functions/finnhub-quote/resource";
import { schwabMarketInfo } from "./functions/schwab-market-info/resource";
import { tastyMarketInfo } from "./functions/tasty-market-info/resource";
import { tastyRestMarketInfo } from "./functions/tasty-rest-market-info/resource";

const backend = defineBackend({
  auth,
  data,
  finnhubQuote,
  schwabMarketInfo,
  tastyMarketInfo,
  tastyRestMarketInfo,
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
const tastyRestIntegration = new HttpLambdaIntegration(
  "TastyRestMarketInfoIntegration",
  backend.tastyRestMarketInfo.resources.lambda,
);
const finnhubIntegration = new HttpLambdaIntegration(
  "FinnhubQuoteIntegration",
  backend.finnhubQuote.resources.lambda,
);

schwabHttpApi.addRoutes({
  path: "/schwab/authorize-url",
  methods: [HttpMethod.GET],
  integration: schwabIntegration,
});

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
  path: "/schwab/status",
  methods: [HttpMethod.GET],
  integration: schwabIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty/authorize-url",
  methods: [HttpMethod.GET],
  integration: tastyIntegration,
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

schwabHttpApi.addRoutes({
  path: "/tasty-rest/status",
  methods: [HttpMethod.GET],
  integration: tastyRestIntegration,
});

schwabHttpApi.addRoutes({
  path: "/tasty-rest/market-info",
  methods: [HttpMethod.GET],
  integration: tastyRestIntegration,
});

schwabHttpApi.addRoutes({
  path: "/finnhub/status",
  methods: [HttpMethod.GET],
  integration: finnhubIntegration,
});

schwabHttpApi.addRoutes({
  path: "/finnhub/quote",
  methods: [HttpMethod.GET],
  integration: finnhubIntegration,
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
backend.tastyRestMarketInfo.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      schwabApiStack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: "amplify/tasty/*",
      }),
    ],
  }),
);
backend.finnhubQuote.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      schwabApiStack.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: "amplify/finnhub/*",
      }),
    ],
  }),
);

const userPoolId = backend.auth.resources.userPool.userPoolId;
const userPoolClientId = backend.auth.resources.userPoolClient.userPoolClientId;

backend.schwabMarketInfo.addEnvironment("COGNITO_USER_POOL_ID", userPoolId);
backend.schwabMarketInfo.addEnvironment("COGNITO_USER_POOL_CLIENT_ID", userPoolClientId);
backend.tastyMarketInfo.addEnvironment("COGNITO_USER_POOL_ID", userPoolId);
backend.tastyMarketInfo.addEnvironment("COGNITO_USER_POOL_CLIENT_ID", userPoolClientId);
backend.tastyRestMarketInfo.addEnvironment("COGNITO_USER_POOL_ID", userPoolId);
backend.tastyRestMarketInfo.addEnvironment("COGNITO_USER_POOL_CLIENT_ID", userPoolClientId);
backend.finnhubQuote.addEnvironment("COGNITO_USER_POOL_ID", userPoolId);
backend.finnhubQuote.addEnvironment("COGNITO_USER_POOL_CLIENT_ID", userPoolClientId);

backend.addOutput({
  custom: {
    schwab: {
      api_url: apiBaseUrl,
      callback_url: callbackUrl,
      authorize_url_json: `${apiBaseUrl}schwab/authorize-url`,
      authorize_url: `${apiBaseUrl}schwab/authorize`,
      market_info_url: `${apiBaseUrl}schwab/market-info`,
      status_url: `${apiBaseUrl}schwab/status`,
    },
    tasty: {
      api_url: apiBaseUrl,
      callback_url: tastyCallbackUrl,
      authorize_url_json: `${apiBaseUrl}tasty/authorize-url`,
      authorize_url: `${apiBaseUrl}tasty/authorize`,
      market_info_url: `${apiBaseUrl}tasty/market-info`,
      status_url: `${apiBaseUrl}tasty/status`,
      debug_url: `${apiBaseUrl}tasty/debug`,
    },
    tasty_rest: {
      api_url: apiBaseUrl,
      status_url: `${apiBaseUrl}tasty-rest/status`,
      market_info_url: `${apiBaseUrl}tasty-rest/market-info`,
    },
    finnhub: {
      api_url: apiBaseUrl,
      status_url: `${apiBaseUrl}finnhub/status`,
      quote_url: `${apiBaseUrl}finnhub/quote`,
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
