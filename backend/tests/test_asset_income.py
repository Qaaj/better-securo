import pytest
from httpx import AsyncClient


def _asset(**extra):
    return {"name": "Rental flat", "type": "real_estate", "currency": "EUR", "current_value": 300000, **extra}


@pytest.mark.asyncio
async def test_a_rental_can_carry_a_fixed_income(client: AsyncClient, auth_headers):
    resp = await client.post(
        "/api/assets",
        json=_asset(income_mode="fixed", income_amount=2100, income_frequency="monthly"),
        headers=auth_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["income_mode"] == "fixed"
    assert body["income_amount"] == 2100
    assert body["income_frequency"] == "monthly"
    assert body["income_rate"] is None


@pytest.mark.asyncio
async def test_a_yield_and_a_sell_percentage_round_trip_and_update(client: AsyncClient, auth_headers):
    created = await client.post(
        "/api/assets",
        json=_asset(name="Dividend stock", type="investment", income_mode="yield", income_rate=3.5,
                    income_frequency="quarterly", sell_percent_per_year=4),
        headers=auth_headers,
    )
    assert created.status_code == 201
    body = created.json()
    assert (body["income_rate"], body["sell_percent_per_year"]) == (3.5, 4)

    updated = await client.patch(
        f"/api/assets/{body['id']}",
        json={"income_rate": 4.25, "sell_percent_per_year": 0},
        headers=auth_headers,
    )
    assert updated.status_code == 200
    assert updated.json()["income_rate"] == 4.25
    assert updated.json()["sell_percent_per_year"] == 0

    listed = (await client.get("/api/assets", headers=auth_headers)).json()
    assert next(a for a in listed if a["id"] == body["id"])["income_mode"] == "yield"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [
        {"income_mode": "yield"},
        {"income_mode": "fixed", "income_amount": 100},
        {"income_mode": "fixed", "income_frequency": "monthly"},
        {"income_mode": "bogus"},
        {"income_rate": 120},
        {"income_frequency": "daily"},
    ],
)
async def test_incomplete_or_invalid_income_is_rejected(client: AsyncClient, auth_headers, extra):
    resp = await client.post("/api/assets", json=_asset(**extra), headers=auth_headers)
    assert resp.status_code == 422
