"""Bank CSV exports (Revolut, Millennium, Belfius) import without any setup."""
import pytest
from httpx import AsyncClient

PREVIEW = "/api/transactions/import/preview"

REVOLUT = (
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n"
    "CARD_PAYMENT,Current,2026-01-03 10:00:00,2026-01-04 09:00:00,Coffee,-3.50,0.00,EUR,COMPLETED,96.50\n"
    "TOPUP,Current,2026-01-05 10:00:00,2026-01-05 10:00:01,Top-up,100.00,0.00,EUR,COMPLETED,196.50\n"
    "EXCHANGE,Current,2026-01-06 10:00:00,2026-01-06 10:00:01,Exchange to USD,-10.00,0.10,EUR,COMPLETED,186.40\n"
    "CARD_PAYMENT,Current,2026-01-07 10:00:00,2026-01-07 10:00:01,Hotel,-50.00,0.00,USD,COMPLETED,1.00\n"
    "CARD_PAYMENT,Current,2026-01-08 10:00:00,,Pending thing,-9.00,0.00,EUR,PENDING,0.00\n"
)

MILLENNIUM = (
    "Conta;;;123456789\n"
    "Moeda base;EUR\n"
    "Data lancamento;Data valor;Descricao;Montante;Tipo\n"
    "02-02-2026;03-02-2026;COMPRA CONTINENTE;-25,40;Debito\n"
    "05-02-2026;05-02-2026;SALARIO;1500,00;Credito\n"
)

BELFIUS = (
    "Rekening;Boekingsdatum;Rekeninguittreksel;Transactienummer;Naam tegenpartij;Transactie;Valutadatum;Bedrag;Devies;Mededelingen\n"
    "BE68539007547034;01/03/2026;12;1;DELHAIZE;Betaling;01/03/2026;-1.234,56;EUR;\n"
    "BE68539007547034;02/03/2026;12;2;WERKGEVER;Overschrijving;02/03/2026;2.000,00;EUR;loon\n"
)


async def _preview(client, headers, name, content, **data):
    return await client.post(
        PREVIEW, headers=headers,
        files={"file": (name, content.encode("utf-8"), "text/csv")}, data=data,
    )


@pytest.mark.asyncio
async def test_revolut_is_detected_and_split_by_currency(client: AsyncClient, auth_headers):
    resp = await _preview(client, auth_headers, "revolut.csv", REVOLUT)
    assert resp.status_code == 200
    body = resp.json()
    assert body["detected_bank"] == "revolut"
    assert body["detected_format"] == "revolut"
    assert {(s["currency"], s["row_count"]) for s in body["sources"]} == {("EUR", 3), ("USD", 1)}
    # Pending row dropped, fee folded into the amount (-10.00 - 0.10).
    signed = sorted(
        float(t["amount"]) * (1 if t["type"] == "credit" else -1) for t in body["transactions"]
    )
    assert body["selected_source"].endswith("EUR.csv")
    assert signed == [-10.10, -3.50, 100.00]
    assert all(t["external_id"] for t in body["transactions"])


@pytest.mark.asyncio
async def test_revolut_source_selects_the_other_currency(client: AsyncClient, auth_headers):
    first = (await _preview(client, auth_headers, "revolut.csv", REVOLUT)).json()
    usd = next(s["name"] for s in first["sources"] if s["currency"] == "USD")
    resp = await _preview(client, auth_headers, "revolut.csv", REVOLUT, source=usd)
    body = resp.json()
    assert body["selected_source"] == usd
    assert [t["description"] for t in body["transactions"]] == ["Hotel"]
    assert body["transactions"][0]["currency"] == "USD"


@pytest.mark.asyncio
async def test_millennium_export_converts(client: AsyncClient, auth_headers):
    resp = await _preview(client, auth_headers, "extrato.csv", MILLENNIUM)
    assert resp.status_code == 200
    body = resp.json()
    assert body["detected_bank"] == "millennium"
    assert len(body["sources"]) == 1
    by_desc = {t["description"]: t for t in body["transactions"]}
    assert by_desc["COMPRA CONTINENTE"]["type"] == "debit"
    assert float(by_desc["COMPRA CONTINENTE"]["amount"]) == pytest.approx(25.40)
    assert by_desc["SALARIO"]["type"] == "credit"
    assert by_desc["COMPRA CONTINENTE"]["date"] == "2026-02-02"


@pytest.mark.asyncio
async def test_belfius_export_converts_with_stable_ids(client: AsyncClient, auth_headers):
    resp = await _preview(client, auth_headers, "belfius.csv", BELFIUS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["detected_bank"] == "belfius"
    ids = {t["description"]: t["external_id"] for t in body["transactions"]}
    assert ids["DELHAIZE"].endswith("-12-1")
    assert ids["WERKGEVER"].endswith("-12-2")
    amounts = {t["description"]: float(t["amount"]) for t in body["transactions"]}
    assert amounts["DELHAIZE"] == pytest.approx(1234.56)


@pytest.mark.asyncio
async def test_generic_csv_is_not_treated_as_a_bank_export(client: AsyncClient, auth_headers):
    resp = await _preview(client, auth_headers, "x.csv", "date,description,amount\n2026-01-01,Thing,-5.00\n")
    body = resp.json()
    assert body["detected_bank"] is None
    assert body["detected_format"] == "csv"
    assert body["sources"] == []


@pytest.mark.asyncio
async def test_bank_export_imports_and_reimport_skips_duplicates(
    client: AsyncClient, auth_headers, test_account
):
    preview = (await _preview(client, auth_headers, "belfius.csv", BELFIUS)).json()
    payload = {
        "account_id": str(test_account.id),
        "transactions": preview["transactions"],
        "filename": "belfius.csv",
        "detected_format": preview["detected_format"],
    }
    first = await client.post("/api/transactions/import", headers=auth_headers, json=payload)
    assert first.status_code == 201
    assert first.json()["imported"] == 2

    again = await client.post("/api/transactions/import", headers=auth_headers, json=payload)
    assert again.json()["imported"] == 0
    assert again.json()["skipped"] == 2
