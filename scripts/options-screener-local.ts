import { createServer, type Plugin } from "vite";
import YahooFinance from "yahoo-finance2";
import { buildAprChain } from "../amplify/functions/yahoo-options-skew/handler";

const yahoo = new YahooFinance();
let queue: Promise<unknown> = Promise.resolve();
let lastFinished = 0;

// Serialize local clients too, so multiple tabs cannot issue concurrent Yahoo calls.
function queued<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const delay = Math.max(0, 800 - (Date.now() - lastFinished));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try { return await operation(); } finally { lastFinished = Date.now(); }
  });
  queue = result.catch(() => undefined);
  return result;
}

const localApi: Plugin = {
  name: "local-options-screener-api",
  configureServer(server) {
    server.middlewares.use("/local-options-api", (req, res) => {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const expectedOrigin = "http://127.0.0.1:5173";
  if (req.headers.host !== "127.0.0.1:5173" || (req.headers.origin && req.headers.origin !== expectedOrigin) || req.headers["sec-fetch-site"] === "cross-site") {
    send(403, { error: "Local API accepts same-origin loopback requests only." }); return;
  }
  if (req.method !== "GET") { send(405, { error: "Only GET is supported." }); return; }
  const url = new URL(req.url ?? "/", expectedOrigin);
  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (!/^[A-Z0-9^][A-Z0-9.^=-]{0,19}$/.test(symbol)) { send(400, { error: "A valid symbol is required." }); return; }
  const run = async () => {
    if (url.pathname === "/yahoo-options-apr/expirations") {
      const result = await queued(() => yahoo.options(symbol));
      send(200, { symbol, expirationDates: result.expirationDates.map((date) => date.toISOString().slice(0, 10)) });
    } else if (url.pathname === "/yahoo-options-apr/chain") {
      const expiration = url.searchParams.get("expiration") ?? "";
      const date = new Date(`${expiration}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expiration) {
        send(400, { error: "A valid expiration date (YYYY-MM-DD) is required." }); return;
      }
      const optionType = url.searchParams.get("optionType") ?? "both";
      const strikeRange = url.searchParams.get("strikeRange") ?? "all";
      if (optionType !== "both" && optionType !== "call" && optionType !== "put") {
        send(400, { error: "Option type must be both, call, or put." }); return;
      }
      if (strikeRange !== "all" && strikeRange !== "otm") {
        send(400, { error: "Strike range must be all or otm." }); return;
      }
      const result = await queued(() => yahoo.options(symbol, { date }));
      send(200, { symbol, data: buildAprChain(result, optionType, strikeRange) });
    } else send(404, { error: "Route not found." });
  };
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    send(/429|too many requests/i.test(message) ? 429 : 502, { error: message });
  });
    });
  },
};

const server = await createServer({ plugins: [localApi], server: { host: "127.0.0.1", port: 5173, strictPort: true } });
await server.listen();
console.log("Options APR Screener: http://127.0.0.1:5173/screener.local.html");
