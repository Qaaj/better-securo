import uuid
from datetime import date as _Date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel


class HistoryCharge(BaseModel):
    id: uuid.UUID
    date: _Date
    amount: Decimal
    currency: str
    amount_primary: Optional[Decimal] = None


class PriceChange(BaseModel):
    date: _Date
    from_amount: Decimal
    to_amount: Decimal
    change_pct: float


class RecurringHistoryRead(BaseModel):
    recurring_id: uuid.UUID
    charges: list[HistoryCharge]
    count: int
    first_date: Optional[_Date] = None
    last_date: Optional[_Date] = None
    months_running: Optional[float] = None
    # What the charges came to, in the primary currency.
    total_paid: Decimal = Decimal(0)
    total_last_12_months: Decimal = Decimal(0)
    average_amount: Optional[Decimal] = None
    min_amount: Optional[Decimal] = None
    max_amount: Optional[Decimal] = None
    first_amount: Optional[Decimal] = None
    latest_amount: Optional[Decimal] = None
    # Latest against first, percent; None with fewer than two charges.
    change_since_first_pct: Optional[float] = None
    # Steps where the price moved, when it is otherwise steady. Empty for a bill that varies every time.
    price_changes: list[PriceChange] = []
    amount_varies: bool = False
    # The latest charge differs from the amount on the item by this percent (same currency only).
    latest_vs_planned_pct: Optional[float] = None
    # The scheduled next charge is this many days late, when it is later than the schedule's slack.
    overdue_days: Optional[int] = None
