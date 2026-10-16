import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.services import vlcvx_service
from app.worker import celery_app

logger = logging.getLogger(__name__)


async def _run(details: bool) -> dict:
    engine = create_async_engine(get_settings().database_url)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            started, _ = await vlcvx_service.begin_sync(session)
            if not started:
                return {"skipped": "already running"}
            try:
                return await vlcvx_service.run_sync(session, details=details)
            except vlcvx_service.VlcvxUnavailable as exc:
                logger.warning("vlcvx sync: %s", exc)
                return {"error": str(exc)}
    finally:
        await engine.dispose()


@celery_app.task(name="app.tasks.vlcvx_tasks.sync_vlcvx")
def sync_vlcvx(details: bool = True) -> dict:
    """Celery task: copy the vlCVX bribe market from Llama Airforce into the database."""
    return asyncio.run(_run(details))
