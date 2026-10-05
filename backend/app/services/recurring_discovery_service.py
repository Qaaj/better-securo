"""Find recurring charges in transactions that no recurring item is linked to yet.

Unlinked transactions are grouped by merchant name (the same first-two-words rule the
single-transaction suggestion uses), then split into amount clusters, and each cluster is
a *series*: its dates tell how often it repeats. A merchant whose amount varies (a
utility bill) becomes one "varying" series instead.

Series are then used two ways:

* **Matches.** For each active recurring item, the series that most probably is that item
  (amount close, same frequency, similar name), one series per item and one item per series.
* **New.** Series that repeat convincingly but fit no recurring item.

Nothing is changed here; linking and creating happen in the recurring service.
"""
from __future__ import annotations

import statistics
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.recurring_dismissal import RecurringDismissal
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.schemas.recurring_discovery import CreateFromSeriesRequest
from app.schemas.recurring_transaction import RecurringTransactionCreate
from app.services import recurring_transaction_service
from app.services.recurring_suggestion_service import _PERIODS, infer_frequency, name_key
from app.services.recurring_transaction_service import _advance_date

# Amounts within this share of each other are the same charge.
CLUSTER_TOLERANCE = 0.03
# A merchant's history is one "varying" series when its repeating amounts explain less than this share of it.
VARYING_COVERAGE = 0.6
MATCH_THRESHOLD = 0.55
LAPSED_AFTER_PERIODS = 1.75
RANK = {"high": 3, "medium": 2, "low": 1, "none": 0}


@dataclass
class Tx:
    id: uuid.UUID
    date: date
    amount: Decimal
    primary: Decimal
    currency: str
    description: str
    account_id: Optional[uuid.UUID]
    category_id: Optional[uuid.UUID]
    type: str


@dataclass
class Series:
    key: str
    type: str
    txs: list[Tx]
    varying: bool
    frequency: Optional[str] = None
    confidence: str = "none"
    gap: Optional[int] = None
    words: set[str] = field(default_factory=set)

    @property
    def dates(self) -> list[date]:
        return [t.date for t in self.txs]

    @property
    def last(self) -> Tx:
        return max(self.txs, key=lambda t: (t.date, str(t.id)))

    @property
    def typical(self) -> Decimal:
        return Decimal(str(statistics.median([float(t.amount) for t in self.txs])))

    @property
    def typical_primary(self) -> Decimal:
        return Decimal(str(statistics.median([float(t.primary) for t in self.txs])))


def _words(text: str) -> set[str]:
    import re
    import unicodedata

    plain = unicodedata.normalize("NFKD", text.lower())
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return {w for w in re.findall(r"[a-z]{3,}", plain)}


async def _load(session: AsyncSession, workspace_id: uuid.UUID) -> list[Tx]:
    rows = (
        await session.execute(
            select(Transaction).where(
                Transaction.workspace_id == workspace_id,
                Transaction.recurring_transaction_id.is_(None),
                Transaction.transfer_pair_id.is_(None),
                Transaction.source.notin_(("opening_balance", "recurring")),
            )
        )
    ).scalars().all()
    return [
        Tx(
            id=r.id,
            date=r.date,
            amount=r.amount,
            primary=Decimal(str(r.amount_primary)) if r.amount_primary is not None else r.amount,
            currency=r.currency,
            description=r.description or "",
            account_id=r.account_id,
            category_id=r.category_id,
            type=r.type,
        )
        for r in rows
    ]


def _cluster(txs: list[Tx]) -> list[list[Tx]]:
    """Group transactions whose amounts are within the tolerance of their cluster's middle."""
    clusters: list[list[Tx]] = []
    for tx in sorted(txs, key=lambda t: t.primary):
        if clusters:
            middle = statistics.median([float(t.primary) for t in clusters[-1]])
            larger = max(float(tx.primary), middle)
            if larger > 0 and abs(float(tx.primary) - middle) / larger <= CLUSTER_TOLERANCE:
                clusters[-1].append(tx)
                continue
        clusters.append([tx])
    return clusters


def _finish(series: Series) -> Series:
    series.frequency, series.confidence, series.gap = infer_frequency(series.dates)
    series.words = set()
    for tx in series.txs:
        series.words |= _words(tx.description)
    return series


