"""Suggest a recurring item from a transaction the user is looking at.

Given one transaction, find the other transactions in the workspace that look
like the same charge, work out how often it repeats, and propose a template.

Two passes, strictest first:

1. ``amount_and_name``: same merchant name *and* the exact same amount.
2. ``name``: same merchant name, any amount (a bill that varies).

The name is the first two letter-words of the description, lower-cased, so
"NETFLIX.COM 4412" and "Netflix.com 9981" are the same merchant while the
reference numbers bank descriptions tack on are ignored. The database narrows
the candidates (``LIKE`` on those words); the exact name comparison and the
frequency inference then run on the handful of rows that come back.
"""
from __future__ import annotations

import re
import statistics
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction
from app.services.recurring_transaction_service import _advance_date

_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)
_MAX_CANDIDATES = 500

# frequency -> (typical gap in days, tolerance in days)
_PERIODS: dict[str, tuple[int, int]] = {
    "weekly": (7, 2),
    "biweekly": (14, 3),
    "monthly": (30, 5),
    "quarterly": (91, 7),
    "semiannual": (182, 12),
    "yearly": (365, 15),
}


def name_key(description: Optional[str]) -> tuple[str, ...]:
    """The merchant name: the first two letter-words of the description."""
    return tuple(_WORD.findall((description or "").lower())[:2])


@dataclass
class Match:
    date: date
    amount: Decimal


@dataclass
class RecurringSuggestion:
    match_basis: str  # amount_and_name | name | none
    frequency: Optional[str]  # None when it could not be told
    confidence: str  # high | medium | low | none
    occurrences: int  # matching transactions, including the one clicked
    first_date: Optional[date] = None
    last_date: Optional[date] = None
    average_gap_days: Optional[int] = None
    typical_amount: Optional[Decimal] = None
    amount_varies: bool = False
    day_of_month: Optional[int] = None
    next_occurrence: Optional[date] = None
    dates: list[date] = field(default_factory=list)


def infer_frequency(dates: list[date]) -> tuple[Optional[str], str, Optional[int]]:
    """(frequency, confidence, median gap) for a series of occurrence dates."""
    days = sorted(set(dates))
    if len(days) < 2:
        return None, "none", None
    gaps = [(b - a).days for a, b in zip(days, days[1:])]
    median_gap = int(statistics.median(gaps))

    best: Optional[str] = None
    for frequency, (typical, tolerance) in _PERIODS.items():
        if abs(median_gap - typical) <= tolerance:
            best = frequency
            break
    if best is None:
        return None, "none", median_gap

    typical, tolerance = _PERIODS[best]
    consistent = sum(1 for g in gaps if abs(g - typical) <= tolerance) / len(gaps)
    if len(days) >= 4 and consistent >= 0.8:
        confidence = "high"
    elif len(days) >= 3 and consistent >= 0.6:
        confidence = "medium"
    elif consistent >= 0.6:
        confidence = "low"
    else:
        return None, "none", median_gap
    return best, confidence, median_gap


async def _candidates(
    session: AsyncSession, workspace_id: uuid.UUID, tx: Transaction, key: tuple[str, ...]
) -> list[Transaction]:
    query = select(Transaction).where(
        Transaction.workspace_id == workspace_id,
        Transaction.type == tx.type,
        Transaction.transfer_pair_id.is_(None),
        Transaction.source.notin_(("opening_balance", "recurring")),
    )
    for word in key:
        query = query.where(func.lower(Transaction.description).like(f"%{word}%"))
    query = query.order_by(Transaction.date.desc()).limit(_MAX_CANDIDATES)
    rows = (await session.execute(query)).scalars().all()
    return [r for r in rows if name_key(r.description) == key]


def _build(basis: str, matches: list[Match], tx: Transaction) -> RecurringSuggestion:
    frequency, confidence, gap = infer_frequency([m.date for m in matches])
    amounts = [m.amount for m in matches]
    last = max(m.date for m in matches)
    suggestion = RecurringSuggestion(
        match_basis=basis,
        frequency=frequency,
        confidence=confidence,
        occurrences=len(matches),
        first_date=min(m.date for m in matches),
        last_date=last,
        average_gap_days=gap,
        typical_amount=statistics.median(amounts),
        amount_varies=len(set(amounts)) > 1,
        dates=sorted({m.date for m in matches}, reverse=True)[:12],
    )
    if frequency is not None:
        if frequency in ("monthly", "quarterly", "semiannual", "yearly"):
            suggestion.day_of_month = int(statistics.median([m.date.day for m in matches]))
        suggestion.next_occurrence = _advance_date(
            last, frequency, intended_day=suggestion.day_of_month
        )
    return suggestion


async def suggest_for_transaction(
    session: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Optional[RecurringSuggestion]:
    """None when the transaction is not in the workspace."""
    tx = (
        await session.execute(
            select(Transaction).where(
                Transaction.id == transaction_id, Transaction.workspace_id == workspace_id
            )
        )
    ).scalar_one_or_none()
    if tx is None:
        return None

    key = name_key(tx.description)
    pool: list[Transaction] = []
    if key:
        pool = await _candidates(session, workspace_id, tx, key)
    if tx.id not in {r.id for r in pool}:
        pool.append(tx)

    exact = [Match(r.date, r.amount) for r in pool if r.amount == tx.amount]
    loose = [Match(r.date, r.amount) for r in pool]

    # Prefer the strict pass, but a name-only series that is clearly more
    # convincing (e.g. 2 same-amount rows vs 12 monthly ones) wins.
    rank = {"high": 3, "medium": 2, "low": 1, "none": 0}
    best: Optional[RecurringSuggestion] = None
    for basis, matches in (("amount_and_name", exact), ("name", loose)):
        if len(matches) < 2:
            continue
        suggestion = _build(basis, matches, tx)
        if suggestion.frequency is None:
            continue
        if best is None or rank[suggestion.confidence] > rank[best.confidence]:
            best = suggestion
    if best is not None:
        return best

    # Nothing repeats yet: report what was found so the form can say so.
    basis = "amount_and_name" if len(exact) > 1 else ("name" if len(loose) > 1 else "none")
    matches = exact if len(exact) > 1 else loose
    suggestion = _build(basis, matches, tx)
    suggestion.frequency = None
    suggestion.confidence = "none"
    suggestion.next_occurrence = None
    return suggestion
