"""keep the Retirement tab's plans on the server

Revision ID: 102
Revises: 101
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "102"
down_revision = "101"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "retirement_states",
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("data", sa.JSON, nullable=False),
        sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("retirement_states")
