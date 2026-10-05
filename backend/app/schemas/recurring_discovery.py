import uuid
from datetime import date as _Date
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.schemas.recurring_transaction import RecurringFrequency


class SeriesTransaction(BaseModel):
    id: uuid.UUID
    date: _Date
    amount: Decimal
    description: str


class SeriesRead(BaseModel):
    """Transactions that look like one repeating charge, with nothing linked to them yet."""

    key: str
    name: str
    type: Literal["debit", "credit"]
    frequency: Optional[RecurringFrequency] = None
    confidence: Literal["high", "medium", "low", "none"]
    occurrences: int
    first_date: _Date
    last_date: _Date
    typical_amount: Decimal
    currency: str
    amount_varies: bool = False
    day_of_month: Optional[int] = None
    next_occurrence: Optional[_Date] = None
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    # A year's worth, in the amount's own currency; 0 when the frequency is not known.
    yearly_amount: Decimal = Decimal(0)
    # True when it has not repeated for a while.
    lapsed: bool = False
    transaction_ids: list[uuid.UUID]
    recent: list[SeriesTransaction]


class MatchProposal(BaseModel):
    """The most likely series for an existing recurring item."""

    recurring_id: uuid.UUID
    recurring_description: str
    recurring_amount: Decimal
    recurring_currency: str
    recurring_frequency: str
    score: float
    confidence: Literal["high", "medium", "low"]
    # Why it was chosen, for display: amount, schedule, name.
    reasons: list[str]
    series: SeriesRead


class DiscoveryRead(BaseModel):
    matches: list[MatchProposal]
    new_series: list[SeriesRead]
    dismissed: int = 0


class LinkSeriesRequest(BaseModel):
    transaction_ids: list[uuid.UUID] = Field(min_length=1)


class CreateFromSeriesRequest(BaseModel):
    description: str
    amount: Decimal
    currency: str
    type: Literal["debit", "credit"]
    frequency: RecurringFrequency
    day_of_month: Optional[int] = Field(default=None, ge=1, le=31)
    account_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    transaction_ids: list[uuid.UUID] = Field(min_length=1)


class DismissRequest(BaseModel):
    kind: Literal["series", "match"]
    key: str
    recurring_id: Optional[uuid.UUID] = None
