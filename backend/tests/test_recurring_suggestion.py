from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.models.transaction import Transaction
from app.services.recurring_suggestion_service import infer_frequency, name_key


async def _add(session, user, workspace, account, description, amount, day, **kw):
    tx = Transaction(
        user_id=user.id,
        workspace_id=workspace.id,
        account_id=account.id,
        description=description,
        amount=Decimal(str(amount)),
        currency="BRL",
        date=day,
        type=kw.pop("type", "debit"),
        source=kw.pop("source", "manual"),
        status="posted",
        **kw,
    )
    session.add(tx)
    await session.commit()
    await session.refresh(tx)
    return tx


def _monthly(start: date, n: int) -> list[date]:
    return [date(start.year + (start.month - 1 + i) // 12, (start.month - 1 + i) % 12 + 1, start.day) for i in range(n)]


def test_name_key_ignores_reference_numbers_and_case():
    assert name_key("NETFLIX.COM 4412") == name_key("Netflix.com 9981") == ("netflix", "com")
    assert name_key("12345") == ()


@pytest.mark.parametrize(
    "gaps,expected",
    [
        ([30, 31, 30, 29], "monthly"),
        ([7, 7, 8, 7], "weekly"),
        ([14, 14, 15], "biweekly"),
        ([91, 92, 90], "quarterly"),
        ([365, 366], "yearly"),
    ],
)
def test_infer_frequency_from_gaps(gaps, expected):
    day = date(2024, 1, 5)
    dates = [day]
    for g in gaps:
        day += timedelta(days=g)
        dates.append(day)
    frequency, confidence, _ = infer_frequency(dates)
    assert frequency == expected
    assert confidence in {"high", "medium", "low"}


def test_infer_frequency_refuses_irregular_series():
    dates = [date(2025, 1, 1), date(2025, 1, 9), date(2025, 3, 20), date(2025, 3, 22)]
    assert infer_frequency(dates)[0] is None
    assert infer_frequency([date(2025, 1, 1)])[0] is None


@pytest.mark.asyncio
async def test_monthly_by_amount_and_name(client, auth_headers, session, test_user, test_workspace, test_account):
    txs = [
        await _add(session, test_user, test_workspace, test_account, f"NETFLIX.COM {1000 + i}", "39.90", d)
        for i, d in enumerate(_monthly(date(2026, 1, 10), 5))
    ]
    resp = await client.get(f"/api/recurring-transactions/suggestion/{txs[-1].id}", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["frequency"] == "monthly"
    assert body["match_basis"] == "amount_and_name"
    assert body["confidence"] == "high"
    assert body["occurrences"] == 5
    assert body["day_of_month"] == 10
    assert body["amount_varies"] is False
    assert body["next_occurrence"] == "2026-06-10"


@pytest.mark.asyncio
async def test_falls_back_to_name_when_the_amount_varies(client, auth_headers, session, test_user, test_workspace, test_account):
    amounts = ["60.10", "71.55", "58.00", "64.20"]
    txs = [
        await _add(session, test_user, test_workspace, test_account, "Electricity Co", a, d)
        for a, d in zip(amounts, _monthly(date(2026, 1, 3), 4))
    ]
    resp = await client.get(f"/api/recurring-transactions/suggestion/{txs[-1].id}", headers=auth_headers)
    body = resp.json()
    assert body["match_basis"] == "name"
    assert body["frequency"] == "monthly"
    assert body["amount_varies"] is True
    assert body["occurrences"] == 4


@pytest.mark.asyncio
async def test_yearly(client, auth_headers, session, test_user, test_workspace, test_account):
    txs = [
        await _add(session, test_user, test_workspace, test_account, "Home Insurance", "2042.51", date(y, 6, 15))
        for y in (2023, 2024, 2025)
    ]
    resp = await client.get(f"/api/recurring-transactions/suggestion/{txs[-1].id}", headers=auth_headers)
    assert resp.json()["frequency"] == "yearly"
    assert resp.json()["next_occurrence"] == "2026-06-15"


@pytest.mark.asyncio
async def test_a_one_off_has_no_suggestion(client, auth_headers, session, test_user, test_workspace, test_account):
    tx = await _add(session, test_user, test_workspace, test_account, "Unique Purchase", "9.99", date(2026, 2, 2))
    body = (await client.get(f"/api/recurring-transactions/suggestion/{tx.id}", headers=auth_headers)).json()
    assert body["frequency"] is None
    assert body["match_basis"] == "none"
    assert body["occurrences"] == 1


@pytest.mark.asyncio
async def test_other_directions_and_transfers_do_not_count(client, auth_headers, session, test_user, test_workspace, test_account):
    base = date(2026, 1, 10)
    tx = await _add(session, test_user, test_workspace, test_account, "Gym Membership", "30.00", base)
    await _add(session, test_user, test_workspace, test_account, "Gym Membership", "30.00", date(2026, 2, 10), type="credit")
    body = (await client.get(f"/api/recurring-transactions/suggestion/{tx.id}", headers=auth_headers)).json()
    assert body["occurrences"] == 1


@pytest.mark.asyncio
async def test_unknown_transaction_is_404(client, auth_headers):
    resp = await client.get(
        "/api/recurring-transactions/suggestion/00000000-0000-0000-0000-000000000000", headers=auth_headers
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_creating_from_a_transaction_links_it_and_starts_after_it(
    client, auth_headers, session, test_user, test_workspace, test_account
):
    tx = await _add(session, test_user, test_workspace, test_account, "Netflix", "39.90", date(2026, 3, 10))
    payload = {
        "description": "Netflix", "amount": 39.9, "currency": "BRL", "type": "debit",
        "frequency": "monthly", "start_date": "2026-03-10", "skip_first": True,
        "account_id": str(test_account.id), "source_transaction_id": str(tx.id),
    }
    resp = await client.post("/api/recurring-transactions", json=payload, headers=auth_headers)
    assert resp.status_code == 201
    body = resp.json()
    assert body["next_occurrence"] == "2026-04-10"
    assert body["auto_generate"] is False
    await session.refresh(tx)
    assert str(tx.recurring_transaction_id) == body["id"]

    again = await client.post("/api/recurring-transactions", json=payload, headers=auth_headers)
    assert again.status_code == 400


@pytest.mark.asyncio
async def test_name_pass_wins_when_the_amount_pass_is_thin(client, auth_headers, session, test_user, test_workspace, test_account):
    days = _monthly(date(2026, 1, 8), 6)
    amounts = ["20.00", "21.50", "19.00", "22.10", "20.00", "23.00"]
    txs = [
        await _add(session, test_user, test_workspace, test_account, "ACP Parking", a, d)
        for a, d in zip(amounts, days)
    ]
    body = (await client.get(f"/api/recurring-transactions/suggestion/{txs[0].id}", headers=auth_headers)).json()
    assert body["match_basis"] == "name"
    assert body["occurrences"] == 6
    assert body["confidence"] == "high"


async def _make_recurring(client, headers, account, description, amount, **extra):
    payload = {
        "description": description, "amount": amount, "currency": "BRL", "type": "debit",
        "frequency": "monthly", "start_date": "2026-03-10", "account_id": str(account.id), **extra,
    }
    resp = await client.post("/api/recurring-transactions", json=payload, headers=headers)
    assert resp.status_code == 201
    return resp.json()


@pytest.mark.asyncio
async def test_proposes_unlinked_recurring_items_with_a_close_amount(
    client, auth_headers, session, test_user, test_workspace, test_account
):
    close = await _make_recurring(client, auth_headers, test_account, "Apple One", 35.0)
    await _make_recurring(client, auth_headers, test_account, "Way Off", 500.0)
    tx = await _add(session, test_user, test_workspace, test_account, "APPLE.COM/BILL", "34.50", date(2026, 4, 10))

    body = (await client.get(f"/api/recurring-transactions/suggestion/{tx.id}", headers=auth_headers)).json()
    ids = [m["id"] for m in body["existing_matches"]]
    assert ids == [close["id"]]
    assert body["existing_matches"][0]["difference_pct"] == pytest.approx(1.4, abs=0.1)


@pytest.mark.asyncio
async def test_a_linked_recurring_item_is_not_proposed(
    client, auth_headers, session, test_user, test_workspace, test_account
):
    rec = await _make_recurring(client, auth_headers, test_account, "Gym", 30.0)
    first = await _add(session, test_user, test_workspace, test_account, "Gym", "30.00", date(2026, 3, 10))
    link = await client.post(f"/api/recurring-transactions/{rec['id']}/link/{first.id}", headers=auth_headers)
    assert link.status_code == 200

    other = await _add(session, test_user, test_workspace, test_account, "Gym again", "30.00", date(2026, 4, 10))
    body = (await client.get(f"/api/recurring-transactions/suggestion/{other.id}", headers=auth_headers)).json()
    assert body["existing_matches"] == []


@pytest.mark.asyncio
async def test_linking_moves_the_schedule_past_the_transaction(
    client, auth_headers, session, test_user, test_workspace, test_account
):
    rec = await _make_recurring(client, auth_headers, test_account, "Rent", 800.0, start_date="2026-03-01")
    tx = await _add(session, test_user, test_workspace, test_account, "Rent", "800.00", date(2026, 5, 2))
    resp = await client.post(f"/api/recurring-transactions/{rec['id']}/link/{tx.id}", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["next_occurrence"] == "2026-06-01"
    await session.refresh(tx)
    assert str(tx.recurring_transaction_id) == rec["id"]

    again = await client.post(f"/api/recurring-transactions/{rec['id']}/link/{tx.id}", headers=auth_headers)
    assert again.status_code == 400
    missing = await client.post(
        f"/api/recurring-transactions/{rec['id']}/link/00000000-0000-0000-0000-000000000000", headers=auth_headers
    )
    assert missing.status_code == 404
