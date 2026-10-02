from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.module_gate import require_module, require_module_write
from app.core.workspace_context import WorkspaceContext
from app.models.retirement_state import RetirementState
from app.schemas.retirement_state import RetirementStateRead, RetirementStateWrite
from app.services.module_service import ModuleId

router = APIRouter(prefix="/api/retirement", tags=["retirement"])

_read = require_module(ModuleId.RETIREMENT)
_write = require_module_write(ModuleId.RETIREMENT)


@router.get("/state", response_model=RetirementStateRead)
async def get_state(
    ctx: WorkspaceContext = Depends(_read),
    session: AsyncSession = Depends(get_async_session),
):
    row = await session.get(RetirementState, ctx.workspace.id)
    if row is None:
        return RetirementStateRead(data={})
    return RetirementStateRead(data=row.data or {}, updated_at=row.updated_at)


@router.put("/state", response_model=RetirementStateRead)
async def put_state(
    payload: RetirementStateWrite,
    ctx: WorkspaceContext = Depends(_write),
    session: AsyncSession = Depends(get_async_session),
):
    row = await session.get(RetirementState, ctx.workspace.id)
    if row is None:
        row = RetirementState(workspace_id=ctx.workspace.id, data=payload.data, updated_by_user_id=ctx.user_id)
        session.add(row)
    else:
        row.data = payload.data
        row.updated_by_user_id = ctx.user_id
    await session.commit()
    await session.refresh(row)
    return RetirementStateRead(data=row.data, updated_at=row.updated_at)
