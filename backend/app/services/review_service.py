"""A plain-language review of one month: how it went, where the money went and
what changed, set against the user's own usual month.

Income and spending use the same filter as the dashboard and the reports
(`counts_as_user_pnl`), so transfers, ignored rows and the like are left out
here exactly as they are everywhere else. Money that moved between the user's
own accounts is reported on its own line so the exclusion is visible, not
silent."""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction
from app.services._query_filters import counts_as_user_pnl, is_transfer
from app.services.categorization_service import merchant_key

HISTORY_MONTHS = 12
TOP_MOVERS = 3
TOP_LARGE = 5
TOP_NEW_MERCHANTS = 5
# A category has to move by at least this much (in the primary currency) to be called a mover.
MIN_MOVE = 25.0


def month_start(value: date) -> date:
    return value.replace(day=1)


def add_months(value: date, months: int) -> date:
    index = value.year * 12 + (value.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


def _key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _amount(tx_amount, tx_primary) -> float:
    return float(tx_primary if tx_primary is not None else tx_amount)


def _figures(income: float, expenses: float) -> dict:
    saved = income - expenses
    return {
        "income": round(income, 2),
        "expenses": round(expenses, 2),
        "saved": round(saved, 2),
        "savings_rate": round(saved / income, 4) if income > 0 else None,
    }


async def monthly_review(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    currency: str,
    month: Optional[date] = None,
) -> dict:
    start = month_start(month or app_today())
    end = add_months(start, 1)
    window_start = min(add_months(start, -HISTORY_MONTHS), date(start.year, 1, 1))

    rows = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.date,
                Transaction.type,
                Transaction.amount,
                Transaction.amount_primary,
                Transaction.category_id,
                Transaction.description,
                Transaction.recurring_transaction_id,
            )
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Account.is_closed.is_(False),
                Transaction.date >= window_start,
                Transaction.date < end,
                Transaction.source != "opening_balance",
                Transaction.status == "posted",
                counts_as_user_pnl(),
            )
        )
    ).all()

    categories = {
        c.id: c for c in (await session.execute(select(Category).where(Category.workspace_id == workspace_id))).scalars()
    }

    income_by_month: dict[str, float] = defaultdict(float)
    expense_by_month: dict[str, float] = defaultdict(float)
    category_by_month: dict[tuple, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    merchants_before: set[str] = set()
    merchants_now: dict[str, dict] = {}
    large: list = []
    recurring = other = uncategorized = 0.0

    for tx_id, tx_date, tx_type, amount, primary, category_id, description, recurring_id in rows:
        value = _amount(amount, primary)
        k = _key(tx_date)
        if tx_type == "credit":
            income_by_month[k] += value
            continue
        expense_by_month[k] += value
        category_by_month[category_id][k] += value
        merchant = merchant_key(description)
        if tx_date < start:
            if merchant:
                merchants_before.add(merchant)
            continue
        if recurring_id is not None:
            recurring += value
        else:
            other += value
        if category_id is None:
            uncategorized += value
        group = merchants_now.setdefault(merchant, {"name": description, "amount": 0.0, "count": 0})
        group["amount"] += value
        group["count"] += 1
        large.append((value, tx_id, tx_date, description, category_id))

    this_key, prev_key = _key(start), _key(add_months(start, -1))
    history_keys = [_key(add_months(start, -i)) for i in range(1, HISTORY_MONTHS + 1)]
    # Months before the first one with any data would drag "usual" down for no reason.
    with_data = [k for k in history_keys if income_by_month.get(k) or expense_by_month.get(k)]
    # history_keys is newest first, so "from the oldest month with data" is a prefix of it.
    oldest = max((history_keys.index(k) for k in with_data), default=-1)
    usual_keys = history_keys[: oldest + 1]

    def avg(values: dict[str, float]) -> float:
        return sum(values.get(k, 0.0) for k in usual_keys) / len(usual_keys) if usual_keys else 0.0

    this_income, this_expenses = income_by_month.get(this_key, 0.0), expense_by_month.get(this_key, 0.0)
    previous = (
        _figures(income_by_month.get(prev_key, 0.0), expense_by_month.get(prev_key, 0.0))
        if prev_key in with_data
        else None
    )
    usual = _figures(avg(income_by_month), avg(expense_by_month)) if usual_keys else None

    lines = []
    for category_id, by_month in category_by_month.items():
        amount = by_month.get(this_key, 0.0)
        usual_amount = avg(by_month)
        if amount <= 0 and usual_amount <= 0:
            continue
        category = categories.get(category_id) if category_id else None
        lines.append(
            {
                "category_id": category_id,
                "name": category.name.strip() if category else None,
                "icon": category.icon if category else None,
                "color": category.color if category else None,
                "amount": round(amount, 2),
                "usual": round(usual_amount, 2),
                "delta": round(amount - usual_amount, 2),
                "share": round(amount / this_expenses, 4) if this_expenses > 0 else 0.0,
            }
        )
    lines.sort(key=lambda line: -line["amount"])
    movers = [line for line in lines if abs(line["delta"]) >= MIN_MOVE and usual_keys]
    movers_up = sorted((m for m in movers if m["delta"] > 0), key=lambda m: -m["delta"])[:TOP_MOVERS]
    movers_down = sorted((m for m in movers if m["delta"] < 0), key=lambda m: m["delta"])[:TOP_MOVERS]

    new_merchants = sorted(
        (m for key, m in merchants_now.items() if key and key not in merchants_before),
        key=lambda m: -m["amount"],
    )[:TOP_NEW_MERCHANTS]
    large.sort(key=lambda t: -t[0])
    large_transactions = [
        {
            "id": tx_id,
            "date": tx_date,
            "description": description,
            "amount": round(value, 2),
            "category_name": categories[category_id].name.strip() if category_id in categories else None,
        }
        for value, tx_id, tx_date, description, category_id in large[:TOP_LARGE]
    ]

    moved_amount, moved_count = (
        await session.execute(
            select(func.coalesce(func.sum(func.coalesce(Transaction.amount_primary, Transaction.amount)), 0), func.count())
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Account.is_closed.is_(False),
                Transaction.date >= start,
                Transaction.date < end,
                Transaction.type == "debit",
                Transaction.source != "opening_balance",
                is_transfer(),
            )
        )
    ).one()

    year_rows = []
    for m in range(1, 13):
        k = f"{start.year:04d}-{m:02d}"
        if date(start.year, m, 1) > start:
            break
        year_rows.append(
            {"month": k, "income": round(income_by_month.get(k, 0.0), 2), "expenses": round(expense_by_month.get(k, 0.0), 2),
             "saved": round(income_by_month.get(k, 0.0) - expense_by_month.get(k, 0.0), 2)}
        )

    return {
        "month": start,
        "currency": currency,
        "this_month": _figures(this_income, this_expenses),
        "previous_month": previous,
        "usual": usual,
        "usual_months": len(usual_keys),
        "categories": lines,
        "movers_up": movers_up,
        "movers_down": movers_down,
        "new_merchants": [{"name": m["name"], "amount": round(m["amount"], 2), "count": m["count"]} for m in new_merchants],
        "large_transactions": large_transactions,
        "recurring_expenses": round(recurring, 2),
        "other_expenses": round(other, 2),
        "uncategorized_expenses": round(uncategorized, 2),
        "uncategorized_share": round(uncategorized / this_expenses, 4) if this_expenses > 0 else 0.0,
        "moved_between_accounts": round(float(moved_amount or 0), 2),
        "moved_count": int(moved_count or 0),
        "year": year_rows,
    }
