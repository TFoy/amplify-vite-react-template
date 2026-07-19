#!/usr/bin/env python3
"""
Retrieve the previous 10 years of annual 10-K reports for a given stock ticker.

If the company has fewer than 10 years of 10-K reports available, retrieves as many
as are available.

Uses the SEC EDGAR API to fetch the reports.

Example:
  python scripts/retrieve_10k_reports.py AAPL
  python scripts/retrieve_10k_reports.py --ticker MSFT --output ./output/msft/msft_10ks.json
  python scripts/retrieve_10k_reports.py --ticker MSFT --download-dir ./output/msft/10k_docs
  python scripts/retrieve_10k_reports.py MSFT --analyze
"""

from __future__ import annotations

import argparse
import base64
import gzip
import html
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib
from html.parser import HTMLParser
from typing import Any


OPENAI_API_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4")
DEFAULT_ANALYSIS_CHARS_PER_REPORT = 120_000
MAX_INLINE_OPENAI_FILE_BYTES = 20 * 1024 * 1024
OPENAI_MAX_RETRIES = 3
OPENAI_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}
SEC_REQUEST_DELAY_SECONDS = 1.0

SEC_HEADERS = {
    'User-Agent': 'Thomas Foy thomas.foy@live.com',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
}


class FilingTextExtractor(HTMLParser):
    """Small stdlib HTML-to-text extractor for SEC filing documents."""

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "head"}:
            self._skip_depth += 1
        elif tag in {"br", "p", "div", "tr", "li", "table", "h1", "h2", "h3"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "head"} and self._skip_depth:
            self._skip_depth -= 1
        elif tag in {"p", "div", "tr", "li", "table", "h1", "h2", "h3"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self._parts.append(data)

    def text(self) -> str:
        content = html.unescape(" ".join(self._parts))
        content = re.sub(r"[ \t\r\f\v]+", " ", content)
        content = re.sub(r"\n\s*\n\s*", "\n\n", content)
        return content.strip()


def make_openai_request(
    path: str,
    api_key: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """POST JSON to the OpenAI API and return the parsed response."""
    body = json.dumps(payload).encode("utf-8")

    for attempt in range(1, OPENAI_MAX_RETRIES + 1):
        req = urllib.request.Request(
            f"{OPENAI_API_BASE_URL}{path}",
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=300) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            details = e.read().decode("utf-8", errors="replace")
            if e.code in OPENAI_RETRY_STATUS_CODES and attempt < OPENAI_MAX_RETRIES:
                wait_seconds = 2 ** attempt
                print(
                    f"OpenAI API error {e.code}; retrying in {wait_seconds} seconds "
                    f"({attempt}/{OPENAI_MAX_RETRIES})..."
                )
                time.sleep(wait_seconds)
                continue

            raise RuntimeError(f"OpenAI API error {e.code}: {details}") from e

    raise RuntimeError("OpenAI API request failed after retries")


def upload_openai_file(file_path: str, api_key: str) -> str:
    """Upload a file to OpenAI and return the resulting file ID."""
    boundary = f"----codex-10k-{uuid.uuid4().hex}"
    filename = os.path.basename(file_path)
    content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"

    with open(file_path, "rb") as f:
        file_bytes = f.read()

    body = b"".join(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            b'Content-Disposition: form-data; name="purpose"\r\n\r\n',
            b"user_data\r\n",
            f"--{boundary}\r\n".encode("utf-8"),
            (
                'Content-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode("utf-8"),
        ]
    )

    req = urllib.request.Request(
        f"{OPENAI_API_BASE_URL}/files",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        details = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI file upload error {e.code}: {details}") from e

    file_id = result.get("id")
    if not file_id:
        raise RuntimeError(f"OpenAI file upload response did not include an id: {result}")

    return file_id


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
        details = e.read().decode("utf-8", errors="replace").strip()
        print(f"HTTP Error {e.code}: {e.reason} for {url}")
        if details:
            print(f"SEC response: {details[:1000]}")
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


def write_json_data_file(output_path: str, data: dict[str, Any]) -> None:
    """Write JSON data to a file, creating parent directories if needed."""
    parent_dir = os.path.dirname(os.path.abspath(output_path))
    if os.path.exists(parent_dir) and not os.path.isdir(parent_dir):
        raise NotADirectoryError(f"Output parent is not a directory: {parent_dir}")

    os.makedirs(parent_dir, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
        f.write("\n")


def write_text_file(output_path: str, content: str) -> None:
    """Write text to a file, creating parent directories if needed."""
    parent_dir = os.path.dirname(os.path.abspath(output_path))
    if os.path.exists(parent_dir) and not os.path.isdir(parent_dir):
        raise NotADirectoryError(f"Output parent is not a directory: {parent_dir}")

    os.makedirs(parent_dir, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)


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


def fetch_yahoo_stock_snapshot(ticker: str, output_path: str) -> dict[str, Any]:
    """Run the Yahoo Finance snapshot script and return its parsed JSON output."""
    script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yahoo_stock_snapshot.mjs")
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"Yahoo snapshot script not found: {script_path}")

    parent_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent_dir, exist_ok=True)

    result = subprocess.run(
        ["node", script_path, ticker.upper(), "--output", output_path],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        error_text = (result.stderr or result.stdout or "unknown error").strip()
        raise RuntimeError(f"Yahoo snapshot script failed: {error_text}")

    try:
        snapshot = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Yahoo snapshot script returned invalid JSON: {result.stdout}") from e

    if not os.path.exists(output_path):
        write_json_data_file(output_path, snapshot)

    return snapshot


def read_report_text(file_path: str) -> str:
    """Read a downloaded filing and return plain-ish text for model input."""
    with open(file_path, "rb") as f:
        payload = f.read()

    raw_text = payload.decode("utf-8", errors="replace")
    extension = os.path.splitext(file_path)[1].lower()
    if extension in {".htm", ".html", ".xhtml", ".xml"} or "<html" in raw_text[:1000].lower():
        parser = FilingTextExtractor()
        parser.feed(raw_text)
        return parser.text()

    return raw_text.strip()


def write_analysis_corpus_file(
    reports: list[dict[str, Any]],
    ticker: str,
    output_path: str,
    max_chars_per_report: int,
    stock_snapshot: dict[str, Any] | None = None,
) -> str:
    """Create a model-readable text corpus from downloaded 10-K documents."""
    parent_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(parent_dir, exist_ok=True)

    sections = [
        f"Ticker: {ticker.upper()}",
        f"Report count: {len(reports)}",
        "Source: Downloaded SEC EDGAR annual 10-K filing documents.",
    ]

    if stock_snapshot:
        sections.append(
            "\n".join(
                [
                    "\n" + "=" * 80,
                    "Current Yahoo Finance stock snapshot",
                    "=" * 80,
                    json.dumps(stock_snapshot, indent=2, default=str),
                ]
            )
        )

    for report in reports:
        local_file = report.get("local_file")
        if not local_file or not os.path.exists(local_file):
            continue

        text = read_report_text(local_file)
        if len(text) > max_chars_per_report:
            text = text[:max_chars_per_report] + "\n\n[Truncated for analysis input size.]"

        sections.append(
            "\n".join(
                [
                    "\n" + "=" * 80,
                    f"Filing date: {report.get('filing_date', 'N/A')}",
                    f"Accession number: {report.get('accession_number', 'N/A')}",
                    f"Primary document URL: {report.get('primary_document_url', 'N/A')}",
                    "=" * 80,
                    text,
                ]
            )
        )

    write_text_file(output_path, "\n\n".join(sections))
    return output_path


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

        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            report["local_file"] = output_path
            print(f"Already downloaded {report.get('filing_date', 'N/A')} report at {output_path}")
            continue

        time.sleep(SEC_REQUEST_DELAY_SECONDS)
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


def build_graham_analysis_prompt(
    ticker: str,
    reports: list[dict[str, Any]],
    stock_snapshot: dict[str, Any] | None,
) -> str:
    """Build a prompt for a value-investing analysis of the 10-Ks."""
    report_lines = [
        f"- {report.get('filing_date', 'N/A')}: {report.get('accession_number', 'N/A')}"
        for report in reports
    ]
    snapshot_text = (
        json.dumps(stock_snapshot, indent=2, default=str)
        if stock_snapshot
        else "No Yahoo Finance snapshot was provided."
    )

    return f"""
You are analyzing a model-readable text corpus derived from a current Yahoo
Finance snapshot and annual 10-K reports for {ticker.upper()}.

The attached corpus contains a top-level section titled exactly:
"Current Yahoo Finance stock snapshot"

Use that section for current market data. It includes fields such as
currentSharePrice, marketCapitalization, trailingPE, forwardPE,
enterpriseValueToFreeCashFlow, dividendYieldPercent, treasuryYields,
totalCash, totalDebt, netCashOrNetDebt, and netCashOrNetDebtLabel.

For redundancy, here is the same Yahoo Finance snapshot JSON:
{snapshot_text}

Use a Benjamin Graham-inspired value-investing framework: margin of safety,
quality and durability of earnings, balance-sheet strength, conservative
valuation, dividend record where available, cyclicality, and downside risk.
Do not imitate Graham's prose style; apply his investment principles.

Reports included:
{os.linesep.join(report_lines)}

Produce a rigorous but concise investment memo with:
1. Company overview and business-quality assessment.
2. Ten-year operating performance overview, including revenue, earnings,
   cash-flow, debt, dilution, margins, and any major strategic shifts you can
   identify from the filings.
3. Current valuation context using the Yahoo snapshot, including share price,
   market capitalization, P/E ratios, enterprise value to free cash flow,
   dividend yield, Treasury yields, and net cash/debt position.
4. Graham-style strengths, concerns, and unresolved questions.
5. A comparable rating object that can be used across tickers:
   - overall_score: integer 0-100
   - rating_label: one of Strong Avoid, Avoid, Watchlist, Fair, Attractive, Exceptional
   - business_quality_score: 0-100
   - balance_sheet_score: 0-100
   - earnings_stability_score: 0-100
   - valuation_confidence_score: 0-100
   - margin_of_safety_score: 0-100
   - key_positive_factors: short list
   - key_negative_factors: short list
   - comparability_notes: explain what would make this score comparable to other companies
6. A short disclaimer that this is not financial advice.

Ground claims in the attached filing text and stock snapshot. If a specific
metric is not available or cannot be computed reliably from the provided data,
say so rather than guessing.
""".strip()


def extract_response_text(response: dict[str, Any]) -> str:
    """Extract generated text from a Responses API response."""
    output_text = response.get("output_text")
    if isinstance(output_text, str) and output_text:
        return output_text

    text_parts: list[str] = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            text = content.get("text")
            if isinstance(text, str):
                text_parts.append(text)

    return "\n".join(text_parts).strip() or json.dumps(response, indent=2)


def build_inline_openai_file(file_path: str) -> dict[str, str]:
    """Build an inline input_file payload for the Responses API."""
    with open(file_path, "rb") as f:
        file_bytes = f.read()

    if len(file_bytes) > MAX_INLINE_OPENAI_FILE_BYTES:
        raise RuntimeError(
            f"Analysis corpus is {len(file_bytes):,} bytes, which is too large to "
            "send inline. Lower --analysis-chars-per-report and try again."
        )

    content_type = mimetypes.guess_type(file_path)[0] or "text/plain"
    encoded_file = base64.b64encode(file_bytes).decode("ascii")

    return {
        "type": "input_file",
        "filename": os.path.basename(file_path),
        "file_data": f"data:{content_type};base64,{encoded_file}",
    }


def analyze_reports_corpus(
    ticker: str,
    reports: list[dict[str, Any]],
    corpus_path: str,
    model: str,
    api_key: str,
    stock_snapshot: dict[str, Any] | None = None,
) -> str:
    """Send the 10-K text corpus to OpenAI for a Graham-inspired analysis."""
    corpus_file = build_inline_openai_file(corpus_path)
    prompt = build_graham_analysis_prompt(ticker, reports, stock_snapshot)
    response = make_openai_request(
        "/responses",
        api_key,
        {
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        corpus_file,
                        {
                            "type": "input_text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        },
    )

    return extract_response_text(response)


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
        time.sleep(SEC_REQUEST_DELAY_SECONDS)
        
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

            time.sleep(SEC_REQUEST_DELAY_SECONDS)
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
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Upload a model-readable text corpus derived from the reports to OpenAI and write a Graham-inspired analysis."
    )
    parser.add_argument(
        "--prepare-analysis-only",
        action="store_true",
        help="Prepare the downloaded reports, Yahoo snapshot, and analysis corpus, then skip the OpenAI API call."
    )
    parser.add_argument(
        "--analysis-output",
        type=str,
        help="Markdown output file for OpenAI analysis (default: .\\output\\<ticker>_graham_analysis.md)"
    )
    parser.add_argument(
        "--analysis-corpus-output",
        type=str,
        help="Text corpus file sent to OpenAI (default: .\\output\\<ticker>_10k_analysis_corpus.txt)"
    )
    parser.add_argument(
        "--stock-snapshot-output",
        type=str,
        help="Yahoo Finance stock snapshot JSON file (default: .\\output\\<ticker>_yahoo_snapshot.json)"
    )
    parser.add_argument(
        "--analysis-chars-per-report",
        type=int,
        default=DEFAULT_ANALYSIS_CHARS_PER_REPORT,
        help=f"Maximum characters copied from each 10-K into the analysis corpus (default: {DEFAULT_ANALYSIS_CHARS_PER_REPORT})"
    )
    parser.add_argument(
        "--openai-model",
        type=str,
        default=DEFAULT_OPENAI_MODEL,
        help=f"OpenAI model to use for analysis (default: {DEFAULT_OPENAI_MODEL})"
    )
    
    args = parser.parse_args()
    ticker = args.ticker_option or args.ticker

    if not ticker:
        parser.error("a ticker symbol is required, e.g. python retrieve_10k_reports.py MSFT")

    output_dir = os.path.join(".", "output", ticker.lower())
    args.output = args.output or os.path.join(output_dir, f"{ticker.lower()}_10ks_download_test.json")
    args.download_dir = args.download_dir or os.path.join(output_dir, "10k_docs")
    args.analysis_output = args.analysis_output or os.path.join(output_dir, f"{ticker.lower()}_graham_analysis.md")
    args.analysis_corpus_output = args.analysis_corpus_output or os.path.join(output_dir, f"{ticker.lower()}_10k_analysis_corpus.txt")
    args.stock_snapshot_output = args.stock_snapshot_output or os.path.join(output_dir, f"{ticker.lower()}_yahoo_snapshot.json")

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

        stock_snapshot = None
        try:
            stock_snapshot = fetch_yahoo_stock_snapshot(ticker, args.stock_snapshot_output)
            print(f"Yahoo Finance snapshot saved to: {args.stock_snapshot_output}")
        except Exception as e:
            if args.analyze or args.prepare_analysis_only:
                print(f"\nCould not fetch Yahoo Finance stock snapshot for analysis: {e}")
                sys.exit(1)

            print(f"\nCould not fetch Yahoo Finance stock snapshot: {e}")

        if args.analyze or args.prepare_analysis_only:
            try:
                corpus_path = write_analysis_corpus_file(
                    reports,
                    ticker,
                    args.analysis_corpus_output,
                    args.analysis_chars_per_report,
                    stock_snapshot,
                )
            except Exception as e:
                print(f"\nCould not create analysis corpus: {e}")
                sys.exit(1)

            if args.prepare_analysis_only:
                print(f"\nAnalysis corpus saved to: {corpus_path}")
                print("Skipping OpenAI API call because --prepare-analysis-only was provided.")
            else:
                api_key = os.environ.get("OPENAI_API_KEY")
                if not api_key:
                    print("\nOPENAI_API_KEY is required when using --analyze")
                    sys.exit(1)

                try:
                    print(f"\nAnalyzing {corpus_path} with OpenAI model {args.openai_model}...")
                    analysis = analyze_reports_corpus(
                        ticker,
                        reports,
                        corpus_path,
                        args.openai_model,
                        api_key,
                        stock_snapshot,
                    )
                    write_text_file(args.analysis_output, analysis)
                    print(f"Analysis saved to: {args.analysis_output}")
                except Exception as e:
                    print(f"\nCould not analyze reports: {e}")
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