def build_series(txs: list[Tx]) -> list[Series]:
    groups: dict[tuple[str, tuple[str, ...]], list[Tx]] = {}
    for tx in txs:
        key = name_key(tx.description)
        if key:
            groups.setdefault((tx.type, key), []).append(tx)

    result: list[Series] = []
    for (kind, name), members in groups.items():
        base = f"{kind}|{'-'.join(name)}"
        clusters = [_finish(Series(key=f"{base}|{round(float(statistics.median([float(t.primary) for t in c])))}", type=kind, txs=c, varying=False)) for c in _cluster(members)]
        # How much of the merchant's history the repeating amounts explain between them.
        covered = sum(len(s.txs) for s in clusters if s.frequency)
        if len(members) >= 3 and covered < VARYING_COVERAGE * len(members):
            whole = _finish(Series(key=f"{base}|varying", type=kind, txs=members, varying=True))
            if whole.frequency:
                result.append(whole)
                continue
        result.extend(clusters)
    return result


# ---------------------------------------------------------------- scoring
def _amount_score(wanted: Decimal, series: Series) -> float:
    target = float(series.typical_primary)
    larger = max(float(wanted), target)
    if larger <= 0:
        return 0.0
    difference = abs(float(wanted) - target) / larger
    if series.varying:
        return max(0.0, 1 - difference / 0.35) * 0.7
    if difference <= 0.01:
        return 1.0
    if difference <= 0.03:
        return 0.9
    if difference <= 0.08:
        return 0.7
    if difference <= 0.15:
        return 0.45
    return 0.0


def score_match(rt: RecurringTransaction, series: Series) -> tuple[float, list[str]]:
    """0..1 probability-like score that `series` is the recurring item, with the reasons."""
    if rt.type != series.type:
        return 0.0, []
    wanted = Decimal(str(rt.amount_primary)) if rt.amount_primary is not None else rt.amount
    amount = _amount_score(wanted, series)
    if amount == 0.0:
        return 0.0, []
    if series.frequency == rt.frequency:
        schedule = 1.0
    elif series.frequency is None:
        schedule = 0.35
    else:
        return 0.0, []
    name = 1.0 if _words(rt.description) & series.words else 0.0
    score = 0.40 * amount + 0.35 * schedule + 0.25 * name
    reasons: list[str] = []
    if amount >= 0.9:
        reasons.append("amount")
    elif amount > 0:
        reasons.append("amount_close")
    if series.frequency == rt.frequency:
        reasons.append("schedule")
    if name:
        reasons.append("name")
    return round(score, 3), reasons


def _confidence(score: float) -> str:
    return "high" if score >= 0.8 else "medium" if score >= 0.65 else "low"


# ---------------------------------------------------------------- output
def _modal(values: list) -> Optional[object]:
    cleaned = [v for v in values if v is not None]
    return Counter(cleaned).most_common(1)[0][0] if cleaned else None


def series_read(series: Series, today: date) -> dict:
    last = series.last
    last_date = last.date
    day_of_month = int(statistics.median([t.date.day for t in series.txs]))
    next_date = None
    if series.frequency:
        next_date = _advance_date(last_date, series.frequency, intended_day=day_of_month)
    per_year = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "semiannual": 2, "yearly": 1}.get(series.frequency or "", 0)
    typical = series.typical.quantize(Decimal("0.01"))
    lapsed = False
    if series.frequency:
        period = _PERIODS[series.frequency][0]
        lapsed = (today - last_date).days > LAPSED_AFTER_PERIODS * period
    amounts = {round(float(t.amount), 2) for t in series.txs}
    ordered = sorted(series.txs, key=lambda t: t.date, reverse=True)
    return {
        "key": series.key,
        "name": last.description[:80],
        "type": series.type,
        "frequency": series.frequency,
        "confidence": series.confidence,
        "occurrences": len(series.txs),
        "first_date": min(t.date for t in series.txs),
        "last_date": last_date,
        "typical_amount": typical,
        "currency": _modal([t.currency for t in series.txs]) or last.currency,
        "amount_varies": series.varying or len(amounts) > 1,
        "day_of_month": day_of_month,
        "next_occurrence": next_date,
        "account_id": _modal([t.account_id for t in series.txs]),
        "category_id": _modal([t.category_id for t in series.txs]),
        "yearly_amount": (typical * per_year).quantize(Decimal("0.01")),
        "lapsed": lapsed,
        "transaction_ids": [t.id for t in ordered],
        "recent": [{"id": t.id, "date": t.date, "amount": t.amount, "description": t.description} for t in ordered[:4]],
    }


