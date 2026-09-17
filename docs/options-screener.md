# Options APR Screener

## Run locally without AWS or sign-in

Use Node.js 20.20+ and npm 10.8+ (the versions required by this repository). From the repository root:

```powershell
npm ci
npm run dev:screener
```

Open **http://127.0.0.1:5173/screener.local.html**. Leave the terminal running; Ctrl+C stops it. Port 5173 must be free. Use the exact address above: the local API is restricted to this loopback host and origin.

The local page starts with **INTC, AMZN, GOOGL**. It does not require an AWS account, Cognito login, Yahoo API key, or `amplify_outputs.json`. Yahoo calls run in Node on your computer, not in the browser. Internet access to Yahoo is required. `npm run dev` and `npm run preview` alone do not start this local API.

## Run using the cloud backend

The hosted page is **/options-screener**, also linked from the landing page. Sign in using the existing account menu. The initial tickers come from that user's Options APR Explorer history and remembered tickers. If the list is empty, add symbols manually.

Deploy this repository through the existing Amplify Hosting connected branch. The checked-in `amplify.yml` runs `npm ci`, `npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID`, and `npm run build`, then publishes `dist`. The screener reuses the authenticated `/yahoo-options-apr/expirations` and `/yahoo-options-apr/chain` routes and existing user-owned ticker models; it requires no new cloud resources or secrets. Keep Amplify's single-page-app rewrite to `/index.html` enabled so direct navigation to `/options-screener` works.

To develop the authenticated version locally against an AWS sandbox, with AWS credentials configured:

```powershell
npx ampx sandbox
```

Leave that running to generate `amplify_outputs.json`. In another terminal run `npm run dev`, open the Vite URL at `/options-screener`, and sign in to the sandbox. This mode uses the cloud API and account tickers. Use `dev:screener` instead for the standalone, no-AWS mode. The standalone local API is not included in the cloud deployment.

## Using the screener

1. Add symbols separated by commas, spaces, or semicolons. Use × to remove a symbol. Reset restores the initial list. Changes affect this page only and do not alter APR Explorer history.
2. The **Results** panel contains minimum APR and minimum expires without exercise, both in percent (defaults: 25 and 90). These are display filters only: they never constrain retrieval or disable Run. Adjust them during or after retrieval to update the table immediately without any Yahoo API requests.
3. Choose **Option types** (calls and puts, puts only, or calls only) and **Strike coverage** (OTM/ATM only or all strikes). Defaults match the Explorer: calls and puts, OTM/ATM only. Enter **First N expirations per ticker** to retrieve only the nearest N available expiration dates; leave blank for all. The limit counts expiration chains, not individual contracts. Click **Run** to capture these settings and the ticker list, clear the previous results, and start retrieval. These retrieval controls are locked during a run.
4. Watch ticker progress and the current expiration. The meter counts processed tickers; the separate fully-retrieved count excludes tickers with any failed chains. Errors identify missing data. Successful chains remain available after errors or cancellation. Keep the browser tab open; a run is not a background cloud job.
5. **Exclude outliers**, above Run, defaults to checked. It applies the saved **Flags to exclude** checkboxes in Results. By default, these select invalid quotes, no bid, crossed quotes, and APR outliers. Select or clear any of the eight flag types to customize exclusion; a row is hidden if it has any selected flag. Unchecking Exclude outliers pauses all flag exclusions without forgetting your choices. Changes filter loaded data immediately and do not affect retrieval. The directional rule hides an OTM put with APR at least 10× any usable OTM put at a higher strike, or an OTM call with APR at least 10× any usable OTM call at a lower strike. Comparison quotes must have positive bids and APRs and asks at least as large as bids. Comparisons stay within the same ticker, expiration, and option type, before minimum filters. ITM/ATM points are ignored by the directional rule but still receive quote-quality checks. Toggle exclusion at any time without another retrieval; the original rows remain available subject to the Results minimums.
6. Results start with highest APR first. Click a column heading to make it the primary sort, retaining previous sorts as secondary tie-breakers. For example, sorting by APR and then Type groups calls and puts while retaining APR order inside each group. Click the primary heading again to reverse it; promoting a secondary heading preserves its direction. Arrows and priority numbers identify the sort order. Choose 10, 50, or 100 rows and use First/Previous/Next/Last. Minimums can be changed during or after retrieval without more API calls. Missing APR or probability values do not pass the filters.

