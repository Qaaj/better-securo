"""address, map position, technical details, notes and photos for assets

Revision ID: 104
Revises: 103
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "104"
down_revision = "103"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("address", sa.String(500), nullable=True))
    op.add_column("assets", sa.Column("latitude", sa.Numeric(9, 6), nullable=True))
    op.add_column("assets", sa.Column("longitude", sa.Numeric(9, 6), nullable=True))
    op.add_column("assets", sa.Column("details", sa.JSON, nullable=True))
    op.add_column("assets", sa.Column("notes", sa.Text, nullable=True))
    op.add_column("assets", sa.Column("cover_photo_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_table(
        "asset_photos",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("asset_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(100), nullable=False),
        sa.Column("size", sa.BigInteger, nullable=False),
        sa.Column("caption", sa.String(300), nullable=True),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_asset_photos_asset_id", "asset_photos", ["asset_id"])
    op.create_index("ix_asset_photos_workspace_id", "asset_photos", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_asset_photos_workspace_id", table_name="asset_photos")
    op.drop_index("ix_asset_photos_asset_id", table_name="asset_photos")
    op.drop_table("asset_photos")
    for column in ("cover_photo_id", "notes", "details", "longitude", "latitude", "address"):
        op.drop_column("assets", column)
