"""Run the retirement engine on the server.

The projection and the stress test are TypeScript, written for the Retirement page. They are bundled into
`app/engine/retirement_engine.js` (see scripts/build-engine.sh) and run here with an embedded JavaScript
engine, so a question asked through the MCP server gets the same answer as the page, from one copy of the
logic. This module builds the request (plan, recurring items, assets) from the database and runs it.
"""
from __future__ import annotations

import asyncio
import copy
import json
import threading
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.recurring_transaction import RecurringTransaction
from app.models.retirement_state import RetirementState
from app.models.user import User
from app.services import asset_service
from app.services.fx_rate_service import convert

BUNDLE = Path(__file__).resolve().parents[1] / "engine" / "retirement_engine.js"
PLAN_KEY = "retirement:plan"
SCENARIOS_KEY = "retirement:scenarios"
EXCLUDED_KEY = "retirement:excluded-income"
RUN_TIMEOUT_MS = 90_000

# What a saved plan must have for the page to read it back (the page merges one level deep).
DEFAULT_PLAN: dict[str, Any] = {
    "flat": [],
    "assumptions": {"horizonYears": 30, "inflationPercent": 2, "incomeIndexed": True, "drawdownStartYear": 0, "sellStrategy": "pro_rata"},
    "drawable": {}, "growth": {}, "sellOrder": {}, "tempAssets": [], "whatIfs": [], "lineEnd": {}, "taxFree": {}, "taxRates": {},
}

# Override name -> where it lands in a plan's assumptions.
ASSUMPTION_OVERRIDES = {
    "horizonYears": "horizonYears", "inflationPercent": "inflationPercent", "incomeIndexed": "incomeIndexed",
    "drawdownStartYear": "drawdownStartYear", "drawdownEndYear": "drawdownEndYear", "sellStrategy": "sellStrategy",
    "taxIncomePercent": "taxIncomePercent", "taxYieldPercent": "taxAssetIncomePercent", "taxRentPercent": "taxRentPercent",
    "taxGainsPercent": "taxGainsPercent", "bufferYears": "bufferYears",
}


class EngineUnavailable(Exception):
    """The engine bundle or the embedded JavaScript engine is not there."""


_lock = threading.Lock()
_context: Any = None


def _load() -> Any:
    global _context
    if _context is None:
        try:
            from py_mini_racer import MiniRacer
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise EngineUnavailable("The embedded JavaScript engine (mini-racer) is not installed.") from exc
        if not BUNDLE.exists():
            raise EngineUnavailable("The retirement engine bundle is missing; run scripts/build-engine.sh.")
        ctx = MiniRacer()
        ctx.eval(BUNDLE.read_text(encoding="utf-8"))
        _context = ctx
    return _context


def _run_sync(payload: str) -> str:
    with _lock:
        return _load().call("RetirementEngine.run", payload, timeout=RUN_TIMEOUT_MS)


async def run(request: dict[str, Any]) -> dict[str, Any]:
    """Run one engine request and return its answer (or {'error': ...})."""
    answer = await asyncio.to_thread(_run_sync, json.dumps(request, default=str))
    return json.loads(answer)


def apply_overrides(plan: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """The same changes the engine makes for one run, written into a plan that is to be saved."""
    out = copy.deepcopy(DEFAULT_PLAN)
    out.update(copy.deepcopy(plan or {}))
    out["assumptions"] = {**DEFAULT_PLAN["assumptions"], **(out.get("assumptions") or {})}
    for name, target in ASSUMPTION_OVERRIDES.items():
        if name in overrides:
            if overrides[name] is None:
                out["assumptions"].pop(target, None)
            else:
                out["assumptions"][target] = overrides[name]
    if "livingMonthly" in overrides or "livingInflates" in overrides:
        living = out.get("living") or {"monthly": 0, "inflates": True}
        out["living"] = {"monthly": overrides.get("livingMonthly", living["monthly"]), "inflates": overrides.get("livingInflates", living["inflates"])}
    for i, what_if in enumerate(overrides.get("addWhatIfs") or []):
        out["whatIfs"].append({"id": what_if.get("id") or f"mcp-{uuid.uuid4().hex[:8]}-{i}", **{k: v for k, v in what_if.items() if k != "id"}})
    return out


async def load_state(session: AsyncSession, workspace_id: uuid.UUID) -> dict[str, Any]:
    state = await session.get(RetirementState, workspace_id)
    return copy.deepcopy(state.data) if state and state.data else {}


async def save_state(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, data: dict[str, Any]) -> None:
    state = await session.get(RetirementState, workspace_id)
    if state is None:
        session.add(RetirementState(workspace_id=workspace_id, data=data, updated_by_user_id=user_id))
    else:
        state.data = data
        state.updated_by_user_id = user_id
    await session.commit()


async def build_request(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    op: str,
    *,
    scenario: Optional[str] = None,
    overrides: Optional[dict[str, Any]] = None,
    **extra: Any,
) -> dict[str, Any]:
    """Everything the engine needs for one question, read from the workspace."""
    user = await session.get(User, user_id)
    currency = user.primary_currency if user else "USD"
    state = await load_state(session, workspace_id)
    scenarios = state.get(SCENARIOS_KEY) or {}
    if scenario and scenario not in scenarios:
        raise KeyError(scenario)
    plan = scenarios[scenario] if scenario else (state.get(PLAN_KEY) or {})

    rows = (
        await session.execute(select(RecurringTransaction).where(RecurringTransaction.workspace_id == workspace_id))
    ).scalars().all()
    items = [
        {
            "id": str(r.id), "description": r.description, "amount": float(r.amount), "currency": r.currency, "type": r.type, "frequency": r.frequency,
            "is_active": bool(r.is_active), "amount_primary": float(r.amount_primary) if r.amount_primary is not None else None,
        }
        for r in rows
    ]
    assets = await asset_service.get_assets(session, workspace_id)
    for asset in assets:
        if asset.currency != currency and asset.current_value is not None:
            converted, _ = await convert(session, Decimal(str(asset.current_value)), asset.currency, currency)
            asset.current_value_primary = float(converted)
    return {
        "op": op,
        "currency": currency,
        "thisYear": app_today().year,
        "items": items,
        "assets": [a.model_dump(mode="json") for a in assets],
        "excluded": [str(x) for x in state.get(EXCLUDED_KEY) or []],
        "plan": plan,
        "overrides": overrides or {},
        "scenarios": scenarios,
        **extra,
    }
