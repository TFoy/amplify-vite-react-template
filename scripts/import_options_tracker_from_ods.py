#!/usr/bin/env python3
"""
Import Options Tracker rows from an .ods spreadsheet into the Amplify-backed
OptionsTracker models for a signed-in Cognito user via AppSync GraphQL.

Example:
  python scripts/import_options_tracker_from_ods.py ^
    --username "you@example.com" ^
    --clear-existing

Notes:
- This imports through AppSync using the same owner-based auth path the page uses.
- The script will prompt for the user's password unless you pass --password or
  --password-env.
- Use --dry-run first to preview what will be imported.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import xml.etree.ElementTree as ET

import boto3
from botocore.exceptions import ClientError


TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
NS = {"table": TABLE_NS, "text": TEXT_NS}

DEFAULT_SPREADSHEET = r"c:\Users\thoma\OneDrive\Documents\positions.ods"
DEFAULT_SHEET = "Sheet1"
DEFAULT_CASH_CELL = "P8"
SETTINGS_PAGE_KEY = "options-tracker"
AMPLIFY_OUTPUTS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "amplify_outputs.json",
)

CREATE_RECORD_MUTATION = """
mutation CreateOptionsTrackerRecord($input: CreateOptionsTrackerRecordInput!) {
  createOptionsTrackerRecord(input: $input) {
    id
  }
}
"""

CREATE_SETTING_MUTATION = """
mutation CreateOptionsTrackerSetting($input: CreateOptionsTrackerSettingInput!) {
  createOptionsTrackerSetting(input: $input) {
    id
  }
}
"""

LIST_RECORDS_QUERY = """
query ListOptionsTrackerRecords($nextToken: String) {
  listOptionsTrackerRecords(limit: 1000, nextToken: $nextToken) {
    items {
      id
    }
    nextToken
  }
}
"""

LIST_SETTINGS_QUERY = """
query ListOptionsTrackerSettings($filter: ModelOptionsTrackerSettingFilterInput, $nextToken: String) {
  listOptionsTrackerSettings(filter: $filter, limit: 1000, nextToken: $nextToken) {
    items {
      id
      pageKey
    }
    nextToken
  }
}
"""

DELETE_RECORD_MUTATION = """
mutation DeleteOptionsTrackerRecord($input: DeleteOptionsTrackerRecordInput!) {
  deleteOptionsTrackerRecord(input: $input) {
    id
  }
}
"""

DELETE_SETTING_MUTATION = """
mutation DeleteOptionsTrackerSetting($input: DeleteOptionsTrackerSettingInput!) {
  deleteOptionsTrackerSetting(input: $input) {
    id
  }
}
"""


@dataclass
class ParsedRow:
    ticker: str
    account: str
    option_type: str
    strike_price: Decimal
    option_count: Decimal
    expiration_date: str
    filled: bool
    premium: Decimal
    price_to_close: Decimal
    exercised: bool
    complete: bool
    notes: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import options tracker rows from an ODS spreadsheet through AppSync.",
    )
    parser.add_argument(
        "--spreadsheet",
        default=DEFAULT_SPREADSHEET,
        help=f"Path to the .ods spreadsheet. Default: {DEFAULT_SPREADSHEET}",
    )
    parser.add_argument(
        "--sheet",
        default=DEFAULT_SHEET,
        help=f"Worksheet name to import. Default: {DEFAULT_SHEET}",
    )
    parser.add_argument(
        "--username",
        required=True,
        help="Cognito sign-in username for the target user, usually their email address.",
    )
    parser.add_argument(
        "--password",
        help="Cognito password. If omitted, the script prompts securely.",
    )
    parser.add_argument(
        "--password-env",
        help="Read the Cognito password from this environment variable name.",
    )
    parser.add_argument(
        "--id-token",
        help="Use an existing Cognito ID token instead of signing in with username/password.",
    )
    parser.add_argument(
        "--id-token-env",
        help="Read an existing Cognito ID token from this environment variable name.",
    )
    parser.add_argument(
        "--region",
        default=None,
        help="AWS region override. Defaults to the region in amplify_outputs.json.",
    )
    parser.add_argument(
        "--user-pool-client-id",
        default=None,
        help="Cognito user pool client id override. Defaults to amplify_outputs.json.",
    )
    parser.add_argument(
        "--graphql-url",
        default=None,
        help="AppSync GraphQL URL override. Defaults to amplify_outputs.json.",
    )
    parser.add_argument(
        "--cash-cell",
        default=DEFAULT_CASH_CELL,
        help=f"Spreadsheet cell containing total cash available. Default: {DEFAULT_CASH_CELL}",
    )
    parser.add_argument(
        "--skip-cash",
        action="store_true",
        help="Do not import the cash available setting.",
    )
    parser.add_argument(
        "--clear-existing",
        action="store_true",
        help="Delete the signed-in user's existing tracker rows/settings before importing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview parsed output without writing to AppSync.",
    )
    return parser.parse_args()


def cell_text(cell: ET.Element) -> str:
    parts = []
    for paragraph in cell.findall(".//text:p", NS):
        parts.append("".join(paragraph.itertext()))
    return "\n".join(part for part in parts if part).strip()


def load_sheet_rows(spreadsheet_path: str, sheet_name: str) -> list[list[str]]:
    with zipfile.ZipFile(spreadsheet_path) as archive:
        root = ET.fromstring(archive.read("content.xml"))

    for table in root.findall(".//table:table", NS):
        name = table.get(f"{{{TABLE_NS}}}name")
        if name != sheet_name:
            continue

        rows: list[list[str]] = []
        for row in table.findall("table:table-row", NS):
            row_repeat = int(row.get(f"{{{TABLE_NS}}}number-rows-repeated", "1"))
            values: list[str] = []

            for cell in row.findall("table:table-cell", NS):
                repeat = int(cell.get(f"{{{TABLE_NS}}}number-columns-repeated", "1"))
                value = cell_text(cell)
                for _ in range(repeat):
                    values.append(value)

            for _ in range(row_repeat):
                rows.append(values.copy())

        return rows

    raise ValueError(f"Worksheet '{sheet_name}' was not found in {spreadsheet_path}.")


def normalize_header(value: str) -> str:
    lowered = value.strip().lower()
    lowered = lowered.replace("\n", " ")
    lowered = re.sub(r"\s+", " ", lowered)
    return lowered


def find_header_index(rows: list[list[str]]) -> int:
    for index, row in enumerate(rows):
        normalized = [normalize_header(cell) for cell in row]
        if (
            "account" in normalized
            and "strike" in normalized
            and "options" in normalized
            and "expiration" in normalized
            and "premium" in normalized
        ):
            return index

    raise ValueError("Could not find the options header row in the worksheet.")


def parse_decimal(value: str) -> Decimal:
    normalized = value.strip().replace("$", "").replace(",", "")
    if not normalized:
        return Decimal("0")

    try:
        return Decimal(normalized)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid numeric value: {value!r}") from exc


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    return normalized in {"y", "yes", "true", "1", "x"}


def parse_date(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""

    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(normalized, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue

    raise ValueError(f"Unsupported date format: {value!r}")


def parse_rows(rows: list[list[str]]) -> list[ParsedRow]:
    header_index = find_header_index(rows)
    parsed: list[ParsedRow] = []

    for row in rows[header_index + 1 :]:
        padded = row + [""] * max(0, 14 - len(row))
        ticker = padded[0].strip().upper()
        account = padded[1].strip()
        strike = padded[2].strip()
        option_count = padded[3].strip()
        expiration = padded[4].strip()
        option_type = padded[5].strip()
        filled = padded[6].strip()
        premium = padded[7].strip()
        price_to_close = padded[8].strip()
        exercised = padded[9].strip()
        complete = padded[10].strip()
        notes = padded[13].strip()

        if not ticker and not account and not strike and not option_count:
            continue

        if not ticker:
            continue

        if not strike or not option_count or not expiration:
            continue

        try:
            parsed.append(
                ParsedRow(
                    ticker=ticker,
                    account=account,
                    option_type=option_type.strip().upper() or "PUT",
                    strike_price=parse_decimal(strike),
                    option_count=parse_decimal(option_count),
                    expiration_date=parse_date(expiration),
                    filled=parse_bool(filled),
                    premium=parse_decimal(premium),
                    price_to_close=parse_decimal(price_to_close),
                    exercised=parse_bool(exercised),
                    complete=parse_bool(complete),
                    notes=notes,
                )
            )
        except ValueError:
            continue

    return parsed


def column_letters_to_index(column_letters: str) -> int:
    index = 0
    for char in column_letters.upper():
        if not ("A" <= char <= "Z"):
            raise ValueError(f"Invalid column reference: {column_letters!r}")
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def parse_cell_reference(reference: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Za-z]+)(\d+)", reference.strip())
    if not match:
        raise ValueError(f"Invalid cell reference: {reference!r}")

    column_letters, row_number = match.groups()
    return int(row_number) - 1, column_letters_to_index(column_letters)


def get_cell(rows: list[list[str]], reference: str) -> str:
    row_index, column_index = parse_cell_reference(reference)
    if row_index < 0 or row_index >= len(rows):
        return ""

    row = rows[row_index]
    if column_index < 0 or column_index >= len(row):
        return ""

    return row[column_index].strip()


def preview_rows(rows: list[ParsedRow], cash_value: Decimal | None) -> None:
    payload = {
        "rowCount": len(rows),
        "cashAvailable": str(cash_value) if cash_value is not None else None,
        "rows": [
            {
                "ticker": row.ticker,
                "account": row.account,
                "type": row.option_type,
                "strikePrice": str(row.strike_price),
                "optionCount": str(row.option_count),
                "expirationDate": row.expiration_date,
                "filled": row.filled,
                "premium": str(row.premium),
                "priceToClose": str(row.price_to_close),
                "exercised": row.exercised,
                "complete": row.complete,
                "notes": row.notes,
            }
            for row in rows[:10]
        ],
    }
    print(json.dumps(payload, indent=2))
    if len(rows) > 10:
        print(f"... plus {len(rows) - 10} more rows")


def load_outputs() -> dict:
    with open(AMPLIFY_OUTPUTS_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def get_password(args: argparse.Namespace) -> str:
    if args.password:
        return args.password

    if args.password_env:
        password = os.environ.get(args.password_env)
        if password:
            return password
        raise ValueError(f"Environment variable {args.password_env!r} is not set.")

    return getpass.getpass("Cognito password: ")


def get_existing_id_token(args: argparse.Namespace) -> str | None:
    if args.id_token:
        return normalize_id_token(args.id_token)

    if args.id_token_env:
        token = os.environ.get(args.id_token_env)
        if token:
            return normalize_id_token(token)
        raise ValueError(f"Environment variable {args.id_token_env!r} is not set.")

    return None


def normalize_id_token(token: str) -> str:
    normalized = token.strip().strip("'").strip('"')
    if normalized.lower().startswith("bearer "):
        normalized = normalized[7:].strip()

    parts = normalized.split(".")
    if len(parts) != 3:
        raise ValueError(
            "The provided token does not look like a JWT. "
            "Make sure you copied the Cognito idToken value only.",
        )

    return normalized


def decode_jwt_payload(token: str) -> dict:
    payload = token.split(".")[1]
    padding = "=" * (-len(payload) % 4)
    decoded = base64.urlsafe_b64decode(payload + padding)
    return json.loads(decoded.decode("utf-8"))


def get_id_token(region: str, client_id: str, username: str, password: str) -> str:
    cognito = boto3.client("cognito-idp", region_name=region)

    response = cognito.initiate_auth(
        ClientId=client_id,
        AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={
            "USERNAME": username,
            "PASSWORD": password,
        },
    )

    challenge = response.get("ChallengeName")
    if challenge:
        raise ValueError(
            f"Cognito returned challenge {challenge!r}. "
            "This script currently supports direct USER_PASSWORD_AUTH only.",
        )

    auth_result = response.get("AuthenticationResult") or {}
    id_token = auth_result.get("IdToken")
    if not id_token:
        raise ValueError("Cognito sign-in succeeded but no IdToken was returned.")

    return id_token


def get_id_token_with_fallback(
    region: str,
    user_pool_id: str,
    client_id: str,
    username: str,
    password: str,
) -> str:
    try:
        return get_id_token(region, client_id, username, password)
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code")
        error_message = exc.response.get("Error", {}).get("Message", "")
        if (
            error_code != "InvalidParameterException"
            or "USER_PASSWORD_AUTH flow not enabled for this client" not in error_message
        ):
            raise

    cognito = boto3.client("cognito-idp", region_name=region)
    response = cognito.admin_initiate_auth(
        UserPoolId=user_pool_id,
        ClientId=client_id,
        AuthFlow="ADMIN_USER_PASSWORD_AUTH",
        AuthParameters={
            "USERNAME": username,
            "PASSWORD": password,
        },
    )

    challenge = response.get("ChallengeName")
    if challenge:
        raise ValueError(
            f"Cognito returned challenge {challenge!r}. "
            "This script currently supports direct password auth only.",
        )

    auth_result = response.get("AuthenticationResult") or {}
    id_token = auth_result.get("IdToken")
    if not id_token:
        raise ValueError("Cognito admin auth succeeded but no IdToken was returned.")

    return id_token


def graphql_request(graphql_url: str, id_token: str, query: str, variables: dict | None = None) -> dict:
    body = json.dumps(
        {
            "query": query,
            "variables": variables or {},
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        graphql_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": id_token,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(f"GraphQL request failed: HTTP {exc.code}: {detail}") from exc

    if payload.get("errors"):
        raise ValueError(json.dumps(payload["errors"], indent=2))

    return payload.get("data") or {}


def list_record_ids(graphql_url: str, id_token: str) -> list[str]:
    next_token = None
    ids: list[str] = []

    while True:
        data = graphql_request(
            graphql_url,
            id_token,
            LIST_RECORDS_QUERY,
            {"nextToken": next_token},
        )
        result = data["listOptionsTrackerRecords"]
        ids.extend(item["id"] for item in result.get("items") or [] if item and item.get("id"))
        next_token = result.get("nextToken")
        if not next_token:
            return ids


def list_setting_ids(graphql_url: str, id_token: str) -> list[str]:
    next_token = None
    ids: list[str] = []

    while True:
        data = graphql_request(
            graphql_url,
            id_token,
            LIST_SETTINGS_QUERY,
            {
                "filter": {
                    "pageKey": {
                        "eq": SETTINGS_PAGE_KEY,
                    }
                },
                "nextToken": next_token,
            },
        )
        result = data["listOptionsTrackerSettings"]
        ids.extend(item["id"] for item in result.get("items") or [] if item and item.get("id"))
        next_token = result.get("nextToken")
        if not next_token:
            return ids


def clear_existing(graphql_url: str, id_token: str) -> tuple[int, int]:
    record_ids = list_record_ids(graphql_url, id_token)
    setting_ids = list_setting_ids(graphql_url, id_token)

    for record_id in record_ids:
        graphql_request(
            graphql_url,
            id_token,
            DELETE_RECORD_MUTATION,
            {"input": {"id": record_id}},
        )

    for setting_id in setting_ids:
        graphql_request(
            graphql_url,
            id_token,
            DELETE_SETTING_MUTATION,
            {"input": {"id": setting_id}},
        )

    return len(record_ids), len(setting_ids)


def create_record(graphql_url: str, id_token: str, row: ParsedRow) -> None:
    graphql_request(
        graphql_url,
        id_token,
        CREATE_RECORD_MUTATION,
        {
            "input": {
                "ticker": row.ticker,
                "account": row.account,
                "type": row.option_type,
                "strikePrice": float(row.strike_price),
                "optionCount": float(row.option_count),
                "expirationDate": row.expiration_date,
                "filled": row.filled,
                "premium": float(row.premium),
                "priceToClose": float(row.price_to_close),
                "exercised": row.exercised,
                "complete": row.complete,
                "notes": row.notes,
            }
        },
    )


def create_setting(graphql_url: str, id_token: str, cash_value: Decimal) -> None:
    graphql_request(
        graphql_url,
        id_token,
        CREATE_SETTING_MUTATION,
        {
            "input": {
                "pageKey": SETTINGS_PAGE_KEY,
                "cashAvailable": float(cash_value),
            }
        },
    )


def main() -> int:
    args = parse_args()

    try:
        rows = load_sheet_rows(args.spreadsheet, args.sheet)
        parsed_rows = parse_rows(rows)
    except Exception as exc:
        print(f"Failed to parse spreadsheet: {exc}", file=sys.stderr)
        return 1

    if not parsed_rows:
        print("No importable options rows were found.", file=sys.stderr)
        return 1

    cash_value: Decimal | None = None
    if not args.skip_cash:
        cash_text = get_cell(rows, args.cash_cell)
        if cash_text:
            try:
                cash_value = parse_decimal(cash_text)
            except ValueError as exc:
                print(f"Failed to parse cash cell {args.cash_cell}: {exc}", file=sys.stderr)
                return 1

    if args.dry_run:
        preview_rows(parsed_rows, cash_value)
        return 0

    try:
        outputs = load_outputs()
        region = args.region or outputs["auth"]["aws_region"]
        user_pool_id = outputs["auth"]["user_pool_id"]
        client_id = args.user_pool_client_id or outputs["auth"]["user_pool_client_id"]
        graphql_url = args.graphql_url or outputs["data"]["url"]
        id_token = get_existing_id_token(args)
        if not id_token:
            password = get_password(args)
            id_token = get_id_token_with_fallback(
                region,
                user_pool_id,
                client_id,
                args.username,
                password,
            )
        payload = decode_jwt_payload(id_token)
        token_use = payload.get("token_use")
        token_client_id = payload.get("aud") or payload.get("client_id")
        if token_use != "id":
            raise ValueError(
                f"The provided token has token_use={token_use!r}, not 'id'. "
                "Copy the Cognito idToken, not the access token.",
            )
        if token_client_id != client_id:
            raise ValueError(
                f"The provided token belongs to app client {token_client_id!r}, "
                f"but this app expects {client_id!r}.",
            )
    except Exception as exc:
        print(f"Failed to authenticate for GraphQL import: {exc}", file=sys.stderr)
        return 1

    try:
        if args.clear_existing:
            deleted_records, deleted_settings = clear_existing(graphql_url, id_token)
            print(
                f"Deleted {deleted_records} existing record(s) and "
                f"{deleted_settings} existing setting(s) for {args.username}.",
            )

        for row in parsed_rows:
            create_record(graphql_url, id_token, row)

        if cash_value is not None:
            create_setting(graphql_url, id_token, cash_value)
    except Exception as exc:
        print(f"GraphQL import failed: {exc}", file=sys.stderr)
        return 1

    print(f"Imported {len(parsed_rows)} row(s) for {args.username}.")
    if cash_value is not None:
        print(f"Imported cashAvailable={cash_value} for {args.username}.")
    else:
        print("Skipped cash setting import.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
