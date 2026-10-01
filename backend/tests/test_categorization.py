import json
import uuid
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.categorization import CategorizationSuggestion
from app.models.transaction import Transaction
from app.services import categorization_service as svc


def test_merchant_key_groups_reference_numbers_together():
    assert svc.merchant_key("NETFLIX.COM 4412") == svc.merchant_key("Netflix.com 9981") == "netflix com"
    assert svc.merchant_key(None) == ""
    assert len(svc.merchant_key("x" * 100)) == 40


@pytest.mark.parametrize(
    "given,expected",
    [
        ("http://100.1.2.3:1234", "http://100.1.2.3:1234/v1"),
        ("http://host:1234/v1/", "http://host:1234/v1"),
        ("host:1234", "http://host:1234/v1"),
    ],
)
def test_normalize_base_url(given, expected):
    assert svc.normalize_base_url(given) == expected


def test_an_empty_address_is_rejected():
    with pytest.raises(svc.CategorizerError):
        svc.normalize_base_url("  ")


async def _tx(session, user, workspace, account, description, amount="10.00", category=None, **kw):
    tx = Transaction(
        user_id=user.id, workspace_id=workspace.id, account_id=account.id, description=description,
        amount=Decimal(amount), currency="EUR", date=date(2026, 1, 5), type=kw.pop("type", "debit"),
        source=kw.pop("source", "manual"), status="posted", category_id=category.id if category else None, **kw,
    )
    session.add(tx)
    await session.commit()
    await session.refresh(tx)
    return tx


class FakeClassifier:
    """Answers with a fixed category for every merchant, remembering what it was asked."""

    def __init__(self, answers: dict[str, tuple[str, str]]):
        self.answers = answers
        self.calls: list[tuple[list[dict], list[str], list[str], list[str]]] = []

    async def classify(self, items, examples, categories, notes=()):
        self.calls.append((items, examples, categories, list(notes)))
        return {i["id"]: self.answers.get(i["merchant"], (categories[0], "low")) for i in items}


@pytest.fixture
async def setup(session, test_user, test_workspace, test_account, test_categories):
    food, transport, income = test_categories
    # History: the user already files "albert heijn" under food.
    await _tx(session, test_user, test_workspace, test_account, "ALBERT HEIJN 1", category=food)
    await _tx(session, test_user, test_workspace, test_account, "ALBERT HEIJN 2", category=food)
    # Uncategorized: one known merchant, one new, plus rows that must be left alone.
    for n in range(3):
        await _tx(session, test_user, test_workspace, test_account, f"Albert Heijn {n}0")
    for n in range(2):
        await _tx(session, test_user, test_workspace, test_account, f"STIB MIVB {n}")
    await _tx(session, test_user, test_workspace, test_account, "Opening", source="opening_balance")
    await _tx(session, test_user, test_workspace, test_account, "Own account move", is_ignored=True)
    return food, transport, income


async def _job(session, test_user, test_workspace):
    return await svc.create_job(session, test_workspace.id, test_user.id, "http://lm:1234", "m")


@pytest.mark.asyncio
async def test_run_job_answers_known_merchants_from_history_and_asks_the_model_for_the_rest(
    session, test_user, test_workspace, setup
):
    food, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    classifier = FakeClassifier({"stib mivb": (transport.name, "high")})
    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, classifier)

    await session.refresh(job)
    assert job.status == "completed"
    assert (job.total_merchants, job.processed_merchants) == (2, 2)

    rows = {s.merchant_key: s for s in (await session.execute(select(CategorizationSuggestion))).scalars()}
    assert set(rows) == {"albert heijn", "stib mivb"}
    assert (rows["albert heijn"].source, rows["albert heijn"].suggested_category_id) == ("history", food.id)
    assert rows["albert heijn"].tx_count == 3
    assert (rows["stib mivb"].source, rows["stib mivb"].suggested_category_id) == ("llm", transport.id)
    assert rows["stib mivb"].confidence == "high"

    # Only the unknown merchant reached the model, with the user's own history as examples.
    assert len(classifier.calls) == 1
    items, examples, categories, notes = classifier.calls[0]
    assert [i["merchant"] for i in items] == ["stib mivb"]
    assert examples == [f"albert heijn -> {food.name}"]
    assert transport.name in categories
    # The prompt describes every category, with the merchants the user usually files there.
    assert any(n.startswith(f"- {food.name}") and "[usually: albert heijn]" in n for n in notes)
    assert len(notes) == len(categories)

    # Nothing is applied until the user accepts.
    left = (await session.execute(select(Transaction).where(Transaction.category_id.is_(None)))).scalars().all()
    assert len(left) == 3 + 2 + 1 + 1  # opening balance and the ignored row stay out of the job, not out of the table


