"""vlCVX bribe market data, taken from Llama Airforce's public API and kept in the database.

Votium is the market where vote-locked CVX (vlCVX) holders sell their votes for bribes. Llama Airforce
publishes, for each protocol Convex votes on, an overview of every round since the start (the dollars paid,
and the dollars per vlCVX) and, per round, which pools were bribed with what and how many votes each got.
This module copies both into `vlcvx_rounds` so the history is local, quick to chart and still there if the
API is not. A sync reads the overviews, then fetches the detail of rounds that have none yet or are still
open; running it again only fetches what changed.

Nothing here is personal data: the tables are shared by every workspace.
"""
from __future__ import annotations

import asyncio
import logging
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.vlcvx import VlcvxProtocol, VlcvxRound, VlcvxSync

logger = logging.getLogger(__name__)

PLATFORM = "votium"
# protocol -> what the site calls it and the dashboard its overview lives under
PROTOCOLS: dict[str, dict[str, str]] = {
    "cvx-crv": {"label": "Curve gauges", "dashboard": "bribes-overview-votium"},
    "cvx-fxn": {"label": "f(x) Protocol", "dashboard": "bribes-overview-fxn"},
    "cvx-prisma": {"label": "Prisma", "dashboard": "bribes-overview-prisma"},
}
# A round is still moving until a little after it ends (late bribes, final scores).
OPEN_FOR = timedelta(days=3)
CONCURRENCY = 4
PAUSE_SECONDS = 0.15
RETRIES = 3


