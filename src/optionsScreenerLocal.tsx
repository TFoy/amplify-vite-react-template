import React from "react";
import ReactDOM from "react-dom/client";
import OptionsScreenerPage from "./OptionsScreenerPage";
import { createScreenerRequest } from "./optionsScreener";
import "./index.css";
import { DEFAULT_SCREENER_SETTINGS, parseScreenerSettings, type ScreenerSettings } from "./optionsScreenerSettings";

const request = createScreenerRequest("/local-options-api", async () => ({}));
const storageKey = "options-screener:run-settings";
let initialSettings = DEFAULT_SCREENER_SETTINGS;
try { initialSettings = parseScreenerSettings(localStorage.getItem(storageKey)); } catch { /* Saving errors are surfaced by the page. */ }
const saveSettings = (settings: ScreenerSettings) => localStorage.setItem(storageKey, JSON.stringify(parseScreenerSettings(JSON.stringify(settings))));
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><OptionsScreenerPage local defaultTickers={["INTC", "AMZN", "GOOGL"]} request={request} initialSettings={initialSettings} onSettingsChange={saveSettings} /></React.StrictMode>,
);
