import uuid
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel


class MonthFigures(BaseModel):
    income: float
    expenses: float
    saved: float
    savings_rate: Optional[float] = None  # saved / income, None without income


class CategoryLine(BaseModel):
    category_id: Optional[uuid.UUID] = None  # None = uncategorized
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    amount: float
    usual: float
    delta: float
    share: float  # of this month's expenses, 0..1


class MerchantLine(BaseModel):
    name: str
    amount: float
    count: int


class LargeTransaction(BaseModel):
    id: uuid.UUID
    date: date
    description: str
    amount: float
    category_name: Optional[str] = None


class YearMonth(BaseModel):
    month: str  # YYYY-MM
    income: float
    expenses: float
    saved: float


class Insight(BaseModel):
    """Something in the month worth a second look."""

    kind: Literal["duplicate", "unusual", "price_change"]
    description: str
    amount: float
    previous: Optional[float] = None  # the usual amount, or the old price
    count: int = 1
    dates: list[date] = []


class MonthlyReview(BaseModel):
    month: date
    currency: str
    this_month: MonthFigures
    previous_month: Optional[MonthFigures] = None
    usual: Optional[MonthFigures] = None  # average of the 12 months before
    usual_months: int = 0
    categories: list[CategoryLine]
    movers_up: list[CategoryLine]
    movers_down: list[CategoryLine]
    new_merchants: list[MerchantLine]
    large_transactions: list[LargeTransaction]
    recurring_expenses: float  # expenses linked to a recurring item
    other_expenses: float
    uncategorized_expenses: float
    uncategorized_share: float
    moved_between_accounts: float
    moved_count: int
    year: list[YearMonth]
    insights: list[Insight] = []
