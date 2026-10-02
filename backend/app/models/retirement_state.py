import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.core.database import Base


class RetirementState(Base):
    """The Retirement tab's saved plans and switches for a workspace.

    One document of named values (the current plan, saved plans, which
    income lines are counted, simulator settings). The frontend owns its shape;
    the server only keeps it so it follows the workspace across browsers.
    """

    __tablename__ = "retirement_states"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
