"""contracts, utilities and documents for assets

Revision ID: 105
Revises: 104
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "105"
down_revision = "104"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asset_contracts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("asset_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("provider", sa.String(200), nullable=False),
        sa.Column("contract_number", sa.String(100), nullable=True),
        sa.Column("customer_number", sa.String(100), nullable=True),
        sa.Column("meter_number", sa.String(100), nullable=True),
        sa.Column("start_date", sa.Date, nullable=True),
        sa.Column("end_date", sa.Date, nullable=True),
        sa.Column("notice_days", sa.Integer, nullable=True),
        sa.Column("recurring_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("recurring_transactions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_asset_contracts_asset_id", "asset_contracts", ["asset_id"])
    op.create_index("ix_asset_contracts_workspace_id", "asset_contracts", ["workspace_id"])
    op.create_table(
        "asset_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("asset_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("asset_contracts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(100), nullable=False),
        sa.Column("size", sa.BigInteger, nullable=False),
        sa.Column("document_date", sa.Date, nullable=True),
        sa.Column("expires_on", sa.Date, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_asset_documents_asset_id", "asset_documents", ["asset_id"])
    op.create_index("ix_asset_documents_workspace_id", "asset_documents", ["workspace_id"])


def downgrade() -> None:
    for name in ("ix_asset_documents_workspace_id", "ix_asset_documents_asset_id"):
        op.drop_index(name, table_name="asset_documents")
    op.drop_table("asset_documents")
    for name in ("ix_asset_contracts_workspace_id", "ix_asset_contracts_asset_id"):
        op.drop_index(name, table_name="asset_contracts")
    op.drop_table("asset_contracts")
