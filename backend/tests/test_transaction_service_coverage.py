"""Additional coverage for app.services.transaction_service.

Targets the previously-uncovered branches: filtered
summary, sorting, transfer candidates / linking / counterparts, FX cascade in
updates, bill-link re-sync, and
assorted edge branches. See test_transaction_service.py for the baseline.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, Workspace
from app.models.account import Account
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.schemas.transaction import (
    TransactionCreate,
    TransactionUpdate,
    TransferCreate,
)
from app.services.transaction_service import (
    bulk_add_tags,
    bulk_remove_tags,
    create_transaction,
    create_transfer,
    create_transfer_counterpart,
    get_transaction,
    get_transactions,
    get_transfer_candidates,
    link_existing_as_transfer,
    update_transaction,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def acct(session: AsyncSession, test_user) -> Account:
    account = Account(
        id=uuid.uuid4(),
        user_id=test_user.id,
        name="CovAcc",
        type="checking",
        balance=Decimal("10000"),
        currency="BRL",
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


@pytest_asyncio.fixture
async def acct_usd(session: AsyncSession, test_user) -> Account:
    account = Account(
        id=uuid.uuid4(),
        user_id=test_user.id,
        name="CovUSD",
        type="checking",
        balance=Decimal("5000"),
        currency="USD",
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


@pytest_asyncio.fixture
async def cc_account(session: AsyncSession, test_user: User) -> Account:
    account = Account(
        id=uuid.uuid4(),
        user_id=test_user.id,
        name="CovCard",
        type="credit_card",
        balance=Decimal("0"),
        currency="BRL",
        statement_close_day=10,
        payment_due_day=20,
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


async def _mk_txn(session: AsyncSession, test_user: User, account: Account, **kw) -> Transaction:
    defaults = dict(
        id=uuid.uuid4(),
        user_id=test_user.id,
        account_id=account.id,
        description="T",
        amount=Decimal("10"),
        date=date(2025, 3, 1),
        type="debit",
        source="manual",
        created_at=datetime.now(timezone.utc),
    )
    defaults.update(kw)
    txn = Transaction(**defaults)
    session.add(txn)
    await session.commit()
    await session.refresh(txn)
    return txn


# ---------------------------------------------------------------------------
# get_transactions — filters, summary, sorting, multi-id (lines 144, 209, 365+)
# ---------------------------------------------------------------------------


async def test_get_transactions_filter_by_transaction_ids(session, test_user, test_workspace, acct):
    t1 = await _mk_txn(session, test_user, acct, description="Keep")
    await _mk_txn(session, test_user, acct, description="Drop")
    res, total, _ = await get_transactions(
        session, test_workspace.id, test_user.id, transaction_ids=[t1.id]
    )
    assert {t.description for t in res} == {"Keep"}
    assert total == 1


async def test_get_transactions_filter_by_payee_id(session, test_user, test_workspace, acct):
    from app.models.payee import Payee

    payee = Payee(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, name="Acme")
    session.add(payee)
    await session.commit()
    await _mk_txn(session, test_user, acct, description="WithPayee", payee_id=payee.id)
    await _mk_txn(session, test_user, acct, description="NoPayee")
    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, payee_id=payee.id
    )
    assert {t.description for t in res} == {"WithPayee"}


async def test_get_transactions_filter_by_currency_and_amount(session, test_user, test_workspace, acct):
    await _mk_txn(session, test_user, acct, description="Small", amount=Decimal("5"), currency="BRL")
    await _mk_txn(session, test_user, acct, description="Big", amount=Decimal("500"), currency="BRL")
    await _mk_txn(session, test_user, acct, description="UsdOne", amount=Decimal("50"), currency="USD")

    res, _, _ = await get_transactions(session, test_workspace.id, test_user.id, currency="usd")
    assert {t.description for t in res} == {"UsdOne"}

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, min_amount=10, max_amount=100
    )
    assert {t.description for t in res} == {"UsdOne"}


async def test_get_transactions_filter_by_account_types_and_ids(session, test_user, test_workspace, acct, acct_usd):
    await _mk_txn(session, test_user, acct, description="Checking")
    sav = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="Sav", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(sav)
    await session.commit()
    await _mk_txn(session, test_user, sav, description="Saving")

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, account_types=["savings"]
    )
    assert {t.description for t in res} == {"Saving"}

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, account_ids=[acct.id, sav.id]
    )
    assert {t.description for t in res} == {"Checking", "Saving"}

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, category_ids=[uuid.uuid4()]
    )
    assert res == []


async def test_get_transactions_include_summary(session, test_user, test_workspace, acct):
    await _mk_txn(session, test_user, acct, description="Inc", amount=Decimal("1000"), type="credit")
    await _mk_txn(session, test_user, acct, description="Exp", amount=Decimal("300"), type="debit")
    res, _, summary = await get_transactions(
        session, test_workspace.id, test_user.id, include_summary=True
    )
    assert summary is not None
    assert summary["income"] == Decimal("1000")
    assert summary["expense"] == Decimal("300")
    assert summary["net"] == Decimal("700")
    # Nothing transfer-like / ignored in range, so nothing is excluded (#242).
    assert summary["excluded"] == Decimal("0")


async def test_get_transactions_summary_excludes_ignored(session, test_user, test_workspace, acct):
    await _mk_txn(session, test_user, acct, description="Counted", amount=Decimal("100"), type="debit")
    await _mk_txn(
        session, test_user, acct, description="Ignored", amount=Decimal("999"),
        type="debit", is_ignored=True,
    )
    _, _, summary = await get_transactions(
        session, test_workspace.id, test_user.id, include_summary=True
    )

    assert summary is not None
    assert summary["expense"] == Decimal("100")
    # The ignored row leaves income/expense but surfaces in `excluded` (#242).
    assert summary["excluded"] == Decimal("999")


async def test_get_transactions_summary_excludes_ignored_category(
    session, test_user, test_workspace, acct
):
    from app.models.category import Category

    ignored = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Ignored",
        is_ignored=True,
    )
    session.add(ignored)
    await session.commit()

    await _mk_txn(session, test_user, acct, description="Counted", amount=Decimal("100"), type="debit")
    await _mk_txn(
        session,
        test_user,
        acct,
        description="Ignored by category",
        amount=Decimal("999"),
        type="debit",
        category_id=ignored.id,
    )
    _, _, summary = await get_transactions(
        session, test_workspace.id, test_user.id, include_summary=True
    )

    assert summary is not None
    assert summary["expense"] == Decimal("100")
    assert summary["excluded"] == Decimal("999")


async def test_get_transactions_summary_excludes_transfers_and_treat_as_transfer(
    session, test_user, test_workspace, acct
):
    """income/expense use counts_as_pnl(); paired transfers and
    treat_as_transfer categories are kept out of P/L and surface in
    `excluded` instead (#242)."""
    from app.models.category import Category

    invest = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Investments",
        treat_as_transfer=True,
    )
    session.add(invest)
    await session.commit()

    # Real P/L
    await _mk_txn(session, test_user, acct, description="Salary", amount=Decimal("2000"), type="credit")
    await _mk_txn(session, test_user, acct, description="Rent", amount=Decimal("800"), type="debit")
    # Paired transfer (both legs excluded from P/L, both counted in excluded)
    pair = uuid.uuid4()
    await _mk_txn(session, test_user, acct, description="Xfer out", amount=Decimal("500"), type="debit", transfer_pair_id=pair)
    await _mk_txn(session, test_user, acct, description="Xfer in", amount=Decimal("500"), type="credit", transfer_pair_id=pair)
    # treat_as_transfer category contribution (one-sided, excluded from P/L)
    await _mk_txn(session, test_user, acct, description="Buy ETF", amount=Decimal("300"), type="debit", category_id=invest.id)

    _, _, summary = await get_transactions(
        session, test_workspace.id, test_user.id, include_summary=True
    )

    assert summary is not None
    assert summary["income"] == Decimal("2000")
    assert summary["expense"] == Decimal("800")
    assert summary["net"] == Decimal("1200")
    # 500 (out) + 500 (in) + 300 (investment) — absolute totals.
    assert summary["excluded"] == Decimal("1300")


