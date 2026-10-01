-- Recurring-cost detection, fixed to match Securo's actual data model.
--
-- The upstream find-recurring.sh assumed signed amounts (`amount < 0` for a
-- cost). Securo actually stores amounts as positive magnitudes with a
-- separate `type` column ('debit'/'credit') — so that filter silently
-- matched zero rows, always. Fixed here to `type = 'debit'`.
--
-- Also fixed vs. upstream:
--   - source = 'import' / NOT is_ignored  — excludes recurring rules the
--     user already defined manually (nothing to detect there) and
--     opening-balance rows.
--   - grouped by (description, currency), not just description — avoids
--     summing unrelated currencies together.
--   - regularity judged by coefficient of variation (gap stddev / avg gap),
--     not a fixed day-count threshold — a fixed threshold can't tell a
--     sloppy weekly bill from a clean yearly one, and badly misranked a
--     burst of same-week one-off transfers as a six-figure "recurring cost"
--     when tested against real data.
--   - avg_gap >= 5 days floor — drops same-trip/same-day clusters (e.g.
--     three hotel charges in one stay), which the CV check alone wouldn't
--     catch.
--   - a Confidence column (low/medium/high, from hit count) — a 3-hit
--     series has only two gap measurements, too shaky to treat the same as
--     a 24-hit one.
--
-- Params: bind `:months` (int). 0 means "all time" (no lower date bound).
-- Quarterly/yearly bills need years of history to clear the 3-hit minimum,
-- so don't default this too short — 24 was the sweet spot against real data.
--
-- Uses `:name` bind-param syntax, directly usable via SQLAlchemy's
-- `text()`: conn.execute(text(sql), {"months": 24}).
--
-- Depends on columns from upstream Securo's `transactions` table:
-- date, amount, currency, description, account_id, type, source,
-- is_ignored. If the fork's schema trims or renames any of these, this
-- query needs updating to match.

-- Query 1: the recurring-cost table itself.
WITH params AS (
  SELECT CASE WHEN :months = 0 THEN '-infinity'::date
              ELSE (CURRENT_DATE - (:months || ' months')::interval)::date
         END AS since
),
base AS (
  SELECT
    t.date, t.amount, t.currency, a.name AS account,
    lower(trim(regexp_replace(regexp_replace(t.description, '[0-9]+', '', 'g'), '\s+', ' ', 'g'))) AS key
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  CROSS JOIN params p
  WHERE t.date >= p.since
    AND t.type = 'debit'
    AND t.source = 'import'
    AND NOT t.is_ignored
),
gaps AS (
  SELECT key, currency, account, date, amount,
         date - LAG(date) OVER (PARTITION BY key, currency ORDER BY date) AS gap_days
  FROM base
),
agg AS (
  SELECT
    key, currency,
    max(account) AS account,
    count(*) AS hits,
    round(avg(amount)::numeric, 2) AS avg_amount,
    round(stddev_samp(amount)::numeric, 2) AS amount_sd,
    round(avg(gap_days)::numeric, 1) AS avg_gap,
    round(stddev_samp(gap_days)::numeric, 1) AS gap_sd,
    max(date) AS last_seen
  FROM gaps
  GROUP BY key, currency
  HAVING count(*) >= 3
),
scored AS (
  SELECT *, gap_sd / NULLIF(avg_gap, 0) AS gap_cv
  FROM agg
  WHERE avg_gap >= 5
)
SELECT
  initcap(key) AS "Description",
  account AS "Account",
  currency AS "Ccy",
  hits AS "Seen",
  avg_amount AS "Amount",
  CASE
    WHEN avg_gap BETWEEN 6 AND 8 THEN 'weekly'
    WHEN avg_gap BETWEEN 13 AND 16 THEN 'fortnightly'
    WHEN avg_gap BETWEEN 27 AND 32 THEN 'monthly'
    WHEN avg_gap BETWEEN 85 AND 95 THEN 'quarterly'
    WHEN avg_gap BETWEEN 175 AND 190 THEN 'half-yearly'
    WHEN avg_gap BETWEEN 355 AND 375 THEN 'yearly'
    ELSE 'every ' || avg_gap || 'd'
  END AS "Cadence",
  last_seen AS "Last seen",
  (last_seen + (avg_gap || ' days')::interval)::date AS "Next due",
  round((avg_amount * 365.0 / avg_gap)::numeric, 0) AS "Per year",
  CASE
    WHEN hits >= 6 THEN 'high'
    WHEN hits >= 4 THEN 'medium'
    ELSE 'low'
  END AS "Confidence",
  CASE
    WHEN amount_sd IS NULL OR amount_sd < 0.01 THEN 'fixed'
    WHEN amount_sd / NULLIF(avg_amount,0) < 0.10 THEN 'steady'
    ELSE 'variable'
  END AS "Regularity"
FROM scored
WHERE gap_cv < 0.3
ORDER BY "Per year" DESC;


-- Query 2: total committed spend per year, by currency.
-- Deliberately a *separate*, stricter query (>= 4 hits, i.e. >= 3 gap
-- samples) rather than just summing query 1's rows — a one-number total
-- someone will actually read and act on shouldn't be skewed by a 3-hit
-- series extrapolated off two gap measurements. Those entries still show
-- in query 1, tagged "low" confidence, for the curious.
WITH params AS (
  SELECT CASE WHEN :months = 0 THEN '-infinity'::date
              ELSE (CURRENT_DATE - (:months || ' months')::interval)::date
         END AS since
),
base AS (
  SELECT t.date, t.amount, t.currency,
         lower(trim(regexp_replace(regexp_replace(t.description, '[0-9]+', '', 'g'), '\s+', ' ', 'g'))) AS key
  FROM transactions t
  CROSS JOIN params p
  WHERE t.date >= p.since AND t.type = 'debit' AND t.source = 'import' AND NOT t.is_ignored
),
gaps AS (
  SELECT key, currency, amount,
         date - LAG(date) OVER (PARTITION BY key, currency ORDER BY date) AS gap_days
  FROM base
),
agg AS (
  SELECT key, currency, count(*) AS hits, avg(amount) AS amt,
         avg(gap_days) AS gap, stddev_samp(gap_days) AS gsd
  FROM gaps
  GROUP BY key, currency
  HAVING count(*) >= 4
)
SELECT
  currency AS "Ccy",
  round(sum(amt * 365.0 / gap)::numeric, 0) AS "Recurring cost per year",
  round(sum(amt * 365.0 / gap / 12)::numeric, 0) AS "Per month"
FROM agg
WHERE gap >= 5 AND (gsd / NULLIF(gap, 0)) < 0.3
GROUP BY currency
ORDER BY 2 DESC;
