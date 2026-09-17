import { generateClient } from "aws-amplify/data";
import { getCurrentUser } from "aws-amplify/auth";
import { parseScreenerSettings, type ScreenerSettings } from "./optionsScreenerSettings";
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

  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
  return (result.data[0] ?? null) as UserPreferenceRecord | null;
}

export async function loadLastTicker(pageKey: string) {
  const preference = await findPreference(pageKey);
  return preference?.lastTicker ?? "";
}

export async function loadOptionsScreenerSettings() {
  const preference = await findPreference("options-screener");
  return parseScreenerSettings(preference?.optionsScreenerSettingsJson);
}

// Serialize edits so a slow earlier save cannot overwrite the newest setting.
let screenerSaveQueue: Promise<void> = Promise.resolve();
export function saveOptionsScreenerSettings(settings: ScreenerSettings, userId: string) {
  const json = JSON.stringify(parseScreenerSettings(JSON.stringify(settings)));
  const save = async () => {
    const checkUser = async () => {
      if ((await getCurrentUser()).userId !== userId) throw new Error("The signed-in user changed. Settings were not saved.");
    };
    await checkUser();
    const preference = await findPreference("options-screener");
    await checkUser();
    const result = preference
      ? await client.models.UserPreference.update({ id: preference.id, optionsScreenerSettingsJson: json })
      : await client.models.UserPreference.create({ pageKey: "options-screener", optionsScreenerSettingsJson: json });
    if (result.errors?.length || !result.data) throw new Error(result.errors?.map((error) => error.message).join("; ") || "Unable to save screener settings.");
  };
  const pending = screenerSaveQueue.then(save, save);
  screenerSaveQueue = pending.catch(() => {});
  return pending;
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

export async function loadOptionsAprThresholds(pageKey: string) {
  const preference = await findPreference(pageKey);
  return {
    minimumSimpleApr: preference?.optionsAprMinimumSimpleApr ?? "25",
    minimumProbability: preference?.optionsAprMinimumProbability ?? "90",
    excludeOutliers: preference?.optionsAprExcludeOutliers ?? false,
    callAprBasis:
      preference?.optionsAprCallAprBasis === "strikePrice"
        ? ("strikePrice" as const)
        : ("currentPrice" as const),
  };
}

export async function saveOptionsAprThresholds(
  pageKey: string,
  minimumSimpleApr: string,
  minimumProbability: string,
  callAprBasis: "currentPrice" | "strikePrice",
  excludeOutliers: boolean,
) {
  const preference = await findPreference(pageKey);
  if (!preference) {
    await client.models.UserPreference.create({
      pageKey,
      optionsAprMinimumSimpleApr: minimumSimpleApr,
      optionsAprMinimumProbability: minimumProbability,
      optionsAprCallAprBasis: callAprBasis,
      optionsAprExcludeOutliers: excludeOutliers,
    });
    return;
  }

  await client.models.UserPreference.update({
    id: preference.id,
    optionsAprMinimumSimpleApr: minimumSimpleApr,
    optionsAprMinimumProbability: minimumProbability,
    optionsAprCallAprBasis: callAprBasis,
    optionsAprExcludeOutliers: excludeOutliers,
  });
}
