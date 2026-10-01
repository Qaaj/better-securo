"""automatic categorization jobs and suggestions

Revision ID: 100
Revises: 099
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "100"
down_revision = "099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "categorization_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("base_url", sa.String(500), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("total_merchants", sa.Integer, nullable=False, server_default="0"),
        sa.Column("processed_merchants", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_categorization_jobs_workspace_id", "categorization_jobs", ["workspace_id"])
    op.create_table(
        "categorization_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("job_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("categorization_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("merchant_key", sa.String(60), nullable=False),
        sa.Column("sample_description", sa.String(500), nullable=False),
        sa.Column("tx_type", sa.String(10), nullable=False),
        sa.Column("tx_count", sa.Integer, nullable=False),
        sa.Column("total_amount_primary", sa.Numeric(15, 2), nullable=False, server_default="0"),
        sa.Column("suggested_category_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("categories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("confidence", sa.String(10), nullable=False),
        sa.Column("source", sa.String(10), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("applied_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.create_index("ix_categorization_suggestions_job_id", "categorization_suggestions", ["job_id"])
    op.create_index("ix_categorization_suggestions_workspace_id", "categorization_suggestions", ["workspace_id"])
    op.create_index("ix_categorization_suggestions_status", "categorization_suggestions", ["status"])


def downgrade() -> None:
    op.drop_table("categorization_suggestions")
    op.drop_table("categorization_jobs")
