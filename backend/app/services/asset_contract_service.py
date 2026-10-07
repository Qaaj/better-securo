"""Contracts, utilities and documents tied to an asset."""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.asset import Asset
from app.models.asset_contract import AssetContract, AssetDocument
from app.models.recurring_transaction import RecurringTransaction
from app.providers import get_storage_provider
from app.services.attachment_service import sanitize_filename

MAX_DOCUMENTS_PER_ASSET = 200


async def _asset(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID) -> Asset:
    asset = (await session.execute(select(Asset).where(Asset.id == asset_id, Asset.workspace_id == workspace_id))).scalar_one_or_none()
    if asset is None:
        raise LookupError("Asset not found")
    return asset


async def _contract(session: AsyncSession, contract_id: uuid.UUID, workspace_id: uuid.UUID) -> AssetContract:
    contract = (
        await session.execute(select(AssetContract).where(AssetContract.id == contract_id, AssetContract.workspace_id == workspace_id))
    ).scalar_one_or_none()
    if contract is None:
        raise LookupError("Contract not found")
    return contract


async def _check_recurring(session: AsyncSession, recurring_id: Optional[uuid.UUID], workspace_id: uuid.UUID) -> None:
    if recurring_id is None:
        return
    found = (
        await session.execute(
            select(RecurringTransaction.id).where(RecurringTransaction.id == recurring_id, RecurringTransaction.workspace_id == workspace_id)
        )
    ).scalar_one_or_none()
    if found is None:
        raise ValueError("The recurring item was not found")


def _read(contract: AssetContract, recurring: Optional[RecurringTransaction], documents: int, today: date) -> dict:
    days_left = (contract.end_date - today).days if contract.end_date else None
    notice_by = None
    if contract.end_date and contract.notice_days is not None:
        notice_by = contract.end_date - timedelta(days=contract.notice_days)
    return {
        "id": contract.id,
        "asset_id": contract.asset_id,
        "kind": contract.kind,
        "provider": contract.provider,
        "contract_number": contract.contract_number,
        "customer_number": contract.customer_number,
        "meter_number": contract.meter_number,
        "start_date": contract.start_date,
        "end_date": contract.end_date,
        "notice_days": contract.notice_days,
        "recurring_id": contract.recurring_id,
        "notes": contract.notes,
        "created_at": contract.created_at,
        "recurring": None
        if recurring is None
        else {
            "id": recurring.id,
            "description": recurring.description,
            "amount": recurring.amount,
            "currency": recurring.currency,
            "frequency": recurring.frequency,
            "is_active": recurring.is_active,
            "amount_primary": float(recurring.amount_primary) if recurring.amount_primary is not None else None,
        },
        "document_count": documents,
        "days_left": days_left,
        "notice_by": notice_by,
    }


async def list_contracts(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID, today: Optional[date] = None) -> list[dict]:
    await _asset(session, asset_id, workspace_id)
    today = today or date.today()
    rows = (
        await session.execute(
            select(AssetContract, RecurringTransaction)
            .outerjoin(RecurringTransaction, RecurringTransaction.id == AssetContract.recurring_id)
            .where(AssetContract.asset_id == asset_id, AssetContract.workspace_id == workspace_id)
            .order_by(AssetContract.kind, AssetContract.provider)
        )
    ).all()
    counts = dict(
        (
            await session.execute(
                select(AssetDocument.contract_id, func.count())
                .where(AssetDocument.asset_id == asset_id, AssetDocument.contract_id.is_not(None))
                .group_by(AssetDocument.contract_id)
            )
        ).all()
    )
    return [_read(c, r, counts.get(c.id, 0), today) for c, r in rows]


async def _one(session: AsyncSession, contract: AssetContract) -> dict:
    recurring = (
        await session.get(RecurringTransaction, contract.recurring_id) if contract.recurring_id else None
    )
    documents = await session.scalar(select(func.count()).select_from(AssetDocument).where(AssetDocument.contract_id == contract.id)) or 0
    return _read(contract, recurring, documents, date.today())


async def create_contract(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID, data: dict) -> dict:
    await _asset(session, asset_id, workspace_id)
    await _check_recurring(session, data.get("recurring_id"), workspace_id)
    contract = AssetContract(asset_id=asset_id, workspace_id=workspace_id, **data)
    session.add(contract)
    await session.commit()
    await session.refresh(contract)
    return await _one(session, contract)