async def test_get_transactions_user_pnl_only_returns_only_dashboard_reportable_rows(
    session: AsyncSession, test_user: User, test_workspace: Workspace, acct
):
    from app.models.category import Category

    ignored = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Ignored",
        is_ignored=True,
    )
    transfer_like = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Investments",
        treat_as_transfer=True,
    )
    session.add_all([ignored, transfer_like])
    await session.commit()

    pair = uuid.uuid4()
    await _mk_txn(session, test_user, acct, description="Salary", amount=Decimal("1000"), type="credit")
    await _mk_txn(session, test_user, acct, description="Rent", amount=Decimal("300"), type="debit")
    await _mk_txn(session, test_user, acct, description="Hidden", is_ignored=True)
    await _mk_txn(session, test_user, acct, description="Hidden category", category_id=ignored.id)
    await _mk_txn(session, test_user, acct, description="Investment", category_id=transfer_like.id)
    await _mk_txn(session, test_user, acct, description="Transfer", transfer_pair_id=pair)
    await _mk_txn(session, test_user, acct, description="Settlement credit", type="credit", source="settlement")

    rows, total, summary = await get_transactions(
        session,
        test_workspace.id,
        test_user.id,
        user_pnl_only=True,
        include_summary=True,
    )

    assert {tx.description for tx in rows} == {"Salary", "Rent"}
    assert total == 2

    assert summary is not None
    assert summary["income"] == Decimal("1000")
    assert summary["expense"] == Decimal("300")
    assert summary["excluded"] == Decimal("0")


