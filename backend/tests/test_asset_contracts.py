import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

from app.schemas.recurring_transaction import RecurringTransactionCreate
from app.services import asset_contract_service
from app.services.recurring_transaction_service import create_recurring_transaction


@dataclass
class Stored:
    storage_key: str
    size: int
    content_type: str


def _storage():
    mock = AsyncMock()
    mock.upload.side_effect = lambda key, data, ct: Stored(storage_key=key, size=len(data), content_type=ct)
    mock.download.return_value = b"pdf-bytes"
    mock.delete.return_value = None
    return mock


STORAGE = "app.services.asset_contract_service.get_storage_provider"


async def _asset(client, headers, name="House"):
    response = await client.post("/api/assets", json={"name": name, "type": "real_estate", "currency": "USD", "current_value": 1000}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _recurring(session, user, workspace, account, description="Electricity", amount="85.00"):
    return await create_recurring_transaction(
        session, workspace.id, user.id,
        RecurringTransactionCreate(
            description=description, amount=Decimal(amount), currency="BRL", type="debit",
            frequency="monthly", start_date=date(2026, 1, 5), account_id=account.id,
        ),
    )


async def _upload(client, headers, asset_id, filename="contract.pdf", content_type="application/pdf", **form):
    return await client.post(
        f"/api/assets/{asset_id}/documents",
        files={"file": (filename, b"%PDF-1.4 test", content_type)},
        data=form or None,
        headers=headers,
    )


@pytest.mark.asyncio
async def test_a_contract_with_dates_gets_days_left_and_a_notice_deadline(client, auth_headers):
    asset = await _asset(client, auth_headers)
    end = date.today() + timedelta(days=100)
    created = await client.post(
        f"/api/assets/{asset['id']}/contracts",
        json={"kind": "energy", "provider": "Power Co", "contract_number": "C-1", "meter_number": "M-9", "end_date": end.isoformat(), "notice_days": 30},
        headers=auth_headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["days_left"] == 100
    assert body["notice_by"] == (end - timedelta(days=30)).isoformat()
    assert body["recurring"] is None and body["document_count"] == 0

    listed = (await client.get(f"/api/assets/{asset['id']}/contracts", headers=auth_headers)).json()
    assert [c["provider"] for c in listed] == ["Power Co"]

    # An open-ended contract has no countdown.
    open_ended = (await client.post(f"/api/assets/{asset['id']}/contracts", json={"kind": "water", "provider": "Water Co"}, headers=auth_headers)).json()
    assert open_ended["days_left"] is None and open_ended["notice_by"] is None


@pytest.mark.asyncio
async def test_linking_a_recurring_item_brings_its_cost_and_can_be_undone(client, auth_headers, session, test_user, test_workspace, test_account):
    asset = await _asset(client, auth_headers)
    rt = await _recurring(session, test_user, test_workspace, test_account)
    contract = (await client.post(f"/api/assets/{asset['id']}/contracts", json={"kind": "energy", "provider": "Power Co", "recurring_id": str(rt.id)}, headers=auth_headers)).json()
    assert contract["recurring"]["description"] == "Electricity"
    assert float(contract["recurring"]["amount"]) == 85.0 and contract["recurring"]["frequency"] == "monthly"

    unlinked = await client.patch(f"/api/assets/contracts/{contract['id']}", json={"recurring_id": None}, headers=auth_headers)
    assert unlinked.status_code == 200 and unlinked.json()["recurring"] is None
    relinked = await client.patch(f"/api/assets/contracts/{contract['id']}", json={"recurring_id": str(rt.id), "provider": "New Power Co"}, headers=auth_headers)
    assert relinked.json()["recurring"]["id"] == str(rt.id) and relinked.json()["provider"] == "New Power Co"

    # Removing the recurring item leaves the contract.
    unknown = await client.patch(f"/api/assets/contracts/{contract['id']}", json={"recurring_id": str(uuid.uuid4())}, headers=auth_headers)
    assert unknown.status_code == 400
    assert (await client.delete(f"/api/assets/contracts/{contract['id']}", headers=auth_headers)).status_code == 204
    assert (await client.get(f"/api/assets/{asset['id']}/contracts", headers=auth_headers)).json() == []


@pytest.mark.asyncio
async def test_validation_and_unknown_things(client, auth_headers):
    asset = await _asset(client, auth_headers)
    url = f"/api/assets/{asset['id']}/contracts"
    assert (await client.post(url, json={"kind": "bogus", "provider": "X"}, headers=auth_headers)).status_code == 422
    assert (await client.post(url, json={"kind": "energy", "provider": ""}, headers=auth_headers)).status_code == 422
    assert (await client.post(url, json={"kind": "energy", "provider": "X", "notice_days": -1}, headers=auth_headers)).status_code == 422
    assert (await client.post(f"/api/assets/{uuid.uuid4()}/contracts", json={"kind": "energy", "provider": "X"}, headers=auth_headers)).status_code == 404
    assert (await client.patch(f"/api/assets/contracts/{uuid.uuid4()}", json={"provider": "Y"}, headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_documents_upload_attach_to_a_contract_download_edit_and_delete(client, auth_headers):
    asset = await _asset(client, auth_headers)
    contract = (await client.post(f"/api/assets/{asset['id']}/contracts", json={"kind": "insurance", "provider": "Safe Co"}, headers=auth_headers)).json()
    with patch(STORAGE, return_value=_storage()):
        uploaded = await _upload(client, auth_headers, asset["id"], "policy.pdf", kind="insurance", title="Home policy", contract_id=contract["id"], expires_on="2027-03-01")
        assert uploaded.status_code == 201, uploaded.text
        doc = uploaded.json()
        assert doc["title"] == "Home policy" and doc["kind"] == "insurance" and doc["contract_id"] == contract["id"] and doc["expires_on"] == "2027-03-01"

        # The title defaults to the file name.
        plain = (await _upload(client, auth_headers, asset["id"], "energy_certificate.pdf", kind="energy_certificate")).json()
        assert plain["title"] == "energy_certificate"

        counted = (await client.get(f"/api/assets/{asset['id']}/contracts", headers=auth_headers)).json()
        assert counted[0]["document_count"] == 1
        listed = (await client.get(f"/api/assets/{asset['id']}/documents", headers=auth_headers)).json()
        assert sorted(d["title"] for d in listed) == ["Home policy", "energy_certificate"]

        file = await client.get(f"/api/assets/documents/{doc['id']}/file", headers=auth_headers)
        assert file.status_code == 200 and file.content == b"pdf-bytes"
        assert 'filename="policy.pdf"' in file.headers["content-disposition"]

        edited = await client.patch(f"/api/assets/documents/{doc['id']}", json={"title": "Policy 2026", "kind": "contract", "expires_on": None}, headers=auth_headers)
        assert edited.json()["title"] == "Policy 2026" and edited.json()["kind"] == "contract" and edited.json()["expires_on"] is None

        # Deleting the contract keeps the document, unattached.
        await client.delete(f"/api/assets/contracts/{contract['id']}", headers=auth_headers)
        kept = (await client.get(f"/api/assets/{asset['id']}/documents", headers=auth_headers)).json()
        assert [d["contract_id"] for d in kept if d["id"] == doc["id"]] == [None]

        assert (await client.delete(f"/api/assets/documents/{doc['id']}", headers=auth_headers)).status_code == 204
        assert (await client.get(f"/api/assets/documents/{doc['id']}/file", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_documents_refuse_bad_files_and_other_assets_contracts(client, auth_headers):
    one = await _asset(client, auth_headers, "One")
    two = await _asset(client, auth_headers, "Two")
    contract = (await client.post(f"/api/assets/{two['id']}/contracts", json={"kind": "water", "provider": "W"}, headers=auth_headers)).json()
    with patch(STORAGE, return_value=_storage()):
        assert (await _upload(client, auth_headers, one["id"], "run.exe", "application/octet-stream")).status_code == 400
        assert (await _upload(client, auth_headers, one["id"], "x.pdf", kind="nonsense")).status_code == 422
        wrong = await _upload(client, auth_headers, one["id"], "x.pdf", contract_id=contract["id"])
        assert wrong.status_code == 400
        assert (await _upload(client, auth_headers, str(uuid.uuid4()), "x.pdf")).status_code == 404
        mine = (await _upload(client, auth_headers, one["id"], "x.pdf")).json()
        moved = await client.patch(f"/api/assets/documents/{mine['id']}", json={"contract_id": contract["id"]}, headers=auth_headers)
        assert moved.status_code == 400


@pytest.mark.asyncio
async def test_service_lists_contracts_in_a_stable_order(session, test_user, test_workspace, client, auth_headers):
    asset = await _asset(client, auth_headers)
    for kind, provider in [("water", "B"), ("energy", "Z"), ("energy", "A")]:
        await client.post(f"/api/assets/{asset['id']}/contracts", json={"kind": kind, "provider": provider}, headers=auth_headers)
    rows = await asset_contract_service.list_contracts(session, uuid.UUID(asset["id"]), test_workspace.id)
    assert [(r["kind"], r["provider"]) for r in rows] == [("energy", "A"), ("energy", "Z"), ("water", "B")]
