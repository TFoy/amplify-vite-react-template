#!/usr/bin/env python3
"""Parse Fidelity statement PDFs and generate options APR HTML and CSV reports."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
if (HERE / ".deps").exists():
    sys.path.insert(0, str(HERE / ".deps"))
try:
    from pypdf import PdfReader
except ImportError as exc:
    raise SystemExit(
        "Install the PDF dependency with: "
        "python -m pip install -r scripts/requirements-fidelity-report.txt"
    ) from exc

MONTHS = {name: n for n, name in enumerate(
    "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(), 1
)}
CONTRACT_RE = re.compile(
    r"(?P<kind>CALL|PUT)\s+\((?P<ticker>[A-Z.\-]+)\).*?"
    r"(?P<month>[A-Z]{3})\s+(?P<day>\d{1,2})\s+(?P<year>\d{2})\s+"
    r"\$(?P<strike>[\d,]+(?:\.\d+)?)", re.S,
)
TRADE_RE = re.compile(
    r"You\s+(?P<action>Bought|Sold)\s+"
    r"(?:Transaction\s+(?:Profit|Loss):\s+\$?[\d,]+(?:\.\d+)?\s+)?"
    r"(?P<qty>-?[\d,]+(?:\.\d+)?)\s+"
    r"\$?(?P<price>[\d,]+(?:\.\d+)?)\s+.*?(?P<amount>-?\$?[\d,]+(?:\.\d+)?)"
    r"(?=\s+(?:MR_CE|INVESTMENT REPORT|Total\b|Activity\b|Account\b)|\s*$)", re.S,
)


def number(text: str) -> float:
    return float(text.replace("$", "").replace(",", ""))


@dataclass
class Event:
    when: date
    ticker: str
    kind: str
    expiry: date
    strike: float
    action: str
    opening: bool
    closing: bool
    qty: float
    cash: float
    source: str

    @property
    def contract(self) -> str:
        return f"{self.ticker} {self.expiry:%Y-%m-%d} {self.strike:g} {self.kind[0]}"


@dataclass
class Lot:
    contract: str
    ticker: str
    side: str
    opened: date
    closed: date | None
    qty: float
    open_cash: float
    close_cash: float
    collateral: float
    sources: str

    @property
    def pnl(self) -> float:
        return self.open_cash + self.close_cash

    @property
    def days(self) -> int | None:
        return max(1, (self.closed - self.opened).days) if self.closed else None

    @property
    def ret(self) -> float | None:
        return self.pnl / self.collateral if self.closed and self.collateral else None

    @property
    def apr(self) -> float | None:
        return self.ret * 365 / self.days if self.ret is not None and self.days else None


@dataclass
class StockEvent:
    when: date
    ticker: str
    action: str
    qty: float
    cash: float
    assigned_put: bool


@dataclass
class StockLot:
    ticker: str
    opened: date
    closed: date | None
    qty: float
    cost: float
    proceeds: float | None
    assigned_put: bool

    @property
    def pnl(self) -> float:
        return (self.proceeds or 0.0) - self.cost

    @property
    def days(self) -> int:
        return max(1, (self.closed - self.opened).days) if self.closed else 0


def chunks(text: str) -> list[tuple[str, str]]:
    lines = [line.strip() for line in text.splitlines()]
    starts = [i for i, line in enumerate(lines) if re.match(r"^\d{2}/\d{2}\s+", line)]
    result = []
    for pos, start in enumerate(starts):
        end = starts[pos + 1] if pos + 1 < len(starts) else min(len(lines), start + 16)
        result.append((lines[start][:5], " ".join([lines[start][6:], *lines[start + 1:end]])))
    return result


def parse_pdf(
    path: Path,
    known_security_names: list[tuple[str, str]],
) -> tuple[list[Event], list[StockEvent], list[str], date]:
    text = "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    year_match = re.search(
        r"(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+(20\d{2})",
        text,
    )
    if not year_match:
        raise ValueError(f"Could not determine statement year in {path.name}")
    year = int(year_match.group(1))
    period_end_match = re.search(
        r"-\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2})",
        text,
    )
    if not period_end_match:
        raise ValueError(f"Could not determine statement ending date in {path.name}")
    statement_end = datetime.strptime(period_end_match.group(1), "%B %d, %Y").date()
    events, stock_events, warnings = [], [], []
    security_names = list(known_security_names)
    holdings_aliases = [
        (f"{match.group(1).strip()} {match.group(2).strip()}", match.group(3))
        for match in re.finditer(
            r"(?m)^([A-Z][A-Z0-9 &.'/-]+)\s*\n"
            r"([A-Z][A-Z0-9 &.'/-]+)\s+\(([A-Z][A-Z.\-]{0,5})\)\s*$",
            text,
        )
    ] + [
        (match.group(1).strip(), match.group(2))
        for match in re.finditer(
            r"(?m)^([A-Z][A-Z0-9 &.'/-]+)\s*\n\(([A-Z][A-Z.\-]{0,5})\)\s*$",
            text,
        )
    ]
    for alias in holdings_aliases:
        security_names.append(alias)
        if alias not in known_security_names:
            known_security_names.append(alias)
    for line in text.splitlines():
        holding = re.match(r"^(.+?)\s+\(([A-Z][A-Z.\-]{0,5})\)\s+", line.strip())
        if holding and not holding.group(1).startswith(("CALL ", "PUT ")):
            alias = (holding.group(1).strip(), holding.group(2))
            security_names.append(alias)
            if alias not in known_security_names:
                known_security_names.append(alias)
    for month_day, body in chunks(text):
        contract = CONTRACT_RE.search(body)
        if not contract:
            trade = TRADE_RE.search(body)
            cusip = re.match(r"^(.*?)\s+[A-Z0-9]{9}\s+You\s+", body)
            if trade and cusip:
                security_name = cusip.group(1).strip()
                ticker = next(
                    (symbol for name, symbol in security_names
                     if security_name == name or security_name.startswith(name) or name.startswith(security_name)),
                    None,
                )
                if ticker:
                    action = trade.group("action").lower()
                    cash = abs(number(trade.group("amount")))
                    stock_events.append(StockEvent(
                        datetime.strptime(f"{year}-{month_day}", "%Y-%m/%d").date(),
                        ticker, action, abs(number(trade.group("qty"))),
                        -cash if action == "bought" else cash,
                        action == "bought" and "ASSIGNED PUTS" in body,
                    ))
            continue
        common = dict(
            when=datetime.strptime(f"{year}-{month_day}", "%Y-%m/%d").date(),
            ticker=contract.group("ticker"), kind=contract.group("kind"),
            expiry=date(2000 + int(contract.group("year")), MONTHS[contract.group("month")], int(contract.group("day"))),
            strike=number(contract.group("strike")), source=path.name,
        )
        trade = TRADE_RE.search(body)
        if trade:
            action = trade.group("action").lower()
            cash = number(trade.group("amount"))
            cash = -abs(cash) if action == "bought" else abs(cash)
            events.append(Event(**common, action=action, opening="OPENING TRANSACTION" in body,
                                closing="CLOSING TRANSACTION" in body,
                                qty=abs(number(trade.group("qty"))), cash=cash))
        elif any(word in body for word in ("Expired", "Assigned", "Exercised")):
            disposition = "Assigned" if "Assigned" in body else "Exercised" if "Exercised" in body else "Expired"
            qty = re.search(rf"{disposition}\s+(-?[\d,]+(?:\.\d+)?)", body)
            events.append(Event(**common, action=disposition.lower(), opening=False, closing=True,
                                qty=abs(number(qty.group(1))) if qty else 1.0, cash=0.0))
    return events, stock_events, warnings, statement_end


def match_stock(events: list[StockEvent]) -> tuple[list[StockLot], list[str]]:
    inventory: dict[str, list[dict[str, object]]] = defaultdict(list)
    lots, warnings = [], []
    for event in sorted(events, key=lambda item: item.when):
        if event.action == "bought":
            inventory[event.ticker].append({"event": event, "qty": event.qty, "cost": abs(event.cash)})
            continue
        remaining = event.qty
        queue = inventory[event.ticker]
        while remaining > 1e-8 and queue:
            entry = queue[0]
            opener = entry["event"]
            assert isinstance(opener, StockEvent)
            available = float(entry["qty"])
            matched = min(remaining, available)
            cost = float(entry["cost"]) * matched / available
            proceeds = event.cash * matched / event.qty
            lots.append(StockLot(event.ticker, opener.when, event.when, matched, cost, proceeds,
                                 opener.assigned_put))
            entry["qty"] = available - matched
            entry["cost"] = float(entry["cost"]) - cost
            remaining -= matched
            if float(entry["qty"]) <= 1e-8:
                queue.pop(0)
        if remaining > 1e-8:
            warnings.append(f"Underlying sale without an available-range purchase: {event.when} {event.ticker} x{remaining:g}")
    for queue in inventory.values():
        for entry in queue:
            opener = entry["event"]
            assert isinstance(opener, StockEvent)
            lots.append(StockLot(opener.ticker, opener.when, None, float(entry["qty"]),
                                 float(entry["cost"]), None, opener.assigned_put))
    return lots, warnings


def apply_covered_call_basis(option_lots: list[Lot], stock_lots: list[StockLot]) -> None:
    """Use underlying FIFO stock cost for long calls covered by matched shares."""
    for option in option_lots:
        if option.side != "long" or not option.contract.endswith(" C"):
            continue
        needed_shares = option.qty * 100
        covering = [
            stock for stock in stock_lots
            if stock.ticker == option.ticker
            and stock.opened <= option.opened
            and (stock.closed is None or option.closed is None or stock.closed >= option.closed)
        ]
        available_shares = sum(stock.qty for stock in covering)
        if available_shares + 1e-8 < needed_shares:
            continue
        shares_left = needed_shares
        cost_basis = 0.0
        for stock in covering:
            matched = min(shares_left, stock.qty)
            cost_basis += stock.cost / stock.qty * matched
            shares_left -= matched
            if shares_left <= 1e-8:
                break
        option.collateral = cost_basis


def has_stock_coverage(option: Lot, stock_lots: list[StockLot]) -> bool:
    if not option.contract.endswith(" C"):
        return False
    needed = option.qty * 100
    return sum(
        stock.qty for stock in stock_lots
        if stock.ticker == option.ticker and stock.opened <= option.opened
        and (stock.closed is None or option.closed is None or stock.closed >= option.closed)
    ) + 1e-8 >= needed


def match_events(events: list[Event]) -> tuple[list[Lot], list[str]]:
    open_by_contract: dict[str, list[dict[str, object]]] = defaultdict(list)
    lots, warnings = [], []
    # Fidelity can print a same-contract closing before its opening on the same
    # activity date. Register explicit openings first; ordinary rolls remain
    # distinct because expiration/strike/type are part of the contract key.
    for event in sorted(events, key=lambda item: (item.when, 0 if item.opening else 1)):
        queue = open_by_contract[event.contract]
        inferred_open = event.action in {"bought", "sold"} and not event.closing and not queue
        if event.opening or inferred_open:
            queue.append({"event": event, "qty": event.qty, "cash": event.cash})
            continue
        remaining = event.qty
        while remaining > 1e-8 and queue:
            entry = queue[0]
            opener = entry["event"]
            assert isinstance(opener, Event)
            available = float(entry["qty"])
            matched = min(remaining, available)
            open_cash = float(entry["cash"]) * matched / available
            close_cash = event.cash * matched / event.qty if event.qty else 0.0
            short = opener.action == "sold"
            lots.append(Lot(
                opener.contract, opener.ticker, "short" if short else "long", opener.when,
                event.when, matched, open_cash, close_cash,
                opener.strike * 100 * matched if short else abs(open_cash),
                f"{opener.source}; {event.source}",
            ))
            entry["qty"] = available - matched
            entry["cash"] = float(entry["cash"]) - open_cash
            remaining -= matched
            if float(entry["qty"]) <= 1e-8:
                queue.pop(0)
        if remaining > 1e-8 and event.action not in {"expired", "assigned", "exercised"}:
            warnings.append(f"Unmatched close: {event.when} {event.contract} {event.action} x{remaining:g}")
    for queue in open_by_contract.values():
        for entry in queue:
            opener = entry["event"]
            assert isinstance(opener, Event)
            qty, cash = float(entry["qty"]), float(entry["cash"])
            short = opener.action == "sold"
            lots.append(Lot(opener.contract, opener.ticker, "short" if short else "long",
                            opener.when, None, qty, cash, 0.0,
                            opener.strike * 100 * qty if short else abs(cash), opener.source))
    return lots, warnings


def stats(lots: list[Lot]) -> dict[str, float]:
    closed = [lot for lot in lots if lot.closed and lot.days]
    pnl = sum(lot.pnl for lot in closed)
    collateral = sum(lot.collateral for lot in closed)
    capital_days = sum(lot.collateral * (lot.days or 0) for lot in closed)
    return {"count": len(closed), "pnl": pnl,
            "return": pnl / collateral if collateral else 0.0,
            "apr": pnl * 365 / capital_days if capital_days else 0.0}


def campaign_stats(
    option_lots: list[Lot], stock_lots: list[StockLot], valuation_date: date,
) -> dict[str, float]:
    option = stats(option_lots)
    stocks = list(stock_lots)
    closed_stocks = [lot for lot in stocks if lot.closed]
    stock_pnl = sum(lot.pnl for lot in closed_stocks)
    stock_capital_days = sum(
        lot.cost * (lot.days if lot.closed else max(1, (valuation_date - lot.opened).days))
        for lot in stocks
    )
    closed_options = [lot for lot in option_lots if lot.closed and lot.days]
    # Covered long calls use stock cost in their detail rows, but the same capital is
    # already represented by the matched stock lot in a combined campaign.
    option_capital_days = sum(
        lot.collateral * (lot.days or 0) for lot in closed_options
        if not has_stock_coverage(lot, stock_lots)
    )
    total_pnl = option["pnl"] + stock_pnl
    capital_days = option_capital_days + stock_capital_days
    return {"count": option["count"], "option_pnl": option["pnl"], "stock_pnl": stock_pnl,
            "pnl": total_pnl, "return": total_pnl / sum(lot.cost for lot in stocks) if stocks else option["return"],
            "capital_days": capital_days,
            "apr": total_pnl * 365 / capital_days if capital_days else option["apr"]}


def yahoo_prices(
    tickers: list[str], delay: float, retries: int,
) -> tuple[dict[str, float], dict[str, dict[date, float]], list[str]]:
    prices, history, warnings = {}, {}, []
    headers = {"User-Agent": "Mozilla/5.0 FidelityOptionsAprReport/1.0"}
    for index, ticker in enumerate(sorted(set(tickers))):
        if index:
            time.sleep(delay)
        url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(ticker)
        url += "?range=5y&interval=1d"
        for attempt in range(retries + 1):
            try:
                request = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(request, timeout=20) as response:
                    result = json.load(response)["chart"]["result"][0]
                meta = result.get("meta", {})
                price = meta.get("regularMarketPrice")
                if not isinstance(price, (int, float)):
                    closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
                    price = next((value for value in reversed(closes) if isinstance(value, (int, float))), None)
                if not isinstance(price, (int, float)) or price <= 0:
                    raise ValueError("Yahoo returned no usable current price")
                prices[ticker] = float(price)
                timestamps = result.get("timestamp", [])
                closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
                history[ticker] = {
                    datetime.fromtimestamp(timestamp).date(): float(close)
                    for timestamp, close in zip(timestamps, closes)
                    if isinstance(timestamp, (int, float)) and isinstance(close, (int, float))
                }
                break
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
                if attempt >= retries:
                    warnings.append(f"Yahoo quote unavailable for {ticker}: {error}")
                else:
                    time.sleep(delay * (2 ** attempt))
    return prices, history, warnings


def mark_to_market_stats(
    option_lots: list[Lot],
    stock_lots: list[StockLot],
    prices: dict[str, float],
    valuation_date: date,
) -> dict[str, float]:
    realized = campaign_stats(option_lots, stock_lots, valuation_date)
    open_assigned = [lot for lot in stock_lots if not lot.closed and lot.assigned_put and lot.ticker in prices]
    unrealized = sum(prices[lot.ticker] * lot.qty - lot.cost for lot in open_assigned)
    total_pnl = realized["pnl"] + unrealized
    capital_days = realized["capital_days"]
    return {"pnl": total_pnl, "unrealized": unrealized,
            "apr": total_pnl * 365 / capital_days if capital_days else 0.0}


def month_end_dates(start: date, valuation_date: date) -> list[date]:
    result = []
    cursor = date(start.year, start.month, 1)
    while cursor <= valuation_date:
        next_month = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        result.append(min(next_month - timedelta(days=1), valuation_date))
        cursor = next_month
    return result


def price_as_of(
    ticker: str, as_of: date, current: dict[str, float], history: dict[str, dict[date, float]],
    valuation_date: date,
) -> float | None:
    if as_of == valuation_date and ticker in current:
        return current[ticker]
    eligible = [(day, price) for day, price in history.get(ticker, {}).items() if day <= as_of]
    return max(eligible, default=(None, None), key=lambda item: item[0])[1]


def monthly_kpis(
    option_lots: list[Lot], stock_lots: list[StockLot], current_prices: dict[str, float],
    price_history: dict[str, dict[date, float]], start: date, valuation_date: date,
) -> list[dict[str, object]]:
    rows = []
    for as_of in month_end_dates(start, valuation_date):
        closed_options = [lot for lot in option_lots if lot.closed and lot.closed <= as_of]
        open_options = [
            lot for lot in option_lots
            if lot.opened <= as_of
            and (lot.closed is None or lot.closed > as_of)
            and datetime.strptime(lot.contract.split()[1], "%Y-%m-%d").date() >= as_of
        ]
        stock_views = []
        for lot in stock_lots:
            if lot.opened > as_of:
                continue
            stock_views.append(lot if lot.closed and lot.closed <= as_of else StockLot(
                lot.ticker, lot.opened, None, lot.qty, lot.cost, None, lot.assigned_put,
            ))
        realized = campaign_stats(closed_options, stock_views, as_of)
        held_assigned = [lot for lot in stock_views if not lot.closed and lot.assigned_put]
        unrealized = 0.0
        quoted = 0
        for lot in held_assigned:
            price = price_as_of(lot.ticker, as_of, current_prices, price_history, valuation_date)
            if price is not None:
                unrealized += price * lot.qty - lot.cost
                quoted += 1
        marked_pnl = realized["pnl"] + unrealized
        rows.append({
            "month": as_of.strftime("%Y-%m"), "as_of": as_of,
            "realized_pnl": realized["pnl"], "realized_apr": realized["apr"],
            "matched": realized["count"], "open": len(open_options),
            "marked_pnl": marked_pnl,
            "marked_apr": marked_pnl * 365 / realized["capital_days"] if realized["capital_days"] else 0.0,
            "unrealized": unrealized, "quoted": quoted, "held": len(held_assigned),
        })
    return rows


def dollars(value: float) -> str:
    return f"${value:,.2f}" if value >= 0 else f"-${abs(value):,.2f}"


def bars(rows: list[tuple[str, float]], title: str, suffix: str) -> str:
    if not rows:
        return "<p>No realized trades to chart.</p>"
    maximum = max(abs(value) for _, value in rows) or 1
    zero, scale, height = 430, 300 / maximum, 42 + 36 * len(rows)
    items = [f'<svg viewBox="0 0 780 {height}" role="img" aria-label="{html.escape(title)}">',
             f'<text x="0" y="18" class="chart-title">{html.escape(title)}</text>',
             f'<line x1="{zero}" y1="28" x2="{zero}" y2="{height}" class="axis"/>']
    for index, (label, value) in enumerate(rows):
        y, width = 35 + index * 36, abs(value) * scale
        x = zero if value >= 0 else zero - width
        items += [f'<text x="0" y="{y + 15}">{html.escape(label)}</text>',
                  f'<rect x="{x}" y="{y}" width="{width}" height="20" class="{"pos" if value >= 0 else "neg"}"/>',
                  f'<text x="{x + width + 5 if value >= 0 else x - 5}" y="{y + 15}" text-anchor="{"start" if value >= 0 else "end"}">{value:.2f}{suffix}</text>']
    return "".join(items) + "</svg>"


def daily_capital_chart(lots: list[Lot], stock_lots: list[StockLot], start: date, end: date) -> str:
    series = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        option_capital = 0.0
        for lot in lots:
            expiry = datetime.strptime(lot.contract.split()[1], "%Y-%m-%d").date()
            effective_close = lot.closed or (expiry + timedelta(days=1))
            stock_coverage = sum(
                stock.qty for stock in stock_lots
                if stock.ticker == lot.ticker and stock.opened <= day
                and (stock.closed is None or day < stock.closed)
            )
            covered_call = lot.contract.endswith(" C") and stock_coverage + 1e-8 >= lot.qty * 100
            if lot.opened <= day < effective_close and not covered_call:
                option_capital += lot.collateral
        stock_capital = sum(
            lot.cost for lot in stock_lots
            if lot.opened <= day and (lot.closed is None or day < lot.closed)
        )
        series.append((day, option_capital + stock_capital))
    if not series:
        return "<p>No option-capital history to chart.</p>"
    width, height, left, right, top, bottom = 900, 330, 82, 25, 28, 58
    plot_width, plot_height = width - left - right, height - top - bottom
    maximum = max(value for _, value in series) or 1
    x_at = lambda index: left + plot_width * index / max(1, len(series) - 1)
    y_at = lambda value: top + plot_height * (1 - value / maximum)
    points = " ".join(f"{x_at(i):.1f},{y_at(value):.1f}" for i, (_, value) in enumerate(series))
    area = f"{left},{top + plot_height} {points} {left + plot_width},{top + plot_height}"
    elements = []
    for step in range(5):
        value = maximum * step / 4
        y = y_at(value)
        elements += [f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_width}" y2="{y:.1f}" class="grid"/>',
                     f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end">${value / 1000:,.0f}k</text>']
    for step in range(min(6, len(series))):
        index = round((len(series) - 1) * step / max(1, min(6, len(series)) - 1))
        elements.append(f'<text x="{x_at(index):.1f}" y="{height - 20}" text-anchor="middle">{series[index][0]:%b %d}</text>')
    peak_day, peak = max(series, key=lambda item: item[1])
    return (f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Daily allocated option capital">'
            + "".join(elements) + f'<polygon points="{area}" class="capital-area"/>'
            + f'<polyline points="{points}" class="capital-line"/>'
            + f'<text x="{left}" y="18" class="chart-title">Peak {dollars(peak)} on {peak_day:%b %d, %Y}</text></svg>')


def write_html(
    path: Path, lots: list[Lot], stock_lots: list[StockLot], prices: dict[str, float],
    price_history: dict[str, dict[date, float]],
    valuation_date: date, warnings: list[str], pdf_count: int,
) -> None:
    closed = [x for x in lots if x.closed]
    open_lots = [
        x for x in lots
        if not x.closed
        and x.opened <= valuation_date
        and datetime.strptime(x.contract.split()[1], "%Y-%m-%d").date() >= valuation_date
    ]
    portfolio = campaign_stats(closed, stock_lots, valuation_date)
    tickers = sorted({x.ticker for x in lots} | {x.ticker for x in stock_lots})
    by_ticker = [(ticker, campaign_stats(
        [x for x in closed if x.ticker == ticker],
        [x for x in stock_lots if x.ticker == ticker],
        valuation_date,
    )) for ticker in tickers]
    months: dict[str, list[Lot]] = defaultdict(list)
    for lot in closed:
        assert lot.closed
        months[lot.closed.strftime("%Y-%m")].append(lot)
    by_month = [(month, stats(group)) for month, group in sorted(months.items())]
    ticker_rows = "".join(f"<tr><td>{t}</td><td>{s['count']}</td><td>{dollars(s['option_pnl'])}</td><td>{dollars(s['stock_pnl'])}</td><td>{dollars(s['pnl'])}</td><td>{s['return']*100:.2f}%</td><td><b>{s['apr']*100:.2f}%</b></td></tr>" for t, s in by_ticker)
    closed_rows = "".join(f"<tr><td>{x.opened}</td><td>{x.closed}</td><td>{html.escape(x.contract)}</td><td>{x.side}</td><td>{x.qty:g}</td><td>{dollars(x.collateral)}</td><td>{dollars(x.pnl)}</td><td>{x.ret*100:.2f}%</td><td>{x.apr*100:.2f}%</td></tr>" for x in sorted(closed, key=lambda y: (y.closed or date.max, y.ticker)))
    open_rows = "".join(f"<tr><td>{x.opened}</td><td>{html.escape(x.contract)}</td><td>{x.side}</td><td>{x.qty:g}</td><td>{dollars(x.open_cash)}</td><td>{dollars(x.collateral)}</td></tr>" for x in open_lots) or "<tr><td colspan='6'>None</td></tr>"
    first = min((x.opened for x in lots), default=date.today())
    last = max((x.closed or x.opened for x in lots), default=date.today())
    open_assigned = [x for x in stock_lots if not x.closed and x.assigned_put]
    marked = mark_to_market_stats(closed, stock_lots, prices, valuation_date)
    assigned_rows = "".join(
        f"<tr><td>{x.ticker}</td><td>{x.opened}</td><td>{x.qty:g}</td><td>{dollars(x.cost)}</td>"
        f"<td>{dollars(x.cost / x.qty)}</td><td>{dollars(prices[x.ticker])}</td>"
        f"<td>{dollars(prices[x.ticker] * x.qty - x.cost)}</td></tr>"
        for x in open_assigned if x.ticker in prices
    ) or "<tr><td colspan='7'>No open assigned-put shares with an available Yahoo quote.</td></tr>"
    monthly_rows = monthly_kpis(lots, stock_lots, prices, price_history, first, valuation_date)
    monthly_table_rows = "".join(
        f"<tr><td>{row['month']}</td><td>{dollars(float(row['realized_pnl']))}</td>"
        f"<td>{float(row['realized_apr']) * 100:.2f}%</td><td>{int(row['matched'])}</td>"
        f"<td>{int(row['open'])}</td><td>{dollars(float(row['marked_pnl']))}</td>"
        f"<td>{float(row['marked_apr']) * 100:.2f}%</td><td>{dollars(float(row['unrealized']))}</td>"
        f"<td>{row['as_of']}</td></tr>" for row in monthly_rows
    )
    notes = "".join(f"<li>{html.escape(x)}</li>" for x in warnings) or "<li>None</li>"
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fidelity Options APR Report</title><style>
body{{margin:0;background:#f3f6fa;color:#172033;font:15px/1.45 Segoe UI,sans-serif}}main{{max-width:1160px;margin:auto;padding:30px 20px 60px}}h1{{margin-bottom:4px}}h2{{margin-top:0}}.muted{{color:#627083}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:24px 0}}.card,.panel{{background:#fff;border:1px solid #dfe6ef;border-radius:12px;box-shadow:0 4px 16px #1720330d}}.card{{padding:18px}}.card span{{display:block;color:#627083;font-size:13px}}.card strong{{font-size:27px}}.panel{{padding:20px;margin-top:18px;overflow:auto}}table{{width:100%;border-collapse:collapse;min-width:700px}}th,td{{padding:9px;border-bottom:1px solid #e7ecf2;text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}th{{font-size:12px;color:#627083;text-transform:uppercase}}.note{{border-left:4px solid #2563eb;background:#eff6ff;padding:12px}}svg{{width:100%;min-width:650px}}.axis{{stroke:#aab5c3}}.grid{{stroke:#dfe6ef;stroke-width:1}}.pos{{fill:#059669}}.neg{{fill:#dc2626}}.capital-area{{fill:#2563eb;opacity:.14}}.capital-line{{fill:none;stroke:#2563eb;stroke-width:3;stroke-linejoin:round}}.chart-title{{font-weight:700}}@media print{{body{{background:white}}.panel,.card{{box-shadow:none}}}}
</style></head><body><main><h1>Fidelity Options APR Report</h1><p class="muted">{first} through {last} · {pdf_count} statements · generated {datetime.now():%Y-%m-%d %H:%M}</p>
<div class="cards"><div class="card"><span>Combined realized P&amp;L</span><strong>{dollars(portfolio['pnl'])}</strong></div><div class="card"><span>Combined portfolio APR</span><strong>{portfolio['apr']*100:.2f}%</strong></div><div class="card"><span>Matched option lots</span><strong>{portfolio['count']}</strong></div><div class="card"><span>Open option lots</span><strong>{len(open_lots)}</strong></div></div>
<div class="cards"><div class="card"><span>P&amp;L incl. open assigned shares</span><strong>{dollars(marked['pnl'])}</strong></div><div class="card"><span>APR incl. open assigned shares</span><strong>{marked['apr']*100:.2f}%</strong></div><div class="card"><span>Unrealized assigned-share P&amp;L</span><strong>{dollars(marked['unrealized'])}</strong></div><div class="card"><span>Yahoo valuation date</span><strong>{valuation_date}</strong></div></div>
<section class="panel"><h2>Monthly portfolio measures</h2><table><thead><tr><th>Month</th><th>Combined realized P&amp;L</th><th>Combined portfolio APR</th><th>Matched option lots</th><th>Open option lots</th><th>P&amp;L incl. open assigned shares</th><th>APR incl. open assigned shares</th><th>Unrealized assigned-share P&amp;L</th><th>Valuation date</th></tr></thead><tbody>{monthly_table_rows}</tbody></table><p class="muted">Each row is a cumulative as-of month-end snapshot using the latest Yahoo close on or before that statement month end. The table stops at the latest input statement.</p></section>
<p class="note"><b>Method:</b> Ticker summaries combine realized option cash flows with FIFO-matched stock gains/losses. During a covered call, the call's premium or closing P&amp;L contributes to return while the underlying stock cost remains the single capital allocation. Stock-holding days without realized option income contribute zero realized return and remain in capital-days through the Yahoo valuation date. Unrealized price changes appear only in the separate mark-to-market calculation. This is not tax or investment advice.</p>
<section class="panel"><h2>Combined APR by ticker</h2>{bars([(t,s['apr']*100) for t,s in by_ticker], 'Stock-and-option capital-time-weighted realized APR', '%')}</section>
<section class="panel"><h2>Ticker campaign summary</h2><table><thead><tr><th>Ticker</th><th>Option lots</th><th>Option P&amp;L</th><th>Realized stock P&amp;L</th><th>Combined P&amp;L</th><th>Combined return*</th><th>Combined APR</th></tr></thead><tbody>{ticker_rows}</tbody></table><p class="muted">* Combined P&amp;L divided by matched stock cost. APR includes capital-time for both sold and still-held shares; held shares contribute zero realized return until sold.</p></section>
<section class="panel"><h2>Daily allocated capital</h2>{daily_capital_chart(lots, stock_lots, first, valuation_date)}<p class="muted">All held shares remain allocated at FIFO cost until sold. Short options use strike × 100 × contracts unless covered by held shares. Other long options use premium paid. Unmatched open options are carried only through contractual expiration.</p></section>
<section class="panel"><h2>Open shares acquired by assigned puts</h2><table><thead><tr><th>Ticker</th><th>Assigned</th><th>Shares</th><th>Cost basis</th><th>Exercise price</th><th>Yahoo price as of {valuation_date}</th><th>Unrealized P&amp;L</th></tr></thead><tbody>{assigned_rows}</tbody></table><p class="muted">Prices use the latest Yahoo close on or before the latest input statement date. The separate mark-to-market APR includes these unrealized gains or losses and their capital-days; realized APR remains unchanged.</p></section>
<section class="panel"><h2>Monthly realized P&amp;L</h2>{bars([(m,s['pnl']) for m,s in by_month], 'Net realized option P&L', ' USD')}</section>
<section class="panel"><h2>Realized transactions</h2><table><thead><tr><th>Opened</th><th>Closed</th><th>Contract</th><th>Side</th><th>Qty</th><th>Collateral</th><th>P&amp;L</th><th>Return</th><th>APR</th></tr></thead><tbody>{closed_rows}</tbody></table></section>
<section class="panel"><h2>Open / incomplete transactions</h2><table><thead><tr><th>Opened</th><th>Contract</th><th>Side</th><th>Qty</th><th>Opening cash</th><th>Collateral</th></tr></thead><tbody>{open_rows}</tbody></table></section>
<section class="panel"><h2>Parser review notes</h2><ul>{notes}</ul></section></main></body></html>'''
    path.write_text(page, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("input/fidelity"))
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="HTML path (default: output/fidelity/reports/fidelity-options-apr-YYYYMM.html)",
    )
    parser.add_argument("--quote-delay", type=float, default=1.5, help="Seconds between Yahoo requests")
    parser.add_argument("--quote-retries", type=int, default=2, help="Yahoo retries per ticker")
    args = parser.parse_args()
    if args.output is None:
        args.output = Path("output/fidelity/reports") / f"fidelity-options-apr-{date.today():%Y%m}.html"
    pdfs = sorted(args.input.glob("*.pdf"))
    if not pdfs:
        parser.error(f"No PDFs found in {args.input}")
    events, stock_events, warnings = [], [], []
    statement_ends: list[date] = []
    known_security_names: list[tuple[str, str]] = []
    for pdf in pdfs:
        found, found_stocks, review, statement_end = parse_pdf(pdf, known_security_names)
        events += found
        stock_events += found_stocks
        warnings += review
        statement_ends.append(statement_end)
    if not events:
        raise SystemExit("No option transactions found in the supplied statements.")
    matched_stock_events: set[int] = set()
    for assignment in (event for event in events if event.action == "assigned"):
        shares = assignment.qty * 100
        stock_action = "bought" if assignment.kind == "PUT" else "sold"
        candidates = [
            (index, stock) for index, stock in enumerate(stock_events)
            if index not in matched_stock_events
            and stock.ticker == assignment.ticker and stock.action == stock_action
            and abs(stock.qty - shares) < 1e-8
            # Settlement can cross a weekend/holiday; price, side, ticker, and
            # quantity constraints keep this wider calendar window unambiguous.
            and abs((stock.when - assignment.when).days) <= 7
            and abs(abs(stock.cash) - assignment.strike * shares) <= max(2.0, shares * 0.02)
        ]
        match = min(candidates, key=lambda item: abs((item[1].when - assignment.when).days), default=None)
        existing = match[1] if match else None
        if existing:
            if assignment.kind == "PUT":
                existing.assigned_put = True
            matched_stock_events.add(match[0])
        else:
            cash = assignment.strike * shares
            stock_events.append(StockEvent(
                assignment.when, assignment.ticker, stock_action, shares,
                -cash if stock_action == "bought" else cash,
                assignment.kind == "PUT",
            ))
    lots, matching_notes = match_events(events)
    warnings += matching_notes
    stock_lots, stock_notes = match_stock(stock_events)
    warnings += stock_notes
    # Statements also contain ordinary portfolio holdings (including mutual
    # funds) that have no relationship to an options campaign.  Parsing those
    # transactions is useful for finding covered-call stock, but they must not
    # inflate options-strategy capital or dilute its APR.
    option_tickers = {event.ticker for event in events}
    stock_lots = [lot for lot in stock_lots if lot.ticker in option_tickers]
    apply_covered_call_basis(lots, stock_lots)
    valuation_date = max(statement_ends)
    quote_tickers = [lot.ticker for lot in stock_lots if lot.assigned_put]
    current_prices, price_history, quote_notes = yahoo_prices(
        quote_tickers, max(0.0, args.quote_delay), max(0, args.quote_retries),
    )
    warnings += quote_notes
    prices = {}
    for ticker in quote_tickers:
        eligible = [(day, price) for day, price in price_history.get(ticker, {}).items()
                    if day <= valuation_date]
        if eligible:
            prices[ticker] = max(eligible, key=lambda item: item[0])[1]
        elif ticker in current_prices:
            warnings.append(
                f"No Yahoo close on or before {valuation_date} for {ticker}; current price was not used."
            )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_html(
        args.output, lots, stock_lots, prices, price_history,
        valuation_date, warnings, len(pdfs),
    )
    print(f"Parsed {len(events)} option events into {len(lots)} realized/open lots.")
    print(f"HTML: {args.output.resolve()}")
    print(f"Review notes: {len(warnings)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
