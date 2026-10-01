import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict


class CategorizerSettings(BaseModel):
    base_url: str
    model: str


class CategorizerTestRequest(BaseModel):
    base_url: str


class CategorizerTestResult(BaseModel):
    models: list[str]


class CategorizationJobCreate(BaseModel):
    base_url: str
    model: str


class SuggestionCounts(BaseModel):
    pending: int = 0
    accepted: int = 0
    rejected: int = 0


class CategorizationJobRead(BaseModel):
    id: uuid.UUID
    status: str
    base_url: str
    model: str
    total_merchants: int
    processed_merchants: int
    error: Optional[str] = None
    created_at: datetime
    finished_at: Optional[datetime] = None
    counts: SuggestionCounts = SuggestionCounts()

    model_config = ConfigDict(from_attributes=True)


class SuggestionRead(BaseModel):
    id: uuid.UUID
    merchant_key: str
    sample_description: str
    tx_type: str
    tx_count: int
    total_amount_primary: Decimal
    suggested_category_id: Optional[uuid.UUID] = None
    confidence: str
    source: str
    status: str
    applied_count: int
    # Set only on the response to an accept that asked for a rule.
    rule_created: bool = False

    model_config = ConfigDict(from_attributes=True)


class SuggestionTransaction(BaseModel):
    id: uuid.UUID
    date: date
    description: str
    amount: Decimal
    currency: str
    amount_primary: Optional[Decimal] = None
    type: str
    account_name: Optional[str] = None
    category_id: Optional[uuid.UUID] = None


class SuggestionTransactions(BaseModel):
    items: list[SuggestionTransaction]
    total: int


class RulesForAcceptedResult(BaseModel):
    considered: int
    created: int


class SuggestionList(BaseModel):
    items: list[SuggestionRead]
    total: int


class AcceptSuggestionRequest(BaseModel):
    # Overrides the suggested category; required when none was suggested.
    category_id: Optional[uuid.UUID] = None
    # Also make a rule so future transactions of this merchant are categorized on import.
    create_rule: bool = False


class AcceptAllRequest(BaseModel):
    source: Optional[Literal["history", "llm"]] = None
    min_confidence: Literal["high", "medium", "low"] = "high"
    create_rules: bool = False


class AcceptAllResult(BaseModel):
    suggestions: int
    transactions: int
    rules_created: int = 0
