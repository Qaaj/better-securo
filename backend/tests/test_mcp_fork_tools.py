"""The MCP tools for what this fork adds, called directly with seeded data."""
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
import pytest_asyncio

import mcp_server.tools  # noqa: F401  (registers the tools)
from app.models.asset import Asset
from app.models.categorization import CategorizationJob
from app.models.retirement_state import RetirementState
from app.models.transaction import Transaction
from app.schemas.asset_contract import ContractCreate
from app.schemas.recurring_transaction import RecurringTransactionCreate
from app.services import asset_contract_service
from app.services.recurring_transaction_service import create_recurring_transaction
from mcp_server.auth import CallContext
from mcp_server.registry import REGISTRY

READ = ["get_monthly_review", "get_asset", "list_contracts", "find_recurring_matches", "get_recurring_history", "get_retirement_plan", "get_categorization_status"]
PROPOSE = ["propose_link_recurring_match", "propose_create_recurring_from_series", "propose_dismiss_recurring_suggestion", "propose_create_asset_contract", "propose_update_asset_details"]


@pytest_asyncio.fixture
async def ctx(test_user) -> CallContext:
    return CallContext(user_id=test_user.id, conversation_id=uuid.uuid4())


@pytest_asyncio.fixture
async def external(test_user) -> CallContext:
    return CallContext(user_id=test_user.id, external=True)


def call(name):
    return REGISTRY[name].handler


def test_the_tools_are_registered_and_the_writes_are_proposals():
    for name in READ:
        assert name in REGISTRY and not REGISTRY[name].is_proposal
    for name in PROPOSE:
        assert name in REGISTRY and REGISTRY[name].is_proposal
        assert "apply" in REGISTRY[name].parameters["properties"]


async def _asset(session, user, workspace, name="House", **extra):
    asset = Asset(id=uuid.uuid4(), user_id=user.id, workspace_id=workspace.id, name=name, type="real_estate", currency="BRL", valuation_method="manual", **extra)
    session.add(asset)
    await session.commit()
    return asset


async def _recurring(session, user, workspace, account, description="Electricity", amount="85.00"):
    return await create_recurring_transaction(
        session, workspace.id, user.id,
        RecurringTransactionCreate(description=description, amount=Decimal(amount), currency="BRL", type="debit", frequency="monthly", start_date=date(2026, 1, 5), account_id=account.id),
    )


