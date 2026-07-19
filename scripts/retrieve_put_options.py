#!/usr/bin/env python3
"""Display cash-secured put returns for one ticker and expiration date.

Example:
  python scripts/retrieve_put_options.py AAPL 2026-09-18

The displayed APR is a simple annualized return:
  (option midpoint / strike) * (365 / calendar days to expiration) * 100

It assumes the put expires worthless and ignores fees, taxes, interest earned on
cash collateral, and the possibility of early assignment.
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yfinance as yf
from tabulate import tabulate


def parse_expiration(value: str) -> date:
    """Parse an ISO expiration date for argparse."""
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"invalid expiration {value!r}; use YYYY-MM-DD"
        ) from exc


def finite_number(value: Any) -> float | None:
    """Convert a quote value to a finite float, or return None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def build_rows(puts: Any, days_to_expiration: int) -> list[list[str]]:
    """Build printable rows from yfinance's put-chain DataFrame."""
    rows: list[list[str]] = []
    for _, put in puts.sort_values("strike").iterrows():
        strike = finite_number(put.get("strike"))
        bid = finite_number(put.get("bid"))
        ask = finite_number(put.get("ask"))
        if strike is None or strike <= 0 or bid is None or ask is None:
            continue

        midpoint = (bid + ask) / 2
        period_return = midpoint / strike
        annual_return = period_return * 365 / days_to_expiration
        rows.append(
            [
                f"${strike:,.2f}",
                f"${bid:,.2f}",
                f"${ask:,.2f}",
                f"${midpoint:,.2f}",
                f"{period_return * 100:.2f}%",
                f"{annual_return * 100:.2f}%",
            ]
        )
    return rows


def get_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="List put strikes, bid/ask midpoints, and cash-secured-put APRs."
    )
    parser.add_argument("ticker", help="Stock ticker symbol, for example AAPL")
    parser.add_argument("expiration", type=parse_expiration, help="Expiration (YYYY-MM-DD)")
    return parser


def main() -> int:
    args = get_parser().parse_args()
    ticker_symbol = args.ticker.strip().upper()
    expiration: date = args.expiration
    days_to_expiration = (expiration - date.today()).days

    if not ticker_symbol:
        print("error: ticker cannot be empty", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[A-Z0-9.^=-]+", ticker_symbol):
        print("error: ticker contains unsupported characters", file=sys.stderr)
        return 2
    if days_to_expiration <= 0:
        print("error: expiration must be after today", file=sys.stderr)
        return 2

    try:
        ticker = yf.Ticker(ticker_symbol)
        available_expirations = tuple(ticker.options)
        expiration_text = expiration.isoformat()
        if expiration_text not in available_expirations:
            available = ", ".join(available_expirations) or "none returned"
            print(
                f"error: {expiration_text} is not an available expiration for "
                f"{ticker_symbol}. Available: {available}",
                file=sys.stderr,
            )
            return 1
        puts = ticker.option_chain(expiration_text).puts
    except Exception as exc:
        print(f"error: could not retrieve the option chain: {exc}", file=sys.stderr)
        return 1

    rows = build_rows(puts, days_to_expiration)
    if not rows:
        print("No puts with valid bid, ask, and strike values were returned.", file=sys.stderr)
        return 1

    heading = (
        f"{ticker_symbol} puts expiring {expiration} "
        f"({days_to_expiration} calendar days)"
    )
    table = tabulate(
        rows,
        headers=["Strike", "Bid", "Ask", "Midpoint", "Period return", "Simple APR"],
        # ASCII-only so output works in legacy Windows PowerShell code pages.
        tablefmt="github",
        colalign=("right",) * 6,
    )
    note = (
        "Simple APR = (midpoint / strike) x (365 / days to expiration). "
        "Assumes expiration without assignment; excludes fees, taxes, and cash interest."
    )
    report = f"{heading}\n\n{table}\n\n{note}\n"

    output_path = Path("output") / ticker_symbol / f"CSP_{expiration.isoformat()}.txt"
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report, encoding="utf-8")
    except OSError as exc:
        print(f"error: could not write {output_path}: {exc}", file=sys.stderr)
        return 1

    print(f"Wrote {len(rows)} put-option rows to {output_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