async def test_get_transactions_sorting(session, test_user, test_workspace, acct):
    await _mk_txn(session, test_user, acct, description="Aaa", amount=Decimal("30"))
    await _mk_txn(session, test_user, acct, description="Zzz", amount=Decimal("10"))
    await _mk_txn(session, test_user, acct, description="Mmm", amount=Decimal("20"))

    asc, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, sort_by="amount", sort_dir="asc"
    )
    amts = [t.amount for t in asc]
    assert amts == sorted(amts)

    desc, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, sort_by="description", sort_dir="desc"
    )
    descs = [t.description for t in desc]
    assert descs[0] == "Zzz"

    # transaction_date sort path
    td, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, sort_by="transaction_date", sort_dir="asc"
    )
    assert len(td) == 3


# ---------------------------------------------------------------------------
# include_opening_balance branch
# ---------------------------------------------------------------------------


async def test_get_transactions_opening_balance_excluded_then_included(session, test_user, test_workspace, acct):
    await _mk_txn(
        session, test_user, acct, description="Opening", amount=Decimal("1000"),
        type="credit", source="opening_balance",
    )
    await _mk_txn(session, test_user, acct, description="Normal", amount=Decimal("10"))

    res, _, _ = await get_transactions(session, test_workspace.id, test_user.id)
    assert "Opening" not in {t.description for t in res}

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id, include_opening_balance=True
    )
    assert "Opening" in {t.description for t in res}


# ---------------------------------------------------------------------------
# get_transfer_candidates (lines 802-869)
# ---------------------------------------------------------------------------


async def test_get_transfer_candidates_ranks_by_proximity(session, test_user, test_workspace, acct):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="Cand2", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()

    anchor = await _mk_txn(
        session, test_user, acct, description="Anchor", amount=Decimal("100"),
        type="debit", date=date(2025, 3, 15),
    )
    # Best candidate: closest date + same amount, opposing type, other account
    await _mk_txn(
        session, test_user, acct2, description="Close", amount=Decimal("100"),
        type="credit", date=date(2025, 3, 16),
    )
    await _mk_txn(
        session, test_user, acct2, description="Far", amount=Decimal("100"),
        type="credit", date=date(2025, 3, 25),
    )
    # Same account → excluded
    await _mk_txn(
        session, test_user, acct, description="SameAcct", amount=Decimal("100"),
        type="credit", date=date(2025, 3, 16),
    )

    cands = await get_transfer_candidates(session, test_workspace.id, anchor.id)
    descs = [c.description for c in cands]
    assert descs[0] == "Close"
    assert "Far" in descs
    assert "SameAcct" not in descs


