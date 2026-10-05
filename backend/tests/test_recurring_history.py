from datetime import date
from decimal import Decimal

import pytest

from app.models.transaction import Transaction
from app.schemas.recurring_transaction import RecurringTransactionCreate
from app.services import recurring_history_service as history
from app.services.recurring_transaction_service import create_recurring_transaction


async def _item(session, user, workspace, account, amount="15.00", frequency="monthly"):
    return await create_recurring_transaction(
        session, workspace.id, user.id,
        RecurringTransactionCreate(
            description="Streaming", amount=Decimal(amount), currency="BRL", type="debit",
            frequency=frequency, start_date=date(2025, 1, 5), account_id=account.id,
        ),
    )


async def _charge(session, user, workspace, account, rt, amount, day, **kw):
    tx = Transaction(
        user_id=user.id, workspace_id=workspace.id, account_id=account.id, description="Streaming",
        amount=Decimal(str(amount)), currency="BRL", date=day, type="debit", source=kw.pop("source", "import"),
        status=kw.pop("status", "posted"), recurring_transaction_id=rt.id,
    )
    session.add(tx)
    await session.commit()
    return tx


def _months(n, start=date(2025, 1, 5)):
    return [date(start.year + (start.month - 1 + i) // 12, (start.month - 1 + i) % 12 + 1, 5) for i in range(n)]


@pytest.mark.asyncio
async def test_a_steady_price_with_one_increase(session, test_user, test_workspace, test_account):
    rt = await _item(session, test_user, test_workspace, test_account)
    for i, d in enumerate(_months(10)):
        await _charge(session, test_user, test_workspace, test_account, rt, "15.00" if i < 6 else "17.00", d)

    h = await history.history(session, rt.id, test_workspace.id, today=date(2025, 11, 20))

    assert h["count"] == 10
    assert h["first_date"] == date(2025, 1, 5) and h["last_date"] == date(2025, 10, 5)
    assert h["months_running"] == 9.0
    assert float(h["first_amount"]) == 15.0 and float(h["latest_amount"]) == 17.0
    assert h["change_since_first_pct"] == 13.3
    assert [(float(c["from_amount"]), float(c["to_amount"]), c["change_pct"]) for c in h["price_changes"]] == [(15.0, 17.0, 13.3)]
    assert h["amount_varies"] is False
    assert float(h["total_paid"]) == 6 * 15 + 4 * 17
    # The last 12 months from 2025-11-20 reach back to 2024-11-20: all of them.
    assert float(h["total_last_12_months"]) == float(h["total_paid"])
    assert h["latest_vs_planned_pct"] == 13.3


@pytest.mark.asyncio
async def test_a_bill_that_varies_every_time_has_no_price_steps(session, test_user, test_workspace, test_account):
    rt = await _item(session, test_user, test_workspace, test_account)
    for d, amount in zip(_months(6), ["80", "95", "70", "120", "88", "101"]):
        await _charge(session, test_user, test_workspace, test_account, rt, amount, d)
    h = await history.history(session, rt.id, test_workspace.id, today=date(2025, 7, 1))
    assert h["amount_varies"] is True
    assert h["price_changes"] == []
    assert float(h["min_amount"]) == 70.0 and float(h["max_amount"]) == 120.0


@pytest.mark.asyncio
async def test_only_the_last_twelve_months_count_towards_that_total(session, test_user, test_workspace, test_account):
    rt = await _item(session, test_user, test_workspace, test_account)
    for d in _months(24):
        await _charge(session, test_user, test_workspace, test_account, rt, "10.00", d)
    h = await history.history(session, rt.id, test_workspace.id, today=date(2026, 12, 20))
    assert float(h["total_paid"]) == 240.0
    assert float(h["total_last_12_months"]) == 120.0


@pytest.mark.asyncio
async def test_late_when_the_next_charge_is_past_due_by_more_than_the_slack(session, test_user, test_workspace, test_account):
    rt = await _item(session, test_user, test_workspace, test_account)
    await _charge(session, test_user, test_workspace, test_account, rt, "15.00", date(2025, 1, 5))
    on_time = await history.history(session, rt.id, test_workspace.id, today=rt.next_occurrence)
    assert "overdue_days" not in on_time
    late = await history.history(session, rt.id, test_workspace.id, today=date(2025, 3, 1))
    assert late["overdue_days"] > 5


@pytest.mark.asyncio
async def test_pending_placeholders_are_not_charges_and_no_charges_is_fine(session, test_user, test_workspace, test_account):
    rt = await _item(session, test_user, test_workspace, test_account)
    await _charge(session, test_user, test_workspace, test_account, rt, "15.00", date(2025, 2, 5), status="pending", source="recurring")
    h = await history.history(session, rt.id, test_workspace.id, today=date(2025, 2, 6))
    assert h["count"] == 0 and h["charges"] == []
    assert await history.history(session, rt.id, test_workspace.id, today=date(2025, 2, 6)) is not None


@pytest.mark.asyncio
async def test_api_and_unknown_item(client, auth_headers, session, test_user, test_workspace, test_account):
    import uuid

    rt = await _item(session, test_user, test_workspace, test_account)
    await _charge(session, test_user, test_workspace, test_account, rt, "15.00", date(2025, 1, 5))
    ok = await client.get(f"/api/recurring-transactions/{rt.id}/history", headers=auth_headers)
    assert ok.status_code == 200
    assert ok.json()["count"] == 1
    missing = await client.get(f"/api/recurring-transactions/{uuid.uuid4()}/history", headers=auth_headers)
    assert missing.status_code == 404
