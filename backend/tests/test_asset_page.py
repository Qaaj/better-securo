from dataclasses import dataclass
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services import geocode_service


@dataclass
class Stored:
    storage_key: str
    size: int
    content_type: str


def _storage():
    mock = AsyncMock()
    mock.upload.side_effect = lambda key, data, ct: Stored(storage_key=key, size=len(data), content_type=ct)
    mock.download.return_value = b"image-bytes"
    mock.delete.return_value = None
    return mock


STORAGE = "app.services.asset_photo_service.get_storage_provider"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 40


async def _asset(client, headers, name="House"):
    response = await client.post("/api/assets", json={"name": name, "type": "real_estate", "currency": "USD", "current_value": 100000}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(client, headers, asset_id, filename="front.png", content_type="image/png", data=PNG, caption=None):
    return await client.post(
        f"/api/assets/{asset_id}/photos",
        files={"file": (filename, data, content_type)},
        data={"caption": caption} if caption else None,
        headers=headers,
    )


@pytest.mark.asyncio
async def test_address_position_details_and_notes_are_saved_and_read_back(client, auth_headers):
    asset = await _asset(client, auth_headers)
    assert asset["details"] is None and asset["cover_photo_id"] is None

    patched = await client.patch(
        f"/api/assets/{asset['id']}",
        json={
            "address": "1 Example Street, Town",
            "latitude": "50.8503",
            "longitude": "4.3517",
            "details": {"Floor area (m²)": 120, "Energy label": "B", "Has garden": True},
            "notes": "Roof redone in 2021.",
        },
        headers=auth_headers,
    )
    assert patched.status_code == 200, patched.text
    body = (await client.get(f"/api/assets/{asset['id']}", headers=auth_headers)).json()
    assert body["address"] == "1 Example Street, Town"
    assert body["latitude"] == pytest.approx(50.8503)
    assert body["longitude"] == pytest.approx(4.3517)
    assert body["details"] == {"Floor area (m²)": 120, "Energy label": "B", "Has garden": True}
    assert body["notes"] == "Roof redone in 2021."


@pytest.mark.asyncio
async def test_bad_coordinates_and_details_are_refused(client, auth_headers):
    asset = await _asset(client, auth_headers)
    url = f"/api/assets/{asset['id']}"
    assert (await client.patch(url, json={"latitude": "123"}, headers=auth_headers)).status_code == 422
    assert (await client.patch(url, json={"longitude": "-181"}, headers=auth_headers)).status_code == 422
    assert (await client.patch(url, json={"details": {"x": ["a list"]}}, headers=auth_headers)).status_code == 422
    assert (await client.patch(url, json={"details": {"": "no name"}}, headers=auth_headers)).status_code == 422
    assert (await client.patch(url, json={"details": {"k": "v" * 501}}, headers=auth_headers)).status_code == 422


@pytest.mark.asyncio
async def test_photos_upload_list_cover_caption_and_delete(client, auth_headers):
    asset = await _asset(client, auth_headers)
    with patch(STORAGE, return_value=_storage()):
        first = await _upload(client, auth_headers, asset["id"], "front.png", caption="Front")
        second = await _upload(client, auth_headers, asset["id"], "garden.png")
        assert first.status_code == 201 and second.status_code == 201
        a, b = first.json(), second.json()
        # The first photo leads until another is chosen.
        assert a["is_cover"] is True and b["is_cover"] is False
        assert a["caption"] == "Front"
        assert (await client.get(f"/api/assets/{asset['id']}", headers=auth_headers)).json()["cover_photo_id"] == a["id"]

        picked = await client.patch(f"/api/assets/photos/{b['id']}", json={"is_cover": True, "caption": "Garden view"}, headers=auth_headers)
        assert picked.json()["is_cover"] is True and picked.json()["caption"] == "Garden view"
        listed = (await client.get(f"/api/assets/{asset['id']}/photos", headers=auth_headers)).json()
        assert [p["id"] for p in listed] == [a["id"], b["id"]]
        assert [p["is_cover"] for p in listed] == [False, True]

        file = await client.get(f"/api/assets/photos/{a['id']}/file", headers=auth_headers)
        assert file.status_code == 200 and file.content == b"image-bytes"
        assert file.headers["content-type"] == "image/png"

        # Deleting the cover hands the lead to the next photo; deleting the last clears it.
        assert (await client.delete(f"/api/assets/photos/{b['id']}", headers=auth_headers)).status_code == 204
        assert (await client.get(f"/api/assets/{asset['id']}", headers=auth_headers)).json()["cover_photo_id"] == a["id"]
        assert (await client.delete(f"/api/assets/photos/{a['id']}", headers=auth_headers)).status_code == 204
        assert (await client.get(f"/api/assets/{asset['id']}", headers=auth_headers)).json()["cover_photo_id"] is None
        assert (await client.get(f"/api/assets/photos/{a['id']}/file", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_only_images_are_accepted_and_unknown_assets_404(client, auth_headers):
    import uuid

    asset = await _asset(client, auth_headers)
    with patch(STORAGE, return_value=_storage()):
        pdf = await _upload(client, auth_headers, asset["id"], "deed.pdf", "application/pdf", b"%PDF-1.4")
        assert pdf.status_code == 400
        wrong_type = await _upload(client, auth_headers, asset["id"], "x.png", "text/plain")
        assert wrong_type.status_code == 400
        missing = await _upload(client, auth_headers, str(uuid.uuid4()))
        assert missing.status_code == 404
    assert (await client.get(f"/api/assets/{uuid.uuid4()}/photos", headers=auth_headers)).status_code == 404


@pytest.mark.asyncio
async def test_geocode_returns_matches_and_reports_when_it_is_off_or_down(client, auth_headers):
    rows = [{"display_name": "1 Example Street, Town", "lat": "50.85", "lon": "4.35"}, {"bad": "row"}]

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return rows

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, url, params=None):
            assert params["q"] == "1 Example Street"
            return Response()

    with patch.object(geocode_service.httpx, "AsyncClient", Client):
        ok = await client.post("/api/assets/geocode", json={"query": "1 Example Street"}, headers=auth_headers)
    assert ok.status_code == 200
    assert ok.json() == [{"display_name": "1 Example Street, Town", "latitude": 50.85, "longitude": 4.35}]

    class Down(Client):
        async def get(self, url, params=None):
            raise httpx.ConnectError("no route")

    with patch.object(geocode_service.httpx, "AsyncClient", Down):
        down = await client.post("/api/assets/geocode", json={"query": "1 Example Street"}, headers=auth_headers)
    assert down.status_code == 503

    with patch.object(geocode_service, "get_settings") as settings:
        settings.return_value.geocoder_url = ""
        off = await client.post("/api/assets/geocode", json={"query": "1 Example Street"}, headers=auth_headers)
    assert off.status_code == 503
    assert (await client.post("/api/assets/geocode", json={"query": "ab"}, headers=auth_headers)).status_code == 422