async def test_get_transfer_candidates_anchor_missing(session, test_user, test_workspace):
    cands = await get_transfer_candidates(session, test_workspace.id, uuid.uuid4())
    assert cands == []


async def test_get_transfer_candidates_anchor_already_paired(session, test_user, test_workspace, acct):
    anchor = await _mk_txn(
        session, test_user, acct, description="Paired", amount=Decimal("50"),
        transfer_pair_id=uuid.uuid4(),
    )
    cands = await get_transfer_candidates(session, test_workspace.id, anchor.id)
    assert cands == []


# ---------------------------------------------------------------------------
# link_existing_as_transfer (lines 884-921)
# ---------------------------------------------------------------------------


async def test_link_existing_as_transfer_success(session, test_user, test_workspace, acct):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="Link2", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()
    debit = await _mk_txn(session, test_user, acct, description="D", amount=Decimal("100"), type="debit")
    credit = await _mk_txn(session, test_user, acct2, description="C", amount=Decimal("100"), type="credit")

    d, c = await link_existing_as_transfer(session, test_workspace.id, [debit.id, credit.id])
    assert d.transfer_pair_id == c.transfer_pair_id
    assert d.type == "debit" and c.type == "credit"
    assert d.category_id is None


async def test_link_existing_wrong_count(session, test_workspace):
    with pytest.raises(ValueError, match="Exactly two"):
        await link_existing_as_transfer(session, test_workspace.id, [uuid.uuid4()])


async def test_link_existing_same_id(session, test_workspace):
    same = uuid.uuid4()
    with pytest.raises(ValueError, match="itself"):
        await link_existing_as_transfer(session, test_workspace.id, [same, same])


async def test_link_existing_not_found(session, test_workspace, test_user, acct):
    real = await _mk_txn(session, test_user, acct, description="R", type="debit")
    with pytest.raises(ValueError, match="not found"):
        await link_existing_as_transfer(session, test_workspace.id, [real.id, uuid.uuid4()])


async def test_link_existing_already_transfer(session, test_user, test_workspace, acct):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="L2", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()
    debit = await _mk_txn(session, test_user, acct, description="D", type="debit", transfer_pair_id=uuid.uuid4())
    credit = await _mk_txn(session, test_user, acct2, description="C", type="credit")
    with pytest.raises(ValueError, match="already part of a transfer"):
        await link_existing_as_transfer(session, test_workspace.id, [debit.id, credit.id])


async def test_link_existing_same_account(session, test_user, test_workspace, acct):
    debit = await _mk_txn(session, test_user, acct, description="D", type="debit")
    credit = await _mk_txn(session, test_user, acct, description="C", type="credit")
    with pytest.raises(ValueError, match="different accounts"):
        await link_existing_as_transfer(session, test_workspace.id, [debit.id, credit.id])


async def test_link_existing_wrong_types(session, test_user, test_workspace, acct):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="L3", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()
    a = await _mk_txn(session, test_user, acct, description="A", type="debit")
    b = await _mk_txn(session, test_user, acct2, description="B", type="debit")
    with pytest.raises(ValueError, match="one debit and one credit"):
        await link_existing_as_transfer(session, test_workspace.id, [a.id, b.id])


# ---------------------------------------------------------------------------
# create_transfer_counterpart (lines 942-1013)
# ---------------------------------------------------------------------------


async def test_create_transfer_counterpart_same_currency(session, test_user, test_workspace, acct):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="CP2", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()
    anchor = await _mk_txn(session, test_user, acct, description="Anchor", amount=Decimal("75"), type="debit")

    debit, credit = await create_transfer_counterpart(
        session, test_workspace.id, test_user.id, anchor.id, acct2.id
    )
    assert debit.transfer_pair_id == credit.transfer_pair_id
    assert debit.type == "debit" and credit.type == "credit"
    assert credit.account_id == acct2.id
    assert credit.amount == Decimal("75")