class VlcvxUnavailable(Exception):
    """The data source is switched off or did not answer."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    """Treat a stored time without a zone (some databases drop it) as UTC."""
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _when(epoch: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _client() -> httpx.AsyncClient:
    base = get_settings().llama_airforce_url
    if not base:
        raise VlcvxUnavailable("The vlCVX data source is switched off (LLAMA_AIRFORCE_URL is empty).")
    return httpx.AsyncClient(base_url=base.rstrip("/"), timeout=30.0, headers={"Accept": "application/json", "User-Agent": "better-securo (self-hosted)"})


async def _get(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            response = await client.get(path)
            if response.status_code >= 500:
                raise httpx.HTTPStatusError("server error", request=response.request, response=response)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            last = exc
            await asyncio.sleep(0.5 * (attempt + 1))
    raise VlcvxUnavailable(f"The vlCVX data source did not answer for {path}.") from last


# ---------------------------------------------------------------- sync
async def _state(session: AsyncSession) -> VlcvxSync:
    row = await session.get(VlcvxSync, 1)
    if row is None:
        row = VlcvxSync(id=1, state="idle", done=0, total=0)
        session.add(row)
        await session.flush()
    return row


async def sync_state(session: AsyncSession) -> VlcvxSync:
    row = await _state(session)
    # A sync that has been "running" for much longer than one takes died with its worker.
    started = _aware(row.started_at)
    if row.state == "running" and started and _now() - started > timedelta(minutes=20):
        row.state = "failed"
        row.error = "The last sync did not finish."
        await session.commit()
    return row


async def begin_sync(session: AsyncSession) -> tuple[bool, VlcvxSync]:
    """Mark a sync as running. False when one already is."""
    row = await sync_state(session)
    if row.state == "running":
        return False, row
    row.state, row.started_at, row.finished_at, row.error, row.done, row.total = "running", _now(), None, None, 0, 0
    await session.commit()
    return True, row


async def run_sync(session: AsyncSession, *, details: bool = True, only: Optional[list[str]] = None) -> dict[str, int]:
    """Read the overviews, then the detail of rounds that need it. Marks the sync row as it goes."""
    row = await _state(session)
    counts = {"rounds": 0, "details": 0}
    try:
        async with _client() as client:
            protocols = [p for p in PROTOCOLS if not only or p in only]
            for protocol in protocols:
                counts["rounds"] += await _sync_overview(session, client, protocol)
            if details:
                todo = await _needing_detail(session, protocols)
                row.total = len(todo)
                row.done = 0
                await session.commit()
                await _sync_details(session, client, todo, row, counts)
        row.state, row.finished_at, row.error = "idle", _now(), None
    except VlcvxUnavailable as exc:
        row.state, row.finished_at, row.error = "failed", _now(), str(exc)[:500]
        raise
    except Exception as exc:  # keep the row honest even for the unexpected
        logger.exception("vlcvx sync failed")
        row.state, row.finished_at, row.error = "failed", _now(), f"{type(exc).__name__}: {exc}"[:500]
        raise
    finally:
        await session.commit()
    return counts


async def _sync_overview(session: AsyncSession, client: httpx.AsyncClient, protocol: str) -> int:
    payload = (await _get(client, f"/dashboard/{PROTOCOLS[protocol]['dashboard']}")).get("dashboard") or {}
    epochs = [e for e in payload.get("epochs") or [] if e.get("protocol", protocol) == protocol]
    existing = {
        r.round: r
        for r in (await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol))).scalars().all()
    }
    for e in epochs:
        number = e.get("round")
        if not isinstance(number, int):
            continue
        row = existing.get(number)
        if row is None:
            row = VlcvxRound(platform=PLATFORM, protocol=protocol, round=number)
            session.add(row)
        row.ends_at = _when(e.get("end")) or row.ends_at
        row.proposal = e.get("proposal") or row.proposal
        row.vote_source = e.get("voteSource") or row.vote_source
        row.total_amount_dollars = e.get("totalAmountDollars")
        row.dollar_per_vl = e.get("dollarPerVlAsset")
    meta = await session.get(VlcvxProtocol, protocol)
    if meta is None:
        meta = VlcvxProtocol(protocol=protocol, platform=PLATFORM)
        session.add(meta)
    meta.reward_per_dollar_bribe = payload.get("rewardPerDollarBribe")
    meta.synced_at = _now()
    await session.commit()
    return len(epochs)


async def _needing_detail(session: AsyncSession, protocols: list[str]) -> list[tuple[str, int]]:
    rows = (await session.execute(select(VlcvxRound).where(VlcvxRound.protocol.in_(protocols)).order_by(VlcvxRound.protocol, VlcvxRound.round.desc()))).scalars().all()
    cutoff = _now() - OPEN_FOR
    return [
        (r.protocol, r.round)
        for r in rows
        if r.detail_fetched_at is None or (r.ends_at is not None and _aware(r.ends_at) > cutoff)
    ]


async def _sync_details(session: AsyncSession, client: httpx.AsyncClient, todo: list[tuple[str, int]], row: VlcvxSync, counts: dict[str, int]) -> None:
    gate = asyncio.Semaphore(CONCURRENCY)

    async def fetch(protocol: str, number: int) -> tuple[str, int, Optional[dict]]:
        async with gate:
            try:
                data = await _get(client, f"/bribes/{PLATFORM}/{protocol}/{number}")
            except VlcvxUnavailable:
                return protocol, number, None
            await asyncio.sleep(PAUSE_SECONDS)
            return protocol, number, data.get("epoch")

    for start in range(0, len(todo), 12):
        batch = todo[start:start + 12]
        for protocol, number, epoch in await asyncio.gather(*(fetch(p, n) for p, n in batch)):
            row.done += 1
            if not epoch:
                continue
            r = (await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol, VlcvxRound.round == number))).scalar_one_or_none()
            if r is None:
                continue
            r.scores_total = epoch.get("scoresTotal")
            r.bribes = epoch.get("bribes") or []
            r.bribed = epoch.get("bribed") or {}
            r.vote_source = epoch.get("voteSource") or r.vote_source
            r.proposal = epoch.get("proposal") or r.proposal
            r.ends_at = _when(epoch.get("end")) or r.ends_at
            if r.bribes and r.total_amount_dollars is None:
                r.total_amount_dollars = sum(float(b.get("amountDollars") or 0) for b in r.bribes)
            r.detail_fetched_at = _now()
            counts["details"] += 1
        await session.commit()


# ---------------------------------------------------------------- reading
def _round_summary(r: VlcvxRound) -> dict[str, Any]:
    return {
        "round": r.round,
        "ends_at": r.ends_at,
        "total_amount_dollars": r.total_amount_dollars,
        "dollar_per_vl": r.dollar_per_vl,
        "scores_total": r.scores_total,
        "proposal": r.proposal,
        "vote_source": r.vote_source,
        "has_detail": r.detail_fetched_at is not None,
        "bribe_count": len(r.bribes or []),
    }


async def list_rounds(session: AsyncSession, protocol: str) -> list[dict[str, Any]]:
    rows = (await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol).order_by(VlcvxRound.round))).scalars().all()
    return [_round_summary(r) for r in rows]


async def round_detail(session: AsyncSession, protocol: str, number: int) -> Optional[dict[str, Any]]:
    r = (await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol, VlcvxRound.round == number))).scalar_one_or_none()
    if r is None:
        return None
    bribes = r.bribes or []
    by_pool: dict[str, dict[str, Any]] = defaultdict(lambda: {"dollars": 0.0, "tokens": set()})
    by_token: dict[str, dict[str, float]] = defaultdict(lambda: {"dollars": 0.0, "amount": 0.0})
    for b in bribes:
        by_pool[b.get("pool", "?")]["dollars"] += float(b.get("amountDollars") or 0)
        by_pool[b.get("pool", "?")]["tokens"].add(b.get("token", "?"))
        by_token[b.get("token", "?")]["dollars"] += float(b.get("amountDollars") or 0)
        by_token[b.get("token", "?")]["amount"] += float(b.get("amount") or 0)
    votes = r.bribed or {}
    pools = [
        {"pool": pool, "dollars": round(v["dollars"], 2), "tokens": sorted(v["tokens"]), "votes": votes.get(pool)}
        for pool, v in by_pool.items()
    ]
    for pool, count in votes.items():
        if pool not in by_pool:
            pools.append({"pool": pool, "dollars": 0.0, "tokens": [], "votes": count})
    pools.sort(key=lambda p: (-p["dollars"], -(p["votes"] or 0)))
    return {
        **_round_summary(r),
        "protocol": protocol,
        "pools": pools,
        "tokens": sorted(({"token": t, "dollars": round(v["dollars"], 2), "amount": v["amount"]} for t, v in by_token.items()), key=lambda x: -x["dollars"]),
        "bribes": bribes,
    }


async def breakdown(session: AsyncSession, protocol: str, top: int = 25) -> dict[str, Any]:
    """What was paid in, and which pools were bribed, across all stored rounds of a protocol."""
    rows = (
        await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol).order_by(VlcvxRound.round))
    ).scalars().all()
    token_totals: dict[str, float] = defaultdict(float)
    pools: dict[str, dict[str, Any]] = {}
    by_round: list[dict[str, Any]] = []
    for r in rows:
        tokens: dict[str, float] = defaultdict(float)
        round_pools: dict[str, float] = defaultdict(float)
        for b in r.bribes or []:
            dollars = float(b.get("amountDollars") or 0)
            tokens[b.get("token", "?")] += dollars
            round_pools[b.get("pool", "?")] += dollars
        for token, dollars in tokens.items():
            token_totals[token] += dollars
        for pool, dollars in round_pools.items():
            entry = pools.setdefault(pool, {"pool": pool, "total_dollars": 0.0, "rounds": 0, "first_round": r.round, "last_round": r.round, "best_round_dollars": 0.0})
            entry["total_dollars"] += dollars
            entry["rounds"] += 1
            entry["last_round"] = r.round
            entry["best_round_dollars"] = max(entry["best_round_dollars"], dollars)
        by_round.append({"round": r.round, "ends_at": r.ends_at, "tokens": {t: round(v, 2) for t, v in tokens.items()}, "total_dollars": round(sum(tokens.values()), 2)})
    return {
        "tokens": sorted(({"token": t, "total_dollars": round(v, 2)} for t, v in token_totals.items()), key=lambda x: -x["total_dollars"]),
        "by_round": by_round,
        "top_pools": sorted(({**p, "total_dollars": round(p["total_dollars"], 2), "best_round_dollars": round(p["best_round_dollars"], 2)} for p in pools.values()), key=lambda x: -x["total_dollars"])[:top],
        "rounds_with_detail": sum(1 for r in rows if r.detail_fetched_at is not None),
    }


async def summary(session: AsyncSession) -> dict[str, Any]:
    sync = await sync_state(session)
    out = []
    for protocol, info in PROTOCOLS.items():
        rows = (await session.execute(select(VlcvxRound).where(VlcvxRound.platform == PLATFORM, VlcvxRound.protocol == protocol).order_by(VlcvxRound.round))).scalars().all()
        meta = await session.get(VlcvxProtocol, protocol)
        if not rows:
            out.append({"protocol": protocol, "label": info["label"], "rounds": 0})
            continue
        paid = [r for r in rows if r.total_amount_dollars is not None]
        rates = [r.dollar_per_vl for r in rows if r.dollar_per_vl is not None]
        latest = rows[-1]
        out.append(
            {
                "protocol": protocol,
                "label": info["label"],
                "rounds": len(rows),
                "first_round": rows[0].round,
                "latest_round": latest.round,
                "latest_ends_at": latest.ends_at,
                "latest_total_dollars": latest.total_amount_dollars,
                "latest_dollar_per_vl": latest.dollar_per_vl,
                "latest_votes": latest.scores_total,
                "average_dollar_per_vl_12": statistics.mean(rates[-12:]) if rates else None,
                "best_dollar_per_vl": max(rates) if rates else None,
                "total_dollars_all_time": sum(r.total_amount_dollars for r in paid),
                "reward_per_dollar_bribe": meta.reward_per_dollar_bribe if meta else None,
                "synced_at": meta.synced_at if meta else None,
            }
        )
    total_rows = await session.scalar(select(func.count()).select_from(VlcvxRound)) or 0
    return {
        "enabled": bool(get_settings().llama_airforce_url),
        "source": get_settings().llama_airforce_url or None,
        "protocols": out,
        "has_data": total_rows > 0,
        "sync": {"state": sync.state, "started_at": sync.started_at, "finished_at": sync.finished_at, "error": sync.error, "done": sync.done, "total": sync.total},
    }


# Typed alias for callers that pass their own session factory.
SessionRunner = Callable[[AsyncSession], Awaitable[Any]]
