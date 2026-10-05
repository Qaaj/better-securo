from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.schemas.recurring_transaction import RecurringTransactionCreate
from app.services import recurring_discovery_service as discovery
from app.services.recurring_transaction_service import create_recurring_transaction


def _monthly(start: date, n: int) -> list[date]:
    return [date(start.year + (start.month - 1 + i) // 12, (start.month - 1 + i) % 12 + 1, start.day) for i in range(n)]


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
        source=kw.pop("source", "import"),
        status="posted",
        **kw,
    )
    session.add(tx)
    await session.commit()
    await session.refresh(tx)
    return tx


async def _series(session, user, workspace, account, description, amount, start, n):
    return [await _add(session, user, workspace, account, description, amount, d) for d in _monthly(start, n)]


async def _recurring(session, user, workspace, account, description, amount, frequency="monthly"):
    return await create_recurring_transaction(
        session, workspace.id, user.id,
        RecurringTransactionCreate(
            description=description, amount=Decimal(str(amount)), currency="BRL", type="debit",
            frequency=frequency, start_date=date(2026, 1, 5), account_id=account.id,
        ),
    )


@pytest.mark.asyncio
async def test_matches_an_item_to_its_series_even_when_the_names_differ(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "ACP La Minoterie", "126.00", date(2026, 1, 2), 6)
    await _series(session, test_user, test_workspace, test_account, "Corner Cafe", "4.50", date(2026, 1, 3), 6)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Syndic charges", "126.00")

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert len(result["matches"]) == 1
    match = result["matches"][0]
    assert match["recurring_id"] == rt.id
    assert match["series"]["occurrences"] == 6
    assert match["confidence"] in ("high", "medium")
    assert set(match["reasons"]) >= {"amount", "schedule"}
    # The cafe repeats too and fits no item, so it is a new one.
    assert [s["name"] for s in result["new_series"]] == ["Corner Cafe"]


@pytest.mark.asyncio
async def test_a_name_in_common_helps_and_a_different_frequency_rules_a_series_out(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Netflix Premium", "12.99", date(2026, 1, 8), 5)
    monthly = await _recurring(session, test_user, test_workspace, test_account, "Netflix", "12.99")
    yearly = await _recurring(session, test_user, test_workspace, test_account, "Other yearly", "12.99", frequency="yearly")

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert [m["recurring_id"] for m in result["matches"]] == [monthly.id]
    assert "name" in result["matches"][0]["reasons"]
    assert yearly.id not in {m["recurring_id"] for m in result["matches"]}


@pytest.mark.asyncio
async def test_each_series_goes_to_one_item_only(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Gym Club", "40.00", date(2026, 1, 10), 5)
    await _recurring(session, test_user, test_workspace, test_account, "Gym", "40.00")
    await _recurring(session, test_user, test_workspace, test_account, "Gym copy", "40.00")
    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    assert len(result["matches"]) == 1


@pytest.mark.asyncio
async def test_new_series_need_a_repeating_pattern_and_split_by_amount(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Apple Services", "35.00", date(2026, 1, 25), 5)
    await _series(session, test_user, test_workspace, test_account, "Apple Services", "2.99", date(2026, 1, 12), 5)
    await _add(session, test_user, test_workspace, test_account, "One Off Store", "99.00", date(2026, 3, 3))
    await _add(session, test_user, test_workspace, test_account, "Random Shop", "10.00", date(2026, 2, 3))
    await _add(session, test_user, test_workspace, test_account, "Random Shop", "55.00", date(2026, 4, 20))

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert sorted(float(s["typical_amount"]) for s in result["new_series"]) == [2.99, 35.0]
    assert all(s["frequency"] == "monthly" for s in result["new_series"])
    biggest = result["new_series"][0]
    assert float(biggest["yearly_amount"]) == 420.0
    assert biggest["next_occurrence"] == date(2026, 6, 25)


@pytest.mark.asyncio
async def test_a_charge_that_stopped_is_marked_lapsed_and_sorted_last(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Old Magazine", "20.00", date(2025, 1, 4), 4)
    await _series(session, test_user, test_workspace, test_account, "Live Service", "10.00", date(2026, 1, 4), 6)
    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    assert [(s["name"], s["lapsed"]) for s in result["new_series"]] == [("Live Service", False), ("Old Magazine", True)]


@pytest.mark.asyncio
async def test_a_varying_bill_becomes_one_series(session, test_user, test_workspace, test_account):
    for d, amount in zip(_monthly(date(2026, 1, 15), 6), ["80.10", "95.50", "70.00", "120.25", "88.00", "101.00"]):
        await _add(session, test_user, test_workspace, test_account, "Power Company", amount, d)
    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    assert len(result["new_series"]) == 1
    assert result["new_series"][0]["amount_varies"] is True
    assert result["new_series"][0]["occurrences"] == 6


@pytest.mark.asyncio
async def test_linked_transfers_and_opening_balances_are_left_out(session, test_user, test_workspace, test_account):
    txs = await _series(session, test_user, test_workspace, test_account, "Already Tracked", "9.00", date(2026, 1, 9), 5)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Tracked", "9.00")
    for tx in txs:
        tx.recurring_transaction_id = rt.id
    await session.commit()
    await _series(session, test_user, test_workspace, test_account, "Opening", "50.00", date(2026, 1, 9), 4)
    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    names = [s["name"] for s in result["new_series"]]
    assert "Already Tracked" not in names


@pytest.mark.asyncio
async def test_linking_a_series_links_all_of_it_and_moves_the_schedule(session, test_user, test_workspace, test_account):
    txs = await _series(session, test_user, test_workspace, test_account, "Fees", "126.00", date(2026, 1, 2), 5)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Syndic", "126.00")
    updated = await discovery.link_series(session, rt.id, [t.id for t in txs], test_workspace.id)
    assert updated.next_occurrence > date(2026, 5, 2)
    linked = (await session.execute(select(Transaction).where(Transaction.recurring_transaction_id == rt.id))).scalars().all()
    assert len(linked) == 5
    with pytest.raises(ValueError):
        await discovery.link_series(session, rt.id, [t.id for t in txs], test_workspace.id)


@pytest.mark.asyncio
async def test_creating_from_a_series_links_everything_and_forecasts_the_next_one(session, test_user, test_workspace, test_account):
    from app.schemas.recurring_discovery import CreateFromSeriesRequest

    txs = await _series(session, test_user, test_workspace, test_account, "Streaming Co", "15.00", date(2026, 1, 20), 4)
    created = await discovery.create_from_series(
        session, test_workspace.id, test_user.id,
        CreateFromSeriesRequest(
            description="Streaming Co", amount=Decimal("15.00"), currency="BRL", type="debit", frequency="monthly",
            day_of_month=20, account_id=test_account.id, transaction_ids=[t.id for t in txs],
        ),
    )
    assert created.auto_generate is False
    assert created.next_occurrence == date(2026, 5, 20)
    linked = (await session.execute(select(Transaction).where(Transaction.recurring_transaction_id == created.id))).scalars().all()
    assert len(linked) == 4
    again = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    assert again["new_series"] == []


@pytest.mark.asyncio
async def test_dismissing_hides_it_until_reset(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Unwanted", "5.00", date(2026, 1, 7), 5)
    first = (await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1)))["new_series"][0]
    await discovery.dismiss(session, test_workspace.id, "series", first["key"], None)
    assert (await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1)))["new_series"] == []
    assert await discovery.reset_dismissals(session, test_workspace.id) == 1
    assert len((await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1)))["new_series"]) == 1


