#!/usr/bin/env python3
"""Keep the vlCVX bribe market from Llama Airforce in a SQLite file and write it out as static JSON.

Standard library only, so it runs anywhere with Python 3.10+ (the standalone vlCVX site's server, a cron job, a
laptop) without Securo or its dependencies. It does what Securo's own sync does (app/services/vlcvx_service.py)
and writes the same shapes Securo's API returns, which the standalone page reads as files:

    data/summary.json
    data/rounds/<protocol>.json      every round, oldest first
    data/details/<protocol>.json     {"<round>": the round with its pools, tokens and bribes}
    data/breakdown/<protocol>.json   what was paid in, and the pools bribed most

    python3 vlcvx_export.py --db vlcvx.db --out /var/www/birbs/data

The first run copies the whole history (a few hundred requests); later runs read the overviews and only fetch
the detail of rounds that have none yet or are still open. The SQLite file is the permanent copy.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

API = "https://api.llama.airforce"
PLATFORM = "votium"
PROTOCOLS = {
    "cvx-crv": {"label": "Curve gauges", "dashboard": "bribes-overview-votium"},
    "cvx-fxn": {"label": "f(x) Protocol", "dashboard": "bribes-overview-fxn"},
    "cvx-prisma": {"label": "Prisma", "dashboard": "bribes-overview-prisma"},
}
OPEN_FOR = timedelta(days=3)
RETRIES = 3
WORKERS = 4
PAUSE = 0.15


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def parse_time(text: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(text) if text else None


def when(epoch: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


# ---------------------------------------------------------------- fetching
class SourceDown(Exception):
    pass


def get_json(base: str, path: str) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            request = urllib.request.Request(base.rstrip("/") + path, headers={"Accept": "application/json", "User-Agent": "better-securo vlcvx export"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise SourceDown(f"The data source did not answer for {path}: {last}")


# ---------------------------------------------------------------- storage
SCHEMA = """
CREATE TABLE IF NOT EXISTS rounds (
    protocol TEXT NOT NULL, round INTEGER NOT NULL, ends_at TEXT, proposal TEXT, vote_source TEXT,
    total_amount_dollars REAL, dollar_per_vl REAL, scores_total REAL, bribes TEXT, bribed TEXT, detail_fetched_at TEXT,
    PRIMARY KEY (protocol, round)
);
CREATE TABLE IF NOT EXISTS protocols (protocol TEXT PRIMARY KEY, reward_per_dollar_bribe REAL, synced_at TEXT);
"""


def connect(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def sync_overview(db: sqlite3.Connection, base: str, protocol: str) -> int:
    payload = get_json(base, f"/dashboard/{PROTOCOLS[protocol]['dashboard']}").get("dashboard") or {}
    epochs = [e for e in payload.get("epochs") or [] if e.get("protocol", protocol) == protocol and isinstance(e.get("round"), int)]
    for e in epochs:
        db.execute(
            "INSERT INTO rounds (protocol, round, ends_at, proposal, vote_source, total_amount_dollars, dollar_per_vl) VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(protocol, round) DO UPDATE SET ends_at=COALESCE(excluded.ends_at, ends_at), proposal=COALESCE(excluded.proposal, proposal), "
            "vote_source=COALESCE(excluded.vote_source, vote_source), total_amount_dollars=excluded.total_amount_dollars, dollar_per_vl=excluded.dollar_per_vl",
            (protocol, e["round"], iso(when(e.get("end"))), e.get("proposal"), e.get("voteSource"), e.get("totalAmountDollars"), e.get("dollarPerVlAsset")),
        )
    db.execute(
        "INSERT INTO protocols (protocol, reward_per_dollar_bribe, synced_at) VALUES (?,?,?) "
        "ON CONFLICT(protocol) DO UPDATE SET reward_per_dollar_bribe=excluded.reward_per_dollar_bribe, synced_at=excluded.synced_at",
        (protocol, payload.get("rewardPerDollarBribe"), iso(now())),
    )
    db.commit()
    return len(epochs)


def needing_detail(db: sqlite3.Connection, protocols: list[str]) -> list[tuple[str, int]]:
    cutoff = now() - OPEN_FOR
    out = []
    for r in db.execute("SELECT protocol, round, ends_at, detail_fetched_at FROM rounds ORDER BY protocol, round DESC"):
        if r["protocol"] not in protocols:
            continue
        ends = parse_time(r["ends_at"])
        if r["detail_fetched_at"] is None or (ends is not None and ends > cutoff):
            out.append((r["protocol"], r["round"]))
    return out


def sync_details(db: sqlite3.Connection, base: str, todo: list[tuple[str, int]], log) -> int:
    def fetch(item: tuple[str, int]):
        protocol, number = item
        try:
            data = get_json(base, f"/bribes/{PLATFORM}/{protocol}/{number}")
        except SourceDown:
            return protocol, number, None
        time.sleep(PAUSE)
        return protocol, number, data.get("epoch")

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for start in range(0, len(todo), 12):
            for protocol, number, epoch in pool.map(fetch, todo[start:start + 12]):
                if not epoch:
                    continue
                bribes = epoch.get("bribes") or []
                total = sum(float(b.get("amountDollars") or 0) for b in bribes) if bribes else None
                db.execute(
                    "UPDATE rounds SET scores_total=?, bribes=?, bribed=?, vote_source=COALESCE(?, vote_source), proposal=COALESCE(?, proposal), "
                    "ends_at=COALESCE(?, ends_at), total_amount_dollars=COALESCE(total_amount_dollars, ?), detail_fetched_at=? WHERE protocol=? AND round=?",
                    (epoch.get("scoresTotal"), json.dumps(bribes), json.dumps(epoch.get("bribed") or {}), epoch.get("voteSource"), epoch.get("proposal"),
                     iso(when(epoch.get("end"))), total, iso(now()), protocol, number),
                )
                done += 1
            db.commit()
            log(f"  details {min(start + 12, len(todo))}/{len(todo)}")
    return done


def sync(db: sqlite3.Connection, base: str = API, details: bool = True, log=print) -> dict[str, int]:
    counts = {"rounds": 0, "details": 0}
    for protocol in PROTOCOLS:
        counts["rounds"] += sync_overview(db, base, protocol)
        log(f"{protocol}: overview read")
    if details:
        todo = needing_detail(db, list(PROTOCOLS))
        log(f"{len(todo)} rounds need detail")
        counts["details"] = sync_details(db, base, todo, log)
    return counts


# ---------------------------------------------------------------- shapes (the same as Securo's API)
def _round_summary(r: sqlite3.Row) -> dict[str, Any]:
    bribes = json.loads(r["bribes"]) if r["bribes"] else []
    return {
        "round": r["round"],
        "ends_at": r["ends_at"],
        "total_amount_dollars": r["total_amount_dollars"],
        "dollar_per_vl": r["dollar_per_vl"],
        "scores_total": r["scores_total"],
        "proposal": r["proposal"],
        "vote_source": r["vote_source"],
        "has_detail": r["detail_fetched_at"] is not None,
        "bribe_count": len(bribes),
    }


def rounds_of(db: sqlite3.Connection, protocol: str) -> list[sqlite3.Row]:
    return list(db.execute("SELECT * FROM rounds WHERE protocol=? ORDER BY round", (protocol,)))


def round_detail(r: sqlite3.Row, protocol: str) -> dict[str, Any]:
    bribes = json.loads(r["bribes"]) if r["bribes"] else []
    votes = json.loads(r["bribed"]) if r["bribed"] else {}
    by_pool: dict[str, dict[str, Any]] = defaultdict(lambda: {"dollars": 0.0, "tokens": set()})
    by_token: dict[str, dict[str, float]] = defaultdict(lambda: {"dollars": 0.0, "amount": 0.0})
    for b in bribes:
        pool, token = b.get("pool", "?"), b.get("token", "?")
        by_pool[pool]["dollars"] += float(b.get("amountDollars") or 0)
        by_pool[pool]["tokens"].add(token)
        by_token[token]["dollars"] += float(b.get("amountDollars") or 0)
        by_token[token]["amount"] += float(b.get("amount") or 0)
    pools = [{"pool": p, "dollars": round(v["dollars"], 2), "tokens": sorted(v["tokens"]), "votes": votes.get(p)} for p, v in by_pool.items()]
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


def breakdown(rows: list[sqlite3.Row], top: int = 25) -> dict[str, Any]:
    token_totals: dict[str, float] = defaultdict(float)
    pools: dict[str, dict[str, Any]] = {}
    by_round = []
    for r in rows:
        tokens: dict[str, float] = defaultdict(float)
        round_pools: dict[str, float] = defaultdict(float)
        for b in json.loads(r["bribes"]) if r["bribes"] else []:
            dollars = float(b.get("amountDollars") or 0)
            tokens[b.get("token", "?")] += dollars
            round_pools[b.get("pool", "?")] += dollars
        for token, dollars in tokens.items():
            token_totals[token] += dollars
        for pool, dollars in round_pools.items():
            entry = pools.setdefault(pool, {"pool": pool, "total_dollars": 0.0, "rounds": 0, "first_round": r["round"], "last_round": r["round"], "best_round_dollars": 0.0})
            entry["total_dollars"] += dollars
            entry["rounds"] += 1
            entry["last_round"] = r["round"]
            entry["best_round_dollars"] = max(entry["best_round_dollars"], dollars)
        by_round.append({"round": r["round"], "ends_at": r["ends_at"], "tokens": {t: round(v, 2) for t, v in tokens.items()}, "total_dollars": round(sum(tokens.values()), 2)})
    return {
        "tokens": sorted(({"token": t, "total_dollars": round(v, 2)} for t, v in token_totals.items()), key=lambda x: -x["total_dollars"]),
        "by_round": by_round,
        "top_pools": sorted(({**p, "total_dollars": round(p["total_dollars"], 2), "best_round_dollars": round(p["best_round_dollars"], 2)} for p in pools.values()), key=lambda x: -x["total_dollars"])[:top],
        "rounds_with_detail": sum(1 for r in rows if r["detail_fetched_at"] is not None),
    }


def summary(db: sqlite3.Connection, source: str = API) -> dict[str, Any]:
    out = []
    total_rows = 0
    for protocol, info in PROTOCOLS.items():
        rows = rounds_of(db, protocol)
        total_rows += len(rows)
        meta = db.execute("SELECT * FROM protocols WHERE protocol=?", (protocol,)).fetchone()
        if not rows:
            out.append({"protocol": protocol, "label": info["label"], "rounds": 0})
            continue
        paid = [r for r in rows if r["total_amount_dollars"] is not None]
        rates = [r["dollar_per_vl"] for r in rows if r["dollar_per_vl"] is not None]
        latest = rows[-1]
        out.append({
            "protocol": protocol, "label": info["label"], "rounds": len(rows), "first_round": rows[0]["round"], "latest_round": latest["round"],
            "latest_ends_at": latest["ends_at"], "latest_total_dollars": latest["total_amount_dollars"], "latest_dollar_per_vl": latest["dollar_per_vl"],
            "latest_votes": latest["scores_total"], "average_dollar_per_vl_12": statistics.mean(rates[-12:]) if rates else None,
            "best_dollar_per_vl": max(rates) if rates else None, "total_dollars_all_time": sum(r["total_amount_dollars"] for r in paid),
            "reward_per_dollar_bribe": meta["reward_per_dollar_bribe"] if meta else None, "synced_at": meta["synced_at"] if meta else None,
        })
    return {
        "enabled": True,
        "source": source,
        "protocols": out,
        "has_data": total_rows > 0,
        "sync": {"state": "idle", "started_at": None, "finished_at": iso(now()), "error": None, "done": 0, "total": 0},
    }


# ---------------------------------------------------------------- writing
def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(handle, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), default=str)
    os.chmod(temp, 0o644)
    os.replace(temp, path)


def write_site(db: sqlite3.Connection, out: str, source: str = API) -> None:
    root = Path(out)
    write_json(root / "summary.json", summary(db, source))
    for protocol in PROTOCOLS:
        rows = rounds_of(db, protocol)
        write_json(root / "rounds" / f"{protocol}.json", [_round_summary(r) for r in rows])
        write_json(root / "details" / f"{protocol}.json", {str(r["round"]): round_detail(r, protocol) for r in rows})
        write_json(root / "breakdown" / f"{protocol}.json", breakdown(rows))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", required=True, help="the SQLite file that keeps the history")
    parser.add_argument("--out", required=True, help="where to write the static JSON")
    parser.add_argument("--api", default=API, help="Llama Airforce API base URL")
    parser.add_argument("--no-details", action="store_true", help="only read the overviews")
    args = parser.parse_args(argv)
    db = connect(args.db)
    try:
        counts = sync(db, args.api, details=not args.no_details)
    except SourceDown as exc:
        print(f"Could not sync ({exc}); writing what is stored.", file=sys.stderr)
        counts = None
    write_site(db, args.out, args.api)
    print(f"Done: {counts}" if counts else "Done from stored data")
    return 0 if counts else 1


if __name__ == "__main__":
    sys.exit(main())
