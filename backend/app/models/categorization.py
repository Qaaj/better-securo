import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.core.database import Base


class CategorizationJob(Base):
    """One run of the automatic categorizer over a workspace's uncategorized
    transactions, grouped by merchant."""

    __tablename__ = "categorization_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending, running, completed, cancelled, failed
    base_url: Mapped[str] = mapped_column(String(500))
    model: Mapped[str] = mapped_column(String(200))
    total_merchants: Mapped[int] = mapped_column(Integer, default=0)
    processed_merchants: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class CategorizationSuggestion(Base):
    """A proposed category for every uncategorized transaction of one merchant."""

    __tablename__ = "categorization_suggestions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categorization_jobs.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    merchant_key: Mapped[str] = mapped_column(String(60))
    sample_description: Mapped[str] = mapped_column(String(500))
    tx_type: Mapped[str] = mapped_column(String(10))
    tx_count: Mapped[int] = mapped_column(Integer)
    total_amount_primary: Mapped[Decimal] = mapped_column(Numeric(precision=15, scale=2), default=0)
    suggested_category_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    confidence: Mapped[str] = mapped_column(String(10), default="medium")  # high, medium, low
    source: Mapped[str] = mapped_column(String(10))  # history, llm
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)  # pending, accepted, rejected
    applied_count: Mapped[int] = mapped_column(Integer, default=0)