@pytest.mark.asyncio
async def test_dismissing_a_match_offers_the_series_as_new_instead(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Fees", "126.00", date(2026, 1, 2), 5)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Syndic", "126.00")
    match = (await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1)))["matches"][0]
    await discovery.dismiss(session, test_workspace.id, "match", match["series"]["key"], rt.id)
    after = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))
    assert after["matches"] == []
    assert len(after["new_series"]) == 1


@pytest.mark.asyncio
async def test_api_round_trip(client, auth_headers, session, test_user, test_workspace, test_account):
    txs = await _series(session, test_user, test_workspace, test_account, "Fees", "126.00", date(2026, 1, 2), 5)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Syndic", "126.00")

    found = (await client.get("/api/recurring-transactions/discoveries", headers=auth_headers)).json()
    assert found["matches"][0]["recurring_id"] == str(rt.id)
    ids = found["matches"][0]["series"]["transaction_ids"]
    assert len(ids) == 5

    linked = await client.post(f"/api/recurring-transactions/{rt.id}/link-series", json={"transaction_ids": ids}, headers=auth_headers)
    assert linked.status_code == 200
    again = await client.post(f"/api/recurring-transactions/{rt.id}/link-series", json={"transaction_ids": ids}, headers=auth_headers)
    assert again.status_code == 400

    bad = await client.post("/api/recurring-transactions/discoveries/dismiss", json={"kind": "match", "key": "x"}, headers=auth_headers)
    assert bad.status_code == 422
    ok = await client.post("/api/recurring-transactions/discoveries/dismiss", json={"kind": "series", "key": "x"}, headers=auth_headers)
    assert ok.status_code == 204
    reset = await client.post("/api/recurring-transactions/discoveries/reset", headers=auth_headers)
    assert reset.json() == {"restored": 1}
    assert len(txs) == 5
    assert (await session.execute(select(RecurringTransaction))).scalars().first() is not None


