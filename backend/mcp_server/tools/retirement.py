"""Retirement planning tools: run the projection and the stress test, compare scenarios, and change the saved plan.

The calculations are the Retirement page's own (see app/services/retirement_engine_service.py). Changes follow the
propose pattern: a preview first, and a change only when an external client repeats the call with `apply=true`.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import retirement_engine_service as engine
from mcp_server.auth import CallContext
from mcp_server.registry import tool
from mcp_server.tools._helpers import resolve_workspace_id
from mcp_server.tools.proposals import _APPLY_FIELD, _PROPOSAL_PREFACE, _can_apply

_WHAT_IF = {
    "type": "object",
    "description": (
        "A what-if in the plan's shape. kind 'expense' or 'income': monthly, fromYear (0 = this year), optional toYear and inflates. "
        "kind 'oneoff': amount (negative is a cost), year. kind 'spend': monthly, fromYear (replaces the recurring costs from then on)."
    ),
    "properties": {
        "kind": {"type": "string", "enum": ["expense", "income", "oneoff", "spend"]},
        "label": {"type": "string"}, "monthly": {"type": "number"}, "amount": {"type": "number"},
        "fromYear": {"type": "integer", "minimum": 0}, "toYear": {"type": "integer", "minimum": 0}, "year": {"type": "integer", "minimum": 0},
        "inflates": {"type": "boolean"},
    },
    "required": ["kind", "label"],
}

_OVERRIDE_PROPERTIES: dict[str, Any] = {
    "living_monthly": {"type": "number", "minimum": 0, "description": "Living and travel a month, in today's money"},
    "living_inflates": {"type": "boolean"},
    "horizon_years": {"type": "integer", "minimum": 5, "maximum": 60},
    "inflation_percent": {"type": "number", "minimum": 0, "maximum": 20},
    "income_indexed": {"type": "boolean", "description": "Income rises with inflation like costs do"},
    "drawdown_start_year": {"type": "integer", "minimum": 0, "description": "First year (0 = this year) a shortfall is met by selling assets"},
    "drawdown_end_year": {"type": ["integer", "null"], "minimum": 0},
    "sell_strategy": {"type": "string", "enum": ["pro_rata", "ordered"]},
    "tax_income_percent": {"type": "number", "minimum": 0, "maximum": 80},
    "tax_yield_percent": {"type": "number", "minimum": 0, "maximum": 80},
    "tax_rent_percent": {"type": "number", "minimum": 0, "maximum": 80},
    "tax_gains_percent": {"type": "number", "minimum": 0, "maximum": 80},
    "buffer_years": {"type": "number", "minimum": 0, "maximum": 10, "description": "Years of costs held in cash"},
    "add_what_ifs": {"type": "array", "items": _WHAT_IF},
}
_CAMEL = {
    "living_monthly": "livingMonthly", "living_inflates": "livingInflates", "horizon_years": "horizonYears", "inflation_percent": "inflationPercent",
    "income_indexed": "incomeIndexed", "drawdown_start_year": "drawdownStartYear", "drawdown_end_year": "drawdownEndYear", "sell_strategy": "sellStrategy",
    "tax_income_percent": "taxIncomePercent", "tax_yield_percent": "taxYieldPercent", "tax_rent_percent": "taxRentPercent",
    "tax_gains_percent": "taxGainsPercent", "buffer_years": "bufferYears", "add_what_ifs": "addWhatIfs",
}
_SCENARIO = {"type": "string", "description": "Name of a saved scenario to start from; omit for the current plan"}


def _overrides(kwargs: dict[str, Any]) -> dict[str, Any]:
    return {_CAMEL[k]: v for k, v in kwargs.items() if k in _CAMEL and v is not None or (k == "drawdown_end_year" and k in kwargs)}


def _unknown(name: str, state: dict) -> dict[str, Any]:
    return {"error": f"no saved scenario named '{name}'", "scenarios": sorted(state.get(engine.SCENARIOS_KEY) or {})}


async def _request(session: AsyncSession, ctx: CallContext, op: str, scenario: str | None, overrides: dict, **extra: Any) -> tuple[dict | None, dict | None]:
    ws_id = await resolve_workspace_id(session, ctx)
    try:
        return await engine.build_request(session, ws_id, ctx.user_id, op, scenario=scenario, overrides=overrides, **extra), None
    except KeyError:
        return None, _unknown(scenario or "", await engine.load_state(session, ws_id))


async def _run(request: dict) -> dict[str, Any]:
    try:
        return await engine.run(request)
    except engine.EngineUnavailable as exc:
        return {"error": str(exc)}


@tool(
    name="run_retirement_projection",
    description=(
        "Run the retirement projection now, with today's assets and recurring items and the saved plan (or a saved scenario), "
        "optionally changing settings for this run only: living and travel, inflation, when selling starts, tax rates, a cash "
        "buffer, extra what-ifs. Returns the runway (how long the assets you sell from last), tax paid, what is left at the end, "
        "the assets and a year-by-year table with what is sold from each asset. Nothing is saved; use the propose_* tools for that."
    ),
    parameters={
        "type": "object",
        "properties": {"scenario": _SCENARIO, **_OVERRIDE_PROPERTIES, "include_years": {"type": "boolean", "default": True}},
        "additionalProperties": False,
    },
    tags=["read", "retirement"],
)
async def run_retirement_projection(*, session: AsyncSession, ctx: CallContext, scenario: str | None = None, include_years: bool = True, **overrides: Any) -> dict[str, Any]:
    request, error = await _request(session, ctx, "projection", scenario, _overrides(overrides))
    if error:
        return error
    answer = await _run(request)
    if not include_years:
        answer.pop("years", None)
    return answer


@tool(
    name="run_stress_test",
    description=(
        "Run the retirement stress test (Monte Carlo): many random futures with market crashes, slumps after them and uneven "
        "inflation, through the same plan. Returns the chance the money lasts the whole horizon, a typical and a bad-luck "
        "outcome, percentile bands by year and the share of futures run out by each year. Optionally the resilience grid (chance "
        "by spending level and crash frequency) and the cash buffer comparison. Plan settings can be changed for this run only."
    ),
    parameters={
        "type": "object",
        "properties": {
            "scenario": _SCENARIO,
            **_OVERRIDE_PROPERTIES,
            "futures": {"type": "integer", "minimum": 100, "maximum": 5000, "default": 1000},
            "seed": {"type": "integer", "minimum": 0},
            "crash_chance_percent": {"type": "number", "minimum": 0, "maximum": 50, "description": "Chance of a crash in any year"},
            "crash_min_percent": {"type": "number", "minimum": 5, "maximum": 90},
            "crash_max_percent": {"type": "number", "minimum": 5, "maximum": 90},
            "volatility_scale": {"type": "number", "minimum": 0, "maximum": 3},
            "growth_rates_include_crashes": {"type": "boolean", "default": True},
            "todays_money": {"type": "boolean", "default": True},
            "include_grid": {"type": "boolean", "default": False},
            "include_buffer_comparison": {"type": "boolean", "default": False},
        },
        "additionalProperties": False,
    },
    tags=["read", "retirement"],
)
async def run_stress_test(
    *, session: AsyncSession, ctx: CallContext, scenario: str | None = None, futures: int = 1000, seed: int | None = None,
    crash_chance_percent: float | None = None, crash_min_percent: float | None = None, crash_max_percent: float | None = None,
    volatility_scale: float | None = None, growth_rates_include_crashes: bool = True, todays_money: bool = True,
    include_grid: bool = False, include_buffer_comparison: bool = False, **overrides: Any,
) -> dict[str, Any]:
    sim: dict[str, Any] = {"runs": futures, "rateIncludesCrashes": growth_rates_include_crashes, "todaysMoney": todays_money}
    for key, value in (("seed", seed), ("crashChancePercent", crash_chance_percent), ("crashMinPercent", crash_min_percent), ("crashMaxPercent", crash_max_percent), ("volatilityScale", volatility_scale)):
        if value is not None:
            sim[key] = value
    request, error = await _request(session, ctx, "stress", scenario, _overrides(overrides), sim=sim, includeGrid=include_grid, includeBuffers=include_buffer_comparison)
    if error:
        return error
    return await _run(request)


@tool(
    name="compare_retirement_scenarios",
    description=(
        "Line up the current plan and saved scenarios side by side: living costs, when selling starts, runway, tax paid and what "
        "is left at the end. With with_stress_test, also the chance the money lasts for each (slower)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "scenarios": {"type": "array", "items": {"type": "string"}, "description": "Saved scenario names; omit for all of them"},
            "with_stress_test": {"type": "boolean", "default": False},
        },
        "additionalProperties": False,
    },
    tags=["read", "retirement"],
)
async def compare_retirement_scenarios(*, session: AsyncSession, ctx: CallContext, scenarios: list[str] | None = None, with_stress_test: bool = False) -> dict[str, Any]:
    request, error = await _request(session, ctx, "compare", None, {}, names=scenarios or [], withStress=with_stress_test)
    if error:
        return error
    return await _run(request)


async def _preview_change(session: AsyncSession, ctx: CallContext, overrides: dict, scenario_from: str | None):
    ws_id = await resolve_workspace_id(session, ctx)
    state = await engine.load_state(session, ws_id)
    scenarios = state.get(engine.SCENARIOS_KEY) or {}
    if scenario_from and scenario_from not in scenarios:
        return ws_id, state, None, None, _unknown(scenario_from, state)
    current = scenarios[scenario_from] if scenario_from else (state.get(engine.PLAN_KEY) or {})
    updated = engine.apply_overrides(current, overrides)
    return ws_id, state, current, updated, None


def _diff(before: dict, after: dict) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    for key in ("assumptions", "living", "whatIfs"):
        if before.get(key) != after.get(key):
            changes[key] = {"from": before.get(key), "to": after.get(key)}
    return changes


@tool(
    name="propose_update_retirement_plan",
    description=_PROPOSAL_PREFACE
    + (
        "Preview changing the saved retirement plan (the one the Retirement page shows): living and travel, inflation, when selling "
        "starts, tax rates, a cash buffer, extra what-ifs. Use run_retirement_projection first to see what a change would do. "
        "Applying saves it; the page shows it the next time it is opened."
    ),
    parameters={"type": "object", "properties": {**_OVERRIDE_PROPERTIES, "apply": _APPLY_FIELD}, "additionalProperties": False},
    is_proposal=True,
    tags=["propose", "retirement"],
)
async def propose_update_retirement_plan(*, session: AsyncSession, ctx: CallContext, apply: bool = False, **overrides: Any) -> dict[str, Any]:
    changes = _overrides(overrides)
    if not changes:
        return {"error": "no changes provided"}
    ws_id, state, current, updated, error = await _preview_change(session, ctx, changes, None)
    if error:
        return error
    preview = {"kind": "update_retirement_plan", "changes": _diff(engine.apply_overrides(current, {}), updated), "apply_endpoint": "PUT /api/retirement/state"}
    if _can_apply(ctx, apply):
        state[engine.PLAN_KEY] = updated
        await engine.save_state(session, ws_id, ctx.user_id, state)
        return {**preview, "applied": True}
    return preview


@tool(
    name="propose_save_retirement_scenario",
    description=_PROPOSAL_PREFACE
    + (
        "Preview saving a named retirement scenario: the current plan (or another saved scenario, from_scenario) with the given changes "
        "applied. Saving a scenario does not change the current plan. An existing scenario with that name is replaced."
    ),
    parameters={
        "type": "object",
        "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 80}, "from_scenario": _SCENARIO, **_OVERRIDE_PROPERTIES, "apply": _APPLY_FIELD},
        "required": ["name"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "retirement"],
)
async def propose_save_retirement_scenario(*, session: AsyncSession, ctx: CallContext, name: str, from_scenario: str | None = None, apply: bool = False, **overrides: Any) -> dict[str, Any]:
    changes = _overrides(overrides)
    ws_id, state, current, updated, error = await _preview_change(session, ctx, changes, from_scenario)
    if error:
        return error
    existing = (state.get(engine.SCENARIOS_KEY) or {}).get(name)
    preview = {
        "kind": "save_retirement_scenario", "name": name.strip(), "replaces_existing": existing is not None,
        "settings": {"assumptions": updated["assumptions"], "living": updated.get("living"), "whatIfs": updated["whatIfs"]},
        "apply_endpoint": "PUT /api/retirement/state",
    }
    if _can_apply(ctx, apply):
        state.setdefault(engine.SCENARIOS_KEY, {})[name.strip()] = updated
        await engine.save_state(session, ws_id, ctx.user_id, state)
        return {**preview, "applied": True}
    return preview
