"""Belfius CSV -> Securo. Ported from belfius-to-securo.sh."""
from __future__ import annotations

import csv
from collections import defaultdict

from .common import ConvertedFile, ParseError, clean, decode_lines, dedupe_id, iso_dmy, money_comma, short_hash


def _looks_like_belfius(lines: list[str]) -> bool:
    return any(
        "boekingsdatum" in ln.lower() and "bedrag" in ln.lower() for ln in lines
    )


def sniff(raw: bytes) -> bool:
    try:
        lines, _ = decode_lines(raw, validator=_looks_like_belfius)
    except ParseError:
        return False
    text = "\n".join(lines).lower()
    return "boekingsdatum" in text and "bedrag" in text and "devies" in text


def _col(fields: dict, *frags: str, required: bool = True):
    """Exact match first — 'Transactie' must not match 'Transactienummer'."""
    for frag in frags:
        for name, original in fields.items():
            if name.lower() == frag:
                return original
    for frag in frags:
        for name, original in fields.items():
            if name.lower().startswith(frag):
                return original
    if required:
        raise ParseError(f"Missing column starting with '{frags[0]}'. Found: {list(fields)}")
    return None


def convert(raw: bytes, base_name: str) -> list[ConvertedFile]:
    lines, enc = decode_lines(raw, validator=_looks_like_belfius)

    hdr_idx = None
    for i, ln in enumerate(lines):
        low = ln.lower()
        if "boekingsdatum" in low and "bedrag" in low and "devies" in low:
            hdr_idx = i
            break
    if hdr_idx is None:
        raise ParseError(
            "Couldn't find the transaction header row (needs Boekingsdatum, "
            "Bedrag and Devies). First 20 lines:\n  " + "\n  ".join(lines[:20])
        )

    reader = csv.DictReader(lines[hdr_idx:], delimiter=";")
    fields = {f.strip(): f for f in (reader.fieldnames or [])}

    c_acct = _col(fields, "rekening")
    c_date = _col(fields, "boekingsdatum")
    c_stmt = _col(fields, "rekeninguittreksel", required=False)
    c_txno = _col(fields, "transactienummer", required=False)
    c_party = _col(fields, "naam tegenpartij", required=False)
    c_narr = _col(fields, "transactie", required=False)
    c_vald = _col(fields, "valutadatum", required=False)
    c_amt = _col(fields, "bedrag")
    c_ccy = _col(fields, "devies", required=False)
    c_msg = _col(fields, "mededelingen", "mededeling", required=False)

    rows_by_key: dict[tuple, list[dict]] = defaultdict(list)
    seen: dict[str, int] = defaultdict(int)
    skipped = 0

    for r in reader:
        if r.get(c_date) is None or r.get(c_amt) is None:
            skipped += 1
            continue

        date = iso_dmy(r.get(c_date))
        amount = money_comma(r.get(c_amt))
        if not date or amount is None:
            skipped += 1
            continue

        iban = clean(r.get(c_acct)).replace(" ", "")
        ccy = (clean(r.get(c_ccy)) or "EUR").upper()

        party = clean(r.get(c_party)) if c_party else ""
        narrative = clean(r.get(c_narr)) if c_narr else ""
        message = clean(r.get(c_msg)) if c_msg else ""

        desc = party or narrative[:120] or "(no description)"
        amount_s = f"{amount:.2f}"

        stmt = clean(r.get(c_stmt)) if c_stmt else ""
        txno = clean(r.get(c_txno)) if c_txno else ""
        tail = iban[-6:] if iban else "ACC"
        if stmt and txno:
            tid = f"{tail}-{stmt}-{txno}"
        else:
            tid = f"{date.replace('-', '')}-{short_hash(desc, amount_s, narrative, n=10)}"
        tid = dedupe_id(seen, tid)

        valuta = iso_dmy(r.get(c_vald)) if c_vald else ""
        notes = []
        if valuta and valuta != date:
            notes.append(f"valuta {valuta}")
        if party and narrative:
            notes.append(narrative[:200])
        elif message and message != narrative:
            notes.append(message[:200])

        rows_by_key[(iban, ccy)].append(
            {
                "date": date,
                "description": desc,
                "amount": amount_s,
                "currency": ccy,
                "transaction_id": tid,
                "notes": " · ".join(notes)[:250],
            }
        )

    if not rows_by_key:
        raise ParseError("No transaction rows parsed.")

    warnings = []
    if skipped:
        warnings.append(f"skipped {skipped} non-transaction row(s)")

    out = []
    for (iban, ccy), rows in sorted(rows_by_key.items()):
        rows.sort(key=lambda x: x["date"])
        tail = iban[-6:] if iban else "acct"
        out.append(
            ConvertedFile(name=f"{base_name}-{tail}-{ccy}.csv", rows=rows, warnings=list(warnings))
        )
    return out
