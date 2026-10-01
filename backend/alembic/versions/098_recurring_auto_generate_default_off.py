"""recurring transactions no longer write ledger rows by default

New recurring items only forecast; generating placeholder transactions is
opt-in. Existing rows keep whatever they had.

Revision ID: 098
Revises: 097
"""
from alembic import op

revision = "098"
down_revision = "097"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("recurring_transactions", "auto_generate", server_default="false")


def downgrade() -> None:
    op.alter_column("recurring_transactions", "auto_generate", server_default="true")