async def update_contract(session: AsyncSession, contract_id: uuid.UUID, workspace_id: uuid.UUID, changes: dict) -> dict:
    contract = await _contract(session, contract_id, workspace_id)
    if "recurring_id" in changes:
        await _check_recurring(session, changes["recurring_id"], workspace_id)
    for key, value in changes.items():
        if key in ("kind", "provider") and value is None:
            continue
        setattr(contract, key, value)
    await session.commit()
    await session.refresh(contract)
    return await _one(session, contract)


async def delete_contract(session: AsyncSession, contract_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
    contract = await _contract(session, contract_id, workspace_id)
    # The documents stay with the asset, no longer attached to this contract.
    await session.execute(update(AssetDocument).where(AssetDocument.contract_id == contract_id).values(contract_id=None))
    await session.delete(contract)
    await session.commit()


# ------------------------------------------------------------------ documents
async def _document(session: AsyncSession, document_id: uuid.UUID, workspace_id: uuid.UUID) -> AssetDocument:
    document = (
        await session.execute(select(AssetDocument).where(AssetDocument.id == document_id, AssetDocument.workspace_id == workspace_id))
    ).scalar_one_or_none()
    if document is None:
        raise LookupError("Document not found")
    return document


async def list_documents(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID) -> list[AssetDocument]:
    await _asset(session, asset_id, workspace_id)
    rows = (
        await session.execute(
            select(AssetDocument)
            .where(AssetDocument.asset_id == asset_id, AssetDocument.workspace_id == workspace_id)
            .order_by(AssetDocument.kind, AssetDocument.title)
        )
    ).scalars().all()
    return list(rows)


async def upload_document(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    asset_id: uuid.UUID,
    filename: str,
    content_type: str,
    data: bytes,
    *,
    kind: str,
    title: Optional[str],
    contract_id: Optional[uuid.UUID],
    document_date: Optional[date],
    expires_on: Optional[date],
) -> AssetDocument:
    await _asset(session, asset_id, workspace_id)
    if contract_id is not None:
        contract = await _contract(session, contract_id, workspace_id)
        if contract.asset_id != asset_id:
            raise ValueError("That contract belongs to another asset")
    filename = sanitize_filename(filename)
    settings = get_settings()
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    allowed = {e.strip().lower() for e in settings.storage_allowed_extensions.split(",")}
    if extension not in allowed:
        raise ValueError(f"File type '.{extension}' is not allowed. Allowed: {', '.join(sorted(allowed))}")
    if len(data) > settings.storage_max_file_size_mb * 1024 * 1024:
        raise ValueError(f"File too large. Maximum size is {settings.storage_max_file_size_mb} MB.")
    count = await session.scalar(select(func.count()).select_from(AssetDocument).where(AssetDocument.asset_id == asset_id)) or 0
    if count >= MAX_DOCUMENTS_PER_ASSET:
        raise ValueError(f"At most {MAX_DOCUMENTS_PER_ASSET} documents per asset.")

    storage_key = f"{workspace_id}/assets/{asset_id}/docs/{uuid.uuid4().hex[:8]}_{filename}"
    stored = await get_storage_provider().upload(storage_key, data, content_type)
    document = AssetDocument(
        asset_id=asset_id,
        workspace_id=workspace_id,
        user_id=user_id,
        contract_id=contract_id,
        kind=kind,
        title=(title or filename.rsplit(".", 1)[0]).strip()[:300] or filename,
        filename=filename,
        storage_key=stored.storage_key,
        content_type=stored.content_type,
        size=stored.size,
        document_date=document_date,
        expires_on=expires_on,
    )
    session.add(document)
    await session.commit()
    await session.refresh(document)
    return document


async def read_document(session: AsyncSession, document_id: uuid.UUID, workspace_id: uuid.UUID) -> tuple[AssetDocument, bytes]:
    document = await _document(session, document_id, workspace_id)
    return document, await get_storage_provider().download(document.storage_key)


async def update_document(session: AsyncSession, document_id: uuid.UUID, workspace_id: uuid.UUID, changes: dict) -> AssetDocument:
    document = await _document(session, document_id, workspace_id)
    if changes.get("contract_id") is not None:
        contract = await _contract(session, changes["contract_id"], workspace_id)
        if contract.asset_id != document.asset_id:
            raise ValueError("That contract belongs to another asset")
    for key, value in changes.items():
        if key in ("kind", "title") and value is None:
            continue
        setattr(document, key, value)
    await session.commit()
    await session.refresh(document)
    return document


async def delete_document(session: AsyncSession, document_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
    document = await _document(session, document_id, workspace_id)
    key = document.storage_key
    await session.delete(document)
    await session.commit()
    try:
        await get_storage_provider().delete(key)
    except Exception:
        pass  # best-effort: the row is gone either way
