import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "chart.js/auto";
import type { Plugin } from "chart.js";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import {
  deleteAllOptionsAprHistory,
  deleteNonFavoriteOptionsAprHistory,
  deleteOptionsAprHistory,
  listOptionsAprHistory,
  loadOptionsAprHistory,
  saveOptionsAprHistory,
  setOptionsAprHistoryFavorite,
  type OptionsAprHistoryRecord,
} from "./optionsAprHistory";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type OptionRow = {
  contractSymbol: string;
  optionType: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  simpleApr: number | null;
  impliedVolatility: number | null;
  probabilityExpiresWorthless: number | null;
};

export type ChainResult = {
  companyName: string | null;
  underlyingPrice: number;
  expirationDate: string;
  daysToExpiration: number;
  calls: OptionRow[];
  puts: OptionRow[];
};

type ExpirationsResponse = {
  symbol: string;
  companyName: string | null;
  underlyingPrice: number | null;
  expirationDates: string[];
  nextEarningsDate: string | null;
  exDividendDate: string | null;
  error?: string;
};

type ChainResponse = {
  symbol: string;
  data: ChainResult;
  error?: string;
};

type AmplifyCustomOutputs = {
  custom?: {
    yahoo_options_skew?: { api_url?: string };
    schwab?: { api_url?: string };
  };
};

type ChartPoint = {
  x: number;
  y: number;
  expirationDate: string;
  optionType: "call" | "put";
  strike: number;
  midpoint: number | null;
  probabilityExpiresWorthless: number | null;
};

type DragZoom = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export type RequestedOptionType = "both" | "call" | "put";
export type RequestedStrikeRange = "otm" | "all";

const CHART_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#9333ea",
  "#d97706",
  "#0891b2",
  "#4f46e5",
  "#be185d",
];
const YAHOO_REQUEST_DELAY_MS = 800;