def recent(day: int, months: int = 5) -> date:
    """A start date so that `months` monthly charges run up to about now, which keeps the series active."""
    today = date.today()
    index = today.year * 12 + today.month - 1 - (months - 1)
    return date(index // 12, index % 12 + 1, day)


async def _series(session, user, workspace, account, description, amount, start, n):
    rows = []
    for i in range(n):
        index = start.year * 12 + start.month - 1 + i
        day = date(index // 12, index % 12 + 1, start.day)
        tx = Transaction(user_id=user.id, workspace_id=workspace.id, account_id=account.id, description=description, amount=Decimal(str(amount)), currency="BRL", date=day, type="debit", source="import", status="posted")
        session.add(tx)
        rows.append(tx)
    await session.commit()
    return rows


@pytest.mark.asyncio
async def test_asset_and_contract_tools(session, ctx, test_user, test_workspace, test_account):
    asset = await _asset(session, test_user, test_workspace, address="1 Example Street", details={"Floor area": 120}, notes="Roof redone")
    rt = await _recurring(session, test_user, test_workspace, test_account)
    today = date.today()
    await asset_contract_service.create_contract(session, asset.id, test_workspace.id, ContractCreate(kind="energy", provider="Power Co", end_date=today + timedelta(days=45), notice_days=20, recurring_id=rt.id).model_dump())
    await asset_contract_service.create_contract(session, asset.id, test_workspace.id, ContractCreate(kind="internet", provider="Net Co", end_date=today - timedelta(days=5)).model_dump())
    await asset_contract_service.create_contract(session, asset.id, test_workspace.id, ContractCreate(kind="water", provider="Water Co").model_dump())

    full = await call("get_asset")(session=session, ctx=ctx, asset_id=str(asset.id))
    assert full["asset"]["address"] == "1 Example Street" and full["asset"]["details"] == {"Floor area": 120}
    statuses = {c["provider"]: c["status"] for c in full["contracts"]}
    assert statuses == {"Power Co": "notice_due_soon", "Net Co": "ended", "Water Co": "open_ended"}
    assert full["running_costs"]["contracts_with_cost"] == 1 and full["running_costs"]["contracts_without_cost"] == 2
    assert full["running_costs"]["per_year"] == pytest.approx(85 * 12)
    assert (await call("get_asset")(session=session, ctx=ctx, asset_id=str(uuid.uuid4())))["error"] == "asset not found"

    everything = await call("list_contracts")(session=session, ctx=ctx)
    assert everything["total"] == 3 and everything["items"][0]["asset_name"] == "House"
    attention = await call("list_contracts")(session=session, ctx=ctx, needs_attention=True)
    assert sorted(i["provider"] for i in attention["items"]) == ["Net Co", "Power Co"]
    only_water = await call("list_contracts")(session=session, ctx=ctx, kind="water")
    assert [i["provider"] for i in only_water["items"]] == ["Water Co"]


@pytest.mark.asyncio
async def test_recurring_finder_tools_and_their_proposals(session, ctx, external, test_user, test_workspace, test_account):
    rt = await _recurring(session, test_user, test_workspace, test_account, "Syndic", "126.00")
    await _series(session, test_user, test_workspace, test_account, "ACP Building", "126.00", recent(2, 6), 6)
    await _series(session, test_user, test_workspace, test_account, "Meal Box", "34.50", recent(2, 5), 5)

    found = await call("find_recurring_matches")(session=session, ctx=ctx)
    assert [m["recurring_id"] for m in found["matches"]] == [str(rt.id)]
    assert [n["name"] for n in found["new"]] == ["Meal Box"]
    only_new = await call("find_recurring_matches")(session=session, ctx=ctx, include="new")
    assert "matches" not in only_new

    match_key = found["matches"][0]["series_key"]
    preview = await call("propose_link_recurring_match")(session=session, ctx=ctx, recurring_id=str(rt.id), series_key=match_key, apply=True)
    # An internal caller never writes, even with apply set.
    assert preview["kind"] == "link_recurring_series" and "applied" not in preview
    assert (await call("find_recurring_matches")(session=session, ctx=ctx))["matches"]
    applied = await call("propose_link_recurring_match")(session=session, ctx=external, recurring_id=str(rt.id), series_key=match_key, apply=True)
    assert applied["applied"] is True
    history = await call("get_recurring_history")(session=session, ctx=ctx, recurring_id=str(rt.id))
    assert history["count"] == 6

    new_key = found["new"][0]["series_key"]
    create_preview = await call("propose_create_recurring_from_series")(session=session, ctx=ctx, series_key=new_key, description="Meal box subscription")
    assert create_preview["proposed"]["description"] == "Meal box subscription" and create_preview["proposed"]["frequency"] == "monthly"
    created = await call("propose_create_recurring_from_series")(session=session, ctx=external, series_key=new_key, apply=True)
    assert created["applied"] is True and created["id"]
    assert (await call("find_recurring_matches")(session=session, ctx=ctx))["new"] == []

    assert (await call("propose_link_recurring_match")(session=session, ctx=ctx, recurring_id=str(rt.id), series_key="nope"))["error"].startswith("series not found")
    assert (await call("get_recurring_history")(session=session, ctx=ctx, recurring_id=str(uuid.uuid4())))["error"] == "recurring item not found"


@pytest.mark.asyncio
async def test_dismissing_through_the_tool_hides_the_series(session, ctx, external, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Dog Walker", "120.00", recent(2, 5), 5)
    key = (await call("find_recurring_matches")(session=session, ctx=ctx))["new"][0]["series_key"]
    assert (await call("propose_dismiss_recurring_suggestion")(session=session, ctx=ctx, series_key=key))["dismiss"] == "series"
    await call("propose_dismiss_recurring_suggestion")(session=session, ctx=external, series_key=key, apply=True)
    assert (await call("find_recurring_matches")(session=session, ctx=ctx))["new"] == []


@pytest.mark.asyncio
async def test_contract_and_asset_proposals(session, ctx, external, test_user, test_workspace):
    asset = await _asset(session, test_user, test_workspace, details={"Floor area": 120, "Heating": "Gas"})
    preview = await call("propose_create_asset_contract")(session=session, ctx=ctx, asset_id=str(asset.id), kind="insurance", provider="Safe Co", end_date="2027-03-01", notice_days=60)
    assert preview["kind"] == "create_asset_contract" and preview["proposed"]["provider"] == "Safe Co"
    assert await asset_contract_service.list_contracts(session, asset.id, test_workspace.id) == []
    done = await call("propose_create_asset_contract")(session=session, ctx=external, asset_id=str(asset.id), kind="insurance", provider="Safe Co", apply=True)
    assert done["applied"] is True
    assert len(await asset_contract_service.list_contracts(session, asset.id, test_workspace.id)) == 1
    bad = await call("propose_create_asset_contract")(session=session, ctx=ctx, asset_id=str(asset.id), kind="insurance", provider="X", recurring_id=str(uuid.uuid4()), apply=False)
    assert bad["kind"] == "create_asset_contract"

    change = await call("propose_update_asset_details")(session=session, ctx=ctx, asset_id=str(asset.id), details={"Heating": None, "Energy label": "B"}, notes="New note")
    assert change["changes"]["details"] == {"Floor area": 120, "Energy label": "B"} and change["current"]["notes"] is None
    await call("propose_update_asset_details")(session=session, ctx=external, asset_id=str(asset.id), details={"Heating": None, "Energy label": "B"}, notes="New note", apply=True)
    await session.refresh(asset)
    assert asset.details == {"Floor area": 120, "Energy label": "B"} and asset.notes == "New note"
    assert (await call("propose_update_asset_details")(session=session, ctx=ctx, asset_id=str(asset.id)))["error"] == "no changes provided"


@pytest.mark.asyncio
async def test_retirement_plan_and_categorizer_tools(session, ctx, test_user, test_workspace):
    assert (await call("get_retirement_plan")(session=session, ctx=ctx))["plan"] is None
    asset = await _asset(session, test_user, test_workspace, name="Index fund")
    session.add(RetirementState(workspace_id=test_workspace.id, data={
        "retirement:plan": {"assumptions": {"horizonYears": 30}, "living": {"monthly": 2000, "inflates": True}},
        "retirement:scenarios": {"Lean": {"living": {"monthly": 1500, "inflates": True}}},
        "retirement:summary": {"runwayYears": None, "totalTax": 1234},
    }))
    await session.commit()
    plan = await call("get_retirement_plan")(session=session, ctx=ctx)
    assert plan["plan"]["living"]["monthly"] == 2000 and plan["scenarios"] == ["Lean"]
    assert plan["asset_names"][str(asset.id)] == "Index fund"
    assert plan["latest_results"]["retirement:summary"]["totalTax"] == 1234
    lean = await call("get_retirement_plan")(session=session, ctx=ctx, scenario="Lean")
    assert lean["plan"]["living"]["monthly"] == 1500
    assert (await call("get_retirement_plan")(session=session, ctx=ctx, scenario="Nope"))["scenarios"] == ["Lean"]

    assert (await call("get_categorization_status")(session=session, ctx=ctx))["job"] is None
    session.add(CategorizationJob(user_id=test_user.id, workspace_id=test_workspace.id, status="completed", base_url="x", model="m", total_merchants=3, processed_merchants=3))
    await session.commit()
    status = await call("get_categorization_status")(session=session, ctx=ctx)
    assert status["job"]["status"] == "completed" and status["suggestions"]["pending"] == 0


@pytest.mark.asyncio
async def test_monthly_review_tool(session, ctx, test_user, test_workspace, test_account):
    await _series(session, test_user, test_workspace, test_account, "Corner Cafe", "12.50", date(2026, 5, 3), 1)
    review = await call("get_monthly_review")(session=session, ctx=ctx, month="2026-05-15")
    assert review["month"].startswith("2026-05") and "insights" in review and "categories" in review
