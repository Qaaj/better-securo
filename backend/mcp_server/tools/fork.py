"""Tools for what this fork adds: the monthly review, the recurring finder and history, asset pages
with contracts and documents, the categorization job, and the saved retirement plan.

The retirement projection and stress test run in the browser, so what is exposed here is the saved
plan and the latest figures the page stored with it, not a fresh calculation.

Writes follow the propose pattern of proposals.py: a preview first, and a change only when an
external client repeats the call with `apply=true`.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Optional

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.asset import Asset
from app.models.categorization import CategorizationJob, CategorizationSuggestion
from app.models.category import Category
from app.models.retirement_state import RetirementState
from app.models.user import User
from app.schemas.asset import AssetUpdate
from app.schemas.asset_contract import ContractCreate, ContractKind
from app.schemas.recurring_discovery import CreateFromSeriesRequest
from app.services import (
    asset_contract_service,
    asset_service,
    recurring_discovery_service,
    recurring_history_service,
    review_service,
)
from mcp_server.auth import CallContext
from mcp_server.registry import tool
from mcp_server.tools._helpers import parse_date, parse_uuid, resolve_workspace_id
from mcp_server.tools.proposals import _APPLY_FIELD, _PROPOSAL_PREFACE, _can_apply

PER_YEAR = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "semiannual": 2, "yearly": 1}
CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1, "none": 0}


async def _currency(session: AsyncSession, ctx: CallContext) -> str:
    user = await session.get(User, ctx.user_id)
    return ((user.preferences or {}).get("currency_display") if user else None) or "USD"


def _plain(value: Any) -> Any:
    """JSON-safe copy (dates, decimals and UUIDs become strings and numbers)."""
    return jsonable_encoder(value)


def _status(days_left: Optional[int], notice_by: Optional[date], today: date) -> str:
    if days_left is None:
        return "open_ended"
    if days_left < 0:
        return "ended"
    if notice_by is not None and 0 <= (notice_by - today).days <= 30:
        return "notice_due_soon"
    if days_left <= 90:
        return "ending_soon"
    return "running"


def _running_costs(contracts: list[dict], currency: str) -> dict[str, Any]:
    per_year = 0.0
    costed = uncosted = skipped = 0
    for c in contracts:
        r = c.get("recurring")
        if not r:
            uncosted += 1
            continue
        if not r["is_active"]:
            continue
        amount = float(r["amount"]) if r["currency"] == currency else r.get("amount_primary")
        times = PER_YEAR.get(r["frequency"])
        if amount is None or times is None:
            skipped += 1
            continue
        costed += 1
        per_year += float(amount) * times
    return {"currency": currency, "per_month": round(per_year / 12, 2), "per_year": round(per_year, 2), "contracts_with_cost": costed, "contracts_without_cost": uncosted, "skipped": skipped}


def _contract_row(c: dict, today: date, **extra: Any) -> dict[str, Any]:
    return {
        **extra,
        "contract_id": str(c["id"]),
        "kind": c["kind"],
        "provider": c["provider"],
        "contract_number": c["contract_number"],
        "meter_number": c["meter_number"],
        "start_date": _plain(c["start_date"]),
        "end_date": _plain(c["end_date"]),
        "notice_days": c["notice_days"],
        "notice_by": _plain(c["notice_by"]),
        "days_left": c["days_left"],
        "status": _status(c["days_left"], c["notice_by"], today),
        "cost": None if not c["recurring"] else {"description": c["recurring"]["description"], "amount": float(c["recurring"]["amount"]), "currency": c["recurring"]["currency"], "frequency": c["recurring"]["frequency"], "active": c["recurring"]["is_active"]},
        "documents": c["document_count"],
    }


# ---------------------------------------------------------------- reading
@tool(
    name="get_monthly_review",
    description=(
        "The plain-language review of one month: income, spending and savings against the usual month, where "
        "the money went by category with what changed, new merchants, large payments, what was fixed or "
        "flexible, money moved between accounts, the year so far, and 'worth a look' insights (a possible "
        "double charge, an unusually large payment, a subscription price change). Defaults to last month."
    ),
    parameters={
        "type": "object",
        "properties": {"month": {"type": "string", "format": "date", "description": "Any date inside the month"}},
        "additionalProperties": False,
    },
    tags=["read", "reports"],
)
async def get_monthly_review(*, session: AsyncSession, ctx: CallContext, month: str | None = None) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    today = app_today()
    target = parse_date(month) or (today.replace(day=1) - timedelta(days=1))
    result = await review_service.monthly_review(session, ws_id, await _currency(session, ctx), target.replace(day=1))
    return _plain(result)


@tool(
    name="get_asset",
    description=(
        "Everything about one asset: value, purchase, growth and modelled income, address and coordinates, "
        "technical details (floor area, build year, a vehicle's make and so on), notes, its contracts and "
        "utilities with their status and linked cost, its documents (names and expiry only) and the running "
        "costs a month and a year. Get the id from list_assets."
    ),
    parameters={"type": "object", "properties": {"asset_id": {"type": "string", "format": "uuid"}}, "required": ["asset_id"], "additionalProperties": False},
    tags=["read", "assets"],
)
async def get_asset(*, session: AsyncSession, ctx: CallContext, asset_id: str) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    asset = await asset_service.get_asset(session, parse_uuid(asset_id), ws_id)
    if asset is None:
        return {"error": "asset not found"}
    today = app_today()
    currency = await _currency(session, ctx)
    contracts = await asset_contract_service.list_contracts(session, asset.id, ws_id, today)
    documents = await asset_contract_service.list_documents(session, asset.id, ws_id)
    return {
        "asset": _plain(asset.model_dump(include={
            "id", "name", "type", "currency", "current_value", "purchase_price", "purchase_date", "gain_loss", "growth_type", "growth_rate",
            "growth_frequency", "income_mode", "income_rate", "income_amount", "income_frequency", "sell_percent_per_year", "sell_date", "sell_price",
            "address", "latitude", "longitude", "details", "notes",
        })),
        "contracts": [_contract_row(c, today) for c in contracts],
        "documents": [
            {"id": str(d.id), "title": d.title, "kind": d.kind, "expires_on": _plain(d.expires_on), "attached_to_contract": str(d.contract_id) if d.contract_id else None}
            for d in documents
        ],
        "running_costs": _running_costs(contracts, currency),
    }


@tool(
    name="list_contracts",
    description=(
        "Contracts and utilities across all assets (energy, gas, water, internet, insurance, property tax, "
        "condominium, mortgage, maintenance), with provider, numbers, dates, notice deadline, status "
        "(running / ending_soon / notice_due_soon / ended / open_ended) and the recurring item that pays for "
        "each. Use needs_attention=true for 'which contracts should I act on?'."
    ),
    parameters={
        "type": "object",
        "properties": {
            "needs_attention": {"type": "boolean", "default": False, "description": "Only contracts that ended, have a notice deadline within 30 days or end within 90 days"},
            "kind": {"type": "string", "enum": ["energy", "gas", "water", "internet", "insurance", "tax", "condo", "mortgage", "maintenance", "other"]},
        },
        "additionalProperties": False,
    },
    tags=["read", "assets"],
)
async def list_contracts(*, session: AsyncSession, ctx: CallContext, needs_attention: bool = False, kind: str | None = None) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    today = app_today()
    rows: list[dict[str, Any]] = []
    for asset in await asset_service.get_assets(session, ws_id):
        for c in await asset_contract_service.list_contracts(session, asset.id, ws_id, today):
            row = _contract_row(c, today, asset_id=str(asset.id), asset_name=asset.name)
            if kind and row["kind"] != kind:
                continue
            if needs_attention and row["status"] not in ("ended", "notice_due_soon", "ending_soon"):
                continue
            rows.append(row)
    rows.sort(key=lambda r: (r["days_left"] is None, r["days_left"] if r["days_left"] is not None else 0))
    return {"items": rows, "total": len(rows)}


@tool(
    name="find_recurring_matches",
    description=(
        "Search the transactions nothing is linked to for recurring charges. `matches` are the most likely "
        "transactions for each existing recurring item (amount, schedule and name; with confidence and reasons); "
        "`new` are repeating charges that fit no recurring item. Each has a series_key to use with the "
        "propose_* tools below."
    ),
    parameters={
        "type": "object",
        "properties": {
            "include": {"type": "string", "enum": ["matches", "new", "both"], "default": "both"},
            "min_confidence": {"type": "string", "enum": ["low", "medium", "high"], "default": "medium"},
            "include_ended": {"type": "boolean", "default": False, "description": "Also list new patterns that look like they stopped"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 15},
        },
        "additionalProperties": False,
    },
    tags=["read", "recurring"],
)
async def find_recurring_matches(
    *, session: AsyncSession, ctx: CallContext, include: str = "both", min_confidence: str = "medium", include_ended: bool = False, limit: int = 15
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    found = await recurring_discovery_service.discover(session, ws_id)
    floor = CONFIDENCE_RANK[min_confidence]

    def series_row(s: dict) -> dict[str, Any]:
        return {
            "series_key": s["key"], "name": s["name"], "type": s["type"], "frequency": s["frequency"], "confidence": s["confidence"],
            "occurrences": s["occurrences"], "first_date": _plain(s["first_date"]), "last_date": _plain(s["last_date"]),
            "typical_amount": float(s["typical_amount"]), "currency": s["currency"], "amount_varies": s["amount_varies"],
            "yearly_amount": float(s["yearly_amount"]), "ended": s["lapsed"],
        }

    out: dict[str, Any] = {}
    if include in ("matches", "both"):
        out["matches"] = [
            {
                "recurring_id": str(m["recurring_id"]), "recurring": m["recurring_description"], "recurring_amount": float(m["recurring_amount"]),
                "confidence": m["confidence"], "reasons": m["reasons"], **series_row(m["series"]),
            }
            for m in found["matches"]
            if CONFIDENCE_RANK[m["confidence"]] >= floor
        ][:limit]
    if include in ("new", "both"):
        out["new"] = [
            series_row(s)
            for s in found["new_series"]
            if CONFIDENCE_RANK[s["confidence"]] >= floor and (include_ended or not s["lapsed"])
        ][:limit]
    return out


@tool(
    name="get_recurring_history",
    description=(
        "What the charges linked to one recurring item say: when it started, how many charges, what it cost in "
        "the last 12 months and in total, its price now against the first charge, dated price changes, and whether "
        "the next charge is late. Get the id from list_recurring_transactions."
    ),
    parameters={"type": "object", "properties": {"recurring_id": {"type": "string", "format": "uuid"}}, "required": ["recurring_id"], "additionalProperties": False},
    tags=["read", "recurring"],
)
async def get_recurring_history(*, session: AsyncSession, ctx: CallContext, recurring_id: str) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    result = await recurring_history_service.history(session, parse_uuid(recurring_id), ws_id)
    if result is None:
        return {"error": "recurring item not found"}
    result["charges"] = result["charges"][-24:]
    return _plain(result)


@tool(
    name="get_retirement_plan",
    description=(
        "The saved retirement plan: horizon, inflation, drawdown start, selling order, tax rates (default and per "
        "line), cash buffer, living and travel, what-ifs, temporary assets, lines that end, and the names of the "
        "saved scenarios. `latest_results` holds the figures the Retirement page stored when it last calculated "
        "(runway, tax paid, assets left, and the stress test's chance the money lasts) if it has been opened. "
        "The calculation itself runs in the browser, so these results are as old as the last visit."
    ),
    parameters={
        "type": "object",
        "properties": {"scenario": {"type": "string", "description": "Return this saved scenario's settings instead of the current plan"}},
        "additionalProperties": False,
    },
    tags=["read", "retirement"],
)
async def get_retirement_plan(*, session: AsyncSession, ctx: CallContext, scenario: str | None = None) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    state = await session.get(RetirementState, ws_id)
    if state is None or not state.data:
        return {"plan": None, "note": "No retirement plan has been saved yet."}
    data = state.data
    scenarios = data.get("retirement:scenarios") or {}
    plan = scenarios.get(scenario) if scenario else data.get("retirement:plan")
    if scenario and plan is None:
        return {"error": f"no saved scenario named '{scenario}'", "scenarios": sorted(scenarios)}
    names = {str(a.id): a.name for a in (await session.execute(select(Asset).where(Asset.workspace_id == ws_id))).scalars().all()}
    return {
        "plan": _plain(plan),
        "scenarios": sorted(scenarios),
        "asset_names": names,
        "excluded_income_ids": data.get("retirement:excluded-income") or [],
        "latest_results": _plain({k: data[k] for k in ("retirement:summary", "retirement:simulation-result") if k in data}),
        "updated_at": _plain(state.updated_at),
    }


@tool(
    name="get_categorization_status",
    description=(
        "The automatic categorizer's latest run: its status, how many merchants it handled, how many suggestions "
        "are still waiting, and the biggest waiting suggestions by total value with the category proposed."
    ),
    parameters={"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 30, "default": 10}}, "additionalProperties": False},
    tags=["read", "categories"],
)
async def get_categorization_status(*, session: AsyncSession, ctx: CallContext, limit: int = 10) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    job = (
        await session.execute(select(CategorizationJob).where(CategorizationJob.workspace_id == ws_id).order_by(CategorizationJob.created_at.desc()).limit(1))
    ).scalar_one_or_none()
    if job is None:
        return {"job": None, "note": "The categorizer has not been run."}
    counts = dict(
        (
            await session.execute(
                select(CategorizationSuggestion.status, func.count()).where(CategorizationSuggestion.job_id == job.id).group_by(CategorizationSuggestion.status)
            )
        ).all()
    )
    pending = (
        await session.execute(
            select(CategorizationSuggestion, Category.name)
            .outerjoin(Category, Category.id == CategorizationSuggestion.suggested_category_id)
            .where(CategorizationSuggestion.job_id == job.id, CategorizationSuggestion.status == "pending")
            .order_by(CategorizationSuggestion.total_amount_primary.desc())
            .limit(limit)
        )
    ).all()
    return {
        "job": {"status": job.status, "merchants": job.total_merchants, "processed": job.processed_merchants, "started": _plain(job.created_at), "finished": _plain(job.finished_at), "error": job.error},
        "suggestions": {"pending": counts.get("pending", 0), "accepted": counts.get("accepted", 0), "rejected": counts.get("rejected", 0)},
        "biggest_pending": [
            {"merchant": s.sample_description, "transactions": s.tx_count, "total": float(s.total_amount_primary or 0), "type": s.tx_type, "suggested_category": name, "confidence": s.confidence}
            for s, name in pending
        ],
    }


# ---------------------------------------------------------------- proposals
async def _find_series(session: AsyncSession, ws_id, series_key: str) -> tuple[Optional[dict], dict]:
    found = await recurring_discovery_service.discover(session, ws_id)
    for m in found["matches"]:
        if m["series"]["key"] == series_key:
            return m["series"], found
    for s in found["new_series"]:
        if s["key"] == series_key:
            return s, found
    return None, found


@tool(
    name="propose_link_recurring_match",
    description=_PROPOSAL_PREFACE
    + "Preview linking all the transactions of a found series to an existing recurring item, so its history and schedule are right. Use a series_key from find_recurring_matches.",
    parameters={
        "type": "object",
        "properties": {"recurring_id": {"type": "string", "format": "uuid"}, "series_key": {"type": "string"}, "apply": _APPLY_FIELD},
        "required": ["recurring_id", "series_key"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_link_recurring_match(*, session: AsyncSession, ctx: CallContext, recurring_id: str, series_key: str, apply: bool = False) -> dict[str, Any]:
    from app.services.recurring_transaction_service import get_recurring_transaction

    ws_id = await resolve_workspace_id(session, ctx)
    rt = await get_recurring_transaction(session, parse_uuid(recurring_id), ws_id)
    if rt is None:
        return {"error": "recurring item not found"}
    series, _ = await _find_series(session, ws_id, series_key)
    if series is None:
        return {"error": "series not found; run find_recurring_matches again"}
    preview = {
        "kind": "link_recurring_series",
        "recurring": {"id": str(rt.id), "description": rt.description, "amount": float(rt.amount), "frequency": rt.frequency},
        "series": {"name": series["name"], "occurrences": series["occurrences"], "first_date": _plain(series["first_date"]), "last_date": _plain(series["last_date"]), "typical_amount": float(series["typical_amount"])},
        "apply_endpoint": f"POST /api/recurring-transactions/{rt.id}/link-series",
    }
    if _can_apply(ctx, apply):
        await recurring_discovery_service.link_series(session, rt.id, series["transaction_ids"], ws_id)
        return {**preview, "applied": True}
    return preview


@tool(
    name="propose_create_recurring_from_series",
    description=_PROPOSAL_PREFACE
    + "Preview making a new recurring item (forecast-only) from a repeating charge that fits no item, linking all of its transactions. Use a series_key from the `new` list of find_recurring_matches. The description defaults to the merchant's name.",
    parameters={
        "type": "object",
        "properties": {"series_key": {"type": "string"}, "description": {"type": "string", "maxLength": 500}, "apply": _APPLY_FIELD},
        "required": ["series_key"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_create_recurring_from_series(*, session: AsyncSession, ctx: CallContext, series_key: str, description: str | None = None, apply: bool = False) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    series, _ = await _find_series(session, ws_id, series_key)
    if series is None:
        return {"error": "series not found; run find_recurring_matches again"}
    if not series["frequency"]:
        return {"error": "this series has no regular schedule, so it cannot be a recurring item"}
    account_id = series["account_id"]
    if account_id is None:
        return {"error": "the series has no account"}
    preview = {
        "kind": "create_recurring_from_series",
        "proposed": {
            "description": (description or series["name"]).strip(), "amount": float(series["typical_amount"]), "currency": series["currency"], "type": series["type"],
            "frequency": series["frequency"], "day_of_month": series["day_of_month"], "next_occurrence": _plain(series["next_occurrence"]), "transactions_linked": series["occurrences"],
        },
        "apply_endpoint": "POST /api/recurring-transactions/discoveries/create",
    }
    if _can_apply(ctx, apply):
        created = await recurring_discovery_service.create_from_series(
            session, ws_id, ctx.user_id,
            CreateFromSeriesRequest(
                description=preview["proposed"]["description"], amount=Decimal(str(series["typical_amount"])), currency=series["currency"], type=series["type"],
                frequency=series["frequency"], day_of_month=series["day_of_month"], account_id=account_id, category_id=series["category_id"], transaction_ids=series["transaction_ids"],
            ),
        )
        return {**preview, "applied": True, "id": str(created.id)}
    return preview


@tool(
    name="propose_dismiss_recurring_suggestion",
    description=_PROPOSAL_PREFACE
    + "Preview dismissing a found series so the finder stops offering it: for a new pattern pass only series_key; to say a series is NOT the one meant for an existing item also pass recurring_id.",
    parameters={
        "type": "object",
        "properties": {"series_key": {"type": "string"}, "recurring_id": {"type": "string", "format": "uuid"}, "apply": _APPLY_FIELD},
        "required": ["series_key"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_dismiss_recurring_suggestion(*, session: AsyncSession, ctx: CallContext, series_key: str, recurring_id: str | None = None, apply: bool = False) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    series, _ = await _find_series(session, ws_id, series_key)
    if series is None:
        return {"error": "series not found; run find_recurring_matches again"}
    kind = "match" if recurring_id else "series"
    preview = {"kind": "dismiss_recurring_suggestion", "dismiss": kind, "series": {"name": series["name"], "occurrences": series["occurrences"]}, "apply_endpoint": "POST /api/recurring-transactions/discoveries/dismiss"}
    if _can_apply(ctx, apply):
        await recurring_discovery_service.dismiss(session, ws_id, kind, series_key, parse_uuid(recurring_id))
        return {**preview, "applied": True}
    return preview


@tool(
    name="propose_create_asset_contract",
    description=_PROPOSAL_PREFACE
    + (
        "Preview adding a contract or utility to an asset (an energy supplier for a home, insurance for a vehicle). "
        "Optionally link a recurring item (recurring_id) so its amount counts as the cost. Dates are YYYY-MM-DD."
    ),
    parameters={
        "type": "object",
        "properties": {
            "asset_id": {"type": "string", "format": "uuid"},
            "kind": {"type": "string", "enum": ["energy", "gas", "water", "internet", "insurance", "tax", "condo", "mortgage", "maintenance", "other"]},
            "provider": {"type": "string", "minLength": 1, "maxLength": 200},
            "contract_number": {"type": "string"}, "customer_number": {"type": "string"}, "meter_number": {"type": "string"},
            "start_date": {"type": "string", "format": "date"}, "end_date": {"type": "string", "format": "date"},
            "notice_days": {"type": "integer", "minimum": 0, "maximum": 730},
            "recurring_id": {"type": "string", "format": "uuid"}, "notes": {"type": "string", "maxLength": 2000},
            "apply": _APPLY_FIELD,
        },
        "required": ["asset_id", "kind", "provider"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "assets"],
)
async def propose_create_asset_contract(
    *, session: AsyncSession, ctx: CallContext, asset_id: str, kind: ContractKind, provider: str, contract_number: str | None = None,
    customer_number: str | None = None, meter_number: str | None = None, start_date: str | None = None, end_date: str | None = None,
    notice_days: int | None = None, recurring_id: str | None = None, notes: str | None = None, apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    asset = await asset_service.get_asset(session, parse_uuid(asset_id), ws_id)
    if asset is None:
        return {"error": "asset not found"}
    try:
        data = ContractCreate(
            kind=kind, provider=provider, contract_number=contract_number, customer_number=customer_number, meter_number=meter_number,
            start_date=parse_date(start_date), end_date=parse_date(end_date), notice_days=notice_days, recurring_id=parse_uuid(recurring_id), notes=notes,
        )
    except ValueError as exc:
        return {"error": str(exc)}
    preview = {"kind": "create_asset_contract", "asset": {"id": str(asset.id), "name": asset.name}, "proposed": _plain(data.model_dump()), "apply_endpoint": f"POST /api/assets/{asset.id}/contracts"}
    if _can_apply(ctx, apply):
        try:
            created = await asset_contract_service.create_contract(session, asset.id, ws_id, data.model_dump())
        except ValueError as exc:
            return {"error": str(exc)}
        return {**preview, "applied": True, "id": str(created["id"])}
    return preview


@tool(
    name="propose_update_asset_details",
    description=_PROPOSAL_PREFACE
    + (
        "Preview changing what an asset page keeps: its address, notes, or technical details. `details` is merged "
        "into the existing details by name (a value of null removes one), so pass only what changes. Coordinates are "
        "not looked up here; the page does that."
    ),
    parameters={
        "type": "object",
        "properties": {
            "asset_id": {"type": "string", "format": "uuid"},
            "address": {"type": "string", "maxLength": 500},
            "notes": {"type": "string", "maxLength": 5000},
            "details": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean", "null"]}},
            "apply": _APPLY_FIELD,
        },
        "required": ["asset_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "assets"],
)
async def propose_update_asset_details(
    *, session: AsyncSession, ctx: CallContext, asset_id: str, address: str | None = None, notes: str | None = None, details: dict | None = None, apply: bool = False
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    asset = await asset_service.get_asset(session, parse_uuid(asset_id), ws_id)
    if asset is None:
        return {"error": "asset not found"}
    changes: dict[str, Any] = {}
    if address is not None:
        changes["address"] = address
    if notes is not None:
        changes["notes"] = notes
    if details:
        merged = {**(asset.details or {}), **details}
        changes["details"] = {k: v for k, v in merged.items() if v is not None}
    if not changes:
        return {"error": "no changes provided"}
    try:
        update = AssetUpdate(**changes)
    except ValueError as exc:
        return {"error": str(exc)}
    current = {k: getattr(asset, k) for k in changes}
    preview = {"kind": "update_asset_details", "asset": {"id": str(asset.id), "name": asset.name}, "current": _plain(current), "changes": _plain(changes), "apply_endpoint": f"PATCH /api/assets/{asset.id}"}
    if _can_apply(ctx, apply):
        await asset_service.update_asset(session, asset.id, ws_id, ctx.user_id, update)
        return {**preview, "applied": True}
    return preview
