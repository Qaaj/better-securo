"""Photos of assets, kept in the attachment storage."""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.asset import Asset
from app.models.asset_photo import AssetPhoto
from app.providers import get_storage_provider
from app.services.attachment_service import sanitize_filename

# What a browser shows without help: the app does not convert photos.
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}
MAX_PHOTOS_PER_ASSET = 40


async def _asset(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID) -> Asset:
    asset = (
        await session.execute(select(Asset).where(Asset.id == asset_id, Asset.workspace_id == workspace_id))
    ).scalar_one_or_none()
    if asset is None:
        raise LookupError("Asset not found")
    return asset


async def _photo(session: AsyncSession, photo_id: uuid.UUID, workspace_id: uuid.UUID) -> AssetPhoto:
    photo = (
        await session.execute(select(AssetPhoto).where(AssetPhoto.id == photo_id, AssetPhoto.workspace_id == workspace_id))
    ).scalar_one_or_none()
    if photo is None:
        raise LookupError("Photo not found")
    return photo


def as_read(photo: AssetPhoto, cover_id: Optional[uuid.UUID]) -> dict:
    return {
        "id": photo.id,
        "asset_id": photo.asset_id,
        "filename": photo.filename,
        "content_type": photo.content_type,
        "size": photo.size,
        "caption": photo.caption,
        "position": photo.position,
        "is_cover": photo.id == cover_id,
        "created_at": photo.created_at,
    }


async def list_photos(session: AsyncSession, asset_id: uuid.UUID, workspace_id: uuid.UUID) -> list[dict]:
    asset = await _asset(session, asset_id, workspace_id)
    rows = (
        await session.execute(
            select(AssetPhoto)
            .where(AssetPhoto.asset_id == asset_id, AssetPhoto.workspace_id == workspace_id)
            .order_by(AssetPhoto.position, AssetPhoto.created_at)
        )
    ).scalars().all()
    return [as_read(p, asset.cover_photo_id) for p in rows]


async def upload_photo(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    asset_id: uuid.UUID,
    filename: str,
    content_type: str,
    data: bytes,
    caption: Optional[str] = None,
) -> dict:
    asset = await _asset(session, asset_id, workspace_id)
    filename = sanitize_filename(filename)
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in ALLOWED_EXTENSIONS or not (content_type or "").startswith("image/"):
        raise ValueError("Photos must be JPEG, PNG, WebP or GIF images.")
    settings = get_settings()
    if len(data) > settings.storage_max_file_size_mb * 1024 * 1024:
        raise ValueError(f"File too large. Maximum size is {settings.storage_max_file_size_mb} MB.")
    count = await session.scalar(select(func.count()).select_from(AssetPhoto).where(AssetPhoto.asset_id == asset_id)) or 0
    if count >= MAX_PHOTOS_PER_ASSET:
        raise ValueError(f"At most {MAX_PHOTOS_PER_ASSET} photos per asset.")

    storage_key = f"{workspace_id}/assets/{asset_id}/{uuid.uuid4().hex[:8]}_{filename}"
    stored = await get_storage_provider().upload(storage_key, data, content_type)
    photo = AssetPhoto(
        asset_id=asset_id,
        workspace_id=workspace_id,
        user_id=user_id,
        filename=filename,
        storage_key=stored.storage_key,
        content_type=stored.content_type,
        size=stored.size,
        caption=(caption or None),
        position=count,
    )
    session.add(photo)
    await session.flush()
    if asset.cover_photo_id is None:
        asset.cover_photo_id = photo.id
    await session.commit()
    await session.refresh(photo)
    await session.refresh(asset)
    return as_read(photo, asset.cover_photo_id)


async def read_photo(session: AsyncSession, photo_id: uuid.UUID, workspace_id: uuid.UUID) -> tuple[AssetPhoto, bytes]:
    photo = await _photo(session, photo_id, workspace_id)
    return photo, await get_storage_provider().download(photo.storage_key)


async def update_photo(
    session: AsyncSession, photo_id: uuid.UUID, workspace_id: uuid.UUID, changes: dict
) -> dict:
    photo = await _photo(session, photo_id, workspace_id)
    asset = await _asset(session, photo.asset_id, workspace_id)
    if "caption" in changes:
        photo.caption = changes["caption"] or None
    if changes.get("position") is not None:
        photo.position = changes["position"]
    if changes.get("is_cover") is True:
        asset.cover_photo_id = photo.id
    await session.commit()
    await session.refresh(photo)
    await session.refresh(asset)
    return as_read(photo, asset.cover_photo_id)


async def delete_photo(session: AsyncSession, photo_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
    photo = await _photo(session, photo_id, workspace_id)
    asset = await _asset(session, photo.asset_id, workspace_id)
    key = photo.storage_key
    await session.delete(photo)
    await session.flush()
    if asset.cover_photo_id == photo.id:
        next_photo = (
            await session.execute(
                select(AssetPhoto)
                .where(AssetPhoto.asset_id == asset.id)
                .order_by(AssetPhoto.position, AssetPhoto.created_at)
                .limit(1)
            )
        ).scalar_one_or_none()
        asset.cover_photo_id = next_photo.id if next_photo else None
    await session.commit()
    try:
        await get_storage_provider().delete(key)
    except Exception:
        pass  # best-effort: the row is gone either way
