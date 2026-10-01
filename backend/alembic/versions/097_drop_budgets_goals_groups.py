"""drop budgets, goals and expense-splitting groups

These features were removed from the app. Their tables go in dependency
order: settlements and splits reference group members, members reference
groups.

Revision ID: 097
Revises: 096
"""
from alembic import op

revision = "097"
down_revision = "096"
branch_labels = None
depends_on = None

_TABLES = (
    "group_settlements",
    "transaction_splits",
    "group_members",
    "groups",
    "goals",
    "budgets",
)


def upgrade() -> None:
    for table in _TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def downgrade() -> None:
    raise NotImplementedError("dropped feature tables cannot be restored")