Run settings (minimum APR, minimum probability, expiration limit, option types, strike coverage, and outlier exclusion) save automatically as they are edited. Cloud mode saves them in the signed-in user's owner-protected UserPreference record; local mode uses this browser's local storage. New users default to outlier exclusion enabled. Tickers and results are not saved by this page: cloud tickers reload from the APR Explorer, and local tickers reset to INTC, AMZN, GOOGL.

Deploy the updated Amplify backend schema along with the frontend to enable the new `optionsScreenerSettingsJson` preference field. The existing `amplify.yml` pipeline deploys the backend before building the frontend. An already-running standalone local server must be restarted after this update so its API honors the option-type and strike-coverage selections.

## Calculations and request pacing

Column order is customizable: drag the ↔ handle beside a heading onto another heading, or focus the handle and use Left/Right arrows. Headers and row values move together. Clicking the column name still sorts and moving columns preserves the existing sort priorities and page. **Reset column order** restores the original layout. Order saves automatically to the signed-in user's preferences in cloud mode and this browser's storage in local mode. Old preferences gain any newly introduced columns at the end; unknown or duplicate columns are ignored.

**Maximum distance (%)** sits beside Minimum distance. It defaults to blank (no upper limit), saves with your other settings, and filters loaded data immediately without Yahoo requests. Bounds are inclusive: minimum 3 and maximum 10 shows distances from 3% through 10%. A finite maximum excludes unavailable distances; 0 shows only zero-distance rows when the minimum is also 0. The maximum must not be below the minimum.

**Bid APR**, beside APR, annualizes the displayed bid using the same collateral and days-to-expiration as midpoint APR. A zero bid gives 0% bid APR; a missing or invalid bid gives no value. The APR column and minimum APR filter continue to use midpoint premium. Neither a bid nor a midpoint guarantees execution.

**Flags** lists the reasons a row is suspicious. Expand it for details and bid, ask, reported volume, open interest, and last-trade date. Sorting Flags sorts by the number of flags and supports the existing secondary sorts. Each flag type can be selected under **Flags to exclude**. These warnings are unselected by default, but can also hide rows when selected: relative spread above 50% of midpoint; reported volume below 10; reported open interest below 100; last trade more than seven days before the chain's market-data date. These are starting warning thresholds, not calibrated guarantees of quality. Missing activity is not treated as zero. Last-trade age is not quote age.

Deploy the updated Yahoo Lambda to return volume, open interest, and last-trade date in cloud mode; restart `npm run dev:screener` for local mode. Retrieve again to populate the new fields. Older payloads still support bid APR and bid/ask quality checks, but cannot produce activity warnings where those fields are absent. No additional database schema change is needed for these columns. The Explorer chart retains its existing filtering; this quote-quality layer applies to the screener.

**Minimum distance (%)**, alongside the APR and probability filters in Results, filters retrieved rows immediately without Yahoo requests. It defaults to 0 (unrestricted); for example, 3 keeps distances of at least 3%. Positive minimums exclude rows with unavailable distance. This setting saves with the other preferences, and existing saved settings default to 0.

**Current price** is the underlying share price returned with each expiration chain at retrieval time. **Distance** is `abs(strike − current price) / current price × 100%`: strikes of 103 and 90 with a current price of 100 show 3% and 10%, respectively. Both columns support multi-column sorting. Distance is unavailable when current price is missing or nonpositive. Prices are retrieval snapshots, not streaming quotes.

The local and cloud paths use the same APR-chain calculation code as the Explorer. Put APR uses strike-price collateral; call APR uses current-share-price collateral. Premium is the bid/ask midpoint **per share**. APR is a simple annualized premium-selling measure, not a forecast of option-buying returns. **Exp w/o exercise** displays `probabilityExpiresWorthless` as a percentage, matching the minimum expires without exercise filter. It uses the Explorer's Black–Scholes estimate with zero rates/dividend yield and does not model early assignment.

Requests are sequential with 800 ms between completions and subsequent requests, including ticker boundaries. The cloud expiration endpoint also retains its existing internal delay before fetching calendar metadata. Local requests share a server-side queue. HTTP 429/502/503/504 responses are retried up to three times with 2/4/8-second backoff (or a longer Retry-After). Each HTTP attempt has a 45-second timeout. Yahoo may still reject requests or return unavailable/stale quotes; pacing cannot guarantee availability. Review errors and quote freshness before using results.

## Verify changes

```powershell
npm run test:screener
npm run build
```
