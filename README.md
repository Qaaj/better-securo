<p align="center">
  <img src="docs/logo.svg" width="200" alt="Securo logo" />
</p>
<h1 align="center">Securo</h1>
<p align="center">
  <a href="https://github.com/securo-finance/securo/actions/workflows/ci.yml"><img src="https://github.com/securo-finance/securo/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/tassionoronha/ae627b744aaa2ba89d850ea541c311be/raw/coverage.json" alt="Coverage" />
  <a href="https://github.com/securo-finance/securo/pkgs/container/securo-frontend"><img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/tassionoronha/ae627b744aaa2ba89d850ea541c311be/raw/downloads.json" alt="Downloads" /></a>
  <br />
  <a href="https://artifacthub.io/packages/search?repo=securo"><img src="https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/securo" alt="Artifact Hub" /></a>
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://discord.gg/rUqTKtQ9S4"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="Join our Discord" /></a>
  <br />
  <a href="https://usesecuro.com/">Website</a> · <a href="https://demo.usesecuro.com/">Demo</a> · <a href="https://www.usesecuro.com/roadmap">Roadmap</a> · <a href="https://docs.usesecuro.com/">Docs</a> · <a href="https://discord.gg/rUqTKtQ9S4">Discord</a> · <a href="https://cal.com/tassio/15min">Talk to the maintainer</a>
</p>

<h3 align="center">Finance apps want your data. This one doesn't.</h3>

<p align="center">
We believe personal finance should actually be <em>personal</em>. No corporation should sit between you and your financial data. Securo is an open-source finance manager that runs on your own infrastructure, giving you full visibility into your accounts, spending, and habits, without surrendering a single byte to third parties. Take back control.
</p>

## About this fork

