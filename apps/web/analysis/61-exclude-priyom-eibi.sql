-- #61 analysis filter (#148, owner D9): the reception reports #61's analysis reads.
--
-- Before #148 the page asked EiBi's question about numbers stations by EiBi's
-- season names ("E11 Polish Spy Numbers"), often about a frequency Priyom says
-- wasn't in use. Since #148 those stations are asked about as signal stations,
-- and the server refuses an EiBi answer naming one; this leaves out the answers
-- already stored: kind eibi, askRule null or 1, with a Priyom-driven station as
-- txName or as any " / " part of a joint txName (matched whole, never LIKE).
--
-- Usage: a CTE. Paste it after WITH (or after another CTE and a comma) and read
-- analysed_reports wherever a query read "ReceptionReport":
--   WITH <this file> SELECT ... FROM analysed_reports ...
--
-- The names: every EiBi name of a catalog station with a Priyom designator
-- (signal-stations.ts `eibi` with `priyom`). Add a name when the catalog gains
-- one; never remove one, since past answers carry old seasons' names. A test
-- (analysis-filter.test.ts) fails when a catalog name is missing here.
analysed_reports AS (
  SELECT r.*
  FROM "ReceptionReport" r
  WHERE NOT (
    r."txKind" = 'eibi'
    AND (r."askRule" IS NULL OR r."askRule" = 1)
    AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(r."txName", ' / ')) AS part(name)
      WHERE part.name IN (
        'E06 Russian Spy Numbers',
        'E07 Russian Spy Numbers',
        'E11 Polish Spy Numbers',
        'F06 Russian Spy Numbers',
        'S06 Russian Spy Numbers',
        'S11a Polish Spy Numbers',
        'V07 Russian Spy Numbers'
      )
    )
  )
)
