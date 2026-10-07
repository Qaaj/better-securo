import uuid
from datetime import date as _date, datetime
from decimal import Decimal
from typing import Any, Optional

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

IncomeMode = Literal["yield", "fixed"]
IncomeFrequency = Literal["monthly", "quarterly", "semiannual", "yearly"]


DetailValue = str | int | float | bool | None


def _clean_details(value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Technical details: a few named values, small enough to be what people type by hand."""
    if value is None:
        return None
    if len(value) > 80:
        raise ValueError("At most 80 details")
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key.strip() or len(key) > 80:
            raise ValueError("A detail name must be 1 to 80 characters")
        if item is not None and not isinstance(item, (str, int, float, bool)):
            raise ValueError("A detail must be text, a number, true or false")
        if isinstance(item, str) and len(item) > 500:
            raise ValueError("A detail must be at most 500 characters")
        cleaned[key.strip()] = item
    return cleaned


class AssetCreate(BaseModel):
    name: str
    type: str
    currency: str = "USD"
    units: Optional[Decimal] = None
    valuation_method: str = "manual"
    purchase_date: Optional[_date] = None
    purchase_price: Optional[Decimal] = None
    sell_date: Optional[_date] = None
    sell_price: Optional[Decimal] = None
    current_value: Optional[Decimal] = None  # convenience: creates initial AssetValue
    growth_type: Optional[str] = None
    growth_rate: Optional[Decimal] = None
    growth_frequency: Optional[str] = None
    growth_start_date: Optional[_date] = None
    # Modelled income for the retirement forecast (see the Asset model).
    income_mode: Optional[IncomeMode] = None
    income_rate: Optional[Decimal] = Field(default=None, ge=0, le=100)
    income_amount: Optional[Decimal] = Field(default=None, ge=0)
    income_frequency: Optional[IncomeFrequency] = None
    sell_percent_per_year: Optional[Decimal] = Field(default=None, ge=0, le=100)
    is_archived: bool = False
    position: int = 0
    group_id: Optional[uuid.UUID] = None
    external_id: Optional[str] = None
    # Market-priced assets: ticker is enough to create one. The service
    # fetches the live quote on create and seeds the first AssetValue.
    ticker: Optional[str] = None
    ticker_exchange: Optional[str] = None
    maturity_date: Optional[_date] = None
    # Per-unit price for the opening buy of a market-priced holding (preço
    # médio model, consistent with the transaction ledger). When omitted, the
    # service seeds the buy at the live quote ("bought at market now").
    unit_price: Optional[Decimal] = None

    @model_validator(mode="after")
    def income_fields_are_complete(self) -> "AssetCreate":
        if self.income_mode == "yield" and self.income_rate is None:
            raise ValueError("income_rate is required for a yield")
        if self.income_mode == "fixed" and (self.income_amount is None or self.income_frequency is None):
            raise ValueError("income_amount and income_frequency are required for a fixed income")
        return self

    @field_validator("external_id")
    @classmethod
    def normalize_external_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("external_id must not be blank")
        if len(normalized) > 255:
            raise ValueError("external_id must be at most 255 characters")
        return normalized


class AssetUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    currency: Optional[str] = None
    units: Optional[Decimal] = None
    valuation_method: Optional[str] = None
    purchase_date: Optional[_date] = None
    purchase_price: Optional[Decimal] = None
    sell_date: Optional[_date] = None
    sell_price: Optional[Decimal] = None
    growth_type: Optional[str] = None
    growth_rate: Optional[Decimal] = None
    growth_frequency: Optional[str] = None
    growth_start_date: Optional[_date] = None
    income_mode: Optional[IncomeMode] = None
    income_rate: Optional[Decimal] = Field(default=None, ge=0, le=100)
    income_amount: Optional[Decimal] = Field(default=None, ge=0)
    income_frequency: Optional[IncomeFrequency] = None
    sell_percent_per_year: Optional[Decimal] = Field(default=None, ge=0, le=100)
    is_archived: Optional[bool] = None
    position: Optional[int] = None
    # Use a sentinel to differentiate "don't change group" (field omitted)
    # from "remove from group" (explicit null). Pydantic's exclude_unset
    # already handles this via model_dump.
    group_id: Optional[uuid.UUID] = None
    ticker: Optional[str] = None
    ticker_exchange: Optional[str] = None
    address: Optional[str] = Field(default=None, max_length=500)
    latitude: Optional[Decimal] = Field(default=None, ge=-90, le=90)
    longitude: Optional[Decimal] = Field(default=None, ge=-180, le=180)
    details: Optional[dict[str, DetailValue]] = None
    notes: Optional[str] = Field(default=None, max_length=5000)

    @field_validator("details")
    @classmethod
    def check_details(cls, value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        return _clean_details(value)


class AssetRead(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    type: str
    currency: str
    units: Optional[float] = None
    valuation_method: str
    purchase_date: Optional[_date] = None
    purchase_price: Optional[float] = None
    sell_date: Optional[_date] = None
    sell_price: Optional[float] = None
    growth_type: Optional[str] = None
    growth_rate: Optional[float] = None
    growth_frequency: Optional[str] = None
    growth_start_date: Optional[_date] = None
    income_mode: Optional[str] = None
    income_rate: Optional[float] = None
    income_amount: Optional[float] = None
    income_frequency: Optional[str] = None
    sell_percent_per_year: Optional[float] = None
    is_archived: bool
    position: int
    current_value: Optional[float] = None
    current_value_primary: Optional[float] = None
    gain_loss: Optional[float] = None
    gain_loss_primary: Optional[float] = None
    value_count: int = 0
    source: str = "manual"
    external_id: Optional[str] = None
    connection_id: Optional[uuid.UUID] = None
    isin: Optional[str] = None
    maturity_date: Optional[_date] = None
    group_id: Optional[uuid.UUID] = None
    ticker: Optional[str] = None
    ticker_exchange: Optional[str] = None
    last_price: Optional[float] = None
    last_price_at: Optional[datetime] = None
    logo_url: Optional[str] = None
    # Ledger-derived fields (issue #235). average_price = weighted-average cost
    # per unit (preço médio); total_invested = cost basis of the held units;
    # realized_gain = cumulative gain/loss from sells; transaction_count lets
    # the UI know whether a holding is ledger-backed.
    average_price: Optional[float] = None
    total_invested: Optional[float] = None
    realized_gain: Optional[float] = None
    transaction_count: int = 0
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    details: Optional[dict[str, Any]] = None
    notes: Optional[str] = None
    cover_photo_id: Optional[uuid.UUID] = None

    model_config = ConfigDict(from_attributes=True)


class AssetPhotoRead(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    filename: str
    content_type: str
    size: int
    caption: Optional[str] = None
    position: int
    is_cover: bool = False
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AssetPhotoUpdate(BaseModel):
    caption: Optional[str] = Field(default=None, max_length=300)
    is_cover: Optional[bool] = None
    position: Optional[int] = Field(default=None, ge=0)


class GeocodeRequest(BaseModel):
    query: str = Field(min_length=3, max_length=300)


class GeocodeResult(BaseModel):
    display_name: str
    latitude: float
    longitude: float


class AssetTransactionCreate(BaseModel):
    kind: str  # buy | sell
    quantity: Decimal
    price: Decimal
    fee: Decimal = Decimal("0")
    date: _date
    notes: Optional[str] = None


class AssetTransactionUpdate(BaseModel):
    kind: Optional[str] = None
    quantity: Optional[Decimal] = None
    price: Optional[Decimal] = None
    fee: Optional[Decimal] = None
    date: Optional[_date] = None
    notes: Optional[str] = None


class AssetBuyCreate(BaseModel):
    """Find-or-create a ticker holding (in `group_id`) and record a buy."""

    ticker: str
    quantity: Decimal
    price: Decimal
    fee: Decimal = Decimal("0")
    date: _date
    name: Optional[str] = None
    group_id: Optional[uuid.UUID] = None
    notes: Optional[str] = None


class AssetTransactionRead(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    kind: str
    quantity: float
    price: float
    fee: float
    date: _date
    source: str
    notes: Optional[str] = None
    # Denormalized holding context so the global transactions tab can render
    # rows without an extra per-row asset lookup.
    asset_name: Optional[str] = None
    ticker: Optional[str] = None
    currency: Optional[str] = None
    logo_url: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class MarketSymbolQuote(BaseModel):
    """Live quote for a ticker, used by the add-asset form to preview value."""

    symbol: str
    name: Optional[str] = None
    exchange: Optional[str] = None
    currency: str
    price: float
    quote_type: Optional[str] = None  # EQUITY, ETF, CRYPTOCURRENCY, MUTUALFUND, ...
    # Fully-formed logo URL if the provider can derive one. Caller stores
    # this verbatim on the asset; no further processing required.
    logo_url: Optional[str] = None


class MarketSymbolMatch(BaseModel):
    """A single search result returned by /assets/market/search."""

    symbol: str
    name: Optional[str] = None
    exchange: Optional[str] = None
    quote_type: Optional[str] = None


class AssetValueCreate(BaseModel):
    amount: Decimal
    date: _date


class AssetValueRead(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    amount: float
    date: _date
    source: str

    model_config = ConfigDict(from_attributes=True)
