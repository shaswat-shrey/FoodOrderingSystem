-- Ratings are stored in hundredths of a star (4.35★ = 435), as SCHEMA-NOTES §2 and every
-- reader/writer use. The Phase 3 check on restaurants assumed basis points and rejected
-- every recompute; align it and guard branches and partner stats the same way.
ALTER TABLE restaurants DROP CONSTRAINT restaurants_rating_chk;
ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_rating_chk CHECK (rating_avg_bps IS NULL OR rating_avg_bps BETWEEN 100 AND 500);
ALTER TABLE branches
  ADD CONSTRAINT branches_rating_chk CHECK (rating_avg_bps IS NULL OR rating_avg_bps BETWEEN 100 AND 500);
ALTER TABLE partner_stats
  ADD CONSTRAINT partner_stats_rating_chk CHECK (rating_avg_bps IS NULL OR rating_avg_bps BETWEEN 100 AND 500);
