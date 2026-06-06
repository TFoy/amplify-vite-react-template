#!/usr/bin/env python3
"""
Retrieve the previous 10 years of annual 10-K reports for a given stock ticker.

If the company has fewer than 10 years of 10-K reports available, retrieves as many
as are available.

Uses the SEC EDGAR API to fetch the reports.

Example:
  python scripts/retrieve_10k_reports.py AAPL
  python scripts/retrieve_10k_reports.py --ticker MSFT --output ./msft_10ks.json
  python scripts/retrieve_10k_reports.py --ticker MSFT --download-dir ./msft_10ks
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zlib
from typing import Any


SEC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
}


def decode_response_payload(payload: bytes, content_encoding: str) -> bytes:
    """Decode compressed SEC response bytes."""
    content_encoding = content_encoding.lower()

    if content_encoding == "gzip":
        return gzip.decompress(payload)
    if content_encoding == "deflate":
        return zlib.decompress(payload)

    return payload


def make_sec_bytes_request(url: str, accept: str = "*/*") -> tuple[bytes, str] | None:
    """
    Make a request to the SEC API and return response bytes plus charset.
    
    Args:
        url: The URL to request
        accept: The Accept header value
    
    Returns:
        Tuple of response bytes and charset, or None if request fails
    """
    headers = {**SEC_HEADERS, 'Accept': accept}

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = response.read()
            payload = decode_response_payload(
                payload,
                response.headers.get("Content-Encoding", ""),
            )
            charset = response.headers.get_content_charset() or "utf-8"
            return payload, charset
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.reason}")
        return None
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}")
        return None
    except Exception as e:
        print(f"Request error: {e}")
        return None


def make_sec_request(url: str) -> dict | None:
    """
    Make a request to the SEC API with proper headers and error handling.
    
    Args:
        url: The URL to request
    
    Returns:
        Parsed JSON response or None if request fails
    """
    try:
        response = make_sec_bytes_request(url, accept="application/json")
        if not response:
            return None

        payload, charset = response
        return json.loads(payload.decode(charset))
    except Exception as e:
        print(f"Request error: {e}")
        return None


def write_json_file(output_path: str, reports: list[dict[str, Any]]) -> None:
    """Write report data to a JSON file, creating parent directories if needed."""
    parent_dir = os.path.dirname(os.path.abspath(output_path))
    if os.path.exists(parent_dir) and not os.path.isdir(parent_dir):
        raise NotADirectoryError(f"Output parent is not a directory: {parent_dir}")

    os.makedirs(parent_dir, exist_ok=True)

    with open(output_path, 'w', encoding="utf-8") as f:
        json.dump(reports, f, indent=2, default=str)


def validate_output_path(output_path: str) -> None:
    """Validate that a JSON output file can be created later."""
    parent_dir = os.path.dirname(os.path.abspath(output_path))
    if os.path.exists(parent_dir) and not os.path.isdir(parent_dir):
        raise NotADirectoryError(f"Output parent is not a directory: {parent_dir}")


def sanitize_filename(value: str) -> str:
    """Return a filesystem-safe filename segment."""
    safe_chars = []

    for char in value:
        if char.isalnum() or char in ("-", "_", "."):
            safe_chars.append(char)
        else:
            safe_chars.append("_")

    return "".join(safe_chars).strip("._") or "filing"


def download_report_documents(
    reports: list[dict[str, Any]],
    ticker: str,
    download_dir: str,
) -> int:
    """Download each report's primary HTML document and add local file paths."""
    os.makedirs(download_dir, exist_ok=True)
    downloaded_count = 0

    for report in reports:
        document_url = report.get("primary_document_url") or report.get("complete_submission_url")
        if not document_url:
            print(f"Skipping {report.get('accession_number', 'N/A')}: no document URL")
            continue

        filing_date = sanitize_filename(report.get("filing_date", "unknown_date"))
        accession_number = sanitize_filename(report.get("accession_number", "unknown_accession"))
        primary_document = report.get("primary_document") or f"{accession_number}.html"
        _, extension = os.path.splitext(primary_document)
        if not extension:
            extension = ".html"

        output_name = f"{ticker.lower()}_{filing_date}_{accession_number}{extension}"
        output_path = os.path.join(download_dir, output_name)

        time.sleep(0.5)
        response = make_sec_bytes_request(document_url, accept="text/html,application/xhtml+xml,text/plain,*/*")
        if not response:
            print(f"Could not download {document_url}")
            continue

        payload, _charset = response
        with open(output_path, "wb") as f:
            f.write(payload)

        report["local_file"] = output_path
        downloaded_count += 1
        print(f"Downloaded {report.get('filing_date', 'N/A')} report to {output_path}")

    return downloaded_count


