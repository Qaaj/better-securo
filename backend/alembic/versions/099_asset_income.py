"""modelled income on assets

Optional fields the retirement forecast reads: a yield rate or a fixed
periodic amount (e.g. a rental), and a planned yearly sell percentage. They
are inputs to the forecast only and never create transactions.

Revision ID: 099
Revises: 098
"""
import sqlalchemy as sa
from alembic import op

revision = "099"
down_revision = "098"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("income_mode", sa.String(10), nullable=True))
    op.add_column("assets", sa.Column("income_rate", sa.Numeric(9, 4), nullable=True))
    op.add_column("assets", sa.Column("income_amount", sa.Numeric(15, 2), nullable=True))
    op.add_column("assets", sa.Column("income_frequency", sa.String(20), nullable=True))
    op.add_column("assets", sa.Column("sell_percent_per_year", sa.Numeric(6, 3), nullable=True))


def downgrade() -> None:
    for column in ("sell_percent_per_year", "income_frequency", "income_amount", "income_rate", "income_mode"):
        op.drop_column("assets", column)