async def discover(session: AsyncSession, workspace_id: uuid.UUID, today: Optional[date] = None) -> dict:
    today = today or date.today()
    txs = await _load(session, workspace_id)
    series = build_series(txs)

    dismissals = (
        await session.execute(select(RecurringDismissal).where(RecurringDismissal.workspace_id == workspace_id))
    ).scalars().all()
    dismissed_series = {d.key for d in dismissals if d.kind == "series"}
    dismissed_matches = {(d.recurring_id, d.key) for d in dismissals if d.kind == "match"}

    items = (
        await session.execute(
            select(RecurringTransaction).where(
                RecurringTransaction.workspace_id == workspace_id,
                RecurringTransaction.is_active.is_(True),
            )
        )
    ).scalars().all()

    # Every plausible (item, series) pair, best first; each item and series is used once.
    pairs: list[tuple[float, RecurringTransaction, Series, list[str]]] = []
    for rt in items:
        for s in series:
            if (rt.id, s.key) in dismissed_matches:
                continue
            score, reasons = score_match(rt, s)
            if score >= MATCH_THRESHOLD:
                pairs.append((score, rt, s, reasons))
    pairs.sort(key=lambda p: (-p[0], p[1].description, p[2].key))
    used_items: set[uuid.UUID] = set()
    used_series: set[str] = set()
    matches = []
    for score, rt, s, reasons in pairs:
        if rt.id in used_items or s.key in used_series:
            continue
        used_items.add(rt.id)
        used_series.add(s.key)
        matches.append(
            {
                "recurring_id": rt.id,
                "recurring_description": rt.description,
                "recurring_amount": rt.amount,
                "recurring_currency": rt.currency,
                "recurring_frequency": rt.frequency,
                "score": score,
                "confidence": _confidence(score),
                "reasons": reasons,
                "series": series_read(s, today),
            }
        )

    new = []
    for s in series:
        if s.key in used_series or s.key in dismissed_series or s.frequency is None:
            continue
        new.append(series_read(s, today))
    new.sort(key=lambda r: (r["lapsed"], -RANK[r["confidence"]], -float(r["yearly_amount"])))
    return {"matches": matches, "new_series": new, "dismissed": len(dismissed_series)}


# ---------------------------------------------------------------- changes
async def _unlinked(session: AsyncSession, workspace_id: uuid.UUID, ids: list[uuid.UUID]) -> list[Transaction]:
    rows = (
        await session.execute(select(Transaction).where(Transaction.id.in_(ids), Transaction.workspace_id == workspace_id))
    ).scalars().all()
    return [r for r in rows if r.recurring_transaction_id is None]


async def link_series(
    session: AsyncSession, recurring_id: uuid.UUID, transaction_ids: list[uuid.UUID], workspace_id: uuid.UUID
) -> Optional[RecurringTransaction]:
    """Link many transactions to a recurring item and move its schedule past the latest one."""
    recurring = await recurring_transaction_service.get_recurring_transaction(session, recurring_id, workspace_id)
    if recurring is None:
        return None
    txs = await _unlinked(session, workspace_id, transaction_ids)
    if not txs:
        raise ValueError("Nothing to link: the transactions are missing or already linked")
    for tx in txs:
        tx.recurring_transaction_id = recurring.id
    latest = max(tx.date for tx in txs)
    while recurring.next_occurrence <= latest:
        recurring.next_occurrence = _advance_date(
            recurring.next_occurrence, recurring.frequency, intended_day=recurring.day_of_month
        )
    await session.commit()
    await session.refresh(recurring)
    return recurring


async def create_from_series(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, data: CreateFromSeriesRequest
) -> RecurringTransaction:
    """Create a recurring item from a series and link all of its transactions to it."""
    txs = await _unlinked(session, workspace_id, data.transaction_ids)
    if not txs:
        raise ValueError("Nothing to link: the transactions are missing or already linked")
    latest = max(txs, key=lambda t: (t.date, str(t.id)))
    recurring = await recurring_transaction_service.create_recurring_transaction(
        session,
        workspace_id,
        user_id,
        RecurringTransactionCreate(
            description=data.description,
            amount=data.amount,
            currency=data.currency,
            type=data.type,
            frequency=data.frequency,
            day_of_month=data.day_of_month,
            start_date=latest.date,
            account_id=data.account_id,
            category_id=data.category_id,
            skip_first=True,
            auto_generate=False,
            source_transaction_id=latest.id,
        ),
    )
    rest = [t.id for t in txs if t.id != latest.id]
    if rest:
        for tx in await _unlinked(session, workspace_id, rest):
            tx.recurring_transaction_id = recurring.id
        await session.commit()
        await session.refresh(recurring)
    return recurring


async def dismiss(
    session: AsyncSession, workspace_id: uuid.UUID, kind: str, key: str, recurring_id: Optional[uuid.UUID]
) -> None:
    session.add(RecurringDismissal(workspace_id=workspace_id, kind=kind, key=key, recurring_id=recurring_id))
    await session.commit()


async def reset_dismissals(session: AsyncSession, workspace_id: uuid.UUID) -> int:
    result = await session.execute(delete(RecurringDismissal).where(RecurringDismissal.workspace_id == workspace_id))
    await session.commit()
    return result.rowcount or 0


__all__ = ["discover", "link_series", "create_from_series", "dismiss", "reset_dismissals", "build_series", "score_match"]