def get_cik_from_ticker(ticker: str) -> str | None:
    """
    Retrieve the CIK (Central Index Key) for a ticker symbol from SEC EDGAR.
    
    Args:
        ticker: Stock ticker symbol (e.g., 'AAPL')
    
    Returns:
        CIK as a string, or None if not found
    """
    try:
        url = "https://www.sec.gov/files/company_tickers.json"
        data = make_sec_request(url)
        
        if not data:
            print(f"Could not fetch company tickers list")
            return None
        
        for entry in data.values():
            if entry.get("ticker", "").upper() == ticker.upper():
                # Pad CIK to 10 digits with leading zeros
                cik = str(entry.get("cik_str", "")).zfill(10)
                print(f"Found CIK for {ticker}: {cik}")
                return cik
        
        print(f"Ticker {ticker} not found in company tickers list")
        return None
    except Exception as e:
        print(f"Error fetching CIK for {ticker}: {e}")
        return None


def add_10k_reports_from_filings(
    reports: list[dict[str, Any]],
    filings: dict[str, list[Any]],
    cik: str,
    max_years: int,
    seen_accessions: set[str],
) -> None:
    """Append 10-K filings from one SEC submissions payload."""
    forms = filings.get("form", [])
    dates = filings.get("filingDate", [])
    accession_nums = filings.get("accessionNumber", [])
    primary_documents = filings.get("primaryDocument", [])

    for i, form in enumerate(forms):
        if len(reports) >= max_years:
            return

        if form != "10-K":
            continue

        accession_number = accession_nums[i] if i < len(accession_nums) else "N/A"
        if accession_number in seen_accessions:
            continue

        seen_accessions.add(accession_number)
        accession_path = accession_number.replace("-", "")
        primary_document = primary_documents[i] if i < len(primary_documents) else ""

        report = {
            "form": "10-K",
            "filing_date": dates[i] if i < len(dates) else "N/A",
            "accession_number": accession_number,
            "filing_url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_path}/",
            "complete_submission_url": (
                f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_path}/{accession_number}.txt"
            ),
            "document_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-K&dateb=&owner=exclude&count=100",
        }

        if primary_document and accession_number != "N/A":
            report["primary_document"] = primary_document
            report["primary_document_url"] = (
                f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_path}/{primary_document}"
            )

        reports.append(report)


