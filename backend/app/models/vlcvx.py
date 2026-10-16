import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class VlcvxRound(Base):
    """One vote round of a vlCVX bribe market (Votium), as published by Llama Airforce.

    Public market data, not tied to any workspace. The summary columns come from the overview dashboard; the
    detail (`bribes`, `bribed`, `scores_total`) from the per-round endpoint.
    """

    __tablename__ = "vlcvx_rounds"
    __table_args__ = (UniqueConstraint("platform", "protocol", "round", name="uq_vlcvx_round"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    platform: Mapped[str] = mapped_column(String(20))
    protocol: Mapped[str] = mapped_column(String(20), index=True)
    round: Mapped[int] = mapped_column(Integer)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    proposal: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    vote_source: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    total_amount_dollars: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    dollar_per_vl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Total vlCVX voting power that voted in the round.
    scores_total: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    bribes: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    # Votes (vlCVX) each pool received.
    bribed: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    detail_fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class VlcvxProtocol(Base):
    """Per-protocol figures that are not per round."""

    __tablename__ = "vlcvx_protocols"

    protocol: Mapped[str] = mapped_column(String(20), primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))
    reward_per_dollar_bribe: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class VlcvxSync(Base):
    """The single row that says whether a sync is running and how far it has got."""

    __tablename__ = "vlcvx_sync"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    state: Mapped[str] = mapped_column(String(10), default="idle")  # idle, running, failed
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    done: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
