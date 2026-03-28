import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getAuthenticatedUserSub } from "../shared/user-auth";

type ApiGatewayEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
};

type EvaluationPoint = {
  symbol: string;
  timestamp: string;
  currentPrice: number;
  buyScore: number;
  sellScore: number;
};

const dynamoClient = new DynamoDBClient();
const ssmClient = new SSMClient();

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function getRequiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

function normalizeLimit(rawLimit: string | undefined) {
  if (!rawLimit) {
    return 250;
  }

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 250;
  }

  return Math.min(Math.trunc(parsed), 1000);
}

function getNumberAttribute(
  item: Record<string, { N?: string; S?: string } | undefined>,
  key: string,
) {
  const value = item[key]?.N;
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStringAttribute(
  item: Record<string, { N?: string; S?: string } | undefined>,
  key: string,
) {
  const value = item[key]?.S;
  return typeof value === "string" ? value : null;
}

function extractTimestamp(sortKey: string) {
  const marker = "EVALUATION#";
  return sortKey.startsWith(marker) ? sortKey.slice(marker.length) : sortKey;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim().toUpperCase() : ""))
    .filter((entry) => entry.length > 0);
}

function parseSymbolsConfig(value: string) {
  try {
    const parsed = JSON.parse(value) as { symbols?: unknown };
    const symbols = asStringArray(parsed.symbols);
    if (symbols.length > 0) {
      return symbols;
    }
  } catch {
    const csvSymbols = value
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0);

    if (csvSymbols.length > 0) {
      return csvSymbols;
    }
  }

  throw new Error("Parameter store app config did not contain a usable 'symbols' list.");
}

async function getParameterValue(name: string) {
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );

  if (!result.Parameter?.Value) {
    throw new Error(`Missing SSM parameter value for: ${name}`);
  }

  return result.Parameter.Value;
}

async function getConfiguredSymbols() {
  const parameterName = getRequiredEnvironment("STOCK_ANALYZER_APP_CONFIG_PARAMETER_NAME");
  const configValue = await getParameterValue(parameterName);
  return parseSymbolsConfig(configValue);
}

async function getEvaluationSeries(symbol: string, limit: number) {
  const tableName = getRequiredEnvironment("STOCK_ANALYZER_EVALUATIONS_TABLE_NAME");
  const normalizedSymbol = symbol.trim().toUpperCase();
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pkValue AND begins_with(#sk, :skPrefix)",
      ExpressionAttributeNames: {
        "#pk": "PK",
        "#sk": "SK",
      },
      ExpressionAttributeValues: {
        ":pkValue": { S: `SYMBOL#${normalizedSymbol}` },
        ":skPrefix": { S: "EVALUATION#" },
      },
      Limit: limit,
      ScanIndexForward: true,
    }),
  );

  const points: EvaluationPoint[] = [];

  for (const item of result.Items ?? []) {
    const typedItem = item as Record<string, { N?: string; S?: string } | undefined>;
    const sortKey = getStringAttribute(typedItem, "SK");
    const currentPrice = getNumberAttribute(typedItem, "CurrentPrice");
    const buyScore = getNumberAttribute(typedItem, "BuyScore");
    const sellScore = getNumberAttribute(typedItem, "SellScore");

    if (!sortKey || currentPrice === null || buyScore === null || sellScore === null) {
      continue;
    }

    points.push({
      symbol: getStringAttribute(typedItem, "Symbol") ?? normalizedSymbol,
      timestamp: extractTimestamp(sortKey),
      currentPrice,
      buyScore,
      sellScore,
    });
  }

  return points;
}

export const handler = async (event: ApiGatewayEvent) => {
  try {
    const path = event.rawPath ?? "";
    const query = event.queryStringParameters ?? {};

    if (path.endsWith("/stock-analyzer/evaluations")) {
      await getAuthenticatedUserSub(event);

      const symbol = query.symbol?.trim();
      if (!symbol) {
        return jsonResponse(400, {
          error: "Query parameter 'symbol' is required.",
        });
      }

      const limit = normalizeLimit(query.limit);
      const points = await getEvaluationSeries(symbol, limit);

      return jsonResponse(200, {
        symbol: symbol.toUpperCase(),
        points,
      });
    }

    if (path.endsWith("/stock-analyzer/symbols")) {
      await getAuthenticatedUserSub(event);

      return jsonResponse(200, {
        symbols: await getConfiguredSymbols(),
      });
    }

    return jsonResponse(404, { error: "Route not found." });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
};
