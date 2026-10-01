"""Shared SQLAlchemy filter fragments for report/dashboard queries.

Centralizes the "what counts as real income/expense" definition so every
aggregation site agrees. Changes to the rule (e.g. adding a new exclusion
signal) only need to be made here.
"""
from datetime import date

from sqlalchemy import and_, func, or_, select

from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction


def is_confirmed():
    """SQL filter: the charge is settled rather than merely authorized.

    One of the two independent axes a transaction sits on. This one is about
    *confirmation*: a pending row is real money already committed, it just
    has not cleared yet. It says nothing about when the row is dated.
    """
    return Transaction.status == "posted"


def is_not_future(as_of: date):
    """SQL filter: the transaction has already happened by ``as_of``.

    The other axis, and a pure date question. A future-dated row is forecast
    no matter how confirmed it is; a past-dated row has happened no matter
    whether the bank has cleared it.
    """
    return Transaction.date <= as_of


def is_inside_provider_snapshot():
    """SQL filter: the provider's balance already accounts for this row.

    A connected account's current balance is the number the provider sends,
    not a sum of our rows, and providers net out the pending charges they
    report. A row typed by hand is ambiguous the same way, since the user is
    usually copying a charge the bank is already showing them.

    A recurring placeholder is the one case we can be sure about: we invented
    the row from a schedule, so no provider has ever seen it. Treating it as
    already counted makes it cancel itself out, leaving a charge that shows up
    in the forecast totals but moves no balance.
    """
    return Transaction.source != "recurring"


def counts_in_current_balance(as_of: date):
    """SQL filter: the row belongs in the balance labelled "current".

    Composed from the two axes above so the definition lives in one place and
    moving the line later is a change here rather than at every query site.

    Today the line sits at "confirmed and not future", with one exception:
    a credit card's balance is the debt owed, and an authorized purchase is
    already owed, so pending card rows stay in. Without that carve-out the
    card's balance understates the debt while its own bill total includes it.
    """
    return and_(
        is_not_future(as_of),
        or_(is_confirmed(), Account.type == "credit_card"),
    )


def reporting_date_col(accounting_mode: str):
    """The date column a transaction should be *bucketed by* in period
    aggregations (dashboard, reports, budgets).

    Honors the manual credit-card cycle override (`effective_bill_date`)
    FIRST — regardless of accounting mode — because that's the whole point
    of the override: the user hand-corrected which invoice a purchase
    belongs to (issue #92). When there's no override, fall back to
    `effective_date` in accrual mode or the raw purchase `date` in cash
    mode.

    This mirrors the ordering used by the transaction list and the credit
    card bill view, so a transaction lands in the same month everywhere the
    user looks. Aggregations that skipped the override summed credit-card
    spend under the purchase month instead of the invoice month (issue
    #232).
    """
    base = (
        Transaction.effective_date
        if accounting_mode == "accrual"
        else Transaction.date
    )
    return func.coalesce(Transaction.effective_bill_date, base)


def is_not_ignored():
    """SQL filter: the row is not one the user told us to disregard.

    Only the ignore signal, without the transfer/settlement family that
    `counts_as_pnl` folds in, because hiding rows from a *list* is a
    different question from leaving them out of a *total*: a transfer still
    belongs in the ledger the user is reading.

    Matches what the UI badges as ignored, which is the transaction flag or
    its category's — see `TransactionRead.reflect_ignored_category`. A list
    that hid one but not the other would leave visibly-ignored rows behind
    and look broken.
    """
    return and_(
        Transaction.is_ignored.is_(False),
        or_(
            Transaction.category_id.is_(None),
            Transaction.category_id.not_in(
                select(Category.id).where(Category.is_ignored.is_(True))
            ),
        ),
    )


def is_transfer():
    """SQL filter: the row is a transfer rather than income or expense.

    Either both legs were matched (`transfer_pair_id` set), or the row sits
    in a category flagged `treat_as_transfer` (one-sided movements such as
    an investment application). Same reading the transactions calendar uses
    when it marks a day as having a transfer.
    """
    return or_(
        Transaction.transfer_pair_id.is_not(None),
        Transaction.category_id.in_(
            select(Category.id).where(Category.treat_as_transfer.is_(True))
        ),
    )


