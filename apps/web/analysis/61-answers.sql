-- #61 analysis: shared-frequency answers (#150) counted right (#169).
--
-- Since #150, one answer to "Which did you hear: WWV or WWVH?" is stored as one
-- "signal" row per station named, sharing an askGroup id: "Heard WWV" files WWV
-- heard and WWVH not_heard, "Heard both" both heard, "Heard nothing" both
-- not_heard, "Didn't open" both no_open. Each row repeats the comment and the
-- pick context. A query that counts rows counts each such answer two or three
-- times, and reads WWVH's not_heard beside WWV's heard as a plain "not heard";
-- the owner decided on #150 that it isn't (WWVH may only have been drowned out).
-- Rows with no askGroup (every other answer) pass through both CTEs unchanged.
--
-- Usage: CTEs that read analysed_reports, so paste them after the #148 filter
-- (61-exclude-priyom-eibi.sql) and a comma:
--   WITH <61-exclude-priyom-eibi.sql>, <this file> SELECT ... FROM analysed_answers ...
-- Read the one that fits the count:
--   analysed_answers: one row per answer. For answer-level counts (answers,
--     listeners' answers, picked, outcome mix, receiver failures). A group's row
--     is its first station's row (pick context, comment, receiver and time are
--     the group's), with txName set to every station it named, " / "-joined in
--     name order, and outcome: heard if any station was heard, no_open if it
--     didn't open, else not_heard (owner, #169). heard_names lists the stations
--     heard, " / "-joined; null on rows with no askGroup and on groups none
--     were heard in.
--   analysed_station_reports: one row per station named. For per-station counts
--     (a station's heard/not heard, agreement by txName). A not_heard whose
--     group also has a heard reads 'not_heard_over_other', the same rule as
--     groupedTalliesSql in src/server/grouped-tallies.ts (a test checks they
--     agree).
-- The rows keep "ReceptionReport"'s columns (rebuilt through jsonb, so a column
-- added later comes along); analysed_answers adds heard_names. A TEMP VIEW over
-- analysed_reports fixes its columns when created: after a migration, make the
-- views again (a new SQL session does) or the UNION fails on a column count.
analysed_station_reports AS (
  SELECT s.*
  FROM (
    SELECT r AS row,
           CASE WHEN r."askGroup" IS NOT NULL AND r.outcome = 'not_heard'
                     AND bool_or(r.outcome = 'heard') OVER (PARTITION BY r."askGroup")
                THEN 'not_heard_over_other' ELSE r.outcome END AS outcome
    FROM analysed_reports r
  ) x
  CROSS JOIN LATERAL jsonb_populate_record(NULL::"ReceptionReport",
    to_jsonb(x.row) || jsonb_build_object('outcome', x.outcome)) s
),
analysed_groups AS (
  SELECT "askGroup",
         string_agg("txName", ' / ' ORDER BY "txName") AS names,
         string_agg("txName", ' / ' ORDER BY "txName") FILTER (WHERE outcome = 'heard') AS heard_names,
         CASE WHEN bool_or(outcome = 'heard') THEN 'heard'
              WHEN bool_and(outcome = 'no_open') THEN 'no_open'
              ELSE 'not_heard' END AS outcome
  FROM analysed_reports
  WHERE "askGroup" IS NOT NULL
  GROUP BY 1
),
analysed_answers AS (
  SELECT r.*, NULL::text AS heard_names
  FROM analysed_reports r
  WHERE r."askGroup" IS NULL
  UNION ALL
  SELECT a.*, g.heard_names
  FROM (
    SELECT DISTINCT ON ("askGroup") *
    FROM analysed_reports
    WHERE "askGroup" IS NOT NULL
    ORDER BY "askGroup", "txName"
  ) f
  JOIN analysed_groups g ON g."askGroup" = f."askGroup"
  CROSS JOIN LATERAL jsonb_populate_record(NULL::"ReceptionReport",
    to_jsonb(f) || jsonb_build_object('txName', g.names, 'outcome', g.outcome)) a
)
