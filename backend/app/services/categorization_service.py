"""Automatic categorization of uncategorized transactions with a local LLM.

Transactions are grouped by merchant, so thousands of transactions become a
few hundred decisions. A merchant the user has already categorized before is
answered from that history, with no model call; the rest go to the model in
batches, with the user's own categorized merchants as examples so it follows
their conventions. Nothing is applied automatically: every merchant becomes a
suggestion the user accepts or changes, which then categorizes all of that
merchant's transactions at once.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, Protocol

import httpx
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.categorization import CategorizationJob, CategorizationSuggestion
from app.models.category import Category
from app.models.transaction import Transaction
from app.schemas.rule import RuleAction, RuleCondition, RuleCreate
from app.services import rule_service

logger = logging.getLogger(__name__)

BATCH_SIZE = 40
EXAMPLE_COUNT = 150
HISTORY_AGREEMENT = 0.8
_NOISE = re.compile(r"[0-9*#/.\-]+")
_SPACES = re.compile(r"\s+")
CONFIDENCES = ("high", "medium", "low")


class CategorizerError(Exception):
    """The model server could not be reached or answered something unusable."""


class CategorizerUnavailable(CategorizerError):
    """The server cannot be reached at all, so retrying smaller batches is pointless."""


def merchant_key(description: Optional[str]) -> str:
    """The merchant a description belongs to: lower-case, with the digits and
    punctuation banks tack on removed, so 'NETFLIX.COM 4412' and
    'Netflix.com 9981' group together."""
    return _SPACES.sub(" ", _NOISE.sub(" ", (description or "").lower())).strip()[:40]


def normalize_base_url(url: str) -> str:
    """LM Studio serves the OpenAI-style API under /v1; accept it with or without."""
    cleaned = (url or "").strip().rstrip("/")
    if not cleaned:
        raise CategorizerError("The server address is empty")
    if not cleaned.startswith(("http://", "https://")):
        cleaned = "http://" + cleaned
    return cleaned if cleaned.endswith("/v1") else cleaned + "/v1"


async def list_models(base_url: str) -> list[str]:
    url = normalize_base_url(base_url) + "/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise CategorizerError(f"Could not reach {url}: {exc}") from exc
    return [m["id"] for m in response.json().get("data", [])]


class Classifier(Protocol):
    async def classify(
        self, items: list[dict], examples: list[str], categories: list[str], notes: list[str]
    ) -> dict[int, tuple[str, str]]:
        """Map each item id to (category name, confidence)."""
        ...


class LMStudioClassifier:
    """Asks an OpenAI-compatible server (LM Studio) for one category per item,
    constrained by a JSON schema so the answer can only be a real category."""

    def __init__(self, base_url: str, model: str, timeout: float = 600):
        self.url = normalize_base_url(base_url) + "/chat/completions"
        self.model = model
        self.timeout = timeout

    async def classify(self, items, examples, categories, notes=()):
        schema = {
            "type": "object",
            "properties": {
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "integer"},
                            "category": {"type": "string", "enum": categories},
                            "confidence": {"type": "string", "enum": list(CONFIDENCES)},
                        },
                        "required": ["id", "category", "confidence"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["results"],
            "additionalProperties": False,
        }
        prompt = build_prompt(items, examples, list(notes))
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_schema", "json_schema": {"name": "categories", "strict": True, "schema": schema}},
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(self.url, json=body)
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            results = json.loads(content)["results"]
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text.strip().replace("\n", " ")[:300]
            raise CategorizerError(f"The model server failed: {exc.response.status_code} {detail}") from exc
        except httpx.HTTPError as exc:
            raise CategorizerUnavailable(f"The model server failed: {exc}") from exc
        except (KeyError, IndexError, ValueError) as exc:
            raise CategorizerError(
                "The model did not return valid JSON. Use a non-reasoning (instruct) model."
            ) from exc
        return {int(r["id"]): (r["category"], r.get("confidence", "medium")) for r in results}


def build_prompt(items: list[dict], examples: list[str], notes: list[str]) -> str:
    header = (
        "You categorize bank transactions for one person who lives between Belgium, Portugal and Canada. "
        "Pick exactly one category from the allowed list for every item, and say how confident you are."
    )
    if notes:
        header += "\n\nAllowed categories, with what each is for:\n" + "\n".join(notes)
    shown = ""
    if examples:
        shown = (
            "\n\nFollow THEIR conventions, shown by these already-categorized merchants "
            "(merchant (debit/credit) -> category):\n" + "\n".join(examples)
        )
    return (
        header + shown
        + "\n\nCategorize every item below. Use the examples' conventions when a similar merchant appears; "
        "use confidence 'low' when you are guessing.\n\nItems (JSON):\n"
        + json.dumps(items, ensure_ascii=False)
    )


# ---------------------------------------------------------------------------
# data gathering
# ---------------------------------------------------------------------------
async def _uncategorized(session: AsyncSession, workspace_id: uuid.UUID) -> dict[str, dict]:
    rows = (
        await session.execute(
            select(Transaction.id, Transaction.description, Transaction.type, Transaction.amount, Transaction.amount_primary)
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.category_id.is_(None),
                Transaction.source != "opening_balance",
                Transaction.transfer_pair_id.is_(None),
                Transaction.is_ignored.is_(False),
            )
        )
    ).all()
    groups: dict[str, dict] = {}
    for tx_id, description, tx_type, amount, amount_primary in rows:
        key = merchant_key(description)
        if not key:
            continue
        g = groups.setdefault(
            key, {"key": key, "sample": description, "types": Counter(), "count": 0, "total": Decimal(0), "ids": []}
        )
        g["types"][tx_type] += 1
        g["count"] += 1
        g["total"] += Decimal(str(amount_primary if amount_primary is not None else amount))
        g["ids"].append(tx_id)
    for g in groups.values():
        g["type"] = g["types"].most_common(1)[0][0]
    return groups


async def _history(session: AsyncSession, workspace_id: uuid.UUID) -> dict[str, Counter]:
    rows = (
        await session.execute(
            select(Transaction.description, Transaction.category_id).where(
                Transaction.workspace_id == workspace_id,
                Transaction.category_id.is_not(None),
                Transaction.source != "opening_balance",
            )
        )
    ).all()
    history: dict[str, Counter] = defaultdict(Counter)
    for description, category_id in rows:
        key = merchant_key(description)
        if key:
            history[key][category_id] += 1
    return history


async def _assignable_categories(session: AsyncSession, workspace_id: uuid.UUID) -> list[Category]:
    return list(
        (
            await session.execute(
                select(Category)
                .where(Category.workspace_id == workspace_id, Category.is_hidden.is_(False))
                .order_by(Category.name)
            )
        ).scalars()
    )


# ---------------------------------------------------------------------------
# jobs
# ---------------------------------------------------------------------------
async def create_job(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, base_url: str, model: str
) -> CategorizationJob:
    running = (
        await session.execute(
            select(CategorizationJob.id).where(
                CategorizationJob.workspace_id == workspace_id,
                CategorizationJob.status.in_(("pending", "running")),
            )
        )
    ).first()
    if running is not None:
        raise ValueError("A categorization run is already in progress")
    normalized = normalize_base_url(base_url)
    # A new run replaces the suggestions nobody acted on.
    await session.execute(
        delete(CategorizationSuggestion).where(
            CategorizationSuggestion.workspace_id == workspace_id,
            CategorizationSuggestion.status == "pending",
        )
    )
    job = CategorizationJob(workspace_id=workspace_id, user_id=user_id, status="pending", base_url=normalized, model=model)
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return job


async def _finish(session_maker: async_sessionmaker, job_id: uuid.UUID, status: str, error: Optional[str] = None):
    async with session_maker() as session:
        job = await session.get(CategorizationJob, job_id)
        if job is not None and job.status not in ("cancelled",):
            job.status = status
            job.error = error
        if job is not None:
            job.finished_at = datetime.now(timezone.utc)
        await session.commit()


async def run_job(session_maker: async_sessionmaker, job_id: uuid.UUID, classifier: Classifier) -> None:
    """Build a suggestion for every merchant that still has uncategorized
    transactions. Safe to cancel between batches."""
    try:
        async with session_maker() as session:
            job = await session.get(CategorizationJob, job_id)
            if job is None or job.status == "cancelled":
                return
            job.status = "running"
            await session.commit()
            workspace_id = job.workspace_id

            categories = await _assignable_categories(session, workspace_id)
            if not categories:
                await _finish(session_maker, job_id, "failed", "There are no categories to choose from")
                return
            by_name = {c.name.strip(): c for c in categories}
            by_id = {c.id: c for c in categories}
            groups = await _uncategorized(session, workspace_id)
            history = await _history(session, workspace_id)

            job.total_merchants = len(groups)
            pending_llm: list[dict] = []
            for g in sorted(groups.values(), key=lambda g: -g["count"]):
                seen = history.get(g["key"])
                top = seen.most_common(1)[0] if seen else None
                if top and top[0] in by_id and top[1] / sum(seen.values()) >= HISTORY_AGREEMENT:
                    session.add(_suggestion(job_id, workspace_id, g, top[0], "high" if sum(seen.values()) >= 2 else "medium", "history"))
                    job.processed_merchants += 1
                else:
                    pending_llm.append(g)
            await session.commit()

            examples = _examples(history, by_id)
            notes = await _category_notes(session, categories, history)
            names = [c.name.strip() for c in categories]
            for start in range(0, len(pending_llm), BATCH_SIZE):
                await session.refresh(job)
                if job.status == "cancelled":
                    return
                batch = pending_llm[start : start + BATCH_SIZE]
                items = [{"id": i, "merchant": g["key"], "type": g["type"]} for i, g in enumerate(batch)]
                answers = await _classify_resilient(classifier, items, examples, names, notes)
                for i, g in enumerate(batch):
                    name, confidence = answers.get(i, (None, "low"))
                    category = by_name.get(name.strip()) if name else None
                    session.add(
                        _suggestion(job_id, workspace_id, g, category.id if category else None, confidence if confidence in CONFIDENCES else "low", "llm")
                    )
                    job.processed_merchants += 1
                await session.commit()
        await _finish(session_maker, job_id, "completed")
    except CategorizerError as exc:
        logger.warning("Categorization job %s failed: %s", job_id, exc)
        await _finish(session_maker, job_id, "failed", str(exc))
    except Exception as exc:  # noqa: BLE001 - a background job must record, not crash
        logger.exception("Categorization job %s crashed", job_id)
        await _finish(session_maker, job_id, "failed", f"Unexpected error: {exc}")


async def _classify_resilient(classifier, items, examples, names, notes):
    """Ask for a batch; if the server rejects it, ask for each half instead, so
    one bad item costs that item (left uncategorized, low confidence) and not
    the whole run. A server that cannot be reached still stops the run."""
    try:
        return await classifier.classify(items, examples, names, notes)
    except CategorizerUnavailable:
        raise
    except CategorizerError as exc:
        if len(items) == 1:
            logger.warning("Skipping %r: %s", items[0]["merchant"], exc)
            return {items[0]["id"]: (None, "low")}
        middle = len(items) // 2
        answers = {}
        for half in (items[:middle], items[middle:]):
            answers.update(await _classify_resilient(classifier, half, examples, names, notes))
        return answers


def _suggestion(job_id, workspace_id, group, category_id, confidence, source) -> CategorizationSuggestion:
    return CategorizationSuggestion(
        job_id=job_id,
        workspace_id=workspace_id,
        merchant_key=group["key"],
        sample_description=(group["sample"] or "")[:500],
        tx_type=group["type"],
        tx_count=group["count"],
        total_amount_primary=group["total"],
        suggested_category_id=category_id,
        confidence=confidence,
        source=source,
    )


async def _category_notes(session: AsyncSession, categories: list[Category], history: dict[str, Counter]) -> list[str]:
    """One line per category: its group, the owner's description of it, and the
    merchants they most often put in it. This is what lets a small model place a
    category it has no examples for."""
    from app.models.category_group import CategoryGroup

    groups = {g.id: g.name for g in (await session.execute(select(CategoryGroup))).scalars()}
    typical: dict[uuid.UUID, list[str]] = defaultdict(list)
    for key, counts in sorted(history.items(), key=lambda kv: -sum(kv[1].values())):
        category_id = counts.most_common(1)[0][0]
        if len(typical[category_id]) < 3:
            typical[category_id].append(key)
    lines = []
    for c in categories:
        line = f"- {c.name.strip()}"
        if c.group_id in groups and groups[c.group_id].strip() != c.name.strip():
            line += f" (group: {groups[c.group_id].strip()})"
        if c.description:
            line += f": {c.description.strip()}"
        if typical.get(c.id):
            line += f" [usually: {', '.join(typical[c.id])}]"
        lines.append(line)
    return lines


def _examples(history: dict[str, Counter], by_id: dict) -> list[str]:
    """The user's most used merchants with the category they usually chose."""
    ranked = sorted(history.items(), key=lambda kv: -sum(kv[1].values()))
    lines = []
    for key, counts in ranked:
        category_id = counts.most_common(1)[0][0]
        if category_id in by_id:
            lines.append(f"{key} -> {by_id[category_id].name.strip()}")
        if len(lines) >= EXAMPLE_COUNT:
            break
    return lines


