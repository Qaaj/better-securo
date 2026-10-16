from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class SyncStatus(BaseModel):
    state: str
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    done: int = 0
    total: int = 0


class ProtocolSummary(BaseModel):
    protocol: str
    label: str
    rounds: int = 0
    first_round: Optional[int] = None
    latest_round: Optional[int] = None
    latest_ends_at: Optional[datetime] = None
    latest_total_dollars: Optional[float] = None
    latest_dollar_per_vl: Optional[float] = None
    latest_votes: Optional[float] = None
    average_dollar_per_vl_12: Optional[float] = None
    best_dollar_per_vl: Optional[float] = None
    total_dollars_all_time: Optional[float] = None
    reward_per_dollar_bribe: Optional[float] = None
    synced_at: Optional[datetime] = None


class VlcvxSummary(BaseModel):
    enabled: bool
    source: Optional[str] = None
    has_data: bool
    protocols: list[ProtocolSummary]
    sync: SyncStatus


class RoundSummary(BaseModel):
    round: int
    ends_at: Optional[datetime] = None
    total_amount_dollars: Optional[float] = None
    dollar_per_vl: Optional[float] = None
    scores_total: Optional[float] = None
    proposal: Optional[str] = None
    vote_source: Optional[str] = None
    has_detail: bool = False
    bribe_count: int = 0


class PoolLine(BaseModel):
    pool: str
    dollars: float
    tokens: list[str]
    votes: Optional[float] = None


class TokenLine(BaseModel):
    token: str
    dollars: float
    amount: float


class RoundDetail(RoundSummary):
    protocol: str
    pools: list[PoolLine]
    tokens: list[TokenLine]
    bribes: list[dict[str, Any]]


class TokenTotal(BaseModel):
    token: str
    total_dollars: float


class RoundTokens(BaseModel):
    round: int
    ends_at: Optional[datetime] = None
    tokens: dict[str, float]
    total_dollars: float


class PoolHistory(BaseModel):
    pool: str
    total_dollars: float
    rounds: int
    first_round: int
    last_round: int
    best_round_dollars: float


class Breakdown(BaseModel):
    tokens: list[TokenTotal]
    by_round: list[RoundTokens]
    top_pools: list[PoolHistory]
    rounds_with_detail: int
