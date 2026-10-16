"""vlCVX bribe market data from Llama Airforce

Revision ID: 106
Revises: 105
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "106"
down_revision = "105"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "vlcvx_rounds",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("platform", sa.String(20), nullable=False),
        sa.Column("protocol", sa.String(20), nullable=False),
        sa.Column("round", sa.Integer, nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("proposal", sa.String(100), nullable=True),
        sa.Column("vote_source", sa.String(30), nullable=True),
        sa.Column("total_amount_dollars", sa.Float, nullable=True),
        sa.Column("dollar_per_vl", sa.Float, nullable=True),
        sa.Column("scores_total", sa.Float, nullable=True),
        sa.Column("bribes", sa.JSON, nullable=True),
        sa.Column("bribed", sa.JSON, nullable=True),
        sa.Column("detail_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("platform", "protocol", "round", name="uq_vlcvx_round"),
    )
    op.create_index("ix_vlcvx_rounds_protocol", "vlcvx_rounds", ["protocol"])
    op.create_table(
        "vlcvx_protocols",
        sa.Column("protocol", sa.String(20), primary_key=True),
        sa.Column("platform", sa.String(20), nullable=False),
        sa.Column("reward_per_dollar_bribe", sa.Float, nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "vlcvx_sync",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("state", sa.String(10), nullable=False, server_default="idle"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("done", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total", sa.Integer, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("vlcvx_sync")
    op.drop_table("vlcvx_protocols")
    op.drop_index("ix_vlcvx_rounds_protocol", table_name="vlcvx_rounds")
    op.drop_table("vlcvx_rounds")
