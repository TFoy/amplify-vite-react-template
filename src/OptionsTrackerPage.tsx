import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

const client = generateClient<Schema>();
const SETTINGS_PAGE_KEY = "options-tracker";
const RECORD_SAVE_DELAY_MS = 500;
const CASH_SAVE_DELAY_MS = 500;
const COLUMN_WIDTHS_STORAGE_SUFFIX = "column-widths";

const COLUMN_KEYS = [
  "ticker",
  "account",
  "type",
  "strike",
  "options",
  "expiration",
  "filled",
  "premium",
  "priceToClose",
  "exercised",
  "complete",
  "setAside",
  "notes",
  "action",
] as const;

type ColumnKey = (typeof COLUMN_KEYS)[number];

type ColumnWidths = Record<ColumnKey, number>;

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  ticker: 120,
  account: 150,
  type: 96,
  strike: 110,
  options: 110,
  expiration: 140,
  filled: 96,
  premium: 110,
  priceToClose: 130,
  exercised: 110,
  complete: 110,
  setAside: 130,
  notes: 320,
  action: 110,
};

type OptionsRecordInput = {
  id: string;
  ticker: string;
  account: string;
  type: string;
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
  type: string;
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

type SortField = "ticker" | "expirationDate" | "filled" | "exercised" | "complete";

type SortCriterion = {
  field: SortField;
  direction: "asc" | "desc";
};

type RecordFilters = {
  ticker: string;
  type: string;
  account: string;
  expirationFrom: string;
  expirationTo: string;
  exercised: string;
  complete: string;
};

type ResizeState = {
  column: ColumnKey;
  startX: number;
  startWidth: number;
} | null;

const EMPTY_DRAFT: RecordDraft = {
  ticker: "",
  account: "",
  type: "PUT",
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

const EMPTY_FILTERS: RecordFilters = {
  ticker: "",
  type: "",
  account: "",
  expirationFrom: "",
  expirationTo: "",
  exercised: "",
  complete: "",
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

function buildColumnWidthsKey(userKey: string) {
  return `options-tracker:${userKey}:${COLUMN_WIDTHS_STORAGE_SUFFIX}`;
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

function normalizeColumnWidths(value: unknown): ColumnWidths {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }

  const candidate = value as Partial<Record<ColumnKey, unknown>>;
  const normalized = { ...DEFAULT_COLUMN_WIDTHS };

  for (const key of COLUMN_KEYS) {
    const width = candidate[key];
    if (typeof width === "number" && Number.isFinite(width) && width >= 72) {
      normalized[key] = width;
    }
  }

  return normalized;
}

function uniqueSortedValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function mapRecordFromModel(
  record: Schema["OptionsTrackerRecord"]["type"],
): OptionsRecordInput {
  return {
    id: record.id,
    ticker: record.ticker ?? "",
    account: record.account ?? "",
    type: record.type ?? "PUT",
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
    type: record.type ?? "PUT",
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
  return parseNumber(record.strikePrice) * parseNumber(record.optionCount) * 100;
}

function compareBooleans(left: boolean, right: boolean) {
  if (left === right) {
    return 0;
  }

  return left ? 1 : -1;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
}

function compareRecordsByField(
  left: OptionsRecordInput,
  right: OptionsRecordInput,
  field: SortField,
) {
  if (field === "ticker") {
    return compareStrings(left.ticker, right.ticker);
  }

  if (field === "expirationDate") {
    return compareStrings(left.expirationDate || "9999-12-31", right.expirationDate || "9999-12-31");
  }

  if (field === "filled") {
    return compareBooleans(left.filled, right.filled);
  }

  if (field === "exercised") {
    return compareBooleans(left.exercised, right.exercised);
  }

  return compareBooleans(left.complete, right.complete);
}

function sortRecords(
  records: OptionsRecordInput[],
  sortCriteria: SortCriterion[] = [{ field: "expirationDate", direction: "asc" }],
) {
  return [...records].sort((left, right) => {
    for (const criterion of sortCriteria) {
      const comparison = compareRecordsByField(left, right, criterion.field);
      if (comparison !== 0) {
        return criterion.direction === "asc" ? comparison : -comparison;
      }
    }

    return 0;
  });
}

function serializeRecordForSave(record: OptionsRecordInput) {
  return {
    ticker: normalizeTicker(record.ticker),
    account: record.account.trim(),
    type: record.type,
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
  const columnWidthsKey = buildColumnWidthsKey(userKey);

  const [records, setRecords] = useState<OptionsRecordInput[]>([]);
  const [cashAvailableInput, setCashAvailableInput] = useState("");
  const [draft, setDraft] = useState<RecordDraft>(EMPTY_DRAFT);
  const [filters, setFilters] = useState<RecordFilters>(EMPTY_FILTERS);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_COLUMN_WIDTHS);
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([
    { field: "expirationDate", direction: "asc" },
  ]);
  const [resizeState, setResizeState] = useState<ResizeState>(null);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const recordSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const cashSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const columnWidthsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCreatingSetting = useRef(false);

  useEffect(() => {
    if (isSignedIn) {
      return;
    }

    try {
      const savedRecords = window.localStorage.getItem(storageKey);
      const savedCash = window.localStorage.getItem(cashKey);
      const savedColumnWidths = window.localStorage.getItem(columnWidthsKey);

      if (savedRecords) {
        const parsed = JSON.parse(savedRecords) as Array<Partial<OptionsRecordInput> & { id: string }>;
        setRecords(
          Array.isArray(parsed) ? parsed.map(normalizeStoredRecord) : [],
        );
      } else {
        setRecords([]);
      }

      setCashAvailableInput(savedCash ?? "");
      setColumnWidths(
        savedColumnWidths
          ? normalizeColumnWidths(JSON.parse(savedColumnWidths))
          : { ...DEFAULT_COLUMN_WIDTHS },
      );
    } catch {
      setRecords([]);
      setCashAvailableInput("");
      setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
    }
  }, [cashKey, columnWidthsKey, isSignedIn, storageKey]);

  useEffect(() => {
    if (!isSignedIn) {
      setSettingId(null);
      return;
    }

    const recordSubscription = client.models.OptionsTrackerRecord.observeQuery().subscribe({
      next: ({ items }) => {
        setRecords(items.map(mapRecordFromModel));
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
        setColumnWidths(normalizeColumnWidths(setting?.columnWidths ? JSON.parse(setting.columnWidths) : null));
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
    if (isSignedIn) {
      return;
    }

    window.localStorage.setItem(columnWidthsKey, JSON.stringify(columnWidths));
  }, [columnWidths, columnWidthsKey, isSignedIn]);

  useEffect(() => {
    return () => {
      Object.values(recordSaveTimers.current).forEach((timer) => clearTimeout(timer));
      if (cashSaveTimer.current) {
        clearTimeout(cashSaveTimer.current);
      }
      if (columnWidthsSaveTimer.current) {
        clearTimeout(columnWidthsSaveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!resizeState) {
      return;
    }

    const activeResize = resizeState;

    function onPointerMove(event: PointerEvent) {
      const delta = event.clientX - activeResize.startX;
      const nextWidth = Math.max(72, Math.round(activeResize.startWidth + delta));
      setColumnWidths((current) => ({
        ...current,
        [activeResize.column]: nextWidth,
      }));
    }

    function onPointerUp() {
      if (isSignedIn) {
        queueRemoteColumnWidthsSave(columnWidths);
      }
      setResizeState(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [columnWidths, isSignedIn, resizeState]);

  const cashAvailable = useMemo(
    () => parseNumber(cashAvailableInput),
    [cashAvailableInput],
  );

  const activeRecords = useMemo(
    () => records.filter((record) => !record.complete),
    [records],
  );

  const filteredRecords = useMemo(() => {
    const tickerFilter = normalizeTicker(filters.ticker);
    const accountFilter = filters.account.trim().toLowerCase();

    return records.filter((record) => {
      if (tickerFilter && !record.ticker.includes(tickerFilter)) {
        return false;
      }

      if (filters.type && record.type !== filters.type) {
        return false;
      }

      if (accountFilter && !record.account.toLowerCase().includes(accountFilter)) {
        return false;
      }

      if (filters.expirationFrom && record.expirationDate && record.expirationDate < filters.expirationFrom) {
        return false;
      }

      if (filters.expirationTo && record.expirationDate && record.expirationDate > filters.expirationTo) {
        return false;
      }

      if (filters.expirationFrom && !record.expirationDate) {
        return false;
      }

      if (filters.complete) {
        const expected = filters.complete === "yes";
        if (record.complete !== expected) {
          return false;
        }
      }

      if (filters.exercised) {
        const expected = filters.exercised === "yes";
        if (record.exercised !== expected) {
          return false;
        }
      }

      return true;
    });
  }, [filters, records]);

  const sortedRecords = useMemo(
    () => sortRecords(filteredRecords, sortCriteria),
    [filteredRecords, sortCriteria],
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

  const usedAccounts = useMemo(
    () => uniqueSortedValues(records.map((record) => record.account)),
    [records],
  );

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

  function updateFilter<K extends keyof RecordFilters>(
    field: K,
    value: RecordFilters[K],
  ) {
    setFilters((current) => ({ ...current, [field]: value }));
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
      type: draft.type,
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
      setRecords((current) => [...current, newRecord]);
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
        columnWidths: JSON.stringify(columnWidths),
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

  function queueRemoteColumnWidthsSave(nextColumnWidths: ColumnWidths) {
    if (columnWidthsSaveTimer.current) {
      clearTimeout(columnWidthsSaveTimer.current);
    }

    columnWidthsSaveTimer.current = setTimeout(() => {
      columnWidthsSaveTimer.current = null;
      const payload = {
        pageKey: SETTINGS_PAGE_KEY,
        cashAvailable: parseNumber(cashAvailableInput),
        columnWidths: JSON.stringify(nextColumnWidths),
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

        if (
          field === "account" ||
          field === "type" ||
          field === "expirationDate" ||
          field === "notes"
        ) {
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

  function fillDraftTicker(ticker: string) {
    setDraft((current) => ({ ...current, ticker }));
  }

  function handleSort(field: SortField) {
    setSortCriteria((current) => {
      const existing = current.find((criterion) => criterion.field === field);
      if (!existing) {
        return [{ field, direction: "asc" }, ...current];
      }

      const nextDirection = existing.direction === "asc" ? "desc" : "asc";
      return [
        { field, direction: nextDirection },
        ...current.filter((criterion) => criterion.field !== field),
      ];
    });
  }

  function getSortIndicator(field: SortField) {
    const criterion = sortCriteria.find((entry) => entry.field === field);
    if (!criterion) {
      return "";
    }

    return criterion.direction === "asc" ? " ↑" : " ↓";
  }

  function handleCashAvailableChange(value: string) {
    setCashAvailableInput(value);
    if (isSignedIn) {
      queueRemoteCashSave(value);
    }
  }

  function beginColumnResize(
    event: React.PointerEvent<HTMLSpanElement>,
    column: ColumnKey,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setResizeState({
      column,
      startX: event.clientX,
      startWidth: columnWidths[column],
    });
  }

  function renderResizableHeader(
    column: ColumnKey,
    label: string,
    sortField?: SortField,
  ) {
    return (
      <th className={column === "ticker" ? "options-tracker-sticky-column" : undefined}>
        {sortField ? (
          <button
            className="options-tracker-sort-button"
            onClick={() => handleSort(sortField)}
            type="button"
          >
            {label}
            {getSortIndicator(sortField)}
          </button>
        ) : (
          <span className="options-tracker-header-label">{label}</span>
        )}
        <span
          className="options-tracker-resize-handle"
          onPointerDown={(event) => beginColumnResize(event, column)}
          role="separator"
        />
      </th>
    );
  }

  function renderTableHeader() {
    return (
      <tr>
        {renderResizableHeader("ticker", "Ticker", "ticker")}
        {renderResizableHeader("account", "Account")}
        {renderResizableHeader("type", "Type")}
        {renderResizableHeader("strike", "Strike")}
        {renderResizableHeader("options", "Options")}
        {renderResizableHeader("expiration", "Expiration", "expirationDate")}
        {renderResizableHeader("filled", "Filled", "filled")}
        {renderResizableHeader("premium", "Premium")}
        {renderResizableHeader("priceToClose", "Price to close")}
        {renderResizableHeader("exercised", "Exercised", "exercised")}
        {renderResizableHeader("complete", "Complete", "complete")}
        {renderResizableHeader("setAside", "Set aside")}
        {renderResizableHeader("notes", "Notes")}
        {renderResizableHeader("action", "Action")}
      </tr>
    );
  }

  function renderColumnGroup() {
    return (
      <colgroup>
        <col style={{ width: columnWidths.ticker }} />
        <col style={{ width: columnWidths.account }} />
        <col style={{ width: columnWidths.type }} />
        <col style={{ width: columnWidths.strike }} />
        <col style={{ width: columnWidths.options }} />
        <col style={{ width: columnWidths.expiration }} />
        <col style={{ width: columnWidths.filled }} />
        <col style={{ width: columnWidths.premium }} />
        <col style={{ width: columnWidths.priceToClose }} />
        <col style={{ width: columnWidths.exercised }} />
        <col style={{ width: columnWidths.complete }} />
        <col style={{ width: columnWidths.setAside }} />
        <col style={{ width: columnWidths.notes }} />
        <col style={{ width: columnWidths.action }} />
      </colgroup>
    );
  }

  function handleBodyScroll(event: React.UIEvent<HTMLDivElement>) {
    if (headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
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
              list="options-tracker-account-options"
              onChange={(event) => updateDraft("account", event.target.value)}
              placeholder="Account"
              type="text"
              value={draft.account}
            />
            <datalist id="options-tracker-account-options">
              {usedAccounts.map((account) => (
                <option key={account} value={account} />
              ))}
            </datalist>
            <select
              onChange={(event) => updateDraft("type", event.target.value)}
              value={draft.type}
            >
              <option value="PUT">PUT</option>
              <option value="CALL">CALL</option>
            </select>
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
                  <button
                    className="options-tracker-pill options-tracker-pill-button options-tracker-pill-muted"
                    key={ticker}
                    onClick={() => fillDraftTicker(ticker)}
                    type="button"
                  >
                    {ticker}
                  </button>
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
        <div className="options-tracker-filters">
          <input
            onChange={(event) => updateFilter("ticker", event.target.value)}
            placeholder="Filter ticker"
            type="text"
            value={filters.ticker}
          />
          <select
            onChange={(event) => updateFilter("type", event.target.value)}
            value={filters.type}
          >
            <option value="">All types</option>
            <option value="PUT">PUT</option>
            <option value="CALL">CALL</option>
          </select>
          <input
            list="options-tracker-filter-account-options"
            onChange={(event) => updateFilter("account", event.target.value)}
            placeholder="Filter account"
            type="text"
            value={filters.account}
          />
          <datalist id="options-tracker-filter-account-options">
            {usedAccounts.map((account) => (
              <option key={account} value={account} />
            ))}
          </datalist>
          <input
            onChange={(event) => updateFilter("expirationFrom", event.target.value)}
            type="date"
            value={filters.expirationFrom}
          />
          <input
            onChange={(event) => updateFilter("expirationTo", event.target.value)}
            type="date"
            value={filters.expirationTo}
          />
          <select
            onChange={(event) => updateFilter("exercised", event.target.value)}
            value={filters.exercised}
          >
            <option value="">All exercised</option>
            <option value="yes">Exercised</option>
            <option value="no">Not exercised</option>
          </select>
          <select
            onChange={(event) => updateFilter("complete", event.target.value)}
            value={filters.complete}
          >
            <option value="">All complete states</option>
            <option value="yes">Complete</option>
            <option value="no">Not complete</option>
          </select>
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            type="button"
          >
            Clear filters
          </button>
        </div>
        <div className="options-tracker-table-header-wrap" ref={headerScrollRef}>
          <table className="options-tracker-table">
            {renderColumnGroup()}
            <thead>
              {renderTableHeader()}
            </thead>
          </table>
        </div>
        <div
          className="options-tracker-table-wrap"
          onScroll={handleBodyScroll}
          ref={bodyScrollRef}
        >
          <table className="options-tracker-table">
            {renderColumnGroup()}
            <tbody>
              {sortedRecords.length > 0 ? (
                sortedRecords.map((record) => (
                  <tr className={record.complete ? "is-complete" : ""} key={record.id}>
                    <td className="options-tracker-sticky-column">
                      <input
                        className="options-tracker-ticker-field"
                        onChange={(event) =>
                          updateRecord(record.id, "ticker", event.target.value)
                        }
                        type="text"
                        value={record.ticker}
                      />
                    </td>
                    <td>
                      <input
                        className="options-tracker-account-field"
                        onChange={(event) =>
                          updateRecord(record.id, "account", event.target.value)
                        }
                        type="text"
                        value={record.account}
                      />
                    </td>
                    <td>
                      <select
                        className="options-tracker-type-select"
                        onChange={(event) =>
                          updateRecord(record.id, "type", event.target.value)
                        }
                        value={record.type}
                      >
                        <option value="PUT">PUT</option>
                        <option value="CALL">CALL</option>
                      </select>
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
                        className="options-tracker-premium-field"
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
                        className="options-tracker-price-to-close-field"
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
                    <td className="options-tracker-notes-cell" title={record.notes}>
                      <input
                        className="options-tracker-notes-field"
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
                  <td className="options-tracker-empty-row" colSpan={14}>
                    No positions match the current filters.
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
