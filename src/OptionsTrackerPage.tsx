import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

const client = generateClient<Schema>();
const SETTINGS_PAGE_KEY = "options-tracker";
const RECORD_SAVE_DELAY_MS = 500;
const CASH_SAVE_DELAY_MS = 500;

type OptionsRecordInput = {
  id: string;
  ticker: string;
  account: string;
  strikePrice: string;
  optionCount: string;
  expirationDate: string;
  filled: boolean;
  premium: string;
  priceToClose: string;
  exercised: boolean;
  complete: boolean;
  notes: string;
};

type RecordDraft = {
  ticker: string;
  account: string;
  strikePrice: string;
  optionCount: string;
  expirationDate: string;
  filled: boolean;
  premium: string;
  priceToClose: string;
  exercised: boolean;
  complete: boolean;
  notes: string;
};

const EMPTY_DRAFT: RecordDraft = {
  ticker: "",
  account: "",
  strikePrice: "",
  optionCount: "1",
  expirationDate: "",
  filled: false,
  premium: "",
  priceToClose: "",
  exercised: false,
  complete: false,
  notes: "",
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function parseNumber(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return 0;
  }

  const normalized = trimmed.replace(/[$,]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTicker(value: string) {
  return value.trim().toUpperCase();
}

function buildStorageKey(userKey: string) {
  return `options-tracker:${userKey}`;
}

function buildCashKey(userKey: string) {
  return `options-tracker-cash:${userKey}`;
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberToInput(value: string | number | null | undefined, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value);
}

function mapRecordFromModel(
  record: Schema["OptionsTrackerRecord"]["type"],
): OptionsRecordInput {
  return {
    id: record.id,
    ticker: record.ticker ?? "",
    account: record.account ?? "",
    strikePrice: numberToInput(record.strikePrice),
    optionCount: numberToInput(record.optionCount, "1"),
    expirationDate: record.expirationDate ?? "",
    filled: record.filled ?? false,
    premium: numberToInput(record.premium),
    priceToClose: numberToInput(record.priceToClose),
    exercised: record.exercised ?? false,
    complete: record.complete ?? false,
    notes: record.notes ?? "",
  };
}

function normalizeStoredRecord(record: Partial<OptionsRecordInput> & { id: string }) {
  return {
    id: record.id,
    ticker: normalizeTicker(record.ticker ?? ""),
    account: record.account ?? "",
    strikePrice: numberToInput(record.strikePrice),
    optionCount: numberToInput(record.optionCount, "1"),
    expirationDate: record.expirationDate ?? "",
    filled: Boolean(record.filled),
    premium: numberToInput(record.premium),
    priceToClose: numberToInput(record.priceToClose),
    exercised: Boolean(record.exercised),
    complete: Boolean(record.complete),
    notes: record.notes ?? "",
  };
}

function recordSetAside(record: Pick<OptionsRecordInput, "strikePrice" | "optionCount">) {
  return parseNumber(record.strikePrice) * parseNumber(record.optionCount);
}

function sortRecords(records: OptionsRecordInput[]) {
  return [...records].sort((left, right) => {
    const leftDate = left.expirationDate || "9999-12-31";
    const rightDate = right.expirationDate || "9999-12-31";
    return leftDate.localeCompare(rightDate) || left.ticker.localeCompare(right.ticker);
  });
}

function serializeRecordForSave(record: OptionsRecordInput) {
  return {
    ticker: normalizeTicker(record.ticker),
    account: record.account.trim(),
    strikePrice: parseNumber(record.strikePrice),
    optionCount: parseNumber(record.optionCount),
    expirationDate: record.expirationDate,
    filled: record.filled,
    premium: parseNumber(record.premium),
    priceToClose: parseNumber(record.priceToClose),
    exercised: record.exercised,
    complete: record.complete,
    notes: record.notes.trim(),
  };
}

function OptionsTrackerPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const userKey = user?.userId ?? user?.username ?? "guest";
  const isSignedIn = Boolean(user);
  const storageKey = buildStorageKey(userKey);
  const cashKey = buildCashKey(userKey);

  const [records, setRecords] = useState<OptionsRecordInput[]>([]);
  const [cashAvailableInput, setCashAvailableInput] = useState("");
  const [draft, setDraft] = useState<RecordDraft>(EMPTY_DRAFT);
  const [settingId, setSettingId] = useState<string | null>(null);
  const recordSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const cashSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCreatingSetting = useRef(false);

  useEffect(() => {
    if (isSignedIn) {
      return;
    }

    try {
      const savedRecords = window.localStorage.getItem(storageKey);
      const savedCash = window.localStorage.getItem(cashKey);

      if (savedRecords) {
        const parsed = JSON.parse(savedRecords) as Array<Partial<OptionsRecordInput> & { id: string }>;
        setRecords(
          Array.isArray(parsed) ? sortRecords(parsed.map(normalizeStoredRecord)) : [],
        );
      } else {
        setRecords([]);
      }

      setCashAvailableInput(savedCash ?? "");
    } catch {
      setRecords([]);
      setCashAvailableInput("");
    }
  }, [cashKey, isSignedIn, storageKey]);

  useEffect(() => {
    if (!isSignedIn) {
      setSettingId(null);
      return;
    }

    const recordSubscription = client.models.OptionsTrackerRecord.observeQuery().subscribe({
      next: ({ items }) => {
        setRecords(sortRecords(items.map(mapRecordFromModel)));
      },
    });

    const settingSubscription = client.models.OptionsTrackerSetting.observeQuery({
      filter: {
        pageKey: {
          eq: SETTINGS_PAGE_KEY,
        },
      },
    }).subscribe({
      next: ({ items }) => {
        const setting = items[0] ?? null;
        setSettingId(setting?.id ?? null);
        isCreatingSetting.current = false;
        setCashAvailableInput(numberToInput(setting?.cashAvailable));
      },
    });

    return () => {
      recordSubscription.unsubscribe();
      settingSubscription.unsubscribe();
    };
  }, [isSignedIn]);

  useEffect(() => {
    if (isSignedIn) {
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(records));
  }, [isSignedIn, records, storageKey]);

  useEffect(() => {
    if (isSignedIn) {
      return;
    }

    window.localStorage.setItem(cashKey, cashAvailableInput);
  }, [cashAvailableInput, cashKey, isSignedIn]);

  useEffect(() => {
    return () => {
      Object.values(recordSaveTimers.current).forEach((timer) => clearTimeout(timer));
      if (cashSaveTimer.current) {
        clearTimeout(cashSaveTimer.current);
      }
    };
  }, []);

  const cashAvailable = useMemo(
    () => parseNumber(cashAvailableInput),
    [cashAvailableInput],
  );

  const activeRecords = useMemo(
    () => records.filter((record) => !record.complete),
    [records],
  );

  const setAsideTotal = useMemo(
    () => activeRecords.reduce((sum, record) => sum + recordSetAside(record), 0),
    [activeRecords],
  );

  const outstandingPremium = useMemo(
    () => activeRecords.reduce((sum, record) => sum + parseNumber(record.premium), 0),
    [activeRecords],
  );

  const completedPremium = useMemo(
    () =>
      records
        .filter((record) => record.complete)
        .reduce((sum, record) => sum + parseNumber(record.premium), 0),
    [records],
  );

  const cashRemaining = cashAvailable - setAsideTotal;

  const usedTickers = useMemo(() => {
    const tickers = new Set(
      records.map((record) => record.ticker).filter((ticker) => ticker.length > 0),
    );

    return [...tickers].sort((left, right) => left.localeCompare(right));
  }, [records]);

  const tickersWithoutOpenRecords = useMemo(() => {
    const openTickers = new Set(
      records
        .filter((record) => !record.complete)
        .map((record) => record.ticker)
        .filter((ticker) => ticker.length > 0),
    );

    return usedTickers.filter((ticker) => !openTickers.has(ticker));
  }, [records, usedTickers]);

  function updateDraft<K extends keyof RecordDraft>(field: K, value: RecordDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function addRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const ticker = normalizeTicker(draft.ticker);
    if (!ticker) {
      return;
    }

    const newRecord: OptionsRecordInput = {
      id: createId(),
      ticker,
      account: draft.account.trim(),
      strikePrice: draft.strikePrice.trim(),
      optionCount: draft.optionCount.trim(),
      expirationDate: draft.expirationDate,
      filled: draft.filled,
      premium: draft.premium.trim(),
      priceToClose: draft.priceToClose.trim(),
      exercised: draft.exercised,
      complete: draft.complete,
      notes: draft.notes.trim(),
    };

    if (isSignedIn) {
      void client.models.OptionsTrackerRecord.create(serializeRecordForSave(newRecord));
    } else {
      setRecords((current) => sortRecords([...current, newRecord]));
    }

    setDraft(EMPTY_DRAFT);
  }

  function queueRemoteRecordSave(record: OptionsRecordInput) {
    const existingTimer = recordSaveTimers.current[record.id];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    recordSaveTimers.current[record.id] = setTimeout(() => {
      delete recordSaveTimers.current[record.id];
      void client.models.OptionsTrackerRecord.update({
        id: record.id,
        ...serializeRecordForSave(record),
      });
    }, RECORD_SAVE_DELAY_MS);
  }

  function queueRemoteCashSave(value: string) {
    if (cashSaveTimer.current) {
      clearTimeout(cashSaveTimer.current);
    }

    cashSaveTimer.current = setTimeout(() => {
      cashSaveTimer.current = null;
      const payload = {
        pageKey: SETTINGS_PAGE_KEY,
        cashAvailable: parseNumber(value),
      };

      if (settingId) {
        void client.models.OptionsTrackerSetting.update({
          id: settingId,
          ...payload,
        });
        return;
      }

      if (isCreatingSetting.current) {
        return;
      }

      isCreatingSetting.current = true;
      void client.models.OptionsTrackerSetting.create(payload);
    }, CASH_SAVE_DELAY_MS);
  }

  function updateRecord(
    id: string,
    field: keyof OptionsRecordInput,
    value: string | boolean,
  ) {
    setRecords((current) =>
      sortRecords(current.map((record) => {
        if (record.id !== id) {
          return record;
        }

        if (field === "ticker") {
          const nextRecord = { ...record, ticker: normalizeTicker(String(value)) };
          if (isSignedIn) {
            queueRemoteRecordSave(nextRecord);
          }
          return nextRecord;
        }

        if (field === "account" || field === "expirationDate" || field === "notes") {
          const nextRecord = { ...record, [field]: String(value) };
          if (isSignedIn) {
            queueRemoteRecordSave(nextRecord);
          }
          return nextRecord;
        }

        if (
          field === "filled" ||
          field === "exercised" ||
          field === "complete"
        ) {
          const nextRecord = { ...record, [field]: Boolean(value) };
          if (isSignedIn) {
            queueRemoteRecordSave(nextRecord);
          }
          return nextRecord;
        }

        if (
          field === "strikePrice" ||
          field === "optionCount" ||
          field === "premium" ||
          field === "priceToClose"
        ) {
          const nextRecord = { ...record, [field]: String(value) };
          if (isSignedIn) {
            queueRemoteRecordSave(nextRecord);
          }
          return nextRecord;
        }

        return record;
      })),
    );
  }

  function removeRecord(id: string) {
    const pendingSave = recordSaveTimers.current[id];
    if (pendingSave) {
      clearTimeout(pendingSave);
      delete recordSaveTimers.current[id];
    }

    if (isSignedIn) {
      void client.models.OptionsTrackerRecord.delete({ id });
      return;
    }

    setRecords((current) => current.filter((record) => record.id !== id));
  }

  function handleCashAvailableChange(value: string) {
    setCashAvailableInput(value);
    if (isSignedIn) {
      queueRemoteCashSave(value);
    }
  }

  return (
    <main className="options-tracker-page">
      <a href="/">Back to landing page</a>
      <section className="options-tracker-hero">
        <div>
          <p className="options-tracker-kicker">Cash-Secured Puts And Covered Calls</p>
          <h1>Options Tracker</h1>
          <p className="options-tracker-intro">
            Track open and completed contracts, cash reserved for trades, and
            premium totals in one place.
          </p>
        </div>
        <label className="options-tracker-cash-card">
          <span>Total cash available</span>
          <input
            inputMode="decimal"
            onChange={(event) => handleCashAvailableChange(event.target.value)}
            placeholder="0.00"
            type="text"
            value={cashAvailableInput}
          />
        </label>
      </section>

      <section className="options-tracker-summary-grid">
        <article className="options-tracker-summary-card">
          <span>Cash available</span>
          <strong>{formatCurrency(cashAvailable)}</strong>
        </article>
        <article className="options-tracker-summary-card">
          <span>Set aside</span>
          <strong>{formatCurrency(setAsideTotal)}</strong>
        </article>
        <article className="options-tracker-summary-card">
          <span>Cash remaining for trade</span>
          <strong>{formatCurrency(cashRemaining)}</strong>
        </article>
        <article className="options-tracker-summary-card">
          <span>Outstanding premium</span>
          <strong>{formatCurrency(outstandingPremium)}</strong>
        </article>
        <article className="options-tracker-summary-card">
          <span>Completed premium</span>
          <strong>{formatCurrency(completedPremium)}</strong>
        </article>
        <article className="options-tracker-summary-card">
          <span>Active records</span>
          <strong>{activeRecords.length}</strong>
        </article>
      </section>

      <section className="options-tracker-layout">
        <article className="options-tracker-panel">
          <h2>Add position</h2>
          <form className="options-tracker-form" onSubmit={addRecord}>
            <input
              onChange={(event) => updateDraft("ticker", event.target.value)}
              placeholder="Ticker"
              type="text"
              value={draft.ticker}
            />
            <input
              onChange={(event) => updateDraft("account", event.target.value)}
              placeholder="Account"
              type="text"
              value={draft.account}
            />
            <input
              inputMode="decimal"
              onChange={(event) => updateDraft("strikePrice", event.target.value)}
              placeholder="Strike price"
              type="text"
              value={draft.strikePrice}
            />
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft("optionCount", event.target.value)}
              placeholder="Number of options"
              type="text"
              value={draft.optionCount}
            />
            <input
              onChange={(event) => updateDraft("expirationDate", event.target.value)}
              type="date"
              value={draft.expirationDate}
            />
            <input
              inputMode="decimal"
              onChange={(event) => updateDraft("premium", event.target.value)}
              placeholder="Premium"
              type="text"
              value={draft.premium}
            />
            <input
              inputMode="decimal"
              onChange={(event) => updateDraft("priceToClose", event.target.value)}
              placeholder="Price to close"
              type="text"
              value={draft.priceToClose}
            />
            <input
              className="options-tracker-notes-input"
              onChange={(event) => updateDraft("notes", event.target.value)}
              placeholder="Notes"
              type="text"
              value={draft.notes}
            />
            <label>
              <input
                checked={draft.filled}
                onChange={(event) => updateDraft("filled", event.target.checked)}
                type="checkbox"
              />
              Filled
            </label>
            <label>
              <input
                checked={draft.exercised}
                onChange={(event) => updateDraft("exercised", event.target.checked)}
                type="checkbox"
              />
              Exercised
            </label>
            <label>
              <input
                checked={draft.complete}
                onChange={(event) => updateDraft("complete", event.target.checked)}
                type="checkbox"
              />
              Complete
            </label>
            <button type="submit">Add record</button>
          </form>
        </article>

        <article className="options-tracker-panel">
          <h2>Tickers</h2>
          <div className="options-tracker-pill-group">
            <p>Previously used symbols</p>
            <div className="options-tracker-pills">
              {usedTickers.length > 0 ? (
                usedTickers.map((ticker) => (
                  <span className="options-tracker-pill" key={ticker}>
                    {ticker}
                  </span>
                ))
              ) : (
                <span className="options-tracker-empty">No tickers yet.</span>
              )}
            </div>
          </div>
          <div className="options-tracker-pill-group">
            <p>No open records</p>
            <div className="options-tracker-pills">
              {tickersWithoutOpenRecords.length > 0 ? (
                tickersWithoutOpenRecords.map((ticker) => (
                  <span className="options-tracker-pill options-tracker-pill-muted" key={ticker}>
                    {ticker}
                  </span>
                ))
              ) : (
                <span className="options-tracker-empty">
                  Every used ticker currently has an open record.
                </span>
              )}
            </div>
          </div>
        </article>
      </section>

      <section className="options-tracker-panel">
        <h2>Positions</h2>
        <div className="options-tracker-table-wrap">
          <table className="options-tracker-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Account</th>
                <th>Strike</th>
                <th>Options</th>
                <th>Expiration</th>
                <th>Filled</th>
                <th>Premium</th>
                <th>Price to close</th>
                <th>Exercised</th>
                <th>Complete</th>
                <th>Set aside</th>
                <th>Notes</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {records.length > 0 ? (
                records.map((record) => (
                  <tr className={record.complete ? "is-complete" : ""} key={record.id}>
                    <td>
                      <input
                        onChange={(event) =>
                          updateRecord(record.id, "ticker", event.target.value)
                        }
                        type="text"
                        value={record.ticker}
                      />
                    </td>
                    <td>
                      <input
                        onChange={(event) =>
                          updateRecord(record.id, "account", event.target.value)
                        }
                        type="text"
                        value={record.account}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        onChange={(event) =>
                          updateRecord(record.id, "strikePrice", event.target.value)
                        }
                        type="text"
                        value={record.strikePrice}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="numeric"
                        onChange={(event) =>
                          updateRecord(record.id, "optionCount", event.target.value)
                        }
                        type="text"
                        value={record.optionCount}
                      />
                    </td>
                    <td>
                      <input
                        onChange={(event) =>
                          updateRecord(record.id, "expirationDate", event.target.value)
                        }
                        type="date"
                        value={record.expirationDate}
                      />
                    </td>
                    <td>
                      <input
                        checked={record.filled}
                        onChange={(event) =>
                          updateRecord(record.id, "filled", event.target.checked)
                        }
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        onChange={(event) =>
                          updateRecord(record.id, "premium", event.target.value)
                        }
                        type="text"
                        value={record.premium}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        onChange={(event) =>
                          updateRecord(record.id, "priceToClose", event.target.value)
                        }
                        type="text"
                        value={record.priceToClose}
                      />
                    </td>
                    <td>
                      <input
                        checked={record.exercised}
                        onChange={(event) =>
                          updateRecord(record.id, "exercised", event.target.checked)
                        }
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <input
                        checked={record.complete}
                        onChange={(event) =>
                          updateRecord(record.id, "complete", event.target.checked)
                        }
                        type="checkbox"
                      />
                    </td>
                    <td>{formatCurrency(recordSetAside(record))}</td>
                    <td>
                      <input
                        onChange={(event) =>
                          updateRecord(record.id, "notes", event.target.value)
                        }
                        type="text"
                        value={record.notes}
                      />
                    </td>
                    <td>
                      <button
                        className="options-tracker-delete"
                        onClick={() => removeRecord(record.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="options-tracker-empty-row" colSpan={13}>
                    No positions yet. Add your first ticker above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export default OptionsTrackerPage;
