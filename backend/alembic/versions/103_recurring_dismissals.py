"""remember which recurring-finder suggestions were dismissed

Revision ID: 103
Revises: 102
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "103"
down_revision = "102"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recurring_dismissals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("key", sa.String(300), nullable=False),
        sa.Column("recurring_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("recurring_transactions.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_recurring_dismissals_workspace_id", "recurring_dismissals", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_recurring_dismissals_workspace_id", table_name="recurring_dismissals")
    op.drop_table("recurring_dismissals")