# ---------------------------------------------------------------------------
# rules from accepted suggestions
# ---------------------------------------------------------------------------
MIN_RULE_LETTERS = 4
_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def rule_pattern(key: str) -> Optional[str]:
    """A regex that finds this merchant in a raw description, or None when the
    name is too short or generic to build a safe rule from.

    The words of the merchant key must open the description, in order, separated
    by anything that is not a letter, and not be part of a longer word. A key that was cut
    at the length limit loses its last word, which may be incomplete."""
    words = [_strip_accents(w) for w in _WORD.findall(key)]
    if len(key) >= 40 and len(words) > 1:
        words = words[:-1]
    if sum(len(w) for w in words) < MIN_RULE_LETTERS:
        return None
    separator = r"[^A-Za-z]+"
    # Anchored at the start: a merchant key is the beginning of a description,
    # so "paul" must not also catch "to paul fineau" or "louis delhaize".
    return r"\A[^A-Za-z]*" + separator.join(re.escape(w) for w in words) + r"(?![A-Za-z])"


async def create_rule_for_suggestion(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    suggestion: CategorizationSuggestion,
    category_id: uuid.UUID,
) -> bool:
    """Make a rule so future transactions of the merchant are categorized on
    import. False when the merchant is too generic for a safe rule or a rule
    for it already exists. Existing transactions are not touched: accepting
    already categorized them."""
    pattern = rule_pattern(suggestion.merchant_key)
    if pattern is None:
        return False
    try:
        await rule_service.create_rule(
            session,
            workspace_id,
            user_id,
            RuleCreate(
                name=f"Auto: {suggestion.merchant_key}"[:255],
                conditions=[RuleCondition(field="description", op="regex", value=pattern)],
                actions=[RuleAction(op="set_category", value=str(category_id))],
                apply_to_existing=False,
            ),
        )
    except rule_service.DuplicateRuleError:
        return False
    except ValueError as exc:
        logger.warning("No rule for %r: %s", suggestion.merchant_key, exc)
        return False
    return True


# ---------------------------------------------------------------------------
# acting on suggestions
# ---------------------------------------------------------------------------
async def apply_suggestion(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    suggestion: CategorizationSuggestion,
    category_id: uuid.UUID,
    groups: Optional[dict[str, dict]] = None,
) -> int:
    """Give every still-uncategorized transaction of the suggestion's merchant
    the category. Returns how many were categorized."""
    category = (
        await session.execute(select(Category).where(Category.id == category_id, Category.workspace_id == workspace_id))
    ).scalar_one_or_none()
    if category is None:
        raise ValueError("Category not found")
    if groups is None:
        groups = await _uncategorized(session, workspace_id)
    ids = groups.get(suggestion.merchant_key, {}).get("ids", [])
    for start in range(0, len(ids), 500):
        await session.execute(
            update(Transaction)
            .where(Transaction.id.in_(ids[start : start + 500]), Transaction.workspace_id == workspace_id)
            .values(category_id=category_id)
        )
    suggestion.status = "accepted"
    suggestion.suggested_category_id = category_id
    suggestion.applied_count = len(ids)
    await session.commit()
    return len(ids)