async def test_create_transfer_counterpart_cross_currency(session, test_user, test_workspace, acct, acct_usd):
    anchor = await _mk_txn(session, test_user, acct, description="X", amount=Decimal("500"), type="debit")
    debit, credit = await create_transfer_counterpart(
        session, test_workspace.id, test_user.id, anchor.id, acct_usd.id
    )
    assert credit.currency == "USD"
    assert debit.transfer_pair_id == credit.transfer_pair_id


async def test_create_transfer_counterpart_anchor_missing(session, test_workspace, test_user, acct):
    with pytest.raises(ValueError, match="Transaction not found"):
        await create_transfer_counterpart(
            session, test_workspace.id, test_user.id, uuid.uuid4(), acct.id
        )


async def test_create_transfer_counterpart_already_transfer(session, test_user, test_workspace, acct, acct_usd):
    anchor = await _mk_txn(
        session, test_user, acct, description="P", type="debit", transfer_pair_id=uuid.uuid4()
    )
    with pytest.raises(ValueError, match="already part of a transfer"):
        await create_transfer_counterpart(
            session, test_workspace.id, test_user.id, anchor.id, acct_usd.id
        )


async def test_create_transfer_counterpart_same_account(session, test_user, test_workspace, acct):
    anchor = await _mk_txn(session, test_user, acct, description="S", type="debit")
    with pytest.raises(ValueError, match="different account"):
        await create_transfer_counterpart(
            session, test_workspace.id, test_user.id, anchor.id, acct.id
        )


async def test_create_transfer_counterpart_dest_missing(session, test_user, test_workspace, acct):
    anchor = await _mk_txn(session, test_user, acct, description="N", type="credit")
    with pytest.raises(ValueError, match="Destination account not found"):
        await create_transfer_counterpart(
            session, test_workspace.id, test_user.id, anchor.id, uuid.uuid4()
        )


# ---------------------------------------------------------------------------
# update_transaction — FX cascade, effective_bill_date (1154+, 1166-1173)
# ---------------------------------------------------------------------------


async def test_update_transfer_cascades_amount_cross_currency(session, test_user, test_workspace, acct, acct_usd):
    debit, credit = await create_transfer(session, test_workspace.id, test_user.id, TransferCreate(
        from_account_id=acct.id, to_account_id=acct_usd.id,
        description="XC", amount=Decimal("500"), date=date.today(),
    ))
    # No destination amount was given, so the credit side is a conversion of the
    # debit side: changing the debit amount re-converts it. (A pair created with
    # an explicit destination amount keeps it — see test_transfer_api.py.)
    updated = await update_transaction(
        session, debit.id, test_workspace.id, test_user.id,
        TransactionUpdate(amount=Decimal("1000")),
    )

    assert updated is not None
    assert updated.amount == Decimal("1000")
    paired = await get_transaction(session, credit.id, test_workspace.id)

    assert paired is not None
    # The cross-currency cascade branch ran: paired amount was re-converted
    # (rate is 1:1 in tests since no FX rate is seeded, so it tracks 1000).
    assert paired.amount == Decimal("1000")


async def test_update_transfer_cascade_category(session, test_user, test_workspace, acct, test_categories):
    acct2 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="CC2", type="savings",
        balance=Decimal("0"), currency="BRL",
    )
    session.add(acct2)
    await session.commit()
    debit, credit = await create_transfer(session, test_workspace.id, test_user.id, TransferCreate(
        from_account_id=acct.id, to_account_id=acct2.id,
        description="CatXfer", amount=Decimal("100"), date=date.today(),
    ))
    await update_transaction(
        session, debit.id, test_workspace.id, test_user.id,
        TransactionUpdate(category_id=test_categories[0].id, apply_to_transfer_pair=True),
    )
    paired = await get_transaction(session, credit.id, test_workspace.id)
    
    assert paired is not None
    assert paired.category_id == test_categories[0].id