def retrieve_10k_reports(ticker: str, max_years: int = 10) -> list[dict[str, Any]]:
    """
    Retrieve 10-K annual reports for a given stock ticker.
    
    Args:
        ticker: Stock ticker symbol (e.g., 'AAPL')
        max_years: Maximum number of years of reports to retrieve (default: 10)
    
    Returns:
        List of dictionaries containing 10-K report information
    """
    # Get CIK for the ticker
    cik = get_cik_from_ticker(ticker)
    if not cik:
        print(f"Could not find CIK for ticker: {ticker}")
        return []
    
    try:
        # Add a small delay to respect SEC rate limits
        time.sleep(0.5)
        
        # Query SEC EDGAR API for 10-K filings
        url = f"https://data.sec.gov/submissions/CIK{cik}.json"
        data = make_sec_request(url)
        
        if not data:
            print(f"Could not retrieve filings for {ticker}")
            return []
        
        reports = []
        seen_accessions = set()

        recent_filings = data.get("filings", {}).get("recent", {})
        add_10k_reports_from_filings(reports, recent_filings, cik, max_years, seen_accessions)

        for filing_file in data.get("filings", {}).get("files", []):
            if len(reports) >= max_years:
                break

            file_name = filing_file.get("name")
            if not file_name:
                continue

            time.sleep(0.5)
            older_data = make_sec_request(f"https://data.sec.gov/submissions/{file_name}")
            if older_data:
                add_10k_reports_from_filings(
                    reports,
                    older_data,
                    cik,
                    max_years,
                    seen_accessions,
                )

        if reports:
            print(f"Retrieved {len(reports)} 10-K report(s) for {ticker}")
        else:
            print(f"No 10-K reports found for ticker: {ticker}")
        
        return reports
    
    except Exception as e:
        print(f"Error retrieving 10-K reports for {ticker}: {e}")
        return []


def format_report_info(reports: list[dict[str, Any]]) -> str:
    """Format report information for display."""
    if not reports:
        return "No reports found."
    
    output = []
    for i, report in enumerate(reports, 1):
        output.append(f"\n{i}. Filing Date: {report.get('filing_date', 'N/A')}")
        output.append(f"   Accession Number: {report.get('accession_number', 'N/A')}")
        output.append(f"   Form: {report.get('form', 'N/A')}")
    
    return "\n".join(output)


def main():
    parser = argparse.ArgumentParser(
        description="Retrieve 10-K annual reports for a stock ticker"
    )
    parser.add_argument(
        "ticker",
        nargs="?",
        type=str.upper,
        help="Stock ticker symbol (e.g., AAPL)"
    )
    parser.add_argument(
        "--ticker",
        dest="ticker_option",
        type=str.upper,
        help="Stock ticker symbol (e.g., AAPL). Kept for compatibility; positional ticker is preferred."
    )
    parser.add_argument(
        "--max-years",
        type=int,
        default=10,
        help="Maximum number of years to retrieve (default: 10)"
    )
    parser.add_argument(
        "--output",
        type=str,
        help="Output file path for JSON results (default: .\\output\\<ticker>_10ks_download_test.json)"
    )
    parser.add_argument(
        "--download-dir",
        type=str,
        help="Directory where the 10-K HTML report documents should be downloaded (default: .\\output\\<ticker>_10k_docs)"
    )
    
    args = parser.parse_args()
    ticker = args.ticker_option or args.ticker

    if not ticker:
        parser.error("a ticker symbol is required, e.g. python retrieve_10k_reports.py MSFT")

    args.output = args.output or os.path.join(".", "output", f"{ticker.lower()}_10ks_download_test.json")
    args.download_dir = args.download_dir or os.path.join(".", "output", f"{ticker.lower()}_10k_docs")

    if args.output:
        try:
            validate_output_path(args.output)
        except OSError as e:
            print(f"Could not write results to {args.output}: {e}")
            sys.exit(1)
    
    print(f"Retrieving 10-K reports for {ticker}...")
    
    reports = retrieve_10k_reports(ticker, args.max_years)
    
    if reports:
        print(format_report_info(reports))

        if args.download_dir:
            try:
                downloaded_count = download_report_documents(
                    reports,
                    ticker,
                    args.download_dir,
                )
                print(f"\nDownloaded {downloaded_count} report document(s) to: {args.download_dir}")
            except OSError as e:
                print(f"\nCould not download reports to {args.download_dir}: {e}")
                sys.exit(1)
        
        if args.output:
            try:
                write_json_file(args.output, reports)
                print(f"\nResults saved to: {args.output}")
            except OSError as e:
                print(f"\nCould not write results to {args.output}: {e}")
                sys.exit(1)
    else:
        print(f"No 10-K reports found for {ticker}")
        sys.exit(1)


if __name__ == "__main__":
    main()
