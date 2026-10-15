"""The retirement engine on the server, and the MCP tools built on it."""
import hashlib
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio

pytest.importorskip("py_mini_racer")

import mcp_server.tools  # noqa: E402,F401
from app.models.retirement_state import RetirementState  # noqa: E402
from app.schemas.asset import AssetCreate  # noqa: E402
from app.schemas.recurring_transaction import RecurringTransactionCreate  # noqa: E402
from app.services import asset_service, retirement_engine_service as engine  # noqa: E402
from app.services.recurring_transaction_service import create_recurring_transaction  # noqa: E402
from mcp_server.auth import CallContext  # noqa: E402
from mcp_server.registry import REGISTRY  # noqa: E402

TOOLS = ["run_retirement_projection", "run_stress_test", "compare_retirement_scenarios"]
PROPOSALS = ["propose_update_retirement_plan", "propose_save_retirement_scenario"]


def call(name):
    return REGISTRY[name].handler


@pytest_asyncio.fixture
async def ctx(test_user) -> CallContext:
    return CallContext(user_id=test_user.id)


@pytest_asyncio.fixture
async def external(test_user) -> CallContext:
    return CallContext(user_id=test_user.id, external=True)


@pytest_asyncio.fixture
async def world(session, test_user, test_workspace, test_account):
    """A fund worth 120,000 and a recurring cost of 500 a month, in the user's own currency."""
    currency = test_user.primary_currency
    await asset_service.create_asset(session, test_workspace.id, test_user.id, AssetCreate(name="Fund", type="investment", currency=currency, current_value=Decimal("120000")))
    await create_recurring_transaction(
        session, test_workspace.id, test_user.id,
        RecurringTransactionCreate(description="Rent", amount=Decimal("500"), currency=currency, type="debit", frequency="monthly", start_date=date(2026, 1, 5), account_id=test_account.id),
    )
    session.add(RetirementState(workspace_id=test_workspace.id, data={
        "retirement:plan": {"assumptions": {"horizonYears": 30, "inflationPercent": 0, "incomeIndexed": True}},
        "retirement:scenarios": {"Lean": {"assumptions": {"horizonYears": 30, "inflationPercent": 0, "incomeIndexed": True}, "living": {"monthly": 100, "inflates": True}}},
    }))
    await session.commit()


def test_the_tools_are_registered():
    for name in TOOLS:
        assert name in REGISTRY and not REGISTRY[name].is_proposal
    for name in PROPOSALS:
        assert name in REGISTRY and REGISTRY[name].is_proposal and "apply" in REGISTRY[name].parameters["properties"]


def test_the_backend_copy_of_the_bundle_matches_its_recorded_hash():
    folder = Path(engine.BUNDLE).parent
    recorded = (folder / "retirement_engine.sha256").read_text().strip()
    assert hashlib.sha256(Path(engine.BUNDLE).read_bytes()).hexdigest() == recorded, "run scripts/build-engine.sh"


@pytest.mark.asyncio
async def test_projection_uses_the_workspace_and_changes_for_one_run_only(session, ctx, world):
    plain = await call("run_retirement_projection")(session=session, ctx=ctx)
    assert plain["summary"]["runwayYears"] == 20.0
    assert len(plain["years"]) == 30 and plain["years"][0]["soldTotal"] == 6000
    tighter = await call("run_retirement_projection")(session=session, ctx=ctx, living_monthly=500, include_years=False)
    assert tighter["summary"]["runwayYears"] == 10.0 and "years" not in tighter
    again = await call("run_retirement_projection")(session=session, ctx=ctx)
    assert again["summary"]["runwayYears"] == 20.0  # nothing was saved
    lean = await call("run_retirement_projection")(session=session, ctx=ctx, scenario="Lean")
    assert lean["summary"]["runwayYears"] == pytest.approx(120000 / 7200, abs=0.1)
    assert (await call("run_retirement_projection")(session=session, ctx=ctx, scenario="Nope"))["scenarios"] == ["Lean"]


