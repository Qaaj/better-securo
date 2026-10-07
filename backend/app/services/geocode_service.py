"""Turn an address into coordinates with an OpenStreetMap Nominatim search.

The address typed in is sent to the geocoder; nothing else is. Point `GEOCODER_URL` at your own
Nominatim to keep it in house, or leave it empty to switch the lookup off.
"""
from __future__ import annotations

import httpx

from app.core.config import get_settings


class GeocoderUnavailable(Exception):
    pass


async def search(query: str, limit: int = 5) -> list[dict]:
    url = get_settings().geocoder_url
    if not url:
        raise GeocoderUnavailable("Address lookup is switched off.")
    try:
        async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": "better-securo (self-hosted)"}) as client:
            response = await client.get(url, params={"q": query, "format": "jsonv2", "limit": limit})
            response.raise_for_status()
            rows = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise GeocoderUnavailable("The address lookup did not answer.") from exc
    results = []
    for row in rows if isinstance(rows, list) else []:
        try:
            results.append({"display_name": str(row["display_name"]), "latitude": float(row["lat"]), "longitude": float(row["lon"])})
        except (KeyError, TypeError, ValueError):
            continue
    return results
