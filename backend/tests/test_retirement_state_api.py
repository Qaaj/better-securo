import pytest


@pytest.mark.asyncio
async def test_state_starts_empty_and_round_trips(client, auth_headers, test_workspace):
    empty = await client.get("/api/retirement/state", headers=auth_headers)
    assert empty.status_code == 200
    assert empty.json()["data"] == {}

    payload = {"data": {"retirement:plan": {"assumptions": {"horizonYears": 25}}, "retirement:scenarios": {"A": {}}}}
    saved = await client.put("/api/retirement/state", json=payload, headers=auth_headers)
    assert saved.status_code == 200
    assert saved.json()["updated_at"] is not None

    loaded = await client.get("/api/retirement/state", headers=auth_headers)
    assert loaded.json()["data"] == payload["data"]

    # A second save replaces the document.
    await client.put("/api/retirement/state", json={"data": {"retirement:plan": {}}}, headers=auth_headers)
    assert (await client.get("/api/retirement/state", headers=auth_headers)).json()["data"] == {"retirement:plan": {}}


@pytest.mark.asyncio
async def test_state_rejects_foreign_keys_and_needs_login(client, auth_headers, test_workspace):
    bad = await client.put("/api/retirement/state", json={"data": {"other": 1}}, headers=auth_headers)
    assert bad.status_code == 422
    assert (await client.get("/api/retirement/state")).status_code in (401, 403)
