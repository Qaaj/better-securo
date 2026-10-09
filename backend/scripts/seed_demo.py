#!/usr/bin/env python3
"""Create a demo account full of made-up data, to show the app to other people.

Everything here is invented: the household, the merchants, the amounts, the properties and the
illustrations. Nothing is read from any real account, and nothing outside the demo user's own
workspace is touched.

Run it inside the backend container:

    docker compose -p securo-dev exec backend python scripts/seed_demo.py            # create
    docker compose -p securo-dev exec backend python scripts/seed_demo.py --reset    # rebuild
    docker compose -p securo-dev exec backend python scripts/seed_demo.py --remove   # delete it

It signs in as DEMO_EMAIL with DEMO_PASSWORD below. They protect nothing but invented data;
change them if the demo is ever exposed to the internet.
"""
import argparse
import asyncio
import os
import random
import struct
import sys
import uuid
import zlib
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi_users.db import SQLAlchemyUserDatabase
from fastapi_users.exceptions import UserAlreadyExists
from sqlalchemy import delete, select

from app.core.auth import UserManager
from app.core.database import async_session_maker
from app.models.account import Account
from app.models.asset import Asset
from app.models.asset_group import AssetGroup
from app.models.asset_value import AssetValue
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.retirement_state import RetirementState
from app.models.rule import Rule
from app.models.transaction import Transaction
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.user import UserCreate
from app.services import asset_contract_service, asset_photo_service
from app.services.workspace_service import create_personal_workspace_for_user

DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "DemoPass-2026!"
CURRENCY = "EUR"


# ---------------------------------------------------------------------------
# Pictures and papers, drawn here so the demo needs no files
# ---------------------------------------------------------------------------

def _png(width: int, height: int, pixels: bytearray) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(pixels[y * width * 3:(y + 1) * width * 3]) for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


class Canvas:
    def __init__(self, width: int, height: int):
        self.w, self.h = width, height
        self.px = bytearray(width * height * 3)

    def sky(self, top: tuple, bottom: tuple, horizon: int) -> None:
        for y in range(self.h):
            t = min(1.0, y / max(1, horizon))
            colour = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
            row = bytes(colour) * self.w
            self.px[y * self.w * 3:(y + 1) * self.w * 3] = row

    def rect(self, x0: int, y0: int, x1: int, y1: int, colour: tuple) -> None:
        x0, x1 = max(0, x0), min(self.w, x1)
        for y in range(max(0, y0), min(self.h, y1)):
            self.px[(y * self.w + x0) * 3:(y * self.w + x1) * 3] = bytes(colour) * max(0, x1 - x0)

    def circle(self, cx: int, cy: int, r: int, colour: tuple) -> None:
        for y in range(max(0, cy - r), min(self.h, cy + r)):
            half = int((r * r - (y - cy) ** 2) ** 0.5)
            self.rect(cx - half, y, cx + half, y + 1, colour)

    def triangle(self, x0: int, y0: int, x1: int, y1: int, apex_x: int, apex_y: int, colour: tuple) -> None:
        for y in range(apex_y, y1):
            t = (y - apex_y) / max(1, y1 - apex_y)
            self.rect(int(apex_x - (apex_x - x0) * t), y, int(apex_x + (x1 - apex_x) * t), y + 1, colour)

    def png(self) -> bytes:
        return _png(self.w, self.h, self.px)


def _house() -> bytes:
    c = Canvas(960, 540)
    c.sky((135, 190, 235), (225, 240, 250), 380)
    c.circle(820, 110, 48, (255, 224, 130))
    c.rect(0, 400, 960, 540, (112, 168, 98))
    c.rect(0, 470, 960, 540, (98, 152, 86))
    c.rect(240, 230, 720, 440, (236, 226, 208))
    c.triangle(210, 232, 750, 232, 480, 120, (166, 78, 62))
    c.rect(440, 330, 520, 440, (120, 80, 56))
    for x in (290, 580):
        c.rect(x, 280, x + 90, 350, (170, 210, 235))
        c.rect(x + 43, 280, x + 47, 350, (236, 226, 208))
    c.rect(620, 150, 660, 230, (140, 70, 56))
    return c.png()


def _flat() -> bytes:
    c = Canvas(960, 540)
    c.sky((250, 196, 160), (252, 232, 210), 400)
    c.rect(0, 430, 960, 540, (110, 116, 124))
    c.rect(250, 90, 710, 430, (196, 120, 96))
    for row in range(5):
        for col in range(4):
            c.rect(285 + col * 105, 120 + row * 62, 285 + col * 105 + 62, 120 + row * 62 + 38, (250, 232, 170) if (row + col) % 3 else (120, 150, 176))
    c.rect(450, 380, 510, 430, (70, 60, 56))
    return c.png()


