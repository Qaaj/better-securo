from __future__ import annotations

from . import belfius, millennium, revolut

CONVERTERS = {
    "revolut": revolut,
    "millennium": millennium,
    "belfius": belfius,
}


def detect_bank(raw: bytes) -> str | None:
    for name, mod in CONVERTERS.items():
        try:
            if mod.sniff(raw):
                return name
        except Exception:
            continue
    return None
