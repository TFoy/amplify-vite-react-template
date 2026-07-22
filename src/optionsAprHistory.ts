import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";
import type { ChainResult, RequestedOptionType } from "./OptionsAprPage";

const client = generateClient<Schema>();

export type OptionsAprHistoryRecord = {
  id: string;
  ticker: string;
  companyName: string | null;
  underlyingPrice: number | null;
  retrievedAt: string;
  requestedOptionType: RequestedOptionType;
  selectedExpirations: string[];
  favorite: boolean;
};

function describeErrors(errors: readonly { message: string }[] | undefined) {
  return errors?.map((error) => error.message).join("; ") || "DynamoDB operation failed.";
}

function mapHistory(record: Schema["OptionsAprHistory"]["type"]): OptionsAprHistoryRecord {
  return {
    id: record.id,
    ticker: record.ticker,
    companyName: record.companyName ?? null,
    underlyingPrice: record.underlyingPrice ?? null,
    retrievedAt: record.retrievedAt,
    requestedOptionType:
      record.requestedOptionType === "call" || record.requestedOptionType === "put"
        ? record.requestedOptionType
        : "both",
    selectedExpirations: JSON.parse(record.selectedExpirationsJson) as string[],
    favorite: record.favorite,
  };
}

export async function listOptionsAprHistory(ticker: string) {
  const records: Schema["OptionsAprHistory"]["type"][] = [];
  let nextToken: string | null | undefined;
  do {
    const result = await client.models.OptionsAprHistory.list({
      filter: { ticker: { eq: ticker } },
      nextToken,
    });
    if (result.errors) {
      throw new Error(describeErrors(result.errors));
    }
    records.push(...result.data);
    nextToken = result.nextToken;
  } while (nextToken);

  return records.map(mapHistory).sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return left.favorite ? -1 : 1;
    }
    return right.retrievedAt.localeCompare(left.retrievedAt);
  });
}

export async function saveOptionsAprHistory(input: {
  ticker: string;
  companyName: string | null;
  underlyingPrice: number | null;
  retrievedAt: string;
  requestedOptionType: RequestedOptionType;
  selectedExpirations: string[];
  chains: ChainResult[];
}) {
  const historyResult = await client.models.OptionsAprHistory.create({
    ticker: input.ticker,
    companyName: input.companyName,
    underlyingPrice: input.underlyingPrice,
    retrievedAt: input.retrievedAt,
    requestedOptionType: input.requestedOptionType,
    selectedExpirationsJson: JSON.stringify(input.selectedExpirations),
    favorite: false,
  });
  if (!historyResult.data || historyResult.errors) {
    throw new Error(describeErrors(historyResult.errors));
  }

  const history = mapHistory(historyResult.data);
  try {
    for (const chain of input.chains) {
      const chainResult = await client.models.OptionsAprHistoryChain.create({
        historyId: history.id,
        companyName: chain.companyName,
        underlyingPrice: chain.underlyingPrice,
        expirationDate: chain.expirationDate,
        daysToExpiration: chain.daysToExpiration,
        callsJson: JSON.stringify(chain.calls),
        putsJson: JSON.stringify(chain.puts),
      });
      if (!chainResult.data || chainResult.errors) {
        throw new Error(describeErrors(chainResult.errors));
      }
    }
  } catch (error) {
    await deleteOptionsAprHistory(history.id);
    throw error;
  }
  return history;
}

async function listHistoryChains(historyId: string) {
  const records: Schema["OptionsAprHistoryChain"]["type"][] = [];
  let nextToken: string | null | undefined;
  do {
    const result = await client.models.OptionsAprHistoryChain.list({
      filter: { historyId: { eq: historyId } },
      nextToken,
    });
    if (result.errors) {
      throw new Error(describeErrors(result.errors));
    }
    records.push(...result.data);
    nextToken = result.nextToken;
  } while (nextToken);
  return records;
}

export async function loadOptionsAprHistory(record: OptionsAprHistoryRecord) {
  const chainRecords = await listHistoryChains(record.id);
  const chains: ChainResult[] = chainRecords
    .map((chain) => ({
      companyName: chain.companyName ?? null,
      underlyingPrice: chain.underlyingPrice,
      expirationDate: chain.expirationDate,
      daysToExpiration: chain.daysToExpiration,
      calls: JSON.parse(chain.callsJson) as ChainResult["calls"],
      puts: JSON.parse(chain.putsJson) as ChainResult["puts"],
    }))
    .sort((left, right) => left.expirationDate.localeCompare(right.expirationDate));
  return { record, chains };
}

export async function setOptionsAprHistoryFavorite(id: string, favorite: boolean) {
  const result = await client.models.OptionsAprHistory.update({ id, favorite });
  if (!result.data || result.errors) {
    throw new Error(describeErrors(result.errors));
  }
}

export async function deleteOptionsAprHistory(id: string) {
  const chains = await listHistoryChains(id);
  for (const chain of chains) {
    const result = await client.models.OptionsAprHistoryChain.delete({ id: chain.id });
    if (result.errors) {
      throw new Error(describeErrors(result.errors));
    }
  }
  const result = await client.models.OptionsAprHistory.delete({ id });
  if (result.errors) {
    throw new Error(describeErrors(result.errors));
  }
}

export async function deleteAllOptionsAprHistory(ticker: string) {
  const records = await listOptionsAprHistory(ticker);
  for (const record of records) {
    await deleteOptionsAprHistory(record.id);
  }
}
