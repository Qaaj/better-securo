"""The vlCVX data: syncing from Llama Airforce's API (mocked) and reading it back."""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest

from app.services import vlcvx_service as service


def epoch_ts(days_ago: int) -> int:
    return int((datetime.now(timezone.utc) - timedelta(days=days_ago)).timestamp())


def fake_api(calls: list):
    """The three kinds of answer the real API gives, for two protocols."""
    overview = {
        "bribes-overview-votium": {"id": "bribes-overview-votium", "rewardPerDollarBribe": 1.5, "epochs": [
            {"platform": "votium", "protocol": "cvx-crv", "round": n, "proposal": f"p{n}", "voteSource": "snapshot", "end": epoch_ts(14 * (4 - n) + 20), "totalAmountDollars": 1000.0 * n, "dollarPerVlAsset": 0.01 * n}
            for n in (1, 2, 3)
        ]},
        "bribes-overview-fxn": {"id": "bribes-overview-fxn", "rewardPerDollarBribe": 3.0, "epochs": [
            {"platform": "votium", "protocol": "cvx-fxn", "round": 1, "proposal": "x", "end": epoch_ts(400), "totalAmountDollars": 50.0, "dollarPerVlAsset": 0.001}
        ]},
        "bribes-overview-prisma": {"id": "bribes-overview-prisma", "rewardPerDollarBribe": 0, "epochs": []},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append(path)
        if path.startswith("/dashboard/"):
            return httpx.Response(200, json={"statusCode": 200, "dashboard": overview[path.split("/")[-1]]})
        parts = path.strip("/").split("/")  # bribes / votium / protocol / round
        if parts[0] == "bribes" and len(parts) == 4:
            protocol, number = parts[2], int(parts[3])
            return httpx.Response(200, json={"statusCode": 200, "epoch": {
                "round": number, "protocol": protocol, "proposal": f"p{number}", "voteSource": "convex-onchain", "end": epoch_ts(14 * (4 - number) + 20) if protocol == "cvx-crv" else epoch_ts(400),
                "scoresTotal": 40_000_000.0 + number,
                "bribed": {"Pool A": 30_000_000.0, "Pool B": 10_000_000.0},
                "bribes": [
                    {"pool": "Pool A", "token": "CRV", "amount": 100.0, "amountDollars": 60.0 * number},
                    {"pool": "Pool A", "token": "CVX", "amount": 10.0, "amountDollars": 40.0 * number},
                    {"pool": "Pool B", "token": "CRV", "amount": 50.0, "amountDollars": 30.0 * number},
                ],
            }})
        return httpx.Response(404, text="Not Found")

    return handler


def client_factory(handler):
    return lambda: httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_sync_stores_the_overview_and_the_detail_and_a_second_sync_only_fetches_what_is_open(session):
    calls: list[str] = []
    with patch.object(service, "_client", client_factory(fake_api(calls))), patch.object(service, "PAUSE_SECONDS", 0):
        started, _ = await service.begin_sync(session)
        assert started
        counts = await service.run_sync(session)
        assert counts["rounds"] == 4 and counts["details"] == 4

        rounds = await service.list_rounds(session, "cvx-crv")
        assert [r["round"] for r in rounds] == [1, 2, 3]
        assert rounds[2]["total_amount_dollars"] == 3000.0 and rounds[2]["dollar_per_vl"] == pytest.approx(0.03)
        assert rounds[0]["scores_total"] == 40_000_001.0 and rounds[0]["has_detail"] and rounds[0]["bribe_count"] == 3

        detail = await service.round_detail(session, "cvx-crv", 2)
        assert detail["pools"][0]["pool"] == "Pool A" and detail["pools"][0]["dollars"] == 200.0 and detail["pools"][0]["tokens"] == ["CRV", "CVX"]
        assert detail["pools"][0]["votes"] == 30_000_000.0
        assert {t["token"]: t["dollars"] for t in detail["tokens"]} == {"CRV": 180.0, "CVX": 80.0}
        assert await service.round_detail(session, "cvx-crv", 99) is None

        first_detail_calls = len([c for c in calls if c.startswith("/bribes/")])
        # Round 3 ended 6 days ago and the others longer ago, so a second sync only refreshes what is still open.
        calls.clear()
        await service.begin_sync(session)
        again = await service.run_sync(session)
        assert again["details"] <= first_detail_calls
        assert len([c for c in calls if c.startswith("/dashboard/")]) == 3

    breakdown = await service.breakdown(session, "cvx-crv")
    assert {t["token"]: t["total_dollars"] for t in breakdown["tokens"]} == {"CRV": 540.0, "CVX": 240.0}
    assert [r["total_dollars"] for r in breakdown["by_round"]] == [130.0, 260.0, 390.0]
    assert breakdown["top_pools"][0] == {"pool": "Pool A", "total_dollars": 600.0, "rounds": 3, "first_round": 1, "last_round": 3, "best_round_dollars": 300.0}
    assert breakdown["rounds_with_detail"] == 3

    summary = await service.summary(session)
    crv = next(p for p in summary["protocols"] if p["protocol"] == "cvx-crv")
    assert crv["rounds"] == 3 and crv["latest_round"] == 3 and crv["total_dollars_all_time"] == 6000.0
    assert crv["reward_per_dollar_bribe"] == 1.5 and crv["average_dollar_per_vl_12"] == pytest.approx(0.02)
    assert summary["sync"]["state"] == "idle" and summary["has_data"] is True
    assert next(p for p in summary["protocols"] if p["protocol"] == "cvx-prisma")["rounds"] == 0


@pytest.mark.asyncio
async def test_a_failing_source_marks_the_sync_failed_and_keeps_what_was_stored(session):
    calls: list[str] = []
    with patch.object(service, "_client", client_factory(fake_api(calls))), patch.object(service, "PAUSE_SECONDS", 0):
        await service.begin_sync(session)
        await service.run_sync(session)

    def broken(request):
        return httpx.Response(503, text="down")

    with patch.object(service, "_client", client_factory(broken)), patch.object(service, "RETRIES", 1):
        await service.begin_sync(session)
        with pytest.raises(service.VlcvxUnavailable):
            await service.run_sync(session)
    summary = await service.summary(session)
    assert summary["sync"]["state"] == "failed" and "did not answer" in summary["sync"]["error"]
    assert len(await service.list_rounds(session, "cvx-crv")) == 3


@pytest.mark.asyncio
async def test_only_one_sync_runs_at_a_time_and_a_dead_one_is_noticed(session):
    started, row = await service.begin_sync(session)
    assert started
    again, _ = await service.begin_sync(session)
    assert again is False
    row.started_at = datetime.now(timezone.utc) - timedelta(hours=2)
    await session.commit()
    state = await service.sync_state(session)
    assert state.state == "failed"
    assert (await service.begin_sync(session))[0] is True


@pytest.mark.asyncio
async def test_switched_off_when_no_url_is_set(session):
    with patch.object(service, "get_settings") as settings:
        settings.return_value.llama_airforce_url = ""
        with pytest.raises(service.VlcvxUnavailable):
            service._client()
        assert (await service.summary(session))["enabled"] is False


@pytest.mark.asyncio
async def test_api_reads_and_refreshes(client, auth_headers, session):
    calls: list[str] = []
    with patch.object(service, "_client", client_factory(fake_api(calls))), patch.object(service, "PAUSE_SECONDS", 0):
        await service.begin_sync(session)
        await service.run_sync(session)

    summary = await client.get("/api/vlcvx/summary", headers=auth_headers)
    assert summary.status_code == 200 and summary.json()["has_data"] is True
    rounds = await client.get("/api/vlcvx/cvx-crv/rounds", headers=auth_headers)
    assert [r["round"] for r in rounds.json()] == [1, 2, 3]
    one = await client.get("/api/vlcvx/cvx-crv/rounds/3", headers=auth_headers)
    assert one.status_code == 200 and one.json()["pools"][0]["pool"] == "Pool A"
    assert (await client.get("/api/vlcvx/cvx-crv/rounds/99", headers=auth_headers)).status_code == 404
    shape = await client.get("/api/vlcvx/cvx-crv/breakdown", headers=auth_headers)
    assert shape.status_code == 200 and shape.json()["top_pools"][0]["pool"] == "Pool A"
    assert (await client.get("/api/vlcvx/nope/rounds", headers=auth_headers)).status_code == 404
    assert (await client.get("/api/vlcvx/summary")).status_code in (401, 403)

    with patch("app.tasks.vlcvx_tasks.sync_vlcvx") as task:
        started = await client.post("/api/vlcvx/refresh", headers=auth_headers)
        assert started.status_code == 202 and started.json()["state"] == "running"
        task.delay.assert_called_once()
        again = await client.post("/api/vlcvx/refresh", headers=auth_headers)
        assert again.json()["state"] == "running"
        task.delay.assert_called_once()  # already running: not started twice

    assert json.dumps(summary.json())  # serialisable
