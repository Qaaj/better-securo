"""Revolut CSV -> Securo. Ported from revolut-to-securo.sh."""
from __future__ import annotations

import csv
import io
from collections import defaultdict

from .common import ConvertedFile, ParseError, clean, dedupe_id, short_hash

REQUIRED = {"Completed Date", "Description", "Amount", "Fee", "Currency", "State"}


def sniff(raw: bytes) -> bool:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return False
    head = text[:2000].lower()
    return "completed date" in head and "state" in head and "," in text[:200]


def convert(raw: bytes, base_name: str) -> list[ConvertedFile]:
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    missing = REQUIRED - set(reader.fieldnames or [])
    if missing:
        raise ParseError(f"Missing expected Revolut columns: {', '.join(sorted(missing))}")

    rows_by_ccy: dict[str, list[dict]] = defaultdict(list)
    seen_ids: dict[str, int] = defaultdict(int)
    skipped_state = skipped_nodate = fees_folded = 0

    for r in reader:
        if (r.get("State") or "").strip().upper() != "COMPLETED":
            skipped_state += 1
            continue

        completed = (r.get("Completed Date") or "").strip()
        if not completed:
            skipped_nodate += 1
            continue

        amount = float(r.get("Amount") or 0)
        fee = float(r.get("Fee") or 0)
        if fee:
            amount -= abs(fee)
            fees_folded += 1

        desc = (r.get("Description") or "").strip()
        amount_s = f"{amount:.2f}"

        stamp = completed.replace("-", "").replace(":", "").replace(" ", "")
        tid = dedupe_id(seen_ids, f"{stamp}-{short_hash(desc, amount_s)}")

        ccy = (r.get("Currency") or "").strip().upper()
        rows_by_ccy[ccy].append(
            {
                "date": completed[:10],
                "description": desc,
                "amount": amount_s,
                "currency": ccy,
                "transaction_id": tid,
                "notes": (r.get("Type") or "").strip(),
            }
        )

    if not rows_by_ccy:
        raise ParseError("Nothing to convert — no COMPLETED rows found.")

    warnings = []
    if skipped_state:
        warnings.append(f"skipped {skipped_state} non-COMPLETED row(s)")
    if skipped_nodate:
        warnings.append(f"skipped {skipped_nodate} row(s) with no completed date")
    if fees_folded:
        warnings.append(f"folded fees into amount on {fees_folded} row(s)")

    out = []
    for ccy, rows in sorted(rows_by_ccy.items()):
        rows.sort(key=lambda x: x["date"])
        out.append(ConvertedFile(name=f"{base_name}-{ccy}.csv", rows=rows, warnings=list(warnings)))
    return out
