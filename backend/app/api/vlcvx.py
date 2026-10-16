from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.module_gate import require_module, require_module_write
from app.core.workspace_context import WorkspaceContext
from app.schemas.vlcvx import Breakdown, RoundDetail, RoundSummary, SyncStatus, VlcvxSummary
from app.services import vlcvx_service
from app.services.module_service import ModuleId

router = APIRouter(prefix="/api/vlcvx", tags=["vlcvx"])

_read = require_module(ModuleId.VLCVX)
_write = require_module_write(ModuleId.VLCVX)


def _check(protocol: str) -> None:
    if protocol not in vlcvx_service.PROTOCOLS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown protocol")


@router.get("/summary", response_model=VlcvxSummary)
async def get_summary(ctx: WorkspaceContext = Depends(_read), session: AsyncSession = Depends(get_async_session)):
    """What is stored for each protocol, and whether a sync is running."""
    return await vlcvx_service.summary(session)


@router.post("/refresh", response_model=SyncStatus, status_code=status.HTTP_202_ACCEPTED)
async def refresh(ctx: WorkspaceContext = Depends(_write), session: AsyncSession = Depends(get_async_session)):
    """Start copying the latest data from Llama Airforce in the background."""
    from app.core.config import get_settings

    if not get_settings().llama_airforce_url:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The vlCVX data source is switched off.")
    started, row = await vlcvx_service.begin_sync(session)
    if started:
        from app.tasks.vlcvx_tasks import sync_vlcvx

        try:
            sync_vlcvx.delay()
        except Exception as exc:  # the broker is down: do not leave the row saying "running"
            row.state, row.error = "failed", f"Could not start the sync: {exc}"[:500]
            await session.commit()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not start the sync.")
    return {"state": row.state, "started_at": row.started_at, "finished_at": row.finished_at, "error": row.error, "done": row.done, "total": row.total}


@router.get("/{protocol}/rounds", response_model=list[RoundSummary])
async def list_rounds(protocol: str, ctx: WorkspaceContext = Depends(_read), session: AsyncSession = Depends(get_async_session)):
    """Every stored round of a protocol, oldest first."""
    _check(protocol)
    return await vlcvx_service.list_rounds(session, protocol)


@router.get("/{protocol}/breakdown", response_model=Breakdown)
async def get_breakdown(protocol: str, ctx: WorkspaceContext = Depends(_read), session: AsyncSession = Depends(get_async_session)):
    """What was paid in each round by token, and the pools bribed most over all rounds."""
    _check(protocol)
    return await vlcvx_service.breakdown(session, protocol)


@router.get("/{protocol}/rounds/{round_number}", response_model=RoundDetail)
async def get_round(protocol: str, round_number: int, ctx: WorkspaceContext = Depends(_read), session: AsyncSession = Depends(get_async_session)):
    """One round: the pools bribed, with what, and how many votes each got."""
    _check(protocol)
    detail = await vlcvx_service.round_detail(session, protocol, round_number)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Round not found")
    return detail