async def test_update_transaction_effective_bill_date_links_bill(session, test_user, test_workspace, cc_account):
    bill = CreditCardBill(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        account_id=cc_account.id, external_id="bill-1",
        due_date=date(2025, 4, 20), total_amount=Decimal("500"), currency="BRL",
    )
    session.add(bill)
    await session.commit()
    txn = await create_transaction(session, test_workspace.id, test_user.id, TransactionCreate(
        account_id=cc_account.id, description="CC charge", amount=Decimal("50"),
        date=date(2025, 4, 1), type="debit",
    ))
    updated = await update_transaction(
        session, txn.id, test_workspace.id, test_user.id,
        TransactionUpdate(effective_bill_date=date(2025, 4, 20)),
    )

    assert updated is not None
    assert updated.bill_id == bill.id
    assert updated.effective_date == date(2025, 4, 20)


async def test_update_transaction_effective_bill_date_no_match(session, test_user, test_workspace, cc_account):
    txn = await create_transaction(session, test_workspace.id, test_user.id, TransactionCreate(
        account_id=cc_account.id, description="CC nomatch", amount=Decimal("30"),
        date=date(2025, 4, 1), type="debit",
    ))
    updated = await update_transaction(
        session, txn.id, test_workspace.id, test_user.id,
        TransactionUpdate(effective_bill_date=date(2099, 1, 1)),
    )

    assert updated is not None
    assert updated.bill_id is None
    assert updated.effective_date == date(2099, 1, 1)


async def test_update_transaction_clear_bill_override_recovers_pluggy(session, test_user, test_workspace, cc_account):
    bill = CreditCardBill(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        account_id=cc_account.id, external_id="ext-bill-99",
        due_date=date(2025, 5, 20), total_amount=Decimal("200"), currency="BRL",
    )
    session.add(bill)
    txn = await _mk_txn(
        session, test_user, cc_account, description="Synced charge",
        amount=Decimal("40"), date=date(2025, 5, 1), source="sync",
        effective_bill_date=date(2025, 5, 20), bill_id=bill.id,
        raw_data={"creditCardMetadata": {"billId": "ext-bill-99"}},
    )
    # Clear the override -> should recover the original Pluggy bill linkage.
    updated = await update_transaction(
        session, txn.id, test_workspace.id, test_user.id,
        TransactionUpdate(effective_bill_date=None),
    )
    assert updated is not None
    assert updated.bill_id == bill.id


async def test_update_transaction_clear_bill_override_no_raw(session, test_user, test_workspace, cc_account):
    txn = await _mk_txn(
        session, test_user, cc_account, description="No raw",
        amount=Decimal("40"), date=date(2025, 5, 1),
        effective_bill_date=date(2025, 5, 20),
    )
    updated = await update_transaction(
        session, txn.id, test_workspace.id, test_user.id,
        TransactionUpdate(effective_bill_date=None),
    )
    assert updated is not None
    assert updated.bill_id is None


# ---------------------------------------------------------------------------
# bulk tag edge branches (1221, 1225, 1254, 1258, 1269)
# ---------------------------------------------------------------------------


async def test_bulk_add_tags_empty_inputs(session, test_workspace):
    assert await bulk_add_tags(session, test_workspace.id, [], ["#x"]) == 0
    assert await bulk_add_tags(session, test_workspace.id, [uuid.uuid4()], []) == 0
    # Tags that normalize to nothing
    assert await bulk_add_tags(session, test_workspace.id, [uuid.uuid4()], ["  "]) == 0


async def test_bulk_remove_tags_empty_inputs(session, test_workspace):
    assert await bulk_remove_tags(session, test_workspace.id, [], ["#x"]) == 0
    assert await bulk_remove_tags(session, test_workspace.id, [uuid.uuid4()], []) == 0
    assert await bulk_remove_tags(session, test_workspace.id, [uuid.uuid4()], ["   "]) == 0


