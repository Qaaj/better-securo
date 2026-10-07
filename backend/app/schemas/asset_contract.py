import uuid
from datetime import date as _Date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

ContractKind = Literal["energy", "gas", "water", "internet", "insurance", "tax", "condo", "mortgage", "maintenance", "other"]
DocumentKind = Literal["contract", "insurance", "deed", "energy_certificate", "invoice", "manual", "survey", "other"]


class ContractCreate(BaseModel):
    kind: ContractKind
    provider: str = Field(min_length=1, max_length=200)
    contract_number: Optional[str] = Field(default=None, max_length=100)
    customer_number: Optional[str] = Field(default=None, max_length=100)
    meter_number: Optional[str] = Field(default=None, max_length=100)
    start_date: Optional[_Date] = None
    end_date: Optional[_Date] = None
    notice_days: Optional[int] = Field(default=None, ge=0, le=730)
    recurring_id: Optional[uuid.UUID] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class ContractUpdate(BaseModel):
    kind: Optional[ContractKind] = None
    provider: Optional[str] = Field(default=None, min_length=1, max_length=200)
    contract_number: Optional[str] = Field(default=None, max_length=100)
    customer_number: Optional[str] = Field(default=None, max_length=100)
    meter_number: Optional[str] = Field(default=None, max_length=100)
    start_date: Optional[_Date] = None
    end_date: Optional[_Date] = None
    notice_days: Optional[int] = Field(default=None, ge=0, le=730)
    recurring_id: Optional[uuid.UUID] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class LinkedRecurring(BaseModel):
    id: uuid.UUID
    description: str
    amount: Decimal
    currency: str
    frequency: str
    is_active: bool
    amount_primary: Optional[float] = None


class ContractRead(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    kind: str
    provider: str
    contract_number: Optional[str] = None
    customer_number: Optional[str] = None
    meter_number: Optional[str] = None
    start_date: Optional[_Date] = None
    end_date: Optional[_Date] = None
    notice_days: Optional[int] = None
    recurring_id: Optional[uuid.UUID] = None
    notes: Optional[str] = None
    created_at: datetime
    recurring: Optional[LinkedRecurring] = None
    document_count: int = 0
    # Days until the contract ends, negative once it has; None without an end date.
    days_left: Optional[int] = None
    # The last day to give notice, when there is an end date and a notice period.
    notice_by: Optional[_Date] = None

    model_config = ConfigDict(from_attributes=True)


class DocumentRead(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    contract_id: Optional[uuid.UUID] = None
    kind: str
    title: str
    filename: str
    content_type: str
    size: int
    document_date: Optional[_Date] = None
    expires_on: Optional[_Date] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DocumentUpdate(BaseModel):
    kind: Optional[DocumentKind] = None
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    contract_id: Optional[uuid.UUID] = None
    document_date: Optional[_Date] = None
    expires_on: Optional[_Date] = None
