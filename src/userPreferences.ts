import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

const client = generateClient<Schema>();

type UserPreferenceRecord = Schema["UserPreference"]["type"];

async function findPreference(pageKey: string) {
  const result = await client.models.UserPreference.list({
    filter: {
      pageKey: {
        eq: pageKey,
      },
    },
  });

  return (result.data[0] ?? null) as UserPreferenceRecord | null;
}

export async function loadLastTicker(pageKey: string) {
  const preference = await findPreference(pageKey);
  return preference?.lastTicker ?? "";
}

export async function saveLastTicker(pageKey: string, lastTicker: string) {
  const preference = await findPreference(pageKey);

  if (!preference) {
    await client.models.UserPreference.create({
      pageKey,
      lastTicker,
    });
    return;
  }

  await client.models.UserPreference.update({
    id: preference.id,
    lastTicker,
  });
}