**better-securo** is a fork of [Securo](https://github.com/securo-finance/securo) that trims what it doesn't need and adds what it does: importing real bank exports without setup, a much better recurring-transactions workflow, categorizing thousands of transactions with a local LLM, and a retirement planner. Everything still runs on your own infrastructure; the optional LLM is a server you run yourself.

- **Removed:** budgets, goals and expense-splitting groups (shared expenses, settlements and transaction splits). Category groups and asset groups are unchanged.
- **Added:** see [What's new in this fork](#whats-new-in-this-fork).
- Upstream's website, docs, demo and installer are for upstream Securo, not this fork.

## Quick Start

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker/Podman on Linux), then:

```bash
git clone https://github.com/Qaaj/better-securo.git && cd better-securo
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and create an account. That's it.

The compose file is a development setup: your `backend/` and `frontend/` folders are mounted into the containers and reload on change. Compose derives volume names from the project name, so run a second copy under its own name (`docker compose -p other-name up`) if you do not want it to share data with an existing install.

<p align="center">
  <img src="docs/screenshot.png" width="800" alt="Securo dashboard" />
</p>

## Features

- Multi-account management with running balances
- Transaction management with search, filters, and CSV export
- File import (OFX, QIF, CAMT, CSV), with **Revolut, Millennium BCP and Belfius CSV exports recognised automatically**
- Auto-categorization rules engine, plus **LLM-assisted categorization** with a model running on your own machine
- Recurring transactions that **forecast instead of cluttering the ledger**, and a one-click "Make recurring" on any transaction that works out the frequency for you
- Asset management with valuation tracking, growth rules and **modelled income** (yields, rentals, planned sales)
- A **Retirement** tab: passive income against outgoings, a year-by-year projection with runway, drawdown years, selling order, what-ifs, per-line taxes, a Monte Carlo stress test with crashes and uneven inflation, and export to Markdown or PDF
- Reports: Net Worth and Income vs Expenses with category sparklines
- Bank sync via providers (Pluggy for Brazilian banks, Enable Banking for ~2500 European PSD2 banks, SimpleFIN for US and international banks, extensible)
- Multi-currency support with automatic FX conversion
- Multi-user support with admin panel and registration controls
- Two-factor authentication (TOTP) with brute-force protection
- OIDC login support for Authentik, Pocket ID, and other standard providers
- AI Agents (optional): self-hosted LLM chat with tool-use over your data, plus a per-agent RAG knowledge base

## What's new in this fork

### Bank exports work out of the box

Drop a Revolut, Millennium BCP or Belfius CSV on the Import page and it is recognised, converted and shown for review. There is no column mapping and no separate converter step.

- An export holding several currencies or accounts (a multi-currency Revolut file) gets a picker; each one is imported to the account you choose.
- The bank's own transaction numbers become the transactions' external IDs, so importing the same file twice skips every row.
- Conversion notes (folded fees, a debit/credit sign mismatch) are shown above the preview.
- **Transfers between your own accounts are paired automatically** after an import, so a move from one account to another stops counting as both spending and income (a pair needs both legs to be each other's single best match). *Import → Find transfers* runs the same pairing over everything already imported.

Other CSVs go through the usual column mapping. The converters live in `backend/app/services/bank_converters/` and are plain Python with no extra dependencies.

### Monthly review

**Reports → Monthly review** is the first tab, and answers the questions you actually have, in words:

- **How did the month go?** Income, spending and what you saved, written as sentences against your own *usual* month (the average of the previous twelve months with data).
- **Worth a look.** Things you might miss, judged against your own history: a charge that appears twice within a few days (a possible double charge), a payment far above what you usually pay a merchant, and a price that was fixed every time and has changed (a subscription going up).
- **Where did the money go?** Your categories as bars, each with its usual amount and whether it is up or down, linking to the transactions behind it. A warning appears when much of the spending is not categorized yet.
- **What changed?** The categories you spent more and less on, new merchants and the biggest purchases.
- **Fixed or flexible?** Spending linked to your recurring items against everything else.
- **Your year so far:** a month-by-month table of income, spending and saved.

It uses the same rules as the dashboard for what counts as income and spending, and says how much moved between your own accounts and was left out. The original charts (Net Worth, Income vs Expenses, Cash Flow, Money Map) are still there on the other tabs, and `?tab=net_worth` in the address opens one directly.

### Recurring transactions

- **Forecast only by default.** A recurring item no longer writes placeholder transactions into your ledger. It shows up in forecasts and is matched to the real charge when it arrives. Switch `auto_generate` on per item if you want the old behaviour.
- **Make recurring from any transaction.** Open a transaction and click *Make recurring*. As the dialog opens it looks through your history for the same merchant, first by name *and* exact amount, then by name alone, and infers weekly, biweekly, monthly, quarterly, semiannual or yearly from the gaps, with a confidence. It prefills the amount, day and last occurrence, and says what it found.
- **Link instead of duplicating.** If an existing, still-unlinked recurring item has a close amount (within 15%, compared in your primary currency), the dialog offers to link the transaction to it.
- **Totals.** The recurring page shows monthly, yearly and combined-per-month totals for your active costs.

### Assets with income

An asset can carry a **yield** (a percentage of its value a year: savings, bonds, dividend stocks), a **fixed amount** per month, quarter, half-year or year (a rental), and a **planned yearly sale** percentage. These feed the Retirement tab; they are modelled and never create transactions. Every asset works the same whether or not it is in a group.

### Asset pages

Each asset has its own page (the picture icon beside its name on the Assets page):

- **Photos:** a lead picture and thumbnails with a viewer, captions, a choice of lead photo and drag-and-drop upload. Photos are shrunk in the browser before upload and kept in the attachment storage.
- **Map:** an address you type is found on an OpenStreetMap map and the place is saved with the asset. Finding it sends the typed address to OpenStreetMap's search, and the map loads tiles from OpenStreetMap while it is shown. Point `GEOCODER_URL` at your own Nominatim, or set it empty to turn the lookup off; coordinates can also be typed by hand.
- **Technical details:** fields by type (a building: floor area, plot, rooms, build year, energy label, heating, cadastral reference; a car or a boat: make, model, year, registration, identification number, engine hours, length and so on; valuables; investments), plus your own named fields.
- **At a glance and notes:** what it is worth, what it cost, gain or loss, growth, modelled income and any planned sale, and free notes.

### Retirement

The **Retirement** tab sits under Analysis.

**Overview** sets the monthly equivalent of your recurring income and your assets' income against your recurring costs, and shows how much of the outgoings the income covers. Every line has a checkbox, so you can leave things out and see the effect.

**Projection** is a year-by-year simulation:

- **Runway:** how long the assets you could sell from last, with and without your what-ifs.
- **Assets you would sell from:** a checkbox per asset (property, vehicles and liabilities are off by default), each with its own growth rate (its growth rule where it has one, otherwise 0, and editable here).
- **Drawdown years:** a start year, before which surpluses are saved and shortfalls are assumed paid from earnings that are not modelled, and an optional end year that reports what is left.
- **Selling order:** sell in proportion to value, or in your own order.
- **What-ifs:** an extra monthly cost or income over a span of years, a one-off amount, selling an asset in a given year (value less fees joins the pool, its rent stops), or spending a fixed amount instead of your recurring costs.
- **Living and travel:** one adjustable monthly figure on top of your recurring costs, with a slider and a tickbox for whether it rises with inflation. Five boxes show the runway and what is left at the end of the plan with it 20% and 10% lower, as it is, and 10% and 20% higher; click one to use it.
- **Inflation per line:** choose which income and cost lines rise with inflation, so a fixed mortgage payment or a fixed rent can stay the same. What-if amounts have the same tickbox.
- **Taxes (own tab):** the **Tax** tab lists every line the plan counts and lets you set a rate for each: recurring income, income what-ifs, each asset's yield, each asset's rent, and each asset's gains when sold. A blank rate uses the default for its kind (income, yields, rent, gains), and 0 means untaxed. Each asset keeps a cost basis from its purchase price (without one, only growth from today is taxed), and a sale is sized so that what arrives after tax covers the cost. Summaries show tax over the horizon, as a share of money received, today's tax per year, the heaviest year, tax by kind each year, and a year-by-year table.
- **Lines that end:** give a cost or income a last year, such as when a mortgage is paid off or a rental stops; it drops out of the totals after that.
- **Cash buffer:** hold some years of costs in cash from the first drawdown year, spend it first, and refill it only after a year in which the other assets did not fall.
- **Temporary assets:** hypothetical assets ("more bonds") with a type (stocks, bonds, property, cash or fixed, which decides how the Simulate tab treats them), an amount, growth, yield and an optional year they arrive. They live in the plan only and never touch your real assets.
- **Views:** hover a year to see every asset's value, income by kind, outgoings, what was sold and any shortfall; switch the chart between Total, By asset and Table (a row per year, a column per asset).
- **Saved plans:** name and save a whole setup, such as "without the mortgage", and reload it.
- **Export:** Markdown, a print-ready page for *Save as PDF*, a **Data for sharing (JSON)** with every setting used (rates, per-line taxes, living and travel, what-ifs, assets, the stress test's settings) and every result, which can be pasted into a chat or a script, a **Year by year (CSV)** for a spreadsheet, or a **Full report (HTML)**: one self-contained page with the projection charts (hover a year for the numbers), the settings used, a year-by-year breakdown of which assets are sold and for how much, the assets you do not sell from, and the stress test (success rate, fan chart, resilience grid, buffer comparison and its settings).

**Simulate** stress-tests the plan from the Projection tab. Instead of one steady growth rate and inflation rate, it runs many random futures through the same engine, so your income, costs, what-ifs and selling order all apply:

- **Crashes and slumps:** a yearly chance of a crash (a depth range you set) that hits stocks fully, property partly and bonds a little, followed by a few years of weaker growth.
- **Uneven inflation:** a wandering rate around the plan's, with occasional multi-year spikes.
- **Per-asset behaviour:** pick whether each asset behaves like stocks, bonds, property, cash or fixed. Its growth rate in the plan is treated as its long-run average, crashes included (as historical averages are), so the typical future matches the projection and crashes show up as risk around it. A tickbox switches this off to put crashes on top of the rate, which is much harsher.
- **Results:** the chance the money lasts, in today's money or future money, a fan chart of outcomes, the share of futures that have run out by each year, and a *Where is it resilient?* grid of success rate against spending level and crash frequency.
- **Cash buffer comparison:** the same futures with no buffer and with 1 to 5 years of costs in cash, to see what holding cash is worth.
- **Table view:** the fan chart can be switched to a table with the 10th, 25th, middle, 75th and 90th percentile of the assets you sell from for each year, and the share of futures that have run out.
- **Repeatable:** a seed makes the same settings give the same answer.

Plans, ticks and simulator settings are saved with your workspace on the server (the browser keeps a working copy), so they follow you to any browser or address. Saved plans that only exist in a browser are added when you open the page. The projection is a planning aid, not a forecast: no loan amortisation.

### Finding recurring charges

Two buttons on the Recurring page search the transactions that no recurring item is linked to yet:

- **Search for matches:** for each recurring item, shows inline the series of transactions most likely to be it, judged by amount, repeat schedule and name (the names do not have to agree), with how sure it is and why. **Link N** attaches all of the series at once and moves the schedule past the latest one; **Not this one** is remembered.
- **Search for new recurring:** shows repeating charges that fit none of your items (three or more occurrences on a regular schedule, still active), best first. **Create new** makes the item, forecast-only, and links every transaction of the series.
- **Repeating charges not assigned yet** (bottom of the page): everything else that looks recurring, to assign to an existing item, create as a new one, or dismiss for good (restorable). Less certain and ended ones are behind a toggle.

Click a recurring item's name to see its **history**: how long it has run, how many charges, what it came to in the last 12 months and in total, its price now against the first charge, each price change with its date, a step chart of the price, a warning when the next charge is late, and a button to take the latest amount when it differs from the one on the item. Only charges linked to the item count, which is what the matching above is for.

### Automatic categorization (local LLM)

**Categories → Automate** categorizes uncategorized transactions with a model running on your own machine, typically [LM Studio](https://lmstudio.ai/) or anything that speaks the OpenAI chat API.

- Transactions are grouped by **merchant**, so thousands of rows become a few hundred decisions.
- Merchants you have already categorized are answered from your own history without calling the model. The rest go to the model in batches, with your categorized merchants as examples, and every category's description in the prompt. The answer is constrained to your real categories by a JSON schema.
- **Nothing is applied automatically.** Each merchant becomes a suggestion with a category and a confidence. Accept or change it (all of that merchant's transactions are categorized at once), skip it, or *Accept all high-confidence*. Click a suggestion's transaction count to inspect the transactions behind it first.
- Optionally create a **categorization rule** when you accept, so future imports of that merchant are categorized automatically. *Create rules for accepted* does the same for merchants you accepted earlier.
- Give each category a short **description** in its edit dialog ("Energy: electricity and gas bills, TotalEnergies, Luminus"). A small model uses it a lot.
- It runs as a background job with progress and cancel, and carries on past a rejected batch.

Point it at your model server in `.env` (this prefills the tab; you can still change it there):

```
CATEGORIZER_BASE_URL=http://host.docker.internal:1234   # a server on the Docker host; use its LAN/VPN address otherwise
CATEGORIZER_MODEL=qwen3-4b-instruct-2507
```

Use a small **non-reasoning instruct** model. A 4B model categorizes about fifty merchants in under ten seconds, and an 8B model scored the same on a test against merchants you had already categorized. Large reasoning models spent their output thinking and returned no valid JSON. The Celery worker runs the job, so restart it after changing code: `docker compose restart celery-worker`.

## Bank Sync (Optional)

Add credentials for any of the supported providers to `.env`, then restart with `docker compose up`. Configure one or both — each provider auto-registers when its credentials are present.

### Pluggy — Brazilian banks

Sign up at [pluggy.ai](https://pluggy.ai) and add:

```
PLUGGY_CLIENT_ID=your-client-id
PLUGGY_CLIENT_SECRET=your-client-secret
```

### Enable Banking — European banks (PSD2)

Sign up at [enablebanking.com](https://enablebanking.com), create a Production application, and download its PEM private key. Save the PEM to `./secrets/` (gitignored), then add:

```
ENABLE_BANKING_APP_ID=your-application-id
ENABLE_BANKING_PRIVATE_KEY_FILE=/app/secrets/your-key.pem
ENABLE_BANKING_OAUTH_REDIRECT_URI=https://your-host/oauth/callback
```

The redirect URI must match exactly one of the Allowed Redirect URLs in your EB application. Production EB requires HTTPS — for local development, expose your frontend via a tunnel (ngrok, cloudflared) or use the EB sandbox.

> **Free tier — restricted mode.** Enable Banking's free plan requires you to pre-link the accounts you want to import inside the EB portal *before* connecting from Securo. If you skip that step, the connection returns no accounts and Securo will surface a banner with a link to the portal.

### SimpleFIN — US and international banks

[SimpleFIN](https://www.simplefin.org/) is a read-only open protocol. No API key needed — each connection brings its own credentials via a single-use Setup Token from the [SimpleFIN Bridge](https://bridge.simplefin.org/). Just enable the feature:

```
SIMPLEFIN_ENABLED=true
SIMPLEFIN_API_URL=https://beta-bridge.simplefin.org   # sandbox; use bridge.simplefin.org for real banks
```

Then in Securo: **Accounts → Connect Bank → SimpleFIN**, and paste the token. The [developer page](https://beta-bridge.simplefin.org/info/developers) gives out free demo tokens if you want to try it without a real bank.

## OIDC Login (Optional)

Securo can delegate login to any standard OIDC provider, including Authentik and Pocket ID. Create a confidential/web application in your provider and register this redirect URI:

```
https://your-securo-host/api/auth/oidc/callback
```

Then add the provider settings to `.env` and restart:

```
OIDC_ENABLED=true
OIDC_PROVIDER_NAME=Pocket ID
OIDC_DISCOVERY_URL=https://id.example.com/.well-known/openid-configuration
OIDC_CLIENT_ID=securo
OIDC_CLIENT_SECRET=your-client-secret
# Optional; defaults to ${FRONTEND_URL}/api/auth/oidc/callback
OIDC_REDIRECT_URI=https://your-securo-host/api/auth/oidc/callback
```

To require SSO-only access after OIDC is configured, set `LOCAL_AUTH_ENABLED=false`. Securo will start in this mode only when `OIDC_ENABLED=true`, `OIDC_CLIENT_ID`, and `OIDC_DISCOVERY_URL` are all configured; otherwise startup fails with a validation error instead of leaving the instance with no usable login method. The login page shows an explicit configuration error if the server reports that neither local auth nor OIDC is available. If only the optional OIDC-config request fails, the client keeps local controls available with a warning; the backend remains authoritative and still rejects them in OIDC-only mode.

With local auth disabled, Securo rejects password and passkey login, public registration, first-admin password setup, admin or workspace-invite creation of password-backed users, forgot/reset-password requests, password updates, new passkey registration or verification, and new TOTP setup or enablement. Local credential controls are hidden from login, account, setup, registration, and admin user-management screens. Existing users, password hashes, active sessions, passkeys, and TOTP configuration are not deleted; existing passkeys and TOTP can still be removed as cleanup paths. OIDC user provisioning and existing-account linking remain controlled separately by `OIDC_AUTO_REGISTER` and `OIDC_EXISTING_USER_LINK_MODE`.

On a fresh OIDC-only instance, the first account must be provisioned through OIDC. Keep `OIDC_AUTO_REGISTER=true`, enable `OIDC_SYNC_ROLES=true`, and include one of the values from `OIDC_ADMIN_ROLES` in that identity's configured roles claim so the first login becomes a Securo administrator. Do not disable OIDC auto-registration before at least one matching account exists.

New OIDC users are auto-provisioned by default (`OIDC_AUTO_REGISTER=true`) using verified email addresses. Set `OIDC_AUTO_REGISTER=false` to allow only existing Securo users whose email matches the provider claim.

### Linking existing accounts

An account that already exists in Securo (created with a password) is never linked to an OIDC identity automatically, so the first SSO login of an existing user is rejected by default. `OIDC_EXISTING_USER_LINK_MODE` controls that:

```
OIDC_EXISTING_USER_LINK_MODE=disabled
```

| Value | Behavior |
|-------|----------|
| `disabled` (default) | Never link. Existing accounts must keep using password login. |
| `verified_email` | Link the existing account when the provider sends `email_verified=true` for the same email. |
| `email` | Link on a matching email alone, even without `email_verified`. |

Use `verified_email` to move existing users to SSO without recreating their accounts and data. Only pick `email` if you trust your provider to own every address it asserts, since anyone able to set an email there could claim the matching Securo account. An OIDC identity already linked to another account is always rejected, in every mode.

### Optional OIDC role sync

Securo can also synchronize provider roles/groups into its built-in permissions when `OIDC_SYNC_ROLES=true`. The default claim is `groups`, which works well with Authentik group mappings and Pocket ID role/group assignments.

```
OIDC_SYNC_ROLES=true
OIDC_ROLES_CLAIM=groups
OIDC_ADMIN_ROLES=securo-admins
OIDC_WORKSPACE_ROLE_MAP={"securo-owners":"owner","securo-editors":"editor","securo-viewers":"viewer"}
```

`OIDC_ADMIN_ROLES` grants or revokes Securo admin (`is_superuser`) on each OIDC login. `OIDC_WORKSPACE_ROLE_MAP` maps provider roles/groups to the user's Personal workspace role (`owner`, `editor`, or `viewer`); if multiple mapped roles are present, Securo applies the highest permission. Leave `OIDC_SYNC_ROLES=false` to keep all Securo roles managed locally.

## Passkeys (Optional)

Sign in with Touch ID, Face ID, Windows Hello, or a security key. Passkeys are on by default and need no configuration: they follow whatever address you open Securo on.

Two rules come from the WebAuthn standard itself, and no setting can work around them:

- **An IP address is never valid.** `http://192.168.1.10:3000` cannot register passkeys.
- **Plain HTTP is never valid, except on `localhost`.**

So use passkeys on `http://localhost:3000`, or put Securo on a domain behind an HTTPS reverse proxy. When serving from a domain, point `FRONTEND_URL` at it (this also covers CORS and OAuth callbacks):

```
FRONTEND_URL=https://securo.example.com
```

To pin passkeys to one domain, set `WEBAUTHN_RP_ID` (use the parent domain if you reach Securo on several subdomains). Otherwise Securo follows the browser, and requests from an unusable address get an explanation in the UI instead of a silent failure.

## Exchange Rates (Optional)

For automatic currency conversion, add a free [Open Exchange Rates](https://openexchangerates.org/) key to `.env`:

```
OPENEXCHANGERATES_APP_ID=your-app-id
```

Rates are fetched on-demand when foreign-currency transactions are created. Without a key, cross-currency amounts default to a 1:1 fallback rate with a visual warning.

## Timezone

Balances, due dates and recurring transactions turn over at midnight in the application timezone. Set it once in Admin Settings → Date and time; a workspace that keeps its books somewhere else can pick its own timezone in Workspace settings. Without a saved value the application follows `TZ` from the environment, then the host timezone, then UTC, so an existing installation keeps behaving as before until someone changes it.

## AI Agents (Optional)

Self-hosted AI assistants over your Securo data — multi-provider (OpenAI, Anthropic, Ollama, OpenAI-compatible), tool-use via MCP, per-agent RAG knowledge base, ⌘J global chat panel.

Add to `.env`:

```
AGENTS_ENABLED=true
COMPOSE_PROFILES=agents
```

Then `docker compose up -d`. Settings → AI Agents to add a provider connection. Off by default; zero cost when off.

### Without Docker

`COMPOSE_PROFILES=agents` only tells Docker Compose to start the extra `mcp-server` container, so on a bare-metal or LXC install set `AGENTS_ENABLED=true` alone. The built-in MCP server is a plain uvicorn app in the same virtualenv; run it next to the API and point the backend at it:

```bash
# alongside the API/worker/beat processes
uvicorn mcp_server.main:app --host 127.0.0.1 --port 8765
```

```
AGENTS_ENABLED=true
AGENTS_BUILTIN_MCP_URL=http://127.0.0.1:8765/mcp
```

Without that server the agents still chat, but they have no tools and cannot read your data. The backend log says which MCP server it failed to reach.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | FastAPI, SQLAlchemy, Alembic, Celery |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Database | PostgreSQL |
| Queue | Redis + Celery |

## AI-Assisted Development

Parts of this codebase were built with help of AI. All code is human-reviewed and no data leaves your environment.

Contributing with AI is welcome. We review the author, not the tool: whatever wrote the diff, you own its quality, its fit with where Securo is going, and everything that happens after it merges. See [Using AI](CONTRIBUTING.md#using-ai).

## Development

```bash
# Run backend tests (from backend/, needs Python 3.11+; same as CI)
cd backend
pip install -e ".[dev]"   # first time only — installs pytest and dev deps
pytest

# Rebuild after dependency changes
docker compose up --build
```

If you've [mise](https://mise.jdx.dev/) installed, you can install backend/frontend directly with it:

```
# Install the Python version specified in .python-version,
# and create a project virtual environment using that Python.
# Install all tools and dependencies (include Python with dedicated venv)
mise //...:install

# Install only backend tools/deps
mise backend:install

# Run backend tests
mise backend:test

# Install frontend dependencies
mise frontend:install

# Run frontend linting
mise frontend:lint

# Run frontend build
mise frontend:build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Not sure where to start, or want to talk something through first? [Book 15 minutes](https://cal.com/tassio/15min) — no agenda needed. Something broken, an idea, or just what you think of Securo, all welcome.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

This means you can freely use, modify, and distribute this software, but any modifications — including when used as a network service (SaaS) — must also be released under the AGPL-3.0.
