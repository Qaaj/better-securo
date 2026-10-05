"""What the charges linked to a recurring item say about it: how long it has run, what it came to, and how its price moved."""
from __future__ import annotations

import statistics
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Transaction
from app.services.recurring_suggestion_service import _PERIODS
from app.services.recurring_transaction_service import get_recurring_transaction

# A step this large (as a share of the amount before it) counts as a price change.
PRICE_STEP = 0.01
# More than this share of the steps being changes means the amount varies by nature (a utility bill).
VARIES_SHARE = 0.5


def _money(value: float) -> Decimal:
    return Decimal(str(round(value, 2)))


async def history(
    session: AsyncSession, recurring_id: uuid.UUID, workspace_id: uuid.UUID, today: Optional[date] = None
) -> Optional[dict]:
    today = today or date.today()
    rt = await get_recurring_transaction(session, recurring_id, workspace_id)
    if rt is None:
        return None
    rows = (
        await session.execute(
            select(Transaction)
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.recurring_transaction_id == recurring_id,
                Transaction.status != "pending",
            )
            .order_by(Transaction.date, Transaction.created_at)
        )
    ).scalars().all()

    out: dict = {
        "recurring_id": recurring_id,
        "charges": [
            {"id": r.id, "date": r.date, "amount": r.amount, "currency": r.currency, "amount_primary": r.amount_primary}
            for r in rows
        ],
        "count": len(rows),
        "price_changes": [],
        "amount_varies": False,
    }

    # Late: the scheduled next charge is past due by more than the schedule's slack.
    if rt.is_active and rows:
        slack = _PERIODS.get(rt.frequency, (30, 5))[1]
        late = (today - rt.next_occurrence).days
        if late > slack:
            out["overdue_days"] = late

    if not rows:
        return out

    amounts = [float(r.amount) for r in rows]
    primary = [float(r.amount_primary if r.amount_primary is not None else r.amount) for r in rows]
    first, last = rows[0], rows[-1]
    out.update(
        first_date=first.date,
        last_date=last.date,
        months_running=round((last.date - first.date).days / 30.4375, 1) if len(rows) > 1 else 0.0,
        total_paid=_money(sum(primary)),
        total_last_12_months=_money(sum(p for p, r in zip(primary, rows) if (today - r.date).days <= 365)),
        average_amount=_money(statistics.mean(amounts)),
        min_amount=_money(min(amounts)),
        max_amount=_money(max(amounts)),
        first_amount=_money(amounts[0]),
        latest_amount=_money(amounts[-1]),
    )
    if len(rows) > 1 and amounts[0] > 0:
        out["change_since_first_pct"] = round((amounts[-1] - amounts[0]) / amounts[0] * 100, 1)

    # Steps in the price. A bill that changes nearly every time is just variable.
    changes = []
    steps = 0
    for before, after, row in zip(amounts, amounts[1:], rows[1:]):
        steps += 1
        if before > 0 and abs(after - before) / before > PRICE_STEP:
            changes.append(
                {"date": row.date, "from_amount": _money(before), "to_amount": _money(after), "change_pct": round((after - before) / before * 100, 1)}
            )
    if steps and len(changes) / steps > VARIES_SHARE:
        out["amount_varies"] = True
    else:
        out["price_changes"] = changes

    if last.currency == rt.currency and float(rt.amount) > 0:
        out["latest_vs_planned_pct"] = round((amounts[-1] - float(rt.amount)) / float(rt.amount) * 100, 1)
    return out