def _camper() -> bytes:
    c = Canvas(960, 540)
    c.sky((120, 180, 225), (214, 236, 247), 360)
    c.circle(150, 120, 40, (255, 232, 150))
    c.rect(0, 380, 960, 540, (214, 196, 150))
    c.rect(190, 220, 690, 400, (238, 238, 232))
    c.rect(190, 300, 690, 330, (214, 108, 70))
    c.rect(690, 270, 770, 400, (238, 238, 232))
    c.rect(700, 282, 750, 330, (150, 190, 214))
    for x in (300, 400, 560):
        c.rect(x, 250, x + 60, 295, (150, 190, 214))
    for x in (260, 660):
        c.circle(x, 405, 38, (40, 40, 44))
        c.circle(x, 405, 16, (176, 176, 180))
    return c.png()


def _pdf(title: str, lines: list[str]) -> bytes:
    def esc(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    text = ["BT", "/F1 18 Tf", "56 770 Td", f"({esc(title)}) Tj", "/F1 11 Tf"]
    for line in lines:
        text += ["0 -22 Td", f"({esc(line)}) Tj"]
    text.append("ET")
    stream = "\n".join(text).encode("latin-1", "replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


# ---------------------------------------------------------------------------
# The household
# ---------------------------------------------------------------------------

CATEGORIES = [
    # name, colour, icon, description (read by the automatic categorizer), kind
    ("Housing", "#6366F1", "home", "Mortgage payments and anything paid to keep the home", "debit"),
    ("Groceries", "#22C55E", "shopping-cart", "Supermarkets, bakeries and food shops", "debit"),
    ("Dining out", "#EC4899", "utensils", "Restaurants, cafes, takeaway and bars", "debit"),
    ("Utilities", "#F97316", "zap", "Electricity, water, internet and phone", "debit"),
    ("Transport", "#3B82F6", "car", "Fuel, parking, public transport and car repairs", "debit"),
    ("Health", "#06B6D4", "heart-pulse", "Pharmacy, doctors, dentist and health insurance", "debit"),
    ("Insurance", "#64748B", "shield", "Home, car and life insurance premiums", "debit"),
    ("Subscriptions", "#A855F7", "repeat", "Streaming, music, cloud storage and memberships", "debit"),
    ("Shopping", "#84CC16", "shopping-bag", "Clothes, electronics and household goods", "debit"),
    ("Travel", "#0EA5E9", "plane", "Flights, hotels and holiday spending", "debit"),
    ("Entertainment", "#8B5CF6", "film", "Cinema, concerts, books and hobbies", "debit"),
    ("Pets", "#65A30D", "paw-print", "Vet, food and pet care", "debit"),
    ("Home maintenance", "#D97706", "wrench", "Repairs, tools and garden", "debit"),
    ("Taxes", "#DC2626", "landmark", "Property tax and other taxes", "debit"),
    ("Salary", "#16A34A", "briefcase", "Pay from employers", "credit"),
    ("Rental income", "#15803D", "building", "Rent received from a tenant", "credit"),
    ("Bonus", "#065F46", "star", "Bonuses and one-off pay", "credit"),
    ("Interest", "#166534", "trending-up", "Interest and dividends received", "credit"),
    ("Refunds", "#0F766E", "undo", "Money returned by shops and providers", "credit"),
    ("Transfers", "#94A3B8", "arrow-left-right", "Moves between your own accounts", "transfer"),
]

GROCERS = ["Greenfield Market", "Corner Bakery", "Fresh & Co", "Harbour Deli", "Daily Basket"]
RESTAURANTS = ["Pizzeria Roma", "Café Lune", "Noodle Bar Kyoto", "The Copper Pot", "Sunday Brunch House", "Taco Corner"]
SHOPS = [("Nordic Wear", "Shopping", 25, 140), ("HomeNest", "Shopping", 20, 160), ("Book Haven", "Entertainment", 12, 45), ("Garden Works", "Home maintenance", 15, 90)]

# name, category, amount, day of month, account, kind. `link` charges are tied to their recurring item.
RECURRING = [
    # key, description, category, amount, frequency, day, account, type, link
    ("mortgage", "Mortgage payment", "Housing", "1240.00", "monthly", 3, "joint", "debit", True),
    ("energy", "Volt Energy", "Utilities", "118.00", "monthly", 8, "joint", "debit", True),
    ("water", "AquaFlow Water", "Utilities", "31.00", "monthly", 12, "joint", "debit", True),
    ("internet", "FiberNet Home", "Utilities", "49.99", "monthly", 15, "joint", "debit", True),
    ("mobile", "TelCo Mobile", "Utilities", "30.00", "monthly", 18, "current", "debit", False),
    ("streaming", "StreamBox", "Subscriptions", "15.99", "monthly", 8, "current", "debit", True),
    ("music", "TuneBox Family", "Subscriptions", "16.99", "monthly", 21, "current", "debit", True),
    ("cloud", "CloudKeep Storage", "Subscriptions", "2.99", "monthly", 14, "current", "debit", True),
    ("gym", "FitZone Gym", "Health", "32.00", "monthly", 5, "current", "debit", True),
    ("transit", "City Transit Pass", "Transport", "49.00", "monthly", 2, "current", "debit", False),
    ("health", "MutuaCare Health Top-up", "Insurance", "64.00", "monthly", 6, "joint", "debit", True),
    ("home_ins", "SafeHome Insurance", "Insurance", "486.00", "yearly", 14, "joint", "debit", True),
    ("car_ins", "RoadGuard Car Insurance", "Insurance", "640.00", "yearly", 9, "joint", "debit", True),
    ("prop_tax", "Property tax", "Taxes", "1180.00", "yearly", 14, "joint", "debit", True),
    ("condo", "Condo fees, rental flat", "Housing", "95.00", "monthly", 4, "joint", "debit", True),
    ("salary_a", "Salary Alex", "Salary", "3850.00", "monthly", 1, "current", "credit", True),
    ("salary_b", "Salary Sam", "Salary", "2900.00", "monthly", 2, "current", "credit", True),
    ("rent", "Rent, rental flat", "Rental income", "850.00", "monthly", 1, "joint", "credit", True),
]


def month_start(today: date, back: int) -> date:
    index = today.year * 12 + today.month - 1 - back
    return date(index // 12, index % 12 + 1, 1)


def clamp_day(year: int, month: int, day: int) -> date:
    import calendar

    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


async def build(email: str, password: str) -> None:
    rng = random.Random(7)
    today = date.today()
    async with async_session_maker() as session:
        # ── user and workspace ──────────────────────────────────────────────
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            manager = UserManager(SQLAlchemyUserDatabase(session, User))
            try:
                user = await manager.create(UserCreate(email=email, password=password))
            except UserAlreadyExists:
                user = await session.scalar(select(User).where(User.email == email))
            user.is_verified = True
            user.preferences = {"language": "en", "date_format": "DD/MM/YYYY", "timezone": "Europe/Brussels", "currency_display": CURRENCY}
            await session.commit()
            await session.refresh(user)
        uid = user.id
        workspace = await create_personal_workspace_for_user(session, user, commit=True)
        wid = workspace.id
        workspace.name = "Demo household"
        workspace.default_currency = CURRENCY
        await session.commit()

        # ── accounts ────────────────────────────────────────────────────────
        accounts: dict[str, Account] = {}
        for key, name, kind in (("current", "Everyday account", "checking"), ("joint", "Joint household account", "checking"), ("savings", "Savings account", "savings")):
            accounts[key] = Account(user_id=uid, workspace_id=wid, name=name, type=kind, currency=CURRENCY, balance=Decimal("0"))
            session.add(accounts[key])
        await session.flush()

        # ── categories and rules ────────────────────────────────────────────
        cats: dict[str, Category] = {}
        for name, colour, icon, description, kind in CATEGORIES:
            cats[name] = Category(
                user_id=uid, workspace_id=wid, name=name, color=colour, icon=icon, description=description,
                treat_as_transfer=(kind == "transfer"),
            )
            session.add(cats[name])
        await session.flush()
        for priority, (word, category) in enumerate(
            [("Greenfield", "Groceries"), ("Pizzeria", "Dining out"), ("Fuel", "Transport"), ("StreamBox", "Subscriptions"), ("Pharmacy", "Health"), ("Volt Energy", "Utilities")]
        ):
            session.add(
                Rule(
                    user_id=uid, workspace_id=wid, name=f"{word} → {category}", conditions_op="and", priority=priority, is_active=True,
                    conditions=[{"field": "description", "op": "contains", "value": word}],
                    actions=[{"op": "set_category", "value": str(cats[category].id)}],
                )
            )

        # ── recurring items ─────────────────────────────────────────────────
        items: dict[str, RecurringTransaction] = {}
        for key, description, category, amount, frequency, day, account, kind, _link in RECURRING:
            start = month_start(today, 18)
            items[key] = RecurringTransaction(
                user_id=uid, workspace_id=wid, account_id=accounts[account].id, category_id=cats[category].id, description=description,
                amount=Decimal(amount), amount_primary=Decimal(amount), currency=CURRENCY, type=kind, frequency=frequency,
                day_of_month=day, start_date=clamp_day(start.year, start.month, day), is_active=True, auto_generate=False,
                next_occurrence=today,
            )
            session.add(items[key])
        await session.flush()

        # ── transactions ────────────────────────────────────────────────────
        rows: list[Transaction] = []
        linked: dict[str, list[Transaction]] = defaultdict(list)

        def tx(account: str, day: date, description: str, amount: float | Decimal | str, kind: str, category: str | None, *, link: str | None = None, payee: str | None = None, notes: str | None = None, pair: uuid.UUID | None = None) -> Transaction:
            row = Transaction(
                user_id=uid, workspace_id=wid, account_id=accounts[account].id, category_id=cats[category].id if category else None,
                description=description, amount=Decimal(str(round(float(amount), 2))), amount_primary=Decimal(str(round(float(amount), 2))),
                currency=CURRENCY, date=day, effective_date=day, type=kind, source="import", status="posted", payee=payee or description,
                notes=notes, transfer_pair_id=pair,
            )
            rows.append(row)
            if link:
                linked[link].append(row)
            return row

        def transfer(day: date, amount: float, source: str, target: str, label: str) -> None:
            pair = uuid.uuid4()
            tx(source, day, label, amount, "debit", "Transfers", pair=pair)
            tx(target, day, label, amount, "credit", "Transfers", pair=pair)

        months = 18
        for back in range(months, -1, -1):
            first = month_start(today, back)
            y, m = first.year, first.month
            season = 1 + 0.55 * (1 if m in (12, 1, 2) else 0.35 if m in (3, 11) else 0)
            price_up = back <= 8

            def on(day: int) -> date:
                return clamp_day(y, m, day)

            for key, description, category, amount, frequency, day, account, kind, link in RECURRING:
                if frequency == "yearly" and not (key == "home_ins" and m == 3 or key == "car_ins" and m == 5 or key == "prop_tax" and m == 10):
                    continue
                when = on(day)
                if when > today:
                    continue
                value = float(amount)
                if key == "energy":
                    value = round(value * season * rng.uniform(0.8, 1.15), 2)
                if key == "streaming" and not price_up:
                    value = 13.99
                tx(account, when, description, value, kind, category, link=key if link else None)

            savings_day, joint_day = on(28), on(24)
            if joint_day <= today:
                transfer(joint_day, 2100.0, "current", "joint", "Household contribution")
            if savings_day <= today:
                transfer(savings_day, 900.0, "current", "savings", "Monthly saving")
            if m == 12 and on(18) <= today:
                tx("current", on(18), "Year-end bonus", 2400.0, "credit", "Bonus")
            if m in (3, 6, 9, 12) and on(30) <= today:
                tx("savings", on(30), "Savings interest", round(rng.uniform(52, 71), 2), "credit", "Interest")

            for _ in range(rng.randint(9, 13)):
                tx(rng.choice(["current", "joint"]), on(rng.randint(1, 28)), rng.choice(GROCERS), rng.uniform(11, 96), "debit", "Groceries")
            for _ in range(rng.randint(4, 8)):
                tx("current", on(rng.randint(1, 28)), rng.choice(RESTAURANTS), rng.uniform(14, 72), "debit", "Dining out" if rng.random() > 0.3 else None)
            for _ in range(3):
                tx("current", on(rng.randint(1, 28)), "Petrol Plus Fuel", rng.uniform(44, 69), "debit", "Transport")
            for _ in range(rng.randint(1, 3)):
                tx("current", on(rng.randint(1, 28)), "City Parking", rng.uniform(2.5, 11), "debit", "Transport" if rng.random() > 0.3 else None)
            if rng.random() < 0.55:
                tx("current", on(rng.randint(1, 28)), "Green Cross Pharmacy", rng.uniform(8, 38), "debit", "Health")
            for shop, category, low, high in rng.sample(SHOPS, rng.randint(1, 3)):
                tx("current", on(rng.randint(1, 28)), shop, rng.uniform(low, high), "debit", category if rng.random() > 0.4 else None)
            if rng.random() < 0.35:
                tx("current", on(rng.randint(1, 28)), "Paws & Claws Vet", rng.uniform(35, 120), "debit", "Pets")
            if rng.random() < 0.4:
                tx("current", on(rng.randint(1, 28)), "Cinema Palace", rng.uniform(16, 44), "debit", "Entertainment")
            if rng.random() < 0.15:
                tx("current", on(rng.randint(1, 28)), "HomeNest Refund", rng.uniform(15, 60), "credit", "Refunds")
            if rng.random() < 0.45:
                tx("current", on(rng.randint(1, 28)), "Garage Dupont", rng.uniform(70, 110), "debit", "Transport")
            for _ in range(rng.randint(3, 6)):
                tx("current", on(rng.randint(1, 28)), rng.choice(["Kiosk Central", "Market Stall", "Hardware Hut", "Flower Corner", "Print Shop"]), rng.uniform(4, 38), "debit", None)

        # a summer trip and a winter weekend
        trip = date(today.year if today.month > 8 else today.year - 1, 7, 12)
        for offset, desc, amount in ((0, "SkyAir Flights", 624.0), (1, "Seaview Resort Hotel", 1184.0), (3, "Harbour Boat Trip", 88.0), (4, "Beach Taverna", 64.5), (6, "Old Town Gifts", 112.0), (8, "Seaview Resort Extras", 143.0)):
            tx("current", trip + timedelta(days=offset), desc, amount, "debit", "Travel")
        weekend = date(today.year - 1 if today.month < 12 else today.year, 12, 6)
        tx("current", weekend, "Alpine Lodge Weekend", 396.0, "debit", "Travel")
        tx("current", weekend + timedelta(days=1), "Ski Pass Day", 112.0, "debit", "Travel")

        # things the Monthly review should notice, in the latest full month
        last = month_start(today, 1)
        tx("current", clamp_day(last.year, last.month, 14), "Café Lune", 42.9, "debit", "Dining out")
        tx("current", clamp_day(last.year, last.month, 14), "Café Lune", 42.9, "debit", "Dining out")
        tx("current", clamp_day(last.year, last.month, 22), "Garage Dupont", 412.0, "debit", "Transport", notes="Brake service")
        tx("current", clamp_day(last.year, last.month, 9), "Nordic Wear", 1399.0, "debit", "Shopping", notes="Laptop")
        # repeating charges nobody has made a recurring item of yet
        for back in range(7, -1, -1):
            first = month_start(today, back)
            tx("current", clamp_day(first.year, first.month, 11), "Meal Box Weekly", 34.5, "debit", None)
            tx("current", clamp_day(first.year, first.month, 26), "Paw Walks Dog Walker", 120.0, "debit", "Pets")

        # tie most charges to their recurring items, and put each item's next date after its latest charge
        recurring_by = {key: items[key] for key in items}
        for key, charges in linked.items():
            for charge in charges:
                charge.recurring_transaction_id = recurring_by[key].id
        rows = [r for r in rows if r.date <= today]
        # An opening balance on each account so that it ends where the demo wants it.
        targets = {"current": Decimal("4860.40"), "joint": Decimal("3215.85"), "savings": Decimal("31420.10")}
        opened = month_start(today, months) - timedelta(days=1)
        for key, account in accounts.items():
            net = sum((r.amount if r.type == "credit" else -r.amount) for r in rows if r.account_id == account.id)
            opening = targets[key] - net
            rows.append(
                Transaction(
                    user_id=uid, workspace_id=wid, account_id=account.id, description="Opening balance", amount=abs(opening), amount_primary=abs(opening),
                    currency=CURRENCY, date=opened, effective_date=opened, type="credit" if opening >= 0 else "debit", source="opening_balance", status="posted",
                )
            )
        session.add_all(rows)
        await session.flush()
        from app.services.recurring_transaction_service import _advance_date

        for key, item in items.items():
            dates = [c.date for c in linked.get(key, []) if c.date <= today]
            anchor = max(dates) if dates else today
            nxt = _advance_date(anchor, item.frequency, intended_day=item.day_of_month)
            while nxt <= today:
                nxt = _advance_date(nxt, item.frequency, intended_day=item.day_of_month)
            item.next_occurrence = nxt

        # balances: what is there now, worked back through the transactions
        for key, account in accounts.items():
            account.balance = targets[key]
            account.balance_primary = targets[key]
        await session.commit()

        # ── assets ──────────────────────────────────────────────────────────
        groups = {}
        for name, icon, colour in (("Property", "home", "#F97316"), ("Investments", "trending-up", "#22C55E"), ("Vehicles", "car", "#3B82F6")):
            groups[name] = AssetGroup(user_id=uid, workspace_id=wid, name=name, icon=icon, color=colour)
            session.add(groups[name])
        await session.flush()

        def asset(key, name, kind, group, value, purchase, bought, growth, **extra) -> Asset:
            row = Asset(
                user_id=uid, workspace_id=wid, name=name, type=kind, currency=CURRENCY, valuation_method="manual",
                purchase_price=Decimal(str(purchase)), purchase_date=bought, group_id=groups[group].id,
                growth_type="percentage", growth_rate=Decimal(str(growth)), growth_frequency="yearly", **extra,
            )
            session.add(row)
            row._value = value  # type: ignore[attr-defined]
            row._growth = growth  # type: ignore[attr-defined]
            return row

        home = asset("home", "Family home", "real_estate", "Property", 392000, 310000, date(2016, 6, 3), 2.5,
                     address="12 Sample Lane, 9000 Ghent, Belgium", latitude=Decimal("51.054300"), longitude=Decimal("3.717400"),
                     details={"Property kind": "House", "Floor area": 168, "Plot area": 420, "Rooms": 7, "Bedrooms": 4, "Bathrooms": 2, "Floors": 2,
                              "Built": 1998, "Last renovation": 2021, "Energy label": "B", "Heating": "Gas boiler with underfloor heating",
                              "Insulation and glazing": "Cavity wall, double glazing", "Cadastral reference": "DEMO-0042-17A", "Parking": "Garage and driveway", "Condition": "Very good"},
                     notes="Roof and solar panels redone in 2021. Garden shed needs painting next spring.")
        flat = asset("flat", "Rental flat", "real_estate", "Property", 214000, 168000, date(2019, 9, 20), 2.5,
                     address="4 Harbour Street, Apt 3B, 8400 Ostend, Belgium", latitude=Decimal("51.230000"), longitude=Decimal("2.912000"),
                     income_mode="fixed", income_amount=Decimal("850"), income_frequency="monthly",
                     details={"Property kind": "Apartment", "Floor area": 74, "Rooms": 3, "Bedrooms": 2, "Bathrooms": 1, "Floors": 1, "Built": 2008, "Energy label": "C", "Heating": "Individual gas", "Parking": "None"},
                     notes="Let on a 3+3+3 lease since 2022. Tenant pays utilities.")
        etf = asset("etf", "Global equity ETF", "investment", "Investments", 182400, 121000, date(2017, 1, 15), 6.0,
                    details={"Broker or platform": "Sample Broker", "Account reference": "DEMO-ETF-01", "Account holder": "Alex", "Tax wrapper": "Standard account"})
        bonds = asset("bonds", "Government bond ladder", "investment", "Investments", 61500, 60000, date(2022, 3, 1), 0.5, income_mode="yield", income_rate=Decimal("3.2"),
                      details={"Broker or platform": "Sample Broker", "Account reference": "DEMO-BOND-02", "Tax wrapper": "Standard account"})
        pension = asset("pension", "Pension pot", "investment", "Investments", 96800, 71000, date(2014, 1, 2), 4.0, details={"Account holder": "Sam", "Tax wrapper": "Pension wrapper"})
        sav = asset("sav", "Savings certificates", "investment", "Investments", 26000, 25000, date(2024, 2, 10), 0.0, income_mode="yield", income_rate=Decimal("2.8"))
        van = asset("van", "Weekend campervan", "vehicle", "Vehicles", 36800, 44500, date(2023, 4, 8), -6.0,
                    details={"Vehicle kind": "Caravan or camper", "Make": "Roamer", "Model": "Trail 600", "Year": 2022, "Registration": "DEMO-123", "Fuel or propulsion": "Diesel", "Colour": "White and orange", "Mileage": 18400, "Last service": "March 2026"},
                    notes="Sleeps four. Winter storage booked each November.")
        all_assets = [home, flat, etf, bonds, pension, sav, van]
        await session.flush()
        for row in all_assets:
            current = float(row._value)
            monthly = (1 + row._growth / 100) ** (1 / 12) - 1
            value = current
            history = []
            for back in range(24, -1, -1):
                stamp = month_start(today, back)
                history.append((stamp, value))
                value = value / (1 + monthly + (rng.uniform(-0.012, 0.012) if row.type == "investment" and row.income_mode is None else 0))
            for stamp, amount in history:
                session.add(AssetValue(asset_id=row.id, amount=Decimal(str(round(amount, 2))), date=stamp, source="manual"))
            session.add(AssetValue(asset_id=row.id, amount=Decimal(str(round(current, 2))), date=today, source="manual"))
        await session.commit()

        # ── pictures, contracts and documents ───────────────────────────────
        for row, builder, captions in (
            (home, _house, ["Front of the house", "Seen from the street"]),
            (flat, _flat, ["The building"]),
            (van, _camper, ["On the road in July"]),
        ):
            image = builder()
            for n, caption in enumerate(captions):
                await asset_photo_service.upload_photo(session, wid, uid, row.id, f"{row.name.lower().replace(' ', '-')}-{n + 1}.png", "image/png", image, caption)

        in_days = lambda n: today + timedelta(days=n)  # noqa: E731
        contracts: dict[str, dict] = {}
        for key, asset_row, data in (
            ("energy", home, {"kind": "energy", "provider": "Volt Energy", "contract_number": "VE-2024-118842", "customer_number": "C-77120", "meter_number": "EAN 5414-0000-1234", "start_date": in_days(-310), "end_date": in_days(55), "notice_days": 30, "recurring_id": items["energy"].id}),
            ("water", home, {"kind": "water", "provider": "AquaFlow Water", "contract_number": "AF-33310", "meter_number": "W-91820", "start_date": date(2016, 6, 3), "recurring_id": items["water"].id}),
            ("internet", home, {"kind": "internet", "provider": "FiberNet Home", "contract_number": "FN-882190", "start_date": in_days(-740), "end_date": in_days(-20), "recurring_id": items["internet"].id, "notes": "Out of contract: time to compare offers."}),
            ("home_ins", home, {"kind": "insurance", "provider": "SafeHome Insurance", "contract_number": "SH-5521-9", "start_date": date(2023, 3, 14), "end_date": in_days(240), "notice_days": 60, "recurring_id": items["home_ins"].id}),
            ("tax", home, {"kind": "tax", "provider": "Regional tax office", "customer_number": "DEMO-TAX-4471", "recurring_id": items["prop_tax"].id}),
            ("mortgage", home, {"kind": "mortgage", "provider": "Sample Bank", "contract_number": "MTG-2016-0042", "start_date": date(2016, 6, 3), "end_date": date(2041, 6, 3), "recurring_id": items["mortgage"].id}),
            ("condo", flat, {"kind": "condo", "provider": "Harbour Residence Syndic", "contract_number": "HR-3B", "recurring_id": items["condo"].id}),
            ("van_ins", van, {"kind": "insurance", "provider": "RoadGuard Car Insurance", "contract_number": "RG-889120", "start_date": date(2025, 5, 9), "end_date": in_days(210), "notice_days": 30, "recurring_id": items["car_ins"].id}),
        ):
            contracts[key] = await asset_contract_service.create_contract(session, asset_row.id, wid, data)

        papers = [
            (home, "Energy supply agreement", "contract", "VE-energy-agreement.pdf", contracts["energy"]["id"], None, ["Supplier: Volt Energy", "Contract VE-2024-118842, fixed price, 12 months.", "Invented document for the demo."]),
            (home, "Home insurance policy", "insurance", "SafeHome-policy.pdf", contracts["home_ins"]["id"], in_days(240), ["Insurer: SafeHome Insurance", "Policy SH-5521-9, buildings and contents.", "Invented document for the demo."]),
            (home, "Energy performance certificate", "energy_certificate", "EPC-label-B.pdf", None, in_days(2400), ["Energy label: B", "Valid for ten years from issue.", "Invented document for the demo."]),
            (home, "Property deed", "deed", "deed-12-sample-lane.pdf", None, None, ["Deed of sale, 12 Sample Lane.", "Invented document for the demo."]),
            (flat, "Lease agreement", "contract", "lease-3B.pdf", None, in_days(150), ["Lease of apartment 3B, 3+3+3 years.", "Invented document for the demo."]),
            (van, "Insurance certificate", "insurance", "camper-insurance.pdf", contracts["van_ins"]["id"], in_days(210), ["Insurer: RoadGuard", "Campervan Roamer Trail 600.", "Invented document for the demo."]),
        ]
        for asset_row, title, kind, filename, contract_id, expires, lines in papers:
            await asset_contract_service.upload_document(
                session, wid, uid, asset_row.id, filename, "application/pdf", _pdf(title, lines),
                kind=kind, title=title, contract_id=contract_id, document_date=None, expires_on=expires,
            )

        # ── the retirement plan ─────────────────────────────────────────────
        ids = {k: str(v.id) for k, v in {"home": home, "flat": flat, "etf": etf, "bonds": bonds, "pension": pension, "sav": sav, "van": van}.items()}
        plan = {
            "flat": [str(items["mortgage"].id)],
            "assumptions": {
                "horizonYears": 35, "inflationPercent": 2.2, "incomeIndexed": True, "drawdownStartYear": 3, "sellStrategy": "ordered",
                "taxIncomePercent": 22, "taxAssetIncomePercent": 15, "taxRentPercent": 8, "taxGainsPercent": 20, "bufferYears": 2,
            },
            "drawable": {ids["home"]: False, ids["flat"]: False, ids["van"]: False, ids["pension"]: True},
            "growth": {}, "sellOrder": {ids["sav"]: 1, ids["bonds"]: 2, ids["pension"]: 3, ids["etf"]: 4},
            "tempAssets": [{"id": "demo-temp-bonds", "name": "Inheritance (bonds)", "value": 60000, "growthPercent": 3, "yieldPercent": 2, "fromYear": 6, "riskClass": "bonds"}],
            "whatIfs": [
                {"id": "demo-w1", "kind": "oneoff", "label": "New roof for the flat", "amount": -18000, "year": 4},
                {"id": "demo-w2", "kind": "income", "label": "Part-time consulting", "monthly": 1200, "fromYear": 3, "toYear": 8, "inflates": False},
            ],
            "lineEnd": {str(items["mortgage"].id): today.year + 15},
            "taxFree": {ids["pension"]: True},
            "taxRates": {f"yield:{ids['bonds']}": 12, f"rent:{ids['flat']}": 5},
            "living": {"monthly": 1800, "inflates": True},
        }
        lean = {**plan, "living": {"monthly": 1400, "inflates": True}}
        travel = {**plan, "living": {"monthly": 2600, "inflates": True}, "assumptions": {**plan["assumptions"], "drawdownStartYear": 0}}
        session.add(RetirementState(workspace_id=wid, updated_by_user_id=uid, data={
            "retirement:plan": plan,
            "retirement:scenarios": {"Base case": plan, "Lean years": lean, "Retire now and travel": travel},
            # In retirement the salaries stop; the rental and the assets carry the plan.
            "retirement:excluded-income": [str(items["salary_a"].id), str(items["salary_b"].id)],
        }))
        await session.commit()

        counts = {
            "accounts": len(accounts), "categories": len(cats), "transactions": len(rows), "recurring items": len(items),
            "assets": len(all_assets), "contracts": len(contracts), "documents": len(papers),
        }
        print("Demo account ready:", ", ".join(f"{n} {k}" for k, n in counts.items()))
        print(f"Sign in as {email}")


async def remove(email: str) -> bool:
    """Delete the demo user and everything in its workspace. Only this user's workspace is touched."""
    async with async_session_maker() as session:
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            return False
        workspaces = (await session.execute(select(Workspace).where(Workspace.created_by_user_id == user.id))).scalars().all()
        from app.providers import get_storage_provider
        from app.models.asset_contract import AssetDocument
        from app.models.asset_photo import AssetPhoto

        ids = [w.id for w in workspaces]
        if ids:
            keys = [k for (k,) in (await session.execute(select(AssetPhoto.storage_key).where(AssetPhoto.workspace_id.in_(ids)))).all()]
            keys += [k for (k,) in (await session.execute(select(AssetDocument.storage_key).where(AssetDocument.workspace_id.in_(ids)))).all()]
            storage = get_storage_provider()
            for key in keys:
                try:
                    await storage.delete(key)
                except Exception:
                    pass
            await session.execute(delete(Workspace).where(Workspace.id.in_(ids)))
        await session.execute(delete(User).where(User.id == user.id))
        await session.commit()
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="delete the demo account first, then rebuild it")
    parser.add_argument("--remove", action="store_true", help="delete the demo account and stop")
    args = parser.parse_args()

    async def run() -> None:
        if args.reset or args.remove:
            print("Removed the demo account." if await remove(DEMO_EMAIL) else "There was no demo account to remove.")
        if args.remove:
            return
        async with async_session_maker() as session:
            if await session.scalar(select(User).where(User.email == DEMO_EMAIL)):
                print("The demo account already exists. Use --reset to rebuild it.")
                return
        await build(DEMO_EMAIL, DEMO_PASSWORD)

    asyncio.run(run())


if __name__ == "__main__":
    main()
