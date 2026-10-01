import uuid
from datetime import date
from decimal import Decimal

import pytest

from app.models.transaction import Transaction

MONTH = "2026-06-01"


async def _tx(session, user, workspace, account, day, amount, kind="debit", description="Shop", category=None, **kw):
    tx = Transaction(
        user_id=user.id, workspace_id=workspace.id, account_id=account.id, description=description,
        amount=Decimal(str(amount)), currency="BRL", date=day, type=kind, source=kw.pop("source", "manual"),
        status="posted", category_id=category.id if category else None, **kw,
    )
    session.add(tx)
    await session.commit()
    return tx


def _prior_months(count=12):
    year, month = 2026, 5
    for _ in range(count):
        yield date(year, month, 10)
        month -= 1
        if month == 0:
            year, month = year - 1, 12


@pytest.fixture
async def history(session, test_user, test_workspace, test_account, test_categories):
    food, transport, _ = test_categories
    for day in _prior_months():
        await _tx(session, test_user, test_workspace, test_account, day, 1000, "credit", "Salary")
        await _tx(session, test_user, test_workspace, test_account, day, 100, "debit", "Old Grocer", food)
        await _tx(session, test_user, test_workspace, test_account, day, 50, "debit", "Bus Pass", transport)
    return food, transport


@pytest.mark.asyncio
async def test_the_month_is_set_against_the_previous_and_the_usual_month(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    food, _ = history
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 5), 1000, "credit", "Salary")
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 6), 250, "debit", "Old Grocer", food)
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 7), 50, "debit", "Bus Pass", history[1])

    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()
    assert body["month"] == MONTH
    this = body["this_month"]
    assert (this["income"], this["expenses"], this["saved"]) == (1000, 300, 700)
    assert this["savings_rate"] == pytest.approx(0.7)
    assert body["previous_month"]["expenses"] == 150
    assert body["usual"]["expenses"] == 150 and body["usual"]["income"] == 1000
    assert body["usual_months"] == 12


@pytest.mark.asyncio
async def test_categories_show_this_month_against_their_usual_and_the_movers(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    food, transport = history
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 6), 250, "debit", "Old Grocer", food)
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()

    by_name = {c["name"]: c for c in body["categories"]}
    assert by_name[food.name]["amount"] == 250 and by_name[food.name]["usual"] == 100
    assert by_name[food.name]["delta"] == 150
    assert by_name[food.name]["share"] == pytest.approx(1.0)
    assert by_name[transport.name]["amount"] == 0 and by_name[transport.name]["delta"] == -50
    assert [m["name"] for m in body["movers_up"]] == [food.name]
    assert [m["name"] for m in body["movers_down"]] == [transport.name]
    assert body["categories"][0]["name"] == food.name  # biggest this month first


@pytest.mark.asyncio
async def test_new_merchants_large_transactions_and_what_is_uncategorized(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 8), 400, "debit", "Brand New Gadget 42")
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 9), 100, "debit", "Old Grocer 7", history[0])
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()

    assert [m["name"] for m in body["new_merchants"]] == ["Brand New Gadget 42"]  # Old Grocer was seen before
    assert body["large_transactions"][0]["description"] == "Brand New Gadget 42"
    assert body["large_transactions"][0]["category_name"] is None
    assert body["uncategorized_expenses"] == 400
    assert body["uncategorized_share"] == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_transfers_are_left_out_but_reported_on_their_own_line(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    pair = uuid.uuid4()
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 10), 700, "debit", "Move out", transfer_pair_id=pair)
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 10), 700, "credit", "Move in", transfer_pair_id=pair)
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()
    assert body["this_month"]["income"] == 0 and body["this_month"]["expenses"] == 0
    assert body["moved_between_accounts"] == 700 and body["moved_count"] == 1


@pytest.mark.asyncio
async def test_expenses_linked_to_a_recurring_item_are_split_from_the_rest(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 2), 300, "debit", "Rent", recurring_transaction_id=uuid.uuid4())
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 3), 120, "debit", "Cafe")
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()
    assert body["recurring_expenses"] == 300 and body["other_expenses"] == 120


@pytest.mark.asyncio
async def test_the_year_table_runs_from_january_to_the_chosen_month(
    client, auth_headers, session, test_user, test_workspace, test_account, history
):
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()
    assert [m["month"] for m in body["year"]] == [f"2026-{m:02d}" for m in range(1, 7)]
    assert body["year"][0] == {"month": "2026-01", "income": 1000, "expenses": 150, "saved": 850}


@pytest.mark.asyncio
async def test_a_workspace_without_history_still_gets_a_review(
    client, auth_headers, session, test_user, test_workspace, test_account
):
    await _tx(session, test_user, test_workspace, test_account, date(2026, 6, 3), 80, "debit", "First Ever")
    body = (await client.get(f"/api/reports/monthly-review?month={MONTH}", headers=auth_headers)).json()
    assert body["this_month"]["expenses"] == 80
    assert body["usual"] is None and body["previous_month"] is None and body["usual_months"] == 0
    assert body["movers_up"] == [] and body["movers_down"] == []
    assert body["new_merchants"][0]["name"] == "First Ever"
