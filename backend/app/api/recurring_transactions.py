import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import (
    WorkspaceContext,
    current_workspace,
    current_writable_workspace,
)
from app.schemas.recurring_transaction import (
    RecurringSuggestionRead,
    RecurringTransactionCreate,
    RecurringTransactionRead,
    RecurringTransactionUpdate,
)
from app.services import recurring_suggestion_service, recurring_transaction_service

router = APIRouter(prefix="/api/recurring-transactions", tags=["recurring-transactions"])


@router.get("", response_model=list[RecurringTransactionRead])
async def list_recurring_transactions(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    return await recurring_transaction_service.get_recurring_transactions(session, ctx.workspace.id)


@router.get("/suggestion/{transaction_id}", response_model=RecurringSuggestionRead)
async def suggest_recurring_from_transaction(
    transaction_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """What a transaction would look like as a recurring item: how often it
    repeats, judged from the matching transactions in the workspace."""
    suggestion = await recurring_suggestion_service.suggest_for_transaction(
        session, ctx.workspace.id, transaction_id
    )
    if suggestion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found")
    return suggestion


@router.post("/{recurring_id}/link/{transaction_id}", response_model=RecurringTransactionRead)
async def link_transaction_to_recurring(
    recurring_id: uuid.UUID,
    transaction_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Mark a transaction as an occurrence of an existing recurring item."""
    try:
        recurring = await recurring_transaction_service.link_transaction(
            session, recurring_id, transaction_id, ctx.workspace.id
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if recurring is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring or transaction not found")
    return recurring


@router.post("", response_model=RecurringTransactionRead, status_code=status.HTTP_201_CREATED)
async def create_recurring_transaction(
    data: RecurringTransactionCreate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        return await recurring_transaction_service.create_recurring_transaction(
            session, ctx.workspace.id, ctx.user_id, data
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.patch("/{recurring_id}", response_model=RecurringTransactionRead)
async def update_recurring_transaction(
    recurring_id: uuid.UUID,
    data: RecurringTransactionUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        recurring = await recurring_transaction_service.update_recurring_transaction(
            session, recurring_id, ctx.workspace.id, data
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not recurring:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring transaction not found")
    return recurring


@router.delete("/{recurring_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring_transaction(
    recurring_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    deleted = await recurring_transaction_service.delete_recurring_transaction(
        session, recurring_id, ctx.workspace.id
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring transaction not found")


@router.post("/generate")
async def generate_recurring_transactions(
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    count = await recurring_transaction_service.generate_pending(session, ctx.user_id)
    return {"generated": count}