async def test_bulk_remove_tags_skips_empty_notes(session, test_user, test_workspace, acct):
    t = await _mk_txn(session, test_user, acct, description="NoNotes", notes=None)
    touched = await bulk_remove_tags(session, test_workspace.id, [t.id], ["#anything"])
    assert touched == 0


# ---------------------------------------------------------------------------
# Bill-driven filters and unbilled_only cycle math (lines 247-325)
# ---------------------------------------------------------------------------


async def test_get_transactions_bill_id_filter(session, test_user, test_workspace, cc_account):
    bill = CreditCardBill(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        account_id=cc_account.id, external_id="b-filter",
        due_date=date(2025, 4, 20), total_amount=Decimal("500"), currency="BRL",
    )
    session.add(bill)
    await session.commit()

    # Linked to the bill directly.
    await _mk_txn(
        session, test_user, cc_account, description="Linked", amount=Decimal("100"),
        date=date(2025, 4, 5), bill_id=bill.id, effective_date=date(2025, 4, 20),
    )
    # Unlinked manual tx whose date falls inside the window.
    await _mk_txn(
        session, test_user, cc_account, description="InWindow", amount=Decimal("50"),
        date=date(2025, 4, 7), effective_date=date(2025, 4, 7),
    )
    # Outside the window and unlinked.
    await _mk_txn(
        session, test_user, cc_account, description="Outside", amount=Decimal("20"),
        date=date(2025, 1, 1), effective_date=date(2025, 1, 1),
    )

    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id,
        bill_id=bill.id, from_date=date(2025, 4, 1), to_date=date(2025, 4, 30),
    )
    descs = {t.description for t in res}
    assert "Linked" in descs
    assert "InWindow" in descs
    assert "Outside" not in descs


async def test_get_transactions_bill_id_no_dates(session, test_user, test_workspace, cc_account):
    bill = CreditCardBill(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        account_id=cc_account.id, external_id="b-nodates",
        due_date=date(2025, 4, 20), total_amount=Decimal("500"), currency="BRL",
    )
    session.add(bill)
    await session.commit()
    await _mk_txn(
        session, test_user, cc_account, description="OnlyLinked", amount=Decimal("100"),
        date=date(2025, 4, 5), bill_id=bill.id, effective_date=date(2025, 4, 20),
    )
    res, _, _ = await get_transactions(session, test_workspace.id, test_user.id, bill_id=bill.id)
    assert "OnlyLinked" in {t.description for t in res}


async def test_get_transactions_unbilled_only(session, test_user, test_workspace, cc_account):
    bill = CreditCardBill(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        account_id=cc_account.id, external_id="b-unbilled",
        due_date=date(2025, 4, 20), total_amount=Decimal("500"), currency="BRL",
    )
    session.add(bill)
    await session.commit()

    await _mk_txn(
        session, test_user, cc_account, description="AlreadyBilled", amount=Decimal("100"),
        date=date(2025, 5, 3), bill_id=bill.id, effective_date=date(2025, 5, 3),
    )
    await _mk_txn(
        session, test_user, cc_account, description="StillUnbilled", amount=Decimal("40"),
        date=date(2025, 5, 4), effective_date=date(2025, 5, 4),
    )
    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id,
        unbilled_only=True, from_date=date(2025, 5, 1), to_date=date(2025, 5, 31),
    )
    descs = {t.description for t in res}
    assert "StillUnbilled" in descs
    assert "AlreadyBilled" not in descs


async def test_get_transactions_unbilled_only_forward_override(session, test_user, test_workspace, cc_account):
    # A tx with a forward-pointing manual override beyond the window edge
    # should still surface in the in-progress cycle (issue #162).
    await _mk_txn(
        session, test_user, cc_account, description="ForwardOverride", amount=Decimal("70"),
        date=date(2025, 5, 10), effective_date=date(2025, 7, 20),
        effective_bill_date=date(2025, 7, 20),
    )
    res, _, _ = await get_transactions(
        session, test_workspace.id, test_user.id,
        unbilled_only=True, from_date=date(2025, 5, 1), to_date=date(2025, 5, 31),
    )
    assert "ForwardOverride" in {t.description for t in res}
