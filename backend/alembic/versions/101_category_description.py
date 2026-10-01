"""describe what a category is for

Read by the automatic categorizer so the model follows the owner's own
conventions.

Revision ID: 101
Revises: 100
"""
import sqlalchemy as sa
from alembic import op

revision = "101"
down_revision = "100"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("categories", sa.Column("description", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("categories", "description")