@pytest.mark.asyncio
async def test_accepting_categorizes_every_transaction_of_the_merchant(
    session, test_user, test_workspace, setup
):
    food, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "medium")}),
    )
    stib = (await session.execute(
        select(CategorizationSuggestion).where(CategorizationSuggestion.merchant_key == "stib mivb")
    )).scalar_one()

    assert await svc.apply_suggestion(session, test_workspace.id, stib, transport.id) == 2
    assert stib.status == "accepted"
    categorized = (await session.execute(
        select(Transaction).where(Transaction.description.like("STIB%"))
    )).scalars().all()
    assert {t.category_id for t in categorized} == {transport.id}


@pytest.mark.asyncio
async def test_a_failing_model_marks_the_job_failed_and_keeps_what_was_found(
    session, test_user, test_workspace, setup
):
    class Broken:
        async def classify(self, items, examples, categories, notes=()):
            raise svc.CategorizerUnavailable("server down")

    job = await _job(session, test_user, test_workspace)
    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, Broken())
    await session.refresh(job)
    assert (job.status, job.error) == ("failed", "server down")
    kept = (await session.execute(select(CategorizationSuggestion))).scalars().all()
    assert [s.merchant_key for s in kept] == ["albert heijn"]  # the history answer was already saved


@pytest.mark.asyncio
async def test_only_one_run_at_a_time_and_a_new_run_drops_unacted_suggestions(
    session, test_user, test_workspace, setup
):
    job = await _job(session, test_user, test_workspace)
    with pytest.raises(ValueError):
        await _job(session, test_user, test_workspace)

    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, FakeClassifier({}))
    assert len((await session.execute(select(CategorizationSuggestion))).scalars().all()) == 2
    second = await _job(session, test_user, test_workspace)
    assert second.id != job.id
    assert (await session.execute(select(CategorizationSuggestion))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_cancelled_job_stops_before_the_model_is_asked(session, test_user, test_workspace, setup):
    job = await _job(session, test_user, test_workspace)
    job.status = "cancelled"
    await session.commit()
    classifier = FakeClassifier({})
    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, classifier)
    assert classifier.calls == []


# --------------------------------------------------------------------------- API
@pytest.mark.asyncio
async def test_api_runs_and_accepts_suggestions(client, auth_headers, session, test_user, test_workspace, setup):
    food, transport, _ = setup
    with patch("app.tasks.categorization_tasks.run_categorization_job.delay") as delay:
        started = await client.post(
            "/api/categorization/jobs", json={"base_url": "lm:1234", "model": "m"}, headers=auth_headers
        )
    assert started.status_code == 201
    job_id = started.json()["id"]
    delay.assert_called_once_with(job_id)
    assert (await client.post("/api/categorization/jobs", json={"base_url": "lm", "model": "m"}, headers=auth_headers)).status_code == 400

    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), uuid.UUID(job_id),
        FakeClassifier({"stib mivb": (transport.name, "high")}),
    )

    latest = (await client.get("/api/categorization/jobs/latest", headers=auth_headers)).json()
    assert latest["status"] == "completed"
    assert latest["counts"] == {"pending": 2, "accepted": 0, "rejected": 0}

    listed = (await client.get(f"/api/categorization/jobs/{job_id}/suggestions", headers=auth_headers)).json()
    assert listed["total"] == 2
    assert [s["merchant_key"] for s in listed["items"]] == ["albert heijn", "stib mivb"]  # most transactions first

    stib = next(s for s in listed["items"] if s["merchant_key"] == "stib mivb")
    accepted = await client.post(f"/api/categorization/suggestions/{stib['id']}/accept", json={}, headers=auth_headers)
    assert accepted.status_code == 200
    assert (accepted.json()["status"], accepted.json()["applied_count"]) == ("accepted", 2)

    rejected_target = next(s for s in listed["items"] if s["merchant_key"] == "albert heijn")
    rejected = await client.post(f"/api/categorization/suggestions/{rejected_target['id']}/reject", headers=auth_headers)
    assert rejected.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_api_accept_all_respects_the_confidence_bar(client, auth_headers, session, test_user, test_workspace, setup):
    _, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "low")}),
    )
    result = await client.post(
        f"/api/categorization/jobs/{job.id}/accept-all", json={"min_confidence": "high"}, headers=auth_headers
    )
    # Only the history match (3 Albert Heijn rows) clears the bar; the low-confidence STIB guess waits.
    assert result.json() == {"suggestions": 1, "transactions": 3, "rules_created": 0}


