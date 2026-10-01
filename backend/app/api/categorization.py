import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace, current_writable_workspace
from app.models.categorization import CategorizationJob, CategorizationSuggestion
from app.schemas.categorization import (
    AcceptAllRequest,
    AcceptAllResult,
    AcceptSuggestionRequest,
    CategorizationJobCreate,
    CategorizationJobRead,
    CategorizerSettings,
    CategorizerTestRequest,
    CategorizerTestResult,
    RulesForAcceptedResult,
    SuggestionCounts,
    SuggestionList,
    SuggestionRead,
    SuggestionTransaction,
    SuggestionTransactions,
)
from app.services import categorization_service

router = APIRouter(prefix="/api/categorization", tags=["categorization"])

_CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1}


async def _job_read(session: AsyncSession, job: CategorizationJob) -> CategorizationJobRead:
    rows = (
        await session.execute(
            select(CategorizationSuggestion.status, func.count())
            .where(CategorizationSuggestion.job_id == job.id)
            .group_by(CategorizationSuggestion.status)
        )
    ).all()
    counts = SuggestionCounts(**{status_: n for status_, n in rows if status_ in ("pending", "accepted", "rejected")})
    read = CategorizationJobRead.model_validate(job)
    read.counts = counts
    return read


async def _get_job(session: AsyncSession, job_id: uuid.UUID, workspace_id: uuid.UUID) -> CategorizationJob:
    job = (
        await session.execute(
            select(CategorizationJob).where(CategorizationJob.id == job_id, CategorizationJob.workspace_id == workspace_id)
        )
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Categorization run not found")
    return job


async def _get_suggestion(session: AsyncSession, suggestion_id: uuid.UUID, workspace_id: uuid.UUID) -> CategorizationSuggestion:
    suggestion = (
        await session.execute(
            select(CategorizationSuggestion).where(
                CategorizationSuggestion.id == suggestion_id, CategorizationSuggestion.workspace_id == workspace_id
            )
        )
    ).scalar_one_or_none()
    if suggestion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Suggestion not found")
    return suggestion


@router.get("/settings", response_model=CategorizerSettings)
async def get_categorizer_settings(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Where to prefill the Automate tab from: the last run's server, else the
    deployment's configured one."""
    settings = get_settings()
    last = (
        await session.execute(
            select(CategorizationJob)
            .where(CategorizationJob.workspace_id == ctx.workspace.id)
            .order_by(CategorizationJob.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if last is not None:
        return CategorizerSettings(base_url=last.base_url, model=last.model)
    return CategorizerSettings(base_url=settings.categorizer_base_url, model=settings.categorizer_model)


@router.post("/test", response_model=CategorizerTestResult)
async def test_categorizer_connection(
    data: CategorizerTestRequest,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
):
    try:
        return CategorizerTestResult(models=await categorization_service.list_models(data.base_url))
    except categorization_service.CategorizerError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/jobs", response_model=CategorizationJobRead, status_code=status.HTTP_201_CREATED)
async def start_categorization(
    data: CategorizationJobCreate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    from app.tasks.categorization_tasks import run_categorization_job

    try:
        job = await categorization_service.create_job(session, ctx.workspace.id, ctx.user_id, data.base_url, data.model)
    except (ValueError, categorization_service.CategorizerError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    run_categorization_job.delay(str(job.id))
    return await _job_read(session, job)


@router.get("/jobs/latest", response_model=Optional[CategorizationJobRead])
async def latest_categorization(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    job = (
        await session.execute(
            select(CategorizationJob)
            .where(CategorizationJob.workspace_id == ctx.workspace.id)
            .order_by(CategorizationJob.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return await _job_read(session, job) if job is not None else None


@router.post("/jobs/{job_id}/cancel", response_model=CategorizationJobRead)
async def cancel_categorization(
    job_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    job = await _get_job(session, job_id, ctx.workspace.id)
    if job.status in ("pending", "running"):
        job.status = "cancelled"
        await session.commit()
        await session.refresh(job)
    return await _job_read(session, job)


@router.get("/jobs/{job_id}/suggestions", response_model=SuggestionList)
async def list_suggestions(
    job_id: uuid.UUID,
    status_filter: str = Query("pending", alias="status", pattern="^(pending|accepted|rejected)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    await _get_job(session, job_id, ctx.workspace.id)
    base = select(CategorizationSuggestion).where(
        CategorizationSuggestion.job_id == job_id, CategorizationSuggestion.status == status_filter
    )
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (
        await session.execute(
            base.order_by(CategorizationSuggestion.tx_count.desc(), CategorizationSuggestion.merchant_key).limit(limit).offset(offset)
        )
    ).scalars().all()
    return SuggestionList(items=[SuggestionRead.model_validate(r) for r in rows], total=total)


@router.get("/suggestions/{suggestion_id}/transactions", response_model=SuggestionTransactions)
async def suggestion_transactions(
    suggestion_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """The transactions a suggestion is about, so they can be inspected."""
    suggestion = await _get_suggestion(session, suggestion_id, ctx.workspace.id)
    rows, total = await categorization_service.suggestion_transactions(session, ctx.workspace.id, suggestion)
    return SuggestionTransactions(
        items=[
            SuggestionTransaction(
                id=tx.id, date=tx.date, description=tx.description, amount=tx.amount, currency=tx.currency,
                amount_primary=tx.amount_primary, type=tx.type, account_name=account, category_id=tx.category_id,
            )
            for tx, account in rows
        ],
        total=total,
    )


@router.post("/rules-for-accepted", response_model=RulesForAcceptedResult)
async def create_rules_for_accepted(
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Make rules for merchants accepted earlier without one."""
    considered, created = await categorization_service.create_rules_for_accepted(
        session, ctx.workspace.id, ctx.user_id
    )
    return RulesForAcceptedResult(considered=considered, created=created)


@router.post("/suggestions/{suggestion_id}/accept", response_model=SuggestionRead)
async def accept_suggestion(
    suggestion_id: uuid.UUID,
    data: AcceptSuggestionRequest,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    suggestion = await _get_suggestion(session, suggestion_id, ctx.workspace.id)
    category_id = data.category_id or suggestion.suggested_category_id
    if category_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a category")
    try:
        await categorization_service.apply_suggestion(session, ctx.workspace.id, suggestion, category_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    rule_created = False
    if data.create_rule:
        rule_created = await categorization_service.create_rule_for_suggestion(
            session, ctx.workspace.id, ctx.user_id, suggestion, category_id
        )
    await session.refresh(suggestion)
    result = SuggestionRead.model_validate(suggestion)
    result.rule_created = rule_created
    return result


@router.post("/suggestions/{suggestion_id}/reject", response_model=SuggestionRead)
async def reject_suggestion(
    suggestion_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    suggestion = await _get_suggestion(session, suggestion_id, ctx.workspace.id)
    suggestion.status = "rejected"
    await session.commit()
    await session.refresh(suggestion)
    return SuggestionRead.model_validate(suggestion)


@router.post("/jobs/{job_id}/accept-all", response_model=AcceptAllResult)
async def accept_all(
    job_id: uuid.UUID,
    data: AcceptAllRequest,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Accept every pending suggestion that has a category and meets the
    confidence bar (and, optionally, comes from one source)."""
    await _get_job(session, job_id, ctx.workspace.id)
    query = select(CategorizationSuggestion).where(
        CategorizationSuggestion.job_id == job_id,
        CategorizationSuggestion.status == "pending",
        CategorizationSuggestion.suggested_category_id.is_not(None),
    )
    if data.source:
        query = query.where(CategorizationSuggestion.source == data.source)
    floor = _CONFIDENCE_RANK[data.min_confidence]
    suggestions = [
        s for s in (await session.execute(query)).scalars().all() if _CONFIDENCE_RANK.get(s.confidence, 0) >= floor
    ]
    groups = await categorization_service._uncategorized(session, ctx.workspace.id)
    applied = 0
    rules = 0
    for suggestion in suggestions:
        applied += await categorization_service.apply_suggestion(
            session, ctx.workspace.id, suggestion, suggestion.suggested_category_id, groups=groups
        )
        if data.create_rules and await categorization_service.create_rule_for_suggestion(
            session, ctx.workspace.id, ctx.user_id, suggestion, suggestion.suggested_category_id
        ):
            rules += 1
    return AcceptAllResult(suggestions=len(suggestions), transactions=applied, rules_created=rules)