@pytest.mark.asyncio
async def test_an_item_with_its_own_charges_linked_is_not_offered_another_merchants_series(session, test_user, test_workspace, test_account):
    own = await _series(session, test_user, test_workspace, test_account, "Starlink Internet", "62.00", date(2026, 1, 25), 5)
    for tx in own:
        tx.recurring_transaction_id = None
    rt = await _recurring(session, test_user, test_workspace, test_account, "Starlink", "62.00")
    for tx in own:
        tx.recurring_transaction_id = rt.id
    await session.commit()
    # A different merchant with a similar amount and the same schedule.
    await _series(session, test_user, test_workspace, test_account, "Telenet BV", "63.27", date(2026, 1, 28), 6)

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert result["matches"] == []
    assert [s["name"] for s in result["new_series"]] == ["Telenet BV"]


@pytest.mark.asyncio
async def test_more_of_the_same_merchant_still_matches_an_item_that_has_charges_linked(session, test_user, test_workspace, test_account):
    linked = await _series(session, test_user, test_workspace, test_account, "Starlink Internet", "62.00", date(2026, 4, 25), 3)
    rt = await _recurring(session, test_user, test_workspace, test_account, "Dish", "62.00")
    for tx in linked:
        tx.recurring_transaction_id = rt.id
    await session.commit()
    # Older charges from the same merchant, not linked yet.
    await _series(session, test_user, test_workspace, test_account, "Starlink Internet", "62.00", date(2025, 10, 25), 4)

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert [m["recurring_id"] for m in result["matches"]] == [rt.id]
    assert "name" in result["matches"][0]["reasons"]


@pytest.mark.asyncio
async def test_a_series_named_like_another_item_is_not_offered_to_an_item_on_amount_alone(session, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Netflix Premium", "17.99", date(2026, 1, 24), 6)
    await _recurring(session, test_user, test_workspace, test_account, "Netflix", "17.99")
    spotify = await _recurring(session, test_user, test_workspace, test_account, "Spotify", "18.00")

    result = await discovery.discover(session, test_workspace.id, today=date(2026, 7, 1))

    assert spotify.id not in {m["recurring_id"] for m in result["matches"]}
    assert len(result["matches"]) == 1