@pytest.mark.asyncio
async def test_api_accept_without_any_category_is_refused(client, auth_headers, session, test_user, test_workspace, setup):
    job = await _job(session, test_user, test_workspace)
    suggestion = CategorizationSuggestion(
        job_id=job.id, workspace_id=test_workspace.id, merchant_key="x", sample_description="x",
        tx_type="debit", tx_count=1, suggested_category_id=None, confidence="low", source="llm",
    )
    session.add(suggestion)
    await session.commit()
    resp = await client.post(f"/api/categorization/suggestions/{suggestion.id}/accept", json={}, headers=auth_headers)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_api_connection_test_lists_models_or_explains(client, auth_headers):
    async def fake_models(url):
        return ["qwen3-4b-instruct-2507"]

    with patch.object(svc, "list_models", fake_models):
        ok = await client.post("/api/categorization/test", json={"base_url": "lm:1234"}, headers=auth_headers)
    assert ok.json() == {"models": ["qwen3-4b-instruct-2507"]}

    async def broken(url):
        raise svc.CategorizerError("Could not reach it")

    with patch.object(svc, "list_models", broken):
        bad = await client.post("/api/categorization/test", json={"base_url": "lm:1234"}, headers=auth_headers)
    assert bad.status_code == 400
    assert "Could not reach" in bad.json()["detail"]


@pytest.mark.asyncio
async def test_api_settings_fall_back_to_the_configured_server(client, auth_headers):
    resp = await client.get("/api/categorization/settings", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["model"]


# ------------------------------------------------------------------ LM Studio client
import httpx  # noqa: E402


def _mock_lm(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr(svc.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


@pytest.mark.asyncio
async def test_classifier_sends_a_schema_limited_to_the_real_categories(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        content = json.dumps({"results": [{"id": 0, "category": "Food", "confidence": "high"}]})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    _mock_lm(monkeypatch, handler)
    answers = await svc.LMStudioClassifier("lm:1234", "m").classify(
        [{"id": 0, "merchant": "delhaize", "type": "debit"}], ["colruyt -> Food"], ["Food", "Transport"]
    )
    assert answers == {0: ("Food", "high")}
    assert seen["url"] == "http://lm:1234/v1/chat/completions"
    assert seen["body"]["temperature"] == 0
    schema = seen["body"]["response_format"]["json_schema"]["schema"]
    assert schema["properties"]["results"]["items"]["properties"]["category"]["enum"] == ["Food", "Transport"]
    assert "colruyt -> Food" in seen["body"]["messages"][0]["content"]


@pytest.mark.asyncio
async def test_classifier_explains_a_model_that_returns_no_json(monkeypatch):
    _mock_lm(monkeypatch, lambda request: httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}))
    with pytest.raises(svc.CategorizerError, match="non-reasoning"):
        await svc.LMStudioClassifier("lm:1234", "m").classify([], [], ["Food"])


@pytest.mark.asyncio
async def test_classifier_reports_an_unreachable_server(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    _mock_lm(monkeypatch, handler)
    with pytest.raises(svc.CategorizerError, match="model server failed"):
        await svc.LMStudioClassifier("lm:1234", "m").classify([], [], ["Food"])


@pytest.mark.asyncio
async def test_list_models_reads_the_servers_catalogue(monkeypatch):
    _mock_lm(monkeypatch, lambda request: httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}]}))
    assert await svc.list_models("lm:1234") == ["a", "b"]


