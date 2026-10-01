import asyncio
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models.categorization import CategorizationJob
from app.services import categorization_service
from app.worker import celery_app

logger = logging.getLogger(__name__)


async def _run(job_id: uuid.UUID) -> None:
    engine = create_async_engine(get_settings().database_url)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with session_maker() as session:
            job = await session.get(CategorizationJob, job_id)
            if job is None:
                return
            classifier = categorization_service.LMStudioClassifier(job.base_url, job.model)
        await categorization_service.run_job(session_maker, job_id, classifier)
    finally:
        await engine.dispose()


@celery_app.task(name="app.tasks.categorization_tasks.run_categorization_job")
def run_categorization_job(job_id: str) -> dict:
    """Celery task: categorize a workspace's uncategorized transactions with the local LLM."""
    asyncio.run(_run(uuid.UUID(job_id)))
    return {"job_id": job_id}
