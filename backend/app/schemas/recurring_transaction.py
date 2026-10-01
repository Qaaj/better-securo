import uuid
from datetime import date as _Date
from decimal import Decimal
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

WeekendAdjustment = Literal["none", "previous_friday", "next_monday"]
RecurringFrequency = Literal["weekly", "biweekly", "monthly", "quarterly", "semiannual", "yearly"]
DayOfMonth = Annotated[int, Field(ge=1, le=31)]


class RecurringTransactionCreate(BaseModel):
    description: str
    amount: Decimal
    currency: str = "USD"
    type: str  # debit, credit
    frequency: str  # weekly, biweekly, monthly, quarterly, semiannual, yearly
    weekend_adjustment: WeekendAdjustment = "none"
    day_of_month: Optional[DayOfMonth] = None
    start_date: _Date
    end_date: Optional[_Date] = None
    account_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    skip_first: bool = False  # Set true when first occurrence already created as a transaction
    auto_generate: bool = False  # Materialize occurrences; off by default: the item only forecasts until the real charge is matched
    # The transaction this item was made from. It becomes the item's first
    # occurrence: it is linked to it, and with `skip_first` the schedule starts
    # after it.
    source_transaction_id: Optional[uuid.UUID] = None


class ExistingRecurringMatch(BaseModel):
    """An existing, still-unlinked recurring item whose amount is close."""

    id: uuid.UUID
    description: str
    amount: Decimal
    currency: str
    amount_primary: Optional[float] = None
    frequency: str
    next_occurrence: _Date
    difference_pct: float
    same_name: bool


class RecurringSuggestionRead(BaseModel):
    match_basis: Literal["amount_and_name", "name", "none"]
    frequency: Optional[RecurringFrequency] = None
    confidence: Literal["high", "medium", "low", "none"]
    occurrences: int
    first_date: Optional[_Date] = None
    last_date: Optional[_Date] = None
    average_gap_days: Optional[int] = None
    typical_amount: Optional[Decimal] = None
    amount_varies: bool = False
    day_of_month: Optional[int] = None
    next_occurrence: Optional[_Date] = None
    dates: list[_Date] = []
    # Existing recurring items that might already be this one.
    existing_matches: list[ExistingRecurringMatch] = []


class RecurringTransactionUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    type: Optional[str] = None
    frequency: Optional[RecurringFrequency] = None
    weekend_adjustment: Optional[WeekendAdjustment] = None
    day_of_month: Optional[DayOfMonth] = None
    start_date: Optional[_Date] = None
    end_date: Optional[_Date] = None
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    is_active: Optional[bool] = None
    auto_generate: Optional[bool] = None


class RecurringTransactionRead(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    description: str
    amount: Decimal
    currency: str
    type: str
    frequency: str
    weekend_adjustment: WeekendAdjustment = "none"
    day_of_month: Optional[int] = None
    start_date: _Date
    end_date: Optional[_Date] = None
    is_active: bool
    auto_generate: bool = False
    next_occurrence: _Date
    amount_primary: Optional[float] = None
    fx_rate_used: Optional[float] = None

    model_config = ConfigDict(from_attributes=True)
