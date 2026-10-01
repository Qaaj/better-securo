# helpers/

Reusable logic carried over from `securo-helper` (a standalone drag-and-drop
import tool built against the original, unforked Securo) and from manual
bug-hunting against real data. Everything here is framework-agnostic — no
FastAPI, no routes, no UI — meant to be imported/wired into whatever this
fork's backend ends up looking like.

## Bank CSV converters — moved

The Revolut / Millennium / Belfius converters now live in the backend at
`backend/app/services/bank_converters/` and run automatically in the import
preview (`POST /api/transactions/import/preview`): upload the bank's CSV and
it is detected, converted and shown for review. Exports holding several
currencies/accounts get a picker in the import page. See that package's
modules for the per-bank quirks (UTF-16 decode order, Belfius transaction
ids, Millennium sign cross-check).

**Not covered**: CIBC exports QFX, which Securo already imports natively.

## `recurring_costs.sql` — fixed recurring-transaction detection

Two standalone SQL queries (no app code, no psql-only syntax — just
`:months`-style bind params, directly usable via SQLAlchemy's `text()`):

```python
from sqlalchemy import text
rows = conn.execute(text(open("helpers/recurring_costs.sql").read().split(";\n\n\n")[0]),
                     {"months": 24}).fetchall()
```

(In practice you'll want to split the two queries into their own strings/
functions rather than parsing the file at runtime — it's written as one
file for readability, not for naive execution.)

**Why this exists**: upstream Securo has no recurring-transaction
*detection* — you define them manually and it only projects future
occurrences. The original `find-recurring.sh` script tried to detect them
from real transaction history, but assumed signed amounts (`amount < 0` for
a cost). Securo actually stores amounts as **positive magnitudes** with a
separate `type` column (`'debit'`/`'credit'`) — so that filter matched zero
rows, always, on every real Securo database tested.

Beyond that one-line fix, the regularity test was also reworked after
testing against ~6 years of real transaction data: a fixed
"gap-standard-deviation < 12 days" threshold can't distinguish a sloppy
weekly bill from a clean yearly one, and ranked a burst of 3 same-week
one-off e-transfers as a fictitious "$206,000/year recurring cost." Fixed
to coefficient-of-variation (`gap_stddev / avg_gap < 0.3`), plus a 5-day
minimum average gap (drops same-trip/same-day clusters like a hotel
charging you three times in one stay) and a confidence label from hit
count. Full rationale is in the comments at the top of the SQL file itself.

This is meant as the seed for whatever the real recurring/burn-rate feature
in this fork becomes — not a finished feature on its own.

## What's deliberately *not* here

`securo-helper` (still at `~/Projects/securo-helper/`, standalone) also has
a FastAPI server (upload/download/session endpoints, a zip-everything
endpoint) and a plain HTML/JS drag-and-drop frontend. None of that is
copied here — it only existed because `securo-helper` ran as an independent
tool against an unmodified Securo install. Once this logic is hardwired
into this fork's own backend/frontend, those serve no purpose here; copying
them over would just be dead scaffolding shaped for a different app.

If useful for reference anyway: `~/Projects/securo-helper/app/main.py` (the
FastAPI routes) and `~/Projects/securo-helper/web/` (the frontend).

## Background

`~/Projects/securo-helper/SECURO_HANDOFF.md` (if still present) has the
original bug-hunting notes this was built from — worth a skim before
touching the converters, since most of what's tricky in them is there for a
specific, previously-hit reason (silent 0-row imports, CRLF, UTF-16
decode-order, the Belfius prefix-match bug) rather than defensive
overengineering.
