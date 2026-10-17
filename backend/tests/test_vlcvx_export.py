"""The standalone exporter (scripts/vlcvx_export.py) must give what Securo's own service gives."""
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete
from fastapi.encoders import jsonable_encoder

from app.models.vlcvx import VlcvxProtocol, VlcvxRound, VlcvxSync
from app.services import vlcvx_service as service

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "vlcvx_export.py"
spec = importlib.util.spec_from_file_location("vlcvx_export", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


@pytest_asyncio.fixture(autouse=True)
async def clean_vlcvx(session):
    """These tables are shared by every workspace, so each test starts from empty ones."""
    for model in (VlcvxRound, VlcvxProtocol, VlcvxSync):
        await session.execute(delete(model))
    await session.commit()
    yield


NOW = datetime.now(timezone.utc).replace(microsecond=0)


def ts(days_ago: int) -> int:
    return int((NOW - timedelta(days=days_ago)).timestamp())


def payload(path: str):
    """What the API answers, for two protocols with a few rounds."""
    if path.startswith("/dashboard/"):
        name = path.split("/")[-1]
        epochs = {
            "bribes-overview-votium": [{"platform": "votium", "protocol": "cvx-crv", "round": n, "proposal": f"p{n}", "voteSource": "snapshot", "end": ts(14 * (4 - n) + 20), "totalAmountDollars": 1000.0 * n, "dollarPerVlAsset": 0.01 * n} for n in (1, 2, 3)],
            "bribes-overview-fxn": [{"platform": "votium", "protocol": "cvx-fxn", "round": 1, "proposal": "x", "end": ts(400), "totalAmountDollars": 50.0, "dollarPerVlAsset": 0.001}],
            "bribes-overview-prisma": [],
        }[name]
        return 200, {"statusCode": 200, "dashboard": {"id": name, "rewardPerDollarBribe": 1.5, "epochs": epochs}}
    parts = path.strip("/").split("/")
    if parts[0] == "bribes" and len(parts) == 4:
        protocol, number = parts[2], int(parts[3])
        return 200, {"statusCode": 200, "epoch": {
            "round": number, "protocol": protocol, "proposal": f"p{number}", "voteSource": "convex-onchain", "end": ts(14 * (4 - number) + 20) if protocol == "cvx-crv" else ts(400),
            "scoresTotal": 40_000_000.0 + number, "bribed": {"Pool A": 30_000_000.0, "Pool B": 10_000_000.0, "Pool C": 5.0},
            "bribes": [
                {"pool": "Pool A", "token": "CRV", "amount": 100.0, "amountDollars": 60.0 * number},
                {"pool": "Pool A", "token": "CVX", "amount": 10.0, "amountDollars": 40.0 * number},
                {"pool": "Pool B", "token": "CRV", "amount": 50.0, "amountDollars": 30.0 * number},
            ],
        }}
    return 404, {}


def transport(request: httpx.Request) -> httpx.Response:
    status, body = payload(request.url.path)
    return httpx.Response(status, json=body)


def norm(data):
    """The test database (SQLite) drops the zone from stored times; Postgres keeps it. Compare them the same."""
    if isinstance(data, dict):
        return {k: norm(v) for k, v in data.items()}
    if isinstance(data, list):
        return [norm(v) for v in data]
    return data[:-6] if isinstance(data, str) and data.endswith("+00:00") else data


def plain(value):
    return norm(json.loads(json.dumps(jsonable_encoder(value))))


def without_times(data):
    """Drop what depends on when the sync happened."""
    if isinstance(data, dict):
        return {k: without_times(v) for k, v in data.items() if k not in ("synced_at", "finished_at", "started_at", "sync")}
    if isinstance(data, list):
        return [without_times(v) for v in data]
    return data


@pytest.mark.asyncio
async def test_the_exporter_writes_what_securo_serves(session, tmp_path):
    def fake_get(base, path):
        status, body = payload(path)
        if status != 200:
            raise exporter.SourceDown(path)
        return body

    with patch.object(exporter, "get_json", fake_get), patch.object(exporter, "PAUSE", 0):
        db = exporter.connect(str(tmp_path / "vlcvx.db"))
        counts = exporter.sync(db, log=lambda *_: None)
        assert counts == {"rounds": 4, "details": 4}
        exporter.write_site(db, str(tmp_path / "data"))

    with patch.object(service, "_client", lambda: httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(transport))), patch.object(service, "PAUSE_SECONDS", 0):
        await service.begin_sync(session)
        await service.run_sync(session)

    data = tmp_path / "data"
    read = lambda *parts: norm(json.loads(Path(data, *parts).read_text()))  # noqa: E731

    mine = without_times(read("summary.json"))
    theirs = without_times(plain(await service.summary(session)))
    theirs.pop("source")
    mine.pop("source")
    assert mine == theirs

    for protocol in ("cvx-crv", "cvx-fxn", "cvx-prisma"):
        assert read("rounds", f"{protocol}.json") == plain(await service.list_rounds(session, protocol))
        assert read("breakdown", f"{protocol}.json") == plain(await service.breakdown(session, protocol))
        details = read("details", f"{protocol}.json")
        assert sorted(details, key=int) == [str(r["round"]) for r in await service.list_rounds(session, protocol)]
        for number, detail in details.items():
            assert detail == plain(await service.round_detail(session, protocol, int(number)))


def test_a_second_run_keeps_the_history_and_only_refreshes_open_rounds(tmp_path):
    calls: list[str] = []

    def fake_get(base, path):
        calls.append(path)
        status, body = payload(path)
        if status != 200:
            raise exporter.SourceDown(path)
        return body

    with patch.object(exporter, "get_json", fake_get), patch.object(exporter, "PAUSE", 0):
        db = exporter.connect(str(tmp_path / "h.db"))
        exporter.sync(db, log=lambda *_: None)
        first = len([c for c in calls if c.startswith("/bribes/")])
        calls.clear()
        exporter.sync(db, log=lambda *_: None)
        again = len([c for c in calls if c.startswith("/bribes/")])
    assert first == 4 and again < first
    assert db.execute("SELECT COUNT(*) FROM rounds").fetchone()[0] == 4


def test_a_dead_source_leaves_what_is_stored_and_still_writes_the_site(tmp_path):
    def down(base, path):
        raise exporter.SourceDown(path)

    db = exporter.connect(str(tmp_path / "h.db"))
    db.execute("INSERT INTO rounds (protocol, round, ends_at, total_amount_dollars, dollar_per_vl) VALUES ('cvx-crv', 1, '2026-01-01T00:00:00+00:00', 10, 0.01)")
    db.commit()
    with patch.object(exporter, "get_json", down):
        code = exporter.main(["--db", str(tmp_path / "h.db"), "--out", str(tmp_path / "out"), "--no-details"])
    assert code == 1
    assert json.loads((tmp_path / "out" / "summary.json").read_text())["protocols"][0]["rounds"] == 1