@pytest.mark.asyncio
async def test_one_rejected_item_does_not_stop_the_run(session, test_user, test_workspace, setup):
    """The server rejects any batch containing 'stib mivb'; the rest is still answered."""
    food, transport, _ = setup
    class Picky:
        def __init__(self):
            self.calls = 0

        async def classify(self, items, examples, categories, notes=()):
            self.calls += 1
            if len(items) > 1 or items[0]["merchant"] == "stib mivb":
                raise svc.CategorizerError("400 bad request")
            return {items[0]["id"]: (food.name, "high")}

    job = await _job(session, test_user, test_workspace)
    classifier = Picky()
    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, classifier)
    await session.refresh(job)
    assert job.status == "completed"
    rows = {s.merchant_key: s for s in (await session.execute(select(CategorizationSuggestion))).scalars()}
    assert rows["stib mivb"].suggested_category_id is None
    assert rows["stib mivb"].confidence == "low"


@pytest.mark.asyncio
async def test_an_unreachable_server_still_fails_the_run(session, test_user, test_workspace, setup):
    class Down:
        async def classify(self, items, examples, categories, notes=()):
            raise svc.CategorizerUnavailable("connection refused")

    job = await _job(session, test_user, test_workspace)
    await svc.run_job(async_sessionmaker(session.bind, expire_on_commit=False), job.id, Down())
    await session.refresh(job)
    assert (job.status, job.error) == ("failed", "connection refused")


@pytest.mark.asyncio
async def test_classifier_includes_the_servers_reason_for_a_rejection(monkeypatch):
    _mock_lm(monkeypatch, lambda request: httpx.Response(400, text='{"error":"context length exceeded"}'))
    with pytest.raises(svc.CategorizerError, match="context length exceeded") as caught:
        await svc.LMStudioClassifier("lm:1234", "m").classify([], [], ["Food"])
    assert not isinstance(caught.value, svc.CategorizerUnavailable)


# ------------------------------------------------------------------ rules from suggestions
import re  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from app.models.rule import Rule  # noqa: E402
from app.services import rule_engine  # noqa: E402


def _matches(pattern: str, description: str) -> bool:
    condition = {"field": "description", "op": "regex", "value": pattern}
    return rule_engine._match_condition(condition, SimpleNamespace(description=description))


def test_a_rule_pattern_finds_the_merchant_through_references_and_punctuation():
    pattern = svc.rule_pattern("netflix com")
    assert _matches(pattern, "NETFLIX.COM 4412")
    assert _matches(pattern, "Netflix.com 9981 AMSTERDAM")
    assert not _matches(pattern, "NETFLIXX COMMUNITY")
    stib = svc.rule_pattern("stib mivb")
    assert _matches(stib, "STIB-MIVB") and _matches(stib, "stib / mivb 123")


def test_a_rule_pattern_ignores_accents_and_does_not_match_inside_longer_words():
    pattern = svc.rule_pattern("café de flore")
    assert _matches(pattern, "CAFE DE FLORE PARIS")
    assert not _matches(svc.rule_pattern("temu"), "TEMUCO CHILE")
    # The merchant is the start of the description, not any word inside it.
    assert not _matches(svc.rule_pattern("paul"), "TO PAUL FINEAU")
    assert _matches(svc.rule_pattern("paul"), "Paul 8841")
    assert _matches(svc.rule_pattern("temu"), "Temu.com 1234")


def test_a_cut_key_drops_its_possibly_incomplete_last_word():
    key = svc.merchant_key("BIJDRAGE IN DE BEHEERSKOSTEN VAN UW GEBOUW")
    assert len(key) == 40
    pattern = svc.rule_pattern(key)
    assert _matches(pattern, "BIJDRAGE IN DE BEHEERSKOSTEN VAN UW GEBOUW 12")
    assert key.endswith("gebo") and "gebo" not in pattern.lower()  # the cut-off word is left out
    assert "beheerskosten" in pattern.lower()


@pytest.mark.parametrize("key", ["", "ok", "bp 1", "a b"])
def test_a_name_too_short_to_be_safe_gets_no_rule(key):
    assert svc.rule_pattern(key) is None
    assert re.compile(svc.rule_pattern("abcd")) is not None


