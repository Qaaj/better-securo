"""Millennium BCP extrato -> Securo. Ported from millennium-to-securo.sh."""
from __future__ import annotations

import csv

from .common import ConvertedFile, ParseError, decode_lines, dedupe_id, short_hash


def _looks_like_millennium(lines: list[str]) -> bool:
    return any("montante" in ln.lower() for ln in lines)


def sniff(raw: bytes) -> bool:
    try:
        lines, _ = decode_lines(raw, validator=_looks_like_millennium)
    except ParseError:
        return False
    return _looks_like_millennium(lines)


def _col(fields: dict, *fragments: str):
    for frag in fragments:
        for name, original in fields.items():
            if name.lower().startswith(frag):
                return original
    raise ParseError(f"Missing column starting with '{fragments[0]}'. Found: {list(fields)}")


def _iso(d) -> str:
    """DD-MM-YYYY -> YYYY-MM-DD."""
    if not d:
        return ""
    d = str(d).strip()
    if not d:
        return ""
    p = d.replace("/", "-").split("-")
    if len(p) != 3 or len(p[0]) != 2:
        return ""
    return f"{p[2]}-{p[1]}-{p[0]}"


def convert(raw: bytes, base_name: str) -> list[ConvertedFile]:
    lines, enc = decode_lines(raw, validator=_looks_like_millennium)

    currency = "EUR"
    account = ""
    for ln in lines[:20]:
        low = ln.lower()
        if low.startswith("moeda base"):
            parts = ln.split(";")
            if len(parts) > 1 and parts[1].strip():
                currency = parts[1].strip().upper()
        if "conta" in low and ";" in ln:
            tail = ln.split(";")[-1].strip()
            if tail.isdigit():
                account = tail

    hdr_idx = None
    for i, ln in enumerate(lines):
        low = ln.lower()
        if low.startswith("data ") and ";" in ln and "montante" in low:
            hdr_idx = i
            break
    if hdr_idx is None:
        raise ParseError(
            "Couldn't find the transaction header row (expected a line with "
            "'Data...' and 'Montante'). First 15 lines:\n  " + "\n  ".join(lines[:15])
        )

    reader = csv.DictReader(lines[hdr_idx:], delimiter=";")
    fields = {f.strip(): f for f in (reader.fieldnames or [])}

    c_book = _col(fields, "data lan")
    c_val = _col(fields, "data valor")
    c_desc = _col(fields, "descri")
    c_amt = _col(fields, "montante")
    c_type = _col(fields, "tipo")

    rows: list[dict] = []
    seen: dict[str, int] = {}
    sign_mismatch = 0
    skipped = 0

    for r in reader:
        if r.get(c_book) is None or r.get(c_amt) is None:
            skipped += 1
            continue

        book = _iso(r.get(c_book))
        val = _iso(r.get(c_val))
        if not book:
            skipped += 1
            continue

        rawamt = str(r.get(c_amt) or "0").strip().replace(" ", "")
        if "," in rawamt and "." not in rawamt:
            rawamt = rawamt.replace(",", ".")
        try:
            amount = float(rawamt)
        except ValueError:
            skipped += 1
            continue

        tipo = str(r.get(c_type) or "").strip().lower()
        if tipo.startswith("d") and amount > 0:
            sign_mismatch += 1
        if tipo.startswith("c") and amount < 0:
            sign_mismatch += 1

        desc = " ".join(str(r.get(c_desc) or "").split())
        amount_s = f"{amount:.2f}"

        tid = dedupe_id(
            seen, f"{book.replace('-', '')}{val.replace('-', '')}-{short_hash(desc, amount_s)}"
        )

        rows.append(
            {
                "date": book,
                "description": desc,
                "amount": amount_s,
                "currency": currency,
                "transaction_id": tid,
                "notes": f"valor {val}" if val and val != book else "",
            }
        )

    if not rows:
        raise ParseError("No transaction rows parsed.")

    rows.sort(key=lambda x: x["date"])

    warnings = []
    if skipped:
        warnings.append(f"skipped {skipped} non-transaction row(s) (totals, blanks, short rows)")
    if sign_mismatch:
        warnings.append(f"{sign_mismatch} row(s) where Tipo disagrees with the sign of Montante — check these")

    suffix = f"-{account}" if account else ""
    name = f"{base_name}{suffix}-{currency}.csv"
    return [ConvertedFile(name=name, rows=rows, warnings=warnings)]
