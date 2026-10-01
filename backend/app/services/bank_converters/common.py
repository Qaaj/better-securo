"""Shared helpers for bank-CSV -> Securo-CSV conversion.

Ported from the original belfius-to-securo.sh / millennium-to-securo.sh /
revolut-to-securo.sh shell+python scripts, adapted to work on in-memory
bytes (uploaded files) instead of paths on disk.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass, field

SECURO_FIELDS = ["date", "description", "amount", "currency", "transaction_id", "notes"]

# Securo returns HTTP 413 above ~6000 rows in one import; keep chunks safely under that.
CHUNK_SIZE = 1000

# utf-16 must be tried before latin-1: latin-1 decodes ANY byte sequence
# without raising, so it would silently "win" over a real utf-16 file and
# produce text full of nulls (bit us on the Millennium BCP export).
ENCODINGS = ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "latin-1")


class ParseError(Exception):
    pass


def decode_lines(raw: bytes, validator=None) -> tuple[list[str], str]:
    """Decode raw bytes trying several encodings, dropping blank lines.

    If `validator(lines) -> bool` is given, prefer the first encoding whose
    decoded lines satisfy it (matches a header token); otherwise fall back
    to the first encoding that decoded at all.
    """
    fallback = None
    for enc in ENCODINGS:
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        text = text.replace("\x00", "")
        lines = [ln.rstrip("\r\n") for ln in text.splitlines()]
        lines = [ln for ln in lines if ln.strip()]
        if validator is None or validator(lines):
            return lines, enc
        if fallback is None:
            fallback = (lines, enc)
    if fallback:
        return fallback
    raise ParseError("Could not decode file as utf-8, utf-16 or latin-1")


def clean(s) -> str:
    """Collapse heavy padding / whitespace runs into single spaces."""
    return re.sub(r"\s+", " ", str(s or "")).strip()


def money_comma(s) -> float | None:
    """'-72,69' or '-1.234,56' -> float (comma-decimal formats)."""
    s = clean(s).replace(" ", "")
    if not s:
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def iso_dmy(d, sep_pat=r"[/-]") -> str:
    """DD/MM/YYYY or DD-MM-YYYY -> YYYY-MM-DD."""
    d = clean(d)
    if not d:
        return ""
    p = re.split(sep_pat, d.split(" ")[0])
    if len(p) != 3 or len(p[0]) != 2:
        return ""
    return f"{p[2]}-{p[1]}-{p[0]}"


def short_hash(*parts: str, n: int = 8) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:n]


@dataclass
class ConvertedFile:
    name: str
    rows: list[dict]
    warnings: list[str] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def date_range(self) -> tuple[str, str]:
        if not self.rows:
            return "", ""
        dates = sorted(r["date"] for r in self.rows)
        return dates[0], dates[-1]

    @property
    def net_amount(self) -> float:
        return round(sum(float(r["amount"]) for r in self.rows), 2)

    @property
    def currency(self) -> str:
        return self.rows[0]["currency"] if self.rows else ""

    def to_csv_bytes(self) -> bytes:
        buf = io.StringIO(newline="")
        # Securo's importer needs a bare \n terminator: csv.writer defaults to
        # \r\n regardless of the buffer's newline setting.
        w = csv.DictWriter(buf, fieldnames=SECURO_FIELDS, lineterminator="\n")
        w.writeheader()
        w.writerows(self.rows)
        return buf.getvalue().encode("utf-8")

    def chunks(self, size: int = CHUNK_SIZE) -> list["ConvertedFile"]:
        """Split into <=`size`-row parts if needed (Securo 413s above ~6000 rows)."""
        if len(self.rows) <= size:
            return [self]
        base = self.name.rsplit(".csv", 1)[0]
        out = []
        for i in range(0, len(self.rows), size):
            part = self.rows[i : i + size]
            idx = i // size + 1
            out.append(ConvertedFile(name=f"{base}.part{idx}.csv", rows=part, warnings=self.warnings))
        return out


def dedupe_id(seen: dict, tid: str) -> str:
    seen[tid] = seen.get(tid, 0) + 1
    if seen[tid] > 1:
        return f"{tid}-{seen[tid]}"
    return tid