@pytest.mark.asyncio
async def test_accepting_with_create_rule_adds_a_rule_that_does_not_recategorize_the_past(
    client, auth_headers, session, test_user, test_workspace, setup
):
    _, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "high")}),
    )
    stib = (await session.execute(
        select(CategorizationSuggestion).where(CategorizationSuggestion.merchant_key == "stib mivb")
    )).scalar_one()
    resp = await client.post(
        f"/api/categorization/suggestions/{stib.id}/accept", json={"create_rule": True}, headers=auth_headers
    )
    assert resp.status_code == 200
    assert resp.json()["rule_created"] is True

    rule = (await session.execute(select(Rule).where(Rule.name == "Auto: stib mivb"))).scalar_one()
    assert rule.actions == [{"op": "set_category", "value": str(transport.id)}]
    assert rule.conditions[0]["op"] == "regex"
    assert _matches(rule.conditions[0]["value"], "STIB-MIVB 8841")

    # A second accept for the same merchant does not duplicate the rule.
    repeat = await svc.create_rule_for_suggestion(session, test_workspace.id, test_user.id, stib, transport.id)
    assert repeat is False


@pytest.mark.asyncio
async def test_accept_without_the_flag_makes_no_rule_and_accept_all_counts_rules(
    client, auth_headers, session, test_user, test_workspace, setup
):
    _, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "high")}),
    )
    result = await client.post(
        f"/api/categorization/jobs/{job.id}/accept-all",
        json={"min_confidence": "high", "create_rules": True}, headers=auth_headers,
    )
    body = result.json()
    assert body["suggestions"] == 2 and body["rules_created"] == 2
    assert len((await session.execute(select(Rule))).scalars().all()) == 2


# ------------------------------------------------------------------ inspecting + retroactive rules
@pytest.mark.asyncio
async def test_a_suggestions_transactions_are_listed_for_inspection(
    client, auth_headers, session, test_user, test_workspace, setup
):
    _, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "high")}),
    )
    stib = (await session.execute(
        select(CategorizationSuggestion).where(CategorizationSuggestion.merchant_key == "stib mivb")
    )).scalar_one()
    listed = (await client.get(f"/api/categorization/suggestions/{stib.id}/transactions", headers=auth_headers)).json()
    assert listed["total"] == 2
    assert {t["description"] for t in listed["items"]} == {"STIB MIVB 0", "STIB MIVB 1"}
    assert all(t["type"] == "debit" and t["account_name"] for t in listed["items"])

    # Albert Heijn already has two categorized rows; a pending suggestion shows only the uncategorized three.
    ah = (await session.execute(
        select(CategorizationSuggestion).where(CategorizationSuggestion.merchant_key == "albert heijn")
    )).scalar_one()
    assert (await client.get(f"/api/categorization/suggestions/{ah.id}/transactions", headers=auth_headers)).json()["total"] == 3

    missing = await client.get(
        "/api/categorization/suggestions/00000000-0000-0000-0000-000000000000/transactions", headers=auth_headers
    )
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_rules_can_be_made_afterwards_for_merchants_accepted_without_one(
    client, auth_headers, session, test_user, test_workspace, setup
):
    _, transport, _ = setup
    job = await _job(session, test_user, test_workspace)
    await svc.run_job(
        async_sessionmaker(session.bind, expire_on_commit=False), job.id,
        FakeClassifier({"stib mivb": (transport.name, "high")}),
    )
    # Accepted earlier, no rule asked for.
    accept_all = await client.post(
        f"/api/categorization/jobs/{job.id}/accept-all", json={"min_confidence": "low"}, headers=auth_headers
    )
    assert accept_all.json()["rules_created"] == 0
    assert (await session.execute(select(Rule))).scalars().all() == []

    result = await client.post("/api/categorization/rules-for-accepted", headers=auth_headers)
    assert result.json() == {"considered": 2, "created": 2}
    rules = {r.name: r for r in (await session.execute(select(Rule))).scalars()}
    assert set(rules) == {"Auto: albert heijn", "Auto: stib mivb"}

    # Running it again changes nothing.
    again = await client.post("/api/categorization/rules-for-accepted", headers=auth_headers)
    assert again.json() == {"considered": 2, "created": 0}