def counts_as_pnl():
    """SQL filter: True when a transaction should contribute to income/expense totals.

    Excludes:
      - paired transfers (both legs were matched; already cancel out),
      - transactions in categories flagged `treat_as_transfer` (one-sided
        movements like investment applications where the counterpart is
        an Asset/Holding, not another Account),
      - transactions flagged `is_ignored=True` (user-marked as not to be reported),
      - transactions flagged `exclude_from_pnl=True` (kept in balance,
        omitted from income and expense calculations),
      - transactions in categories flagged `is_ignored=True` (user-marked as not to be reported).

    Does NOT exclude `source='opening_balance'` — callers that already
    filter those keep doing so; this helper only handles the transfer-like
    exclusion family so both rules stay visible at each call site.
    """
    return and_(
        Transaction.transfer_pair_id.is_(None),
        Transaction.is_ignored.is_(False),
        Transaction.exclude_from_pnl.is_(False),
        # Settlement *debits* are repayments of debts that were already
        # booked as an expense via the share. Counting them would
        # double-count. Settlement *credits*, however, represent the
        # receiver actually getting the cash back — they offset the
        # over-recorded expense from when the receiver paid the full
        # parent transaction. So we keep credits, drop debits.
        ~and_(Transaction.source == "settlement", Transaction.type == "debit"),
        or_(
            Transaction.category_id.is_(None),
            Transaction.category_id.not_in(
                select(Category.id).where(
                    or_(
                        Category.treat_as_transfer.is_(True),
                        Category.is_ignored.is_(True),
                    )
                )
            ),
        ),
    )


def counts_on_bill():
    """SQL filter: True when a transaction belongs on a credit-card bill.

    A bill total is an *amount owed*, not a reporting figure, and the two
    answer to different authorities: the bill has to match what the bank
    says you owe, while P/L answers to how the user chose to categorize
    their spending. So the card's cycle total cannot reuse
    `counts_as_pnl` — every judgment that helper makes about what counts
    as *spending* is a judgment the bank never made.

    Kept out, because they are genuinely not charges on this bill:
      - paired transfers (the bill *payment* is not a purchase),
      - settlement debits (a repayment of a share already booked),
      - rows the user flagged `is_ignored`, on the transaction or its
        category — those leave the account balance too, so dropping them
        from the bill keeps the card's two numbers telling one story.

    `treat_as_transfer` categories are handled asymmetrically, and this is
    the whole point of the helper:
      - kept in for *debits*: buying an investment or paying a consortium
        installment with the card still lands on the statement, so a
        charge doesn't stop being owed to the bank because of how it was
        tagged afterwards (issue #647).
      - dropped for *credits*: an unpaired card payment (the payer's
        account isn't connected, the amount doesn't match exactly, or it
        was a partial payment) is normally filed under a transfer-like
        category, and letting it through here would net it against new
        debt instead of being a repayment of it.

    Neither reading is exactly right — there's no field today that tells
    a genuine merchant refund apart from an unpaired bill payment once
    both land as a credit in a transfer-like category, so this is a
    judgment call, not a derived fact. Dropping transfer-tagged credits
    errs toward the more common case (an unmatched payment silently
    shrinking the bill every cycle) over the rarer one (a refund of a
    transfer-tagged purchase failing to shrink it back).

    Deliberately spelled out rather than defined as "`counts_as_pnl`
    minus a clause": a filter for what a *report* excludes will keep
    growing as the product learns new ways to say "don't count this",
    and a bill total must not inherit those. Every clause here is one
    somebody chose for the bill.
    """
    ignored_category = Transaction.category_id.in_(
        select(Category.id).where(Category.is_ignored.is_(True))
    )
    transfer_category = Transaction.category_id.in_(
        select(Category.id).where(Category.treat_as_transfer.is_(True))
    )
    return and_(
        Transaction.transfer_pair_id.is_(None),
        Transaction.is_ignored.is_(False),
        ~and_(Transaction.source == "settlement", Transaction.type == "debit"),
        or_(Transaction.category_id.is_(None), ~ignored_category),
        or_(Transaction.type == "debit", Transaction.category_id.is_(None), ~transfer_category),
    )


def counts_as_user_pnl():
    """SQL filter for *user-level* P/L (dashboard, reports, budgets).

    Stricter than `counts_as_pnl`: also drops settlement *credits*. Under
    the share-only model an owner's expense for a split tx is just their
    share, so the corresponding settlement credits would double-count.
    Per-account stats still use `counts_as_pnl` because account ledgers
    track real cash through the account, not user P/L.
    """
    return and_(
        counts_as_pnl(),
        Transaction.source != "settlement",
    )