function sleep(delayMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function normalizeTicker(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
}

function formatCurrency(value: number | null) {
  return value === null
    ? "--"
    : value.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

function formatPercent(value: number | null) {
  return value === null ? "--" : `${(value * 100).toFixed(2)}%`;
}

function formatHistoryDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function parsePercentSetting(value: string) {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isFriday(expiration: string) {
  return new Date(`${expiration}T00:00:00Z`).getUTCDay() === 5;
}

function isThirdFriday(expiration: string) {
  const expirationDate = new Date(`${expiration}T00:00:00Z`);
  const dayOfMonth = expirationDate.getUTCDate();
  return expirationDate.getUTCDay() === 5 && dayOfMonth >= 15 && dayOfMonth <= 21;
}

function getDefaultExpirations(expirationDates: string[]) {
  return expirationDates.slice(0, 5);
}

function getNearNonFridayExpirations(expirationDates: string[]) {
  const today = new Date();
  const todayText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  const sixMonthsFromToday = new Date(today.getFullYear(), today.getMonth() + 6, today.getDate());
  const sixMonthsText = [
    sixMonthsFromToday.getFullYear(),
    String(sixMonthsFromToday.getMonth() + 1).padStart(2, "0"),
    String(sixMonthsFromToday.getDate()).padStart(2, "0"),
  ].join("-");

  return expirationDates.filter(
    (expiration) =>
      !isFriday(expiration) && expiration >= todayText && expiration < sixMonthsText,
  );
}

function OptionsAprPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [loadedSymbol, setLoadedSymbol] = useState("");
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [underlyingPrice, setUnderlyingPrice] = useState<number | null>(null);
  const [chartCreatedAt, setChartCreatedAt] = useState<Date | null>(null);
  const [nextEarningsDate, setNextEarningsDate] = useState<string | null>(null);
  const [exDividendDate, setExDividendDate] = useState<string | null>(null);
  const [expirationDates, setExpirationDates] = useState<string[]>([]);
  const [selectedExpirations, setSelectedExpirations] = useState<string[]>([]);
  const [requestedOptionType, setRequestedOptionType] = useState<RequestedOptionType>("both");
  const [requestedStrikeRange, setRequestedStrikeRange] = useState<RequestedStrikeRange>("otm");
  const [chains, setChains] = useState<ChainResult[]>([]);
  const [isLoadingExpirations, setIsLoadingExpirations] = useState(false);
  const [isLoadingChains, setIsLoadingChains] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [minimumAprInput, setMinimumAprInput] = useState("25");
  const [minimumProbabilityInput, setMinimumProbabilityInput] = useState("90");
  const [history, setHistory] = useState<OptionsAprHistoryRecord[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const underlyingPriceRef = useRef<number | null>(null);
  const dragZoomRef = useRef<DragZoom | null>(null);

  const apiBaseUrl = useMemo(() => {
    const custom = (outputs as AmplifyCustomOutputs).custom;
    return (custom?.yahoo_options_skew?.api_url ?? custom?.schwab?.api_url ?? "").replace(
      /\/$/,
      "",
    );
  }, []);
  const minimumApr = useMemo(() => parsePercentSetting(minimumAprInput), [minimumAprInput]);
  const minimumProbability = useMemo(
    () => parsePercentSetting(minimumProbabilityInput),
    [minimumProbabilityInput],
  );

  useEffect(() => {
    if (!user) {
      setSymbol("");
      return;
    }
    void loadLastTicker("options-apr").then((ticker) => setSymbol(ticker ?? ""));
  }, [user]);

  useEffect(() => {
    const ticker = normalizeTicker(symbol);
    let cancelled = false;
    setHistoryError(null);
    if (!user || !ticker) {
      setHistory([]);
      return () => {
        cancelled = true;
      };
    }

    void listOptionsAprHistory(ticker)
      .then((records) => {
        if (!cancelled) {
          setHistory(records);
          setSelectedHistoryId((current) =>
            current && records.some((record) => record.id === current) ? current : null,
          );
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setHistory([]);
          setHistoryError(
            loadError instanceof Error ? loadError.message : "Unable to load saved history.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, user]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }

    const currentPricePlugin: Plugin<"line"> = {
      id: "current-stock-price",
      afterDatasetsDraw(chart) {
        const price = underlyingPriceRef.current;
        const xScale = chart.scales.x;
        if (price === null || !xScale || price < xScale.min || price > xScale.max) {
          return;
        }

        const x = xScale.getPixelForValue(price);
        const { ctx, chartArea } = chart;
        const label = `Current: ${formatCurrency(price)}`;
        ctx.save();
        ctx.strokeStyle = "#172033";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();

        ctx.font = "700 12px sans-serif";
        const labelWidth = ctx.measureText(label).width + 12;
        const labelX = Math.min(
          Math.max(x - labelWidth / 2, chartArea.left),
          chartArea.right - labelWidth,
        );
        ctx.fillStyle = "rgba(23, 32, 51, 0.9)";
        ctx.fillRect(labelX, chartArea.top + 4, labelWidth, 22);
        ctx.fillStyle = "white";
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelX + 6, chartArea.top + 15);
        ctx.restore();
      },
    };

    const dragZoomPlugin: Plugin<"line"> = {
      id: "drag-zoom-selection",
      afterDraw(chart) {
        const drag = dragZoomRef.current;
        if (!drag) {
          return;
        }
        const left = Math.min(drag.startX, drag.currentX);
        const top = Math.min(drag.startY, drag.currentY);
        const width = Math.abs(drag.currentX - drag.startX);
        const height = Math.abs(drag.currentY - drag.startY);
        chart.ctx.save();
        chart.ctx.fillStyle = "rgba(37, 99, 235, 0.14)";
        chart.ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
        chart.ctx.fillRect(left, top, width, height);
        chart.ctx.strokeRect(left, top, width, height);
        chart.ctx.restore();
      },
    };

    chartRef.current = new Chart(context, {
      type: "line",
      plugins: [currentPricePlugin, dragZoomPlugin],
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { intersect: false, mode: "nearest", axis: "xy" },
        plugins: {
          legend: { position: "bottom" },
          title: {
            display: false,
            text: [],
            color: "#172033",
            font: { size: 16, weight: "bold" },
            padding: { bottom: 14 },
          },
          tooltip: {
            callbacks: {
              title(items) {
                const point = items[0]?.raw as ChartPoint | undefined;
                return point ? `${point.expirationDate} · ${point.optionType}` : "";
              },
              label(context) {
                const point = context.raw as ChartPoint;
                return [
                  `Strike: ${formatCurrency(point.strike)}`,
                  `Midpoint premium: ${formatCurrency(point.midpoint)}`,
                  `Simple APR: ${point.y.toFixed(2)}%`,
                  `Expires without exercise: ${formatPercent(point.probabilityExpiresWorthless)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Strike price" },
            ticks: { callback: (value) => `$${Number(value).toFixed(0)}` },
          },
          y: {
            title: { display: true, text: "Simple APR" },
            ticks: { callback: (value) => `${Number(value).toFixed(0)}%` },
          },
        },
      },
    });

    const canvas = canvasRef.current;
    const chartCoordinates = (event: PointerEvent) => {
      const bounds = canvas?.getBoundingClientRect();
      return bounds ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top } : null;
    };
    const isInsideChart = (x: number, y: number) => {
      const area = chartRef.current?.chartArea;
      return Boolean(
        area && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom,
      );
    };
    const handlePointerDown = (event: PointerEvent) => {
      const point = chartCoordinates(event);
      if (!canvas || !point || !isInsideChart(point.x, point.y)) {
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      dragZoomRef.current = {
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      };
    };
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragZoomRef.current;
      const point = chartCoordinates(event);
      const area = chartRef.current?.chartArea;
      if (!drag || !point || !area) {
        return;
      }
      drag.currentX = Math.min(Math.max(point.x, area.left), area.right);
      drag.currentY = Math.min(Math.max(point.y, area.top), area.bottom);
      chartRef.current?.draw();
    };
    const handlePointerUp = (event: PointerEvent) => {
      const chart = chartRef.current;
      const drag = dragZoomRef.current;
      dragZoomRef.current = null;
      if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!chart || !drag) {
        return;
      }
      if (
        Math.abs(drag.currentX - drag.startX) < 10 ||
        Math.abs(drag.currentY - drag.startY) < 10
      ) {
        chart.draw();
        return;
      }

      const xValues = [
        chart.scales.x.getValueForPixel(drag.startX),
        chart.scales.x.getValueForPixel(drag.currentX),
      ];
      const yValues = [
        chart.scales.y.getValueForPixel(drag.startY),
        chart.scales.y.getValueForPixel(drag.currentY),
      ];
      const xOptions = chart.options.scales?.x;
      const yOptions = chart.options.scales?.y;
      if (
        xOptions &&
        yOptions &&
        xValues.every((value): value is number => typeof value === "number") &&
        yValues.every((value): value is number => typeof value === "number")
      ) {
        xOptions.min = Math.min(...xValues);
        xOptions.max = Math.max(...xValues);
        yOptions.min = Math.min(...yValues);
        yOptions.max = Math.max(...yValues);
        setIsZoomed(true);
        chart.update();
      }
    };

    canvas?.addEventListener("pointerdown", handlePointerDown);
    canvas?.addEventListener("pointermove", handlePointerMove);
    canvas?.addEventListener("pointerup", handlePointerUp);
    canvas?.addEventListener("pointercancel", handlePointerUp);

    return () => {
      canvas?.removeEventListener("pointerdown", handlePointerDown);
      canvas?.removeEventListener("pointermove", handlePointerMove);
      canvas?.removeEventListener("pointerup", handlePointerUp);
      canvas?.removeEventListener("pointercancel", handlePointerUp);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    underlyingPriceRef.current = underlyingPrice;
    chartRef.current?.draw();
  }, [underlyingPrice]);

  useEffect(() => {
    const chart = chartRef.current;
    const title = chart?.options.plugins?.title;
    if (!chart || !title) {
      return;
    }

    title.display = Boolean(loadedSymbol && chartCreatedAt);
    title.text = chartCreatedAt
      ? [
          `${loadedSymbol}${companyName ? ` — ${companyName}` : ""}`,
          `Chart created ${chartCreatedAt.toLocaleDateString()}`,
          [
            nextEarningsDate ? `Next earnings: ${nextEarningsDate}` : "",
            exDividendDate ? `Ex-dividend: ${exDividendDate}` : "",
          ]
            .filter(Boolean)
            .join("  |  "),
        ]
          .filter(Boolean)
      : [];
    chart.update();
  }, [chartCreatedAt, companyName, exDividendDate, loadedSymbol, nextEarningsDate]);

  function resetChartZoom() {
    const chart = chartRef.current;
    const xOptions = chart?.options.scales?.x;
    const yOptions = chart?.options.scales?.y;
    if (!chart || !xOptions || !yOptions) {
      return;
    }
    xOptions.min = undefined;
    xOptions.max = undefined;
    yOptions.min = undefined;
    yOptions.max = undefined;
    dragZoomRef.current = null;
    setIsZoomed(false);
    chart.update();
  }

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    chart.data.datasets = chains.flatMap((chain, index) => {
      const color = CHART_COLORS[index % CHART_COLORS.length];
      return (["call", "put"] as const).flatMap((optionType) => {
        const options = optionType === "call" ? chain.calls : chain.puts;
        const data: ChartPoint[] = options
          .filter((option) => option.simpleApr !== null)
          .map((option) => ({
            x: option.strike,
            y: (option.simpleApr ?? 0) * 100,
            expirationDate: chain.expirationDate,
            optionType,
            strike: option.strike,
            midpoint: option.midpoint,
            probabilityExpiresWorthless: option.probabilityExpiresWorthless,
          }));
        const isHighlighted = (point: ChartPoint) =>
          minimumApr !== null &&
          minimumProbability !== null &&
          point.y >= minimumApr &&
          point.probabilityExpiresWorthless !== null &&
          point.probabilityExpiresWorthless * 100 >= minimumProbability;
        return data.length === 0 ? [] : [{
          label: `${chain.expirationDate} ${optionType}`,
          data,
          borderColor: color,
          backgroundColor: color,
          borderDash: optionType === "put" ? [7, 4] : undefined,
          pointRadius: data.map((point) => (isHighlighted(point) ? 6 : 1.5)),
          pointHoverRadius: data.map((point) => (isHighlighted(point) ? 8 : 5)),
          pointBackgroundColor: data.map((point) => (isHighlighted(point) ? "#facc15" : color)),
          pointBorderColor: data.map((point) => (isHighlighted(point) ? "#713f12" : color)),
          pointBorderWidth: data.map((point) => (isHighlighted(point) ? 2 : 1)),
          borderWidth: 2,
          tension: 0.08,
        }];
      });
    });
    chart.update();
  }, [chains, minimumApr, minimumProbability]);

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: await getAuthHeaders() });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Yahoo Finance request failed.");
    }
    return payload;
  }

  function validateExpirationLookup() {
    const normalizedSymbol = normalizeTicker(symbol);
    if (!user) {
      setError("Sign in to retrieve option chains.");
      return null;
    }
    if (!apiBaseUrl) {
      setError("The Yahoo options API URL is not configured.");
      return null;
    }
    if (!normalizedSymbol) {
      setError("Enter a ticker symbol.");
      return null;
    }
    return normalizedSymbol;
  }

  async function fetchAndApplyExpirations(normalizedSymbol: string) {
    setError(null);
    setChains([]);
    setChartCreatedAt(null);
    setNextEarningsDate(null);
    setExDividendDate(null);
    resetChartZoom();
    setExpirationDates([]);
    setSelectedExpirations([]);
    const params = new URLSearchParams({ symbol: normalizedSymbol });
    const result = await fetchJson<ExpirationsResponse>(
      `${apiBaseUrl}/yahoo-options-apr/expirations?${params}`,
    );
    setSymbol(result.symbol);
    setLoadedSymbol(result.symbol);
    setCompanyName(result.companyName);
    setUnderlyingPrice(result.underlyingPrice);
    setExpirationDates(result.expirationDates);
    setNextEarningsDate(result.nextEarningsDate);
    setExDividendDate(result.exDividendDate);
    setSelectedExpirations(getDefaultExpirations(result.expirationDates));
    await saveLastTicker("options-apr", result.symbol);
    return result;
  }

  async function handleLoadExpirations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedSymbol = validateExpirationLookup();
    if (!normalizedSymbol) {
      return;
    }

    setIsLoadingExpirations(true);
    try {
      await fetchAndApplyExpirations(normalizedSymbol);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to retrieve expirations.");
    } finally {
      setIsLoadingExpirations(false);
    }
  }

  async function handleGetFirstFive() {
    const normalizedSymbol = validateExpirationLookup();
    if (!normalizedSymbol) {
      return;
    }

    setIsLoadingExpirations(true);
    try {
      const result = await fetchAndApplyExpirations(normalizedSymbol);
      const firstFiveExpirations = result.expirationDates.slice(0, 5);
      setSelectedExpirations(firstFiveExpirations);
      await loadSelectedChains(firstFiveExpirations, result.symbol, result);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to retrieve the first five option chains.",
      );
    } finally {
      setIsLoadingExpirations(false);
    }
  }

  function toggleExpiration(expiration: string) {
    setSelectedExpirations((current) =>
      current.includes(expiration)
        ? current.filter((value) => value !== expiration)
        : [...current, expiration].sort(),
    );
  }

  async function refreshHistory(ticker: string) {
    const records = await listOptionsAprHistory(ticker);
    setHistory(records);
  }

  async function handleLoadHistory(record: OptionsAprHistoryRecord) {
    setHistoryError(null);
    try {
      const snapshot = await loadOptionsAprHistory(record);
      setSymbol(record.ticker);
      setLoadedSymbol(record.ticker);
      setCompanyName(record.companyName);
      setUnderlyingPrice(record.underlyingPrice);
      setChartCreatedAt(new Date(record.retrievedAt));
      setRequestedOptionType(record.requestedOptionType);
      setRequestedStrikeRange(record.requestedStrikeRange);
      setNextEarningsDate(record.nextEarningsDate);
      setExDividendDate(record.exDividendDate);
      setSelectedExpirations(record.selectedExpirations);
      setChains(snapshot.chains);
      setSelectedHistoryId(record.id);
      resetChartZoom();
    } catch (loadError) {
      setHistoryError(
        loadError instanceof Error ? loadError.message : "Unable to load the saved data set.",
      );
    }
  }

  async function handleToggleFavorite(record: OptionsAprHistoryRecord) {
    setHistoryError(null);
    try {
      await setOptionsAprHistoryFavorite(record.id, !record.favorite);
      await refreshHistory(record.ticker);
    } catch (favoriteError) {
      setHistoryError(
        favoriteError instanceof Error ? favoriteError.message : "Unable to update favorite.",
      );
    }
  }

  async function handleDeleteHistory(record: OptionsAprHistoryRecord) {
    if (!window.confirm(`Delete the ${formatHistoryDate(record.retrievedAt)} data set?`)) {
      return;
    }
    setHistoryError(null);
    try {
      await deleteOptionsAprHistory(record.id);
      if (selectedHistoryId === record.id) {
        setSelectedHistoryId(null);
      }
      await refreshHistory(record.ticker);
    } catch (deleteError) {
      setHistoryError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete the data set.",
      );
    }
  }

  async function handleDeleteAllHistory() {
    const ticker = normalizeTicker(symbol);
    if (!ticker || !window.confirm(`Delete every saved ${ticker} option-chain data set?`)) {
      return;
    }
    setHistoryError(null);
    try {
      await deleteAllOptionsAprHistory(ticker);
      setHistory([]);
      setSelectedHistoryId(null);
    } catch (deleteError) {
      setHistoryError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete saved data sets.",
      );
    }
  }

  async function handleDeleteNonFavoriteHistory() {
    const ticker = normalizeTicker(symbol);
    const deletableCount = history.filter((record) => !record.favorite).length;
    if (
      !ticker ||
      deletableCount === 0 ||
      !window.confirm(
        `Delete ${deletableCount} non-favorite ${ticker} data set${deletableCount === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    setHistoryError(null);
    try {
      await deleteNonFavoriteOptionsAprHistory(ticker);
      const remainingHistory = await listOptionsAprHistory(ticker);
      setHistory(remainingHistory);
      setSelectedHistoryId((current) =>
        current && remainingHistory.some((record) => record.id === current) ? current : null,
      );
    } catch (deleteError) {
      setHistoryError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete non-favorite data sets.",
      );
    }
  }

  async function loadSelectedChains(
    expirationsToLoad = selectedExpirations,
    tickerToLoad = loadedSymbol,
    expirationMetadata?: ExpirationsResponse,
  ) {
    if (!tickerToLoad || expirationsToLoad.length === 0) {
      setError("Select at least one expiration date.");
      return;
    }

    setIsLoadingChains(true);
    setError(null);
    setChains([]);
    const retrievedAt = new Date();
    setChartCreatedAt(retrievedAt);
    resetChartZoom();
    const loadedChains: ChainResult[] = [];
    try {
      for (const [index, expiration] of expirationsToLoad.entries()) {
        setProgress(`Retrieving ${index + 1} of ${expirationsToLoad.length}: ${expiration}`);
        const params = new URLSearchParams({
          symbol: tickerToLoad,
          expiration,
          optionType: requestedOptionType,
          strikeRange: requestedStrikeRange,
        });
        const result = await fetchJson<ChainResponse>(
          `${apiBaseUrl}/yahoo-options-apr/chain?${params}`,
        );
        loadedChains.push(result.data);
        if (result.data.companyName) {
          setCompanyName(result.data.companyName);
        }
        setChains([...loadedChains]);
        if (index < expirationsToLoad.length - 1) {
          setProgress(`Waiting ${YAHOO_REQUEST_DELAY_MS} ms before the next Yahoo request...`);
          await sleep(YAHOO_REQUEST_DELAY_MS);
        }
      }
      const snapshotUnderlyingPrice =
        loadedChains[0]?.underlyingPrice ?? expirationMetadata?.underlyingPrice ?? underlyingPrice;
      const snapshotCompanyName =
        loadedChains[0]?.companyName ?? expirationMetadata?.companyName ?? companyName;
      setUnderlyingPrice(snapshotUnderlyingPrice);
      const savedHistory = await saveOptionsAprHistory({
        ticker: tickerToLoad,
        companyName: snapshotCompanyName,
        underlyingPrice: snapshotUnderlyingPrice,
        retrievedAt: retrievedAt.toISOString(),
        requestedOptionType,
        requestedStrikeRange,
        nextEarningsDate: expirationMetadata?.nextEarningsDate ?? nextEarningsDate,
        exDividendDate: expirationMetadata?.exDividendDate ?? exDividendDate,
        selectedExpirations: [...expirationsToLoad],
        chains: loadedChains,
      });
      setSelectedHistoryId(savedHistory.id);
      await refreshHistory(tickerToLoad);
      setProgress("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to retrieve option chains.");
    } finally {
      setIsLoadingChains(false);
    }
  }

  return (
    <main className="skew-page options-apr-page">
      <a href="/">Back to landing page</a>
      <section className="skew-hero">
        <div>
          <p className="skew-kicker">Yahoo Finance Options</p>
          <h1>Options APR Explorer</h1>
          <p className="skew-intro">
            Compare covered-call and cash-secured-put premium returns by strike and expiration.
          </p>
        </div>
        <form className="options-apr-symbol-form" onSubmit={handleLoadExpirations}>
          <input
            aria-label="Ticker symbol"
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="Ticker (e.g., MU)"
            type="text"
            value={symbol}
          />
          <button disabled={isLoadingExpirations || isLoadingChains} type="submit">
            {isLoadingExpirations ? "Retrieving..." : "Get Expiration Dates"}
          </button>
          <button
            disabled={isLoadingExpirations || isLoadingChains}
            onClick={() => void handleGetFirstFive()}
            type="button"
          >
            Get First Five
          </button>
        </form>
      </section>

      {error ? <p className="skew-error">{error}</p> : null}
      {expirationDates.length > 0 ? (
        <section className="skew-panel">
          <div className="skew-panel-header">
            <div>
              <h2>Select Expirations</h2>
              <p>{expirationDates.length} dates available for {loadedSymbol}.</p>
            </div>
            <div className="options-apr-selection-actions">
              <button onClick={() => setSelectedExpirations(expirationDates)} type="button">
                Select all
              </button>
              <button
                onClick={() => setSelectedExpirations(expirationDates.filter(isFriday).slice(0, 5))}
                type="button"
              >
                Select Near Friday
              </button>
              <button
                onClick={() =>
                  setSelectedExpirations(getNearNonFridayExpirations(expirationDates))
                }
                type="button"
              >
                Select Near Non-Friday
              </button>
              <button
                onClick={() => setSelectedExpirations(expirationDates.slice(0, 5))}
                type="button"
              >
                Select First Five
              </button>
              <button onClick={() => setSelectedExpirations([])} type="button">
                Clear
              </button>
            </div>
          </div>
          <div className="options-apr-expirations">
            {expirationDates.map((expiration) => (
              <label
                className={[
                  isFriday(expiration) ? "is-friday" : "",
                  isThirdFriday(expiration) ? "is-third-friday" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
                key={expiration}
              >
                <input
                  checked={selectedExpirations.includes(expiration)}
                  onChange={() => toggleExpiration(expiration)}
                  type="checkbox"
                />
                {expiration}
                {isFriday(expiration) ? (
                  <span className="options-apr-friday-badge">
                    {isThirdFriday(expiration) ? "3rd Friday" : "Friday"}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
          <div className="options-apr-retrieve-controls">
            <label>
              Option types
              <select
                disabled={isLoadingChains}
                onChange={(event) =>
                  setRequestedOptionType(event.target.value as RequestedOptionType)
                }
                value={requestedOptionType}
              >
                <option value="both">Calls and puts</option>
                <option value="put">Puts only</option>
                <option value="call">Calls only</option>
              </select>
            </label>
            <label>
              Strike coverage
              <select
                disabled={isLoadingChains}
                onChange={(event) =>
                  setRequestedStrikeRange(event.target.value as RequestedStrikeRange)
                }
                value={requestedStrikeRange}
              >
                <option value="otm">OTM/ATM only</option>
                <option value="all">All strikes</option>
              </select>
            </label>
            <button
              disabled={isLoadingChains || selectedExpirations.length === 0}
              onClick={() => void loadSelectedChains()}
              type="button"
            >
              {isLoadingChains ? progress : `Retrieve ${selectedExpirations.length} Option Chain${selectedExpirations.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>
      ) : null}

      <section className="skew-panel">
        <div className="skew-panel-header">
          <div>
            <h2>Simple APR vs. Strike</h2>
            <p>
              Solid lines are calls; dashed lines are puts. Hover for details, or drag a rectangle
              over the plot to zoom.
            </p>
          </div>
          <div className="options-apr-chart-actions">
            {underlyingPrice !== null ? (
              <div className="skew-value">
                <span>Underlying</span>
                <strong>{formatCurrency(underlyingPrice)}</strong>
              </div>
            ) : null}
            <button disabled={!isZoomed} onClick={resetChartZoom} type="button">
              Reset zoom
            </button>
          </div>
        </div>
        <div className="options-apr-chart-wrap">
          <canvas ref={canvasRef} />
        </div>
        <div className="options-apr-thresholds">
          <label>
            Minimum Simple APR (%)
            <input
              min="0"
              onChange={(event) => setMinimumAprInput(event.target.value)}
              placeholder="e.g., 12"
              step="0.1"
              type="number"
              value={minimumAprInput}
            />
          </label>
          <label>
            Minimum expires without exercise (%)
            <input
              max="100"
              min="0"
              onChange={(event) => setMinimumProbabilityInput(event.target.value)}
              placeholder="e.g., 75"
              step="0.1"
              type="number"
              value={minimumProbabilityInput}
            />
          </label>
          <p className="options-apr-highlight-key">
            <span aria-hidden="true" /> Gold points meet both minimums.
          </p>
        </div>
        <p className="options-apr-method-note">
          Put APR uses strike as cash collateral. Call APR uses the current share price as covered-call collateral.
          Yahoo chain requests are sequential with an {YAHOO_REQUEST_DELAY_MS} ms delay between expirations.
          Probability is a Black–Scholes risk-neutral estimate using Yahoo implied volatility and zero interest/dividend rates; it is not a forecast.
        </p>
      </section>

      {normalizeTicker(symbol) ? (
        <section className="skew-panel options-apr-history-panel">
          <div className="skew-panel-header">
            <div>
              <h2>{normalizeTicker(symbol)} Retrieval History</h2>
              <p>Select a saved data set to restore its chart and option tables.</p>
            </div>
            <div className="options-apr-history-bulk-actions">
              <button
                className="options-apr-delete-all"
                disabled={!history.some((record) => !record.favorite)}
                onClick={() => void handleDeleteNonFavoriteHistory()}
                type="button"
              >
                Delete all except favorites
              </button>
              <button
                className="options-apr-delete-all"
                disabled={history.length === 0}
                onClick={() => void handleDeleteAllHistory()}
                type="button"
              >
                Delete all for {normalizeTicker(symbol)}
              </button>
            </div>
          </div>
          {historyError ? <p className="skew-error">{historyError}</p> : null}
          {history.length > 0 ? (
            <div className="options-apr-history-list">
              {history.map((record) => (
                <article
                  className={selectedHistoryId === record.id ? "is-selected" : undefined}
                  key={record.id}
                >
                  <button
                    className="options-apr-history-load"
                    onClick={() => void handleLoadHistory(record)}
                    type="button"
                  >
                    <strong>{formatHistoryDate(record.retrievedAt)}</strong>
                    <span>
                      {record.selectedExpirations.length} expiration
                      {record.selectedExpirations.length === 1 ? "" : "s"} · {record.requestedOptionType}
                      {` · ${record.requestedStrikeRange === "all" ? "all strikes" : "OTM/ATM"}`}
                      {record.underlyingPrice !== null
                        ? ` · ${formatCurrency(record.underlyingPrice)}`
                        : ""}
                    </span>
                  </button>
                  <div className="options-apr-history-actions">
                    <button
                      aria-label={record.favorite ? "Remove from favorites" : "Add to favorites"}
                      className={record.favorite ? "is-favorite" : undefined}
                      onClick={() => void handleToggleFavorite(record)}
                      title={record.favorite ? "Remove from favorites" : "Add to favorites"}
                      type="button"
                    >
                      {record.favorite ? "★" : "☆"}
                    </button>
                    <button
                      aria-label={`Delete data set from ${formatHistoryDate(record.retrievedAt)}`}
                      className="options-apr-history-delete"
                      onClick={() => void handleDeleteHistory(record)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="skew-empty">No saved data sets for this ticker yet.</p>
          )}
        </section>
      ) : null}

      {chains.map((chain) => (
        <section className="skew-panel" key={chain.expirationDate}>
          <h2>{chain.expirationDate} · {chain.daysToExpiration} days</h2>
          <div className="skew-table-wrap">
            <table className="skew-table options-apr-table">
              <thead>
                <tr>
                  <th>Type</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Midpoint</th>
                  <th>Simple APR</th><th>Expires without exercise</th>
                </tr>
              </thead>
              <tbody>
                {[...chain.calls, ...chain.puts].map((option) => (
                  <tr key={option.contractSymbol}>
                    <td>{option.optionType}</td>
                    <td>{formatCurrency(option.strike)}</td>
                    <td>{formatCurrency(option.bid)}</td>
                    <td>{formatCurrency(option.ask)}</td>
                    <td>{formatCurrency(option.midpoint)}</td>
                    <td>{formatPercent(option.simpleApr)}</td>
                    <td>{formatPercent(option.probabilityExpiresWorthless)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}

export default OptionsAprPage;
