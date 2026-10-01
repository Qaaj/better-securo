"""Propose-mutations.

In Securo's own runtime these tools NEVER write to the DB. They return a
structured proposal that the agent surfaces to the user. The user confirms
in the UI, which calls the existing Securo write endpoint to do the real
change. Keeps MCP safe and gives the user a chance to review.

When called via an *external* token (Claude Desktop, n8n, custom clients
— `ctx.external` is true), there is no Apply button to render. In that
case the tools accept an extra `apply: true` flag: first call returns
the preview as usual; a follow-up call with `apply=true` performs the
write directly. Internal callers never set `apply`, so behavior is
unchanged for Securo's own UI.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.schemas.category import CategoryCreate
from app.schemas.recurring_transaction import (
    RecurringTransactionCreate,
    RecurringTransactionUpdate,
    WeekendAdjustment,
)
from app.schemas.rule import RuleAction, RuleCondition, RuleCreate
from app.schemas.transaction import TransactionCreate
from app.services import (
    category_service,
    recurring_transaction_service,
    rule_service,
    transaction_service,
)
from mcp_server.auth import CallContext
from mcp_server.registry import tool
from mcp_server.tools._helpers import (
    num,
    parse_date,
    parse_uuid,
    parse_uuid_list,
    resolve_workspace_id,
)


# Repeated in EVERY propose_* tool description. The LLM reads these when
# deciding when to use a tool AND when describing the result to the user.
# The strong "REQUIRES USER CONFIRMATION" framing prevents the model from
# saying "Pronto! Criei…" / "Done! I added…" — the action is NOT executed
# by the tool call; it only takes effect when the user clicks Apply (or
# the caller re-invokes with apply=true on the external transport).
_PROPOSAL_PREFACE = (
    "[PROPOSAL — PREVIEW ONLY, NOT EXECUTED. The user MUST confirm before "
    "the change happens. In Securo's UI an Apply button + diff card render "
    "automatically — do not duplicate the details in your reply. When you "
    "are running through an external MCP client (no Apply button in chat), "
    "pass apply=true on a follow-up call AFTER the user explicitly "
    "confirms in the conversation. Never set apply=true on the first call. "
    "Describe results as 'I prepared a proposal…' / 'Here's a preview…' — "
    "NEVER as 'I created' / 'Done' / 'Ready' unless the response includes "
    "applied=true.] "
)

# Apply flag, attached to every propose_* tool's parameters. Default false.
_APPLY_FIELD = {
    "type": "boolean",
    "default": False,
    "description": (
        "External clients only. When true (and the call is authenticated "
        "with an external MCP token), executes the change instead of "
        "returning a preview. Ignored by Securo's internal runtime."
    ),
}


def _can_apply(ctx: CallContext, apply: bool) -> bool:
    """Gate: writes only happen when the caller is external AND set apply."""
    return bool(apply) and ctx.external


@tool(
    name="propose_categorize",
    description=_PROPOSAL_PREFACE
    + (
        "Build a preview for re-categorizing one or more transactions. "
        "Returns a summary of what would change and the resolved category."
    ),
    parameters={
        "type": "object",
        "properties": {
            "transaction_ids": {
                "type": "array",
                "items": {"type": "string", "format": "uuid"},
                "minItems": 1,
            },
            "category_id": {"type": "string", "format": "uuid"},
            "apply": _APPLY_FIELD,
        },
        "required": ["transaction_ids", "category_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "transactions"],
)
async def propose_categorize(
    *,
    session: AsyncSession,
    ctx: CallContext,
    transaction_ids: list[str],
    category_id: str,
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    cat_id = parse_uuid(category_id)
    cat = (
        await session.execute(
            select(Category).where(Category.id == cat_id, Category.workspace_id == ws_id)
        )
    ).scalar_one_or_none()
    if cat is None:
        return {"error": "category not found"}

    tx_ids = parse_uuid_list(transaction_ids) or []
    txs = (
        (
            await session.execute(
                select(Transaction).where(
                    Transaction.id.in_(tx_ids), Transaction.workspace_id == ws_id
                )
            )
        )
        .scalars()
        .all()
    )

    affected = [
        {
            "id": str(t.id),
            "description": t.description,
            "amount": num(t.amount),
            "currency": t.currency,
            "current_category_id": str(t.category_id) if t.category_id else None,
        }
        for t in txs
    ]
    preview = {
        "kind": "categorize",
        "target_category": {"id": str(cat.id), "name": cat.name},
        "affected_count": len(affected),
        "affected": affected,
        "missing_ids": [str(t) for t in tx_ids if str(t) not in {a["id"] for a in affected}],
        "apply_endpoint": "POST /api/transactions/categorize",
    }

    if _can_apply(ctx, apply):
        if not affected:
            return {**preview, "error": "no matching transactions to update"}
        tx_uuids = [u for a in affected if (u := parse_uuid(a["id"])) is not None]
        updated = await transaction_service.bulk_update_category(
            session, ws_id, tx_uuids, cat.id
        )
        return {**preview, "applied": True, "updated_count": updated}

    return preview


@tool(
    name="propose_create_category",
    description=_PROPOSAL_PREFACE
    + (
        "Preview the creation of a new category. Returns the proposed shape "
        "and any name collision detected."
    ),
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "minLength": 1, "maxLength": 100},
            "group_id": {"type": "string", "format": "uuid"},
            "icon": {"type": "string"},
            "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
            "apply": _APPLY_FIELD,
        },
        "required": ["name"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "categories"],
)
async def propose_create_category(
    *,
    session: AsyncSession,
    ctx: CallContext,
    name: str,
    group_id: str | None = None,
    icon: str | None = None,
    color: str | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    existing = (
        await session.execute(
            select(Category.id, Category.name).where(
                Category.workspace_id == ws_id,
                Category.name.ilike(name.strip()),
            )
        )
    ).first()
    preview = {
        "kind": "create_category",
        "proposed": {
            "name": name.strip(),
            "group_id": str(parse_uuid(group_id)) if group_id else None,
            "icon": icon or "circle-help",
            "color": color or "#6B7280",
        },
        "name_collision": {"id": str(existing.id), "name": existing.name} if existing else None,
        "apply_endpoint": "POST /api/categories",
    }

    if _can_apply(ctx, apply):
        if existing:
            return {**preview, "error": f"category named {existing.name!r} already exists"}
        created = await category_service.create_category(
            session,
            ws_id,
            ctx.user_id,
            CategoryCreate(
                name=preview["proposed"]["name"],
                group_id=parse_uuid(group_id) if group_id else None,
                icon=preview["proposed"]["icon"],
                color=preview["proposed"]["color"],
            ),
        )
        return {**preview, "applied": True, "id": str(created.id)}

    return preview


@tool(
    name="propose_create_transaction",
    description=_PROPOSAL_PREFACE
    + (
        "Build a preview for adding a one-off transaction (e.g. 'add a "
        "R$50 lunch today'). Validates the account/category exist; "
        "leaves currency to the account's default when not provided."
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "minLength": 1, "maxLength": 500},
            "amount": {
                "type": "number",
                "exclusiveMinimum": 0,
                "description": "Absolute value, always positive — direction comes from `type`",
            },
            "type": {
                "type": "string",
                "enum": ["debit", "credit"],
                "description": "debit = expense, credit = income",
            },
            "account_id": {"type": "string", "format": "uuid"},
            "category_id": {"type": "string", "format": "uuid"},
            "date": {"type": "string", "format": "date", "description": "Defaults to today"},
            "currency": {"type": "string", "description": "Defaults to the account's currency"},
            "notes": {"type": "string"},
            "apply": _APPLY_FIELD,
        },
        "required": ["description", "amount", "type", "account_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "transactions"],
)
async def propose_create_transaction(
    *,
    session: AsyncSession,
    ctx: CallContext,
    description: str,
    amount: float,
    type: str,
    account_id: str,
    category_id: str | None = None,
    date: str | None = None,
    currency: str | None = None,
    notes: str | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    acc_id = parse_uuid(account_id)
    acc = (
        await session.execute(
            select(Account).where(Account.id == acc_id, Account.workspace_id == ws_id)
        )
    ).scalar_one_or_none()
    if acc is None:
        return {"error": "account not found"}

    cat = None
    if category_id:
        cat = (
            await session.execute(
                select(Category).where(
                    Category.id == parse_uuid(category_id), Category.workspace_id == ws_id
                )
            )
        ).scalar_one_or_none()
        if cat is None:
            return {"error": "category not found"}

    target_date = parse_date(date) or _today()
    proposed: dict[str, Any] = {
        "description": description.strip(),
        "amount": float(amount),
        "currency": (currency or acc.currency or "USD").upper(),
        "type": type,
        "date": target_date.isoformat(),
        "account_id": str(acc.id),
        "account_name": acc.name,
        "category_id": str(cat.id) if cat else None,
        "category_name": cat.name if cat else None,
        "notes": (notes or None),
    }
    preview = {
        "kind": "create_transaction",
        "proposed": proposed,
        "apply_endpoint": "POST /api/transactions",
    }

    if _can_apply(ctx, apply):
        try:
            created = await transaction_service.create_transaction(
                session,
                ws_id,
                ctx.user_id,
                TransactionCreate(
                    description=proposed["description"],
                    amount=Decimal(str(amount)),
                    date=target_date,
                    type=type,
                    account_id=acc.id,
                    category_id=cat.id if cat else None,
                    currency=proposed["currency"],
                    notes=notes,
                ),
            )
        except ValueError as exc:
            return {**preview, "error": str(exc)}
        return {**preview, "applied": True, "id": str(created.id)}

    return preview


@tool(
    name="propose_create_recurring_transaction",
    description=_PROPOSAL_PREFACE
    + (
        "Build a preview for adding a recurring transaction / subscription "
        "(e.g. 'Netflix R$55 every month on the 10th'). Frequency is one "
        "of weekly/biweekly/monthly/quarterly/semiannual/yearly. For monthly, "
        "quarterly, or semiannual use day_of_month (1-31)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "minLength": 1, "maxLength": 500},
            "amount": {"type": "number", "exclusiveMinimum": 0},
            "type": {"type": "string", "enum": ["debit", "credit"]},
            "frequency": {"type": "string", "enum": ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "yearly"]},
            "weekend_adjustment": {
                "type": "string",
                "enum": ["none", "previous_friday", "next_monday"],
                "default": "none",
            },
            "day_of_month": {"type": "integer", "minimum": 1, "maximum": 31, "description": "Required for monthly, quarterly, or semiannual"},
            "start_date": {"type": "string", "format": "date", "description": "Defaults to today"},
            "end_date": {"type": "string", "format": "date"},
            "account_id": {"type": "string", "format": "uuid"},
            "category_id": {"type": "string", "format": "uuid"},
            "currency": {"type": "string"},
            "apply": _APPLY_FIELD,
        },
        "required": ["description", "amount", "type", "frequency", "account_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_create_recurring_transaction(
    *,
    session: AsyncSession,
    ctx: CallContext,
    description: str,
    amount: float,
    type: str,
    frequency: str,
    account_id: str,
    weekend_adjustment: WeekendAdjustment = "none",
    day_of_month: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    category_id: str | None = None,
    currency: str | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    if frequency in ("monthly", "quarterly", "semiannual") and not day_of_month:
        return {"error": "day_of_month is required for monthly, quarterly, or semiannual frequency"}
    ws_id = await resolve_workspace_id(session, ctx)
    acc = (
        await session.execute(
            select(Account).where(
                Account.id == parse_uuid(account_id), Account.workspace_id == ws_id
            )
        )
    ).scalar_one_or_none()
    if acc is None:
        return {"error": "account not found"}
    cat = None
    if category_id:
        cat = (
            await session.execute(
                select(Category).where(
                    Category.id == parse_uuid(category_id), Category.workspace_id == ws_id
                )
            )
        ).scalar_one_or_none()
        if cat is None:
            return {"error": "category not found"}

    target_start = parse_date(start_date) or _today()
    target_end = parse_date(end_date) if end_date else None
    resolved_currency = (currency or acc.currency or "USD").upper()
    preview = {
        "kind": "create_recurring_transaction",
        "proposed": {
            "description": description.strip(),
            "amount": float(amount),
            "currency": resolved_currency,
            "type": type,
            "frequency": frequency,
            "weekend_adjustment": weekend_adjustment,
            "day_of_month": int(day_of_month) if day_of_month else None,
            "start_date": target_start.isoformat(),
            "end_date": target_end.isoformat() if target_end else None,
            "account_id": str(acc.id),
            "account_name": acc.name,
            "category_id": str(cat.id) if cat else None,
            "category_name": cat.name if cat else None,
        },
        "apply_endpoint": "POST /api/recurring-transactions",
    }

    if _can_apply(ctx, apply):
        created = await recurring_transaction_service.create_recurring_transaction(
            session,
            ws_id,
            ctx.user_id,
            RecurringTransactionCreate(
                description=description.strip(),
                amount=Decimal(str(amount)),
                currency=resolved_currency,
                type=type,
                frequency=frequency,
                weekend_adjustment=weekend_adjustment,
                day_of_month=int(day_of_month) if day_of_month else None,
                start_date=target_start,
                end_date=target_end,
                account_id=acc.id,
                category_id=cat.id if cat else None,
            ),
        )
        return {**preview, "applied": True, "id": str(created.id)}

    return preview


@tool(
    name="propose_update_recurring_transaction",
    description=_PROPOSAL_PREFACE
    + (
        "Build a preview for editing an existing recurring transaction "
        "(e.g. 'update my salary to R$8,000', 'change Netflix to R$60'). "
        "Pass the recurring_id and only the fields you want to change. "
        "Returns the current values alongside the proposed changes so the "
        "user can compare before confirming."
    ),
    parameters={
        "type": "object",
        "properties": {
            "recurring_id": {"type": "string", "format": "uuid"},
            "description": {"type": "string", "minLength": 1, "maxLength": 500},
            "amount": {"type": "number", "exclusiveMinimum": 0},
            "frequency": {"type": "string", "enum": ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "yearly"]},
            "weekend_adjustment": {
                "type": "string",
                "enum": ["none", "previous_friday", "next_monday"],
            },
            "day_of_month": {"type": "integer", "minimum": 1, "maximum": 31},
            "end_date": {"type": "string", "format": "date"},
            "category_id": {"type": "string", "format": "uuid"},
            "is_active": {"type": "boolean"},
            "apply": _APPLY_FIELD,
        },
        "required": ["recurring_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_update_recurring_transaction(
    *,
    session: AsyncSession,
    ctx: CallContext,
    recurring_id: str,
    description: str | None = None,
    amount: float | None = None,
    frequency: str | None = None,
    weekend_adjustment: str | None = None,
    day_of_month: int | None = None,
    end_date: str | None = None,
    category_id: str | None = None,
    is_active: bool | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    rid = parse_uuid(recurring_id)
    rt = (
        await session.execute(
            select(RecurringTransaction).where(
                RecurringTransaction.id == rid, RecurringTransaction.workspace_id == ws_id
            )
        )
    ).scalar_one_or_none()
    if rt is None:
        return {"error": "recurring transaction not found"}

    cat = None
    if category_id:
        cat = (
            await session.execute(
                select(Category).where(
                    Category.id == parse_uuid(category_id), Category.workspace_id == ws_id
                )
            )
        ).scalar_one_or_none()
        if cat is None:
            return {"error": "category not found"}

    changes: dict[str, Any] = {}
    if description is not None:
        changes["description"] = description.strip()
    if amount is not None:
        changes["amount"] = float(amount)
    if frequency is not None:
        changes["frequency"] = frequency
    if weekend_adjustment is not None:
        changes["weekend_adjustment"] = weekend_adjustment
    if day_of_month is not None:
        changes["day_of_month"] = int(day_of_month)
    if end_date is not None:
        parsed_end = parse_date(end_date)
        changes["end_date"] = parsed_end.isoformat() if parsed_end else None
    if cat is not None:
        changes["category_id"] = str(cat.id)
    if is_active is not None:
        changes["is_active"] = bool(is_active)

    if not changes:
        return {"error": "no changes provided"}

    preview = {
        "kind": "update_recurring_transaction",
        "target": {
            "id": str(rt.id),
            "description": rt.description,
            "amount": num(rt.amount),
            "currency": rt.currency,
            "frequency": rt.frequency,
            "weekend_adjustment": rt.weekend_adjustment,
            "day_of_month": rt.day_of_month,
            "is_active": bool(getattr(rt, "is_active", True)),
        },
        "changes": changes,
        "apply_endpoint": f"PATCH /api/recurring-transactions/{rt.id}",
    }

    if _can_apply(ctx, apply):
        update_data: dict[str, Any] = {}
        if "description" in changes:
            update_data["description"] = changes["description"]
        if "amount" in changes:
            update_data["amount"] = Decimal(str(changes["amount"]))
        if "frequency" in changes:
            update_data["frequency"] = changes["frequency"]
        if "weekend_adjustment" in changes:
            update_data["weekend_adjustment"] = changes["weekend_adjustment"]
        if "day_of_month" in changes:
            update_data["day_of_month"] = changes["day_of_month"]
        if "end_date" in changes:
            update_data["end_date"] = (
                parse_date(changes["end_date"]) if changes["end_date"] else None
            )
        if "category_id" in changes:
            update_data["category_id"] = parse_uuid(changes["category_id"])
        if "is_active" in changes:
            update_data["is_active"] = changes["is_active"]
        updated = await recurring_transaction_service.update_recurring_transaction(
            session, rt.id, ws_id, RecurringTransactionUpdate(**update_data)
        )
        if updated is None:
            return {**preview, "error": "recurring transaction not found"}
        return {**preview, "applied": True, "id": str(updated.id)}

    return preview


@tool(
    name="propose_cancel_recurring_transaction",
    description=_PROPOSAL_PREFACE
    + (
        "Build a preview for cancelling a recurring transaction (e.g. "
        "'cancel that subscription'). Two modes: 'deactivate' keeps the "
        "history but stops future occurrences (recommended); 'delete' "
        "removes it entirely."
    ),
    parameters={
        "type": "object",
        "properties": {
            "recurring_id": {"type": "string", "format": "uuid"},
            "mode": {"type": "string", "enum": ["deactivate", "delete"], "default": "deactivate"},
            "apply": _APPLY_FIELD,
        },
        "required": ["recurring_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "recurring"],
)
async def propose_cancel_recurring_transaction(
    *,
    session: AsyncSession,
    ctx: CallContext,
    recurring_id: str,
    mode: str = "deactivate",
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    rt = (
        await session.execute(
            select(RecurringTransaction).where(
                RecurringTransaction.id == parse_uuid(recurring_id),
                RecurringTransaction.workspace_id == ws_id,
            )
        )
    ).scalar_one_or_none()
    if rt is None:
        return {"error": "recurring transaction not found"}

    if mode == "delete":
        endpoint = f"DELETE /api/recurring-transactions/{rt.id}"
    else:
        endpoint = f"PATCH /api/recurring-transactions/{rt.id}  body={{is_active: false}}"

    preview = {
        "kind": "cancel_recurring_transaction",
        "mode": mode,
        "target": {
            "id": str(rt.id),
            "description": rt.description,
            "amount": num(rt.amount),
            "currency": rt.currency,
            "frequency": rt.frequency,
            "is_active": bool(getattr(rt, "is_active", True)),
        },
        "apply_endpoint": endpoint,
    }

    if _can_apply(ctx, apply):
        if mode == "delete":
            ok = await recurring_transaction_service.delete_recurring_transaction(
                session, rt.id, ws_id
            )
            if not ok:
                return {**preview, "error": "recurring transaction not found"}
            return {**preview, "applied": True, "deleted": True}
        # deactivate path
        updated = await recurring_transaction_service.update_recurring_transaction(
            session, rt.id, ws_id, RecurringTransactionUpdate(is_active=False)
        )
        if updated is None:
            return {**preview, "error": "recurring transaction not found"}
        return {**preview, "applied": True, "id": str(updated.id), "is_active": False}

    return preview


def _today():
    from datetime import date as _d

    return _d.today()


@tool(
    name="propose_create_payee_rule",
    description=_PROPOSAL_PREFACE
    + (
        "Preview a rule that auto-categorizes future transactions matching "
        "a description pattern. Returns the proposed rule shape."
    ),
    parameters={
        "type": "object",
        "properties": {
            "match_pattern": {
                "type": "string",
                "description": "Substring to match in transaction description (case-insensitive)",
            },
            "category_id": {"type": "string", "format": "uuid"},
            "apply": _APPLY_FIELD,
        },
        "required": ["match_pattern", "category_id"],
        "additionalProperties": False,
    },
    is_proposal=True,
    tags=["propose", "rules"],
)
async def propose_create_payee_rule(
    *,
    session: AsyncSession,
    ctx: CallContext,
    match_pattern: str,
    category_id: str,
    apply: bool = False,
) -> dict[str, Any]:
    ws_id = await resolve_workspace_id(session, ctx)
    cat_id = parse_uuid(category_id)
    cat = (
        await session.execute(
            select(Category).where(Category.id == cat_id, Category.workspace_id == ws_id)
        )
    ).scalar_one_or_none()
    if cat is None:
        return {"error": "category not found"}

    preview = {
        "kind": "create_payee_rule",
        "proposed": {
            "match_pattern": match_pattern,
            "category_id": str(cat.id),
            "category_name": cat.name,
        },
        "apply_endpoint": "POST /api/rules",
    }

    if _can_apply(ctx, apply):
        created = await rule_service.create_rule(
            session,
            ws_id,
            ctx.user_id,
            RuleCreate(
                name=f"Auto-categorize: {match_pattern}",
                conditions_op="and",
                conditions=[RuleCondition(field="description", op="contains", value=match_pattern)],
                actions=[RuleAction(op="set_category", value=str(cat.id))],
            ),
        )
        return {**preview, "applied": True, "id": str(created.id)}

    return preview