@pytest.mark.asyncio
async def test_stress_test_and_comparison(session, ctx, world):
    stress = await call("run_stress_test")(session=session, ctx=ctx, futures=300, seed=5, include_grid=True)
    assert stress["futures"] == 300 and 0 <= stress["chanceTheMoneyLasts"] <= 1
    assert len(stress["assetsYouSellFromByYear"]) == 30 and len(stress["resilienceGrid"]) == 30
    harsher = await call("run_stress_test")(session=session, ctx=ctx, futures=300, seed=5, growth_rates_include_crashes=False, crash_chance_percent=25)
    assert harsher["chanceTheMoneyLasts"] <= stress["chanceTheMoneyLasts"]

    table = await call("compare_retirement_scenarios")(session=session, ctx=ctx)
    assert [r["scenario"] for r in table["scenarios"]] == ["Current plan", "Lean"]
    assert table["scenarios"][1]["runwayYears"] < table["scenarios"][0]["runwayYears"]
    only = await call("compare_retirement_scenarios")(session=session, ctx=ctx, scenarios=["Lean", "Ghost"], with_stress_test=True)
    assert only["missing"] == ["Ghost"] and "stressTest" in only["scenarios"][1]


@pytest.mark.asyncio
async def test_updating_the_plan_previews_then_applies_only_for_an_external_client(session, ctx, external, test_workspace, world):
    preview = await call("propose_update_retirement_plan")(session=session, ctx=ctx, living_monthly=400, inflation_percent=1.5, apply=True)
    assert preview["kind"] == "update_retirement_plan" and "applied" not in preview
    assert preview["changes"]["living"]["to"] == {"monthly": 400, "inflates": True}
    assert (await call("propose_update_retirement_plan")(session=session, ctx=ctx))["error"] == "no changes provided"

    done = await call("propose_update_retirement_plan")(session=session, ctx=external, living_monthly=400, inflation_percent=1.5, apply=True)
    assert done["applied"] is True
    state = await session.get(RetirementState, test_workspace.id)
    saved = state.data["retirement:plan"]
    assert saved["living"]["monthly"] == 400 and saved["assumptions"]["inflationPercent"] == 1.5
    # What the page needs to read it back is there.
    assert {"flat", "drawable", "tempAssets", "whatIfs"} <= set(saved) and saved["assumptions"]["horizonYears"] == 30
    # Saved settings give the same answer as the same settings passed as overrides.
    saved_run = await call("run_retirement_projection")(session=session, ctx=ctx, include_years=False)
    state.data = {**state.data, "retirement:plan": {"assumptions": {"horizonYears": 30, "inflationPercent": 0, "incomeIndexed": True}}}
    await session.commit()
    override_run = await call("run_retirement_projection")(session=session, ctx=ctx, living_monthly=400, inflation_percent=1.5, include_years=False)
    assert saved_run["summary"] == override_run["summary"]


@pytest.mark.asyncio
async def test_saving_a_scenario_leaves_the_plan_alone(session, ctx, external, test_workspace, world):
    preview = await call("propose_save_retirement_scenario")(session=session, ctx=ctx, name="Travel", living_monthly=900)
    assert preview["kind"] == "save_retirement_scenario" and preview["replaces_existing"] is False
    await call("propose_save_retirement_scenario")(
        session=session, ctx=external, name="Travel", from_scenario="Lean", living_monthly=900,
        add_what_ifs=[{"kind": "oneoff", "label": "Roof", "amount": -5000, "year": 3}], apply=True,
    )
    data = (await session.get(RetirementState, test_workspace.id)).data
    assert set(data["retirement:scenarios"]) == {"Lean", "Travel"}
    travel = data["retirement:scenarios"]["Travel"]
    assert travel["living"]["monthly"] == 900 and travel["whatIfs"][0]["label"] == "Roof" and travel["whatIfs"][0]["id"]
    assert "living" not in data["retirement:plan"]
    assert (await call("propose_save_retirement_scenario")(session=session, ctx=ctx, name="X", from_scenario="Ghost"))["scenarios"] == ["Lean", "Travel"]
    assert uuid.UUID(str(test_workspace.id))
