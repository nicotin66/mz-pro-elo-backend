-- =====================================================================
-- MZ PRO-ELO v3: DEPOLAMA OPTİMİZASYONU + %80 ÇAPA (ANCHOR) & BUDAMA
-- ---------------------------------------------------------------------
-- BÖLÜM 1: 23.11.2026'da canlı veritabanına uygulanan indeks optimizasyonu
--          (kayıt amaçlı; sıfırdan kurulumda aynı yapıyı oluşturur)
-- BÖLÜM 2: Çapa sütunları + atomik çapa/budama fonksiyonu
-- BÖLÜM 3: Depolama istatistiği fonksiyonu
-- =====================================================================

-- ===================== BÖLÜM 1: İNDEKSLER ===========================
-- Hiçbir sorgunun kullanmadığı indeksler kaldırıldı
DROP INDEX IF EXISTS public.idx_mz_teams_country_elo;
DROP INDEX IF EXISTS public.idx_mz_ind_matches_processed;

-- ELO sıralama indeksleri kısmi (partial) hale getirildi:
-- puanı NULL olan ~24.000 takım indekse girmez (yaklaşık 16 MB tasarruf)
DROP INDEX IF EXISTS public.idx_mz_teams_senior_elo;
CREATE INDEX IF NOT EXISTS idx_mz_teams_senior_elo ON public.mz_teams (senior_elo DESC) WHERE senior_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_u23_elo;
CREATE INDEX IF NOT EXISTS idx_mz_teams_u23_elo ON public.mz_teams (u23_elo DESC) WHERE u23_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_u21_elo;
CREATE INDEX IF NOT EXISTS idx_mz_teams_u21_elo ON public.mz_teams (u21_elo DESC) WHERE u21_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_u18_elo;
CREATE INDEX IF NOT EXISTS idx_mz_teams_u18_elo ON public.mz_teams (u18_elo DESC) WHERE u18_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_ind_senior;
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_senior ON public.mz_teams (ind_senior_elo DESC) WHERE ind_senior_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_ind_u23;
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u23 ON public.mz_teams (ind_u23_elo DESC) WHERE ind_u23_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_ind_u21;
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u21 ON public.mz_teams (ind_u21_elo DESC) WHERE ind_u21_elo IS NOT NULL;
DROP INDEX IF EXISTS public.idx_mz_teams_ind_u18;
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u18 ON public.mz_teams (ind_u18_elo DESC) WHERE ind_u18_elo IS NOT NULL;

-- ===================== BÖLÜM 2: ÇAPA & BUDAMA =======================
-- @@APPLY_FROM_HERE@@
-- Çapa sütunları: budama anındaki alex66 Pro-ELO puanlarının mührü.
-- (NULL varsayılanlı sütun eklemek PostgreSQL'de anlıktır, tabloyu kilitlemez.)
-- 18.11 Statsxente başlangıç çapası (snap_*) DEĞİŞTİRİLMEZ.
ALTER TABLE public.mz_teams ADD COLUMN IF NOT EXISTS anchor_senior NUMERIC(7,2);
ALTER TABLE public.mz_teams ADD COLUMN IF NOT EXISTS anchor_u23 NUMERIC(7,2);
ALTER TABLE public.mz_teams ADD COLUMN IF NOT EXISTS anchor_u21 NUMERIC(7,2);
ALTER TABLE public.mz_teams ADD COLUMN IF NOT EXISTS anchor_u18 NUMERIC(7,2);
ALTER TABLE public.mz_teams ADD COLUMN IF NOT EXISTS anchor_at TIMESTAMPTZ;

-- Tek işlemde (atomik): çapa at -> eski maçları sil -> sayaç & filigranı güncelle.
-- Silinecek maç yoksa HİÇBİR ŞEY yapmaz (gereksiz yazma/şişme olmaz).
CREATE OR REPLACE FUNCTION public.anchor_and_prune(p_cutoff TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_to_delete BIGINT;
  v_deleted BIGINT;
  v_prev_archived BIGINT;
  v_anchored BIGINT;
BEGIN
  IF p_cutoff IS NULL OR p_cutoff !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$' THEN
    RAISE EXCEPTION 'Geçersiz p_cutoff: % (beklenen: YYYY-MM-DD HH:MM)', p_cutoff;
  END IF;

  SELECT COUNT(*) INTO v_to_delete FROM public.mz_ind_matches WHERE played_at < p_cutoff;
  IF v_to_delete = 0 THEN
    RETURN jsonb_build_object('deleted', 0, 'anchored', 0, 'cutoff', p_cutoff);
  END IF;

  -- 1) Çapa: o anki alex66 Pro-ELO puanlarını mühürle
  UPDATE public.mz_teams SET
    anchor_senior = ind_senior_elo,
    anchor_u23 = ind_u23_elo,
    anchor_u21 = ind_u21_elo,
    anchor_u18 = ind_u18_elo,
    anchor_at = NOW()
  WHERE ind_senior_elo IS NOT NULL OR ind_u23_elo IS NOT NULL
     OR ind_u21_elo IS NOT NULL OR ind_u18_elo IS NOT NULL;
  GET DIAGNOSTICS v_anchored = ROW_COUNT;

  -- 2) Eski maçları sil (takımların toplam puanı mz_teams'te durduğu için puanlar değişmez)
  DELETE FROM public.mz_ind_matches WHERE played_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- 3) Kümülatif sayaç (ekrandaki "Puana Etki Eden Maç" hiç düşmez)
  SELECT COALESCE(NULLIF(value, '')::BIGINT, 0) INTO v_prev_archived
  FROM public.mz_meta WHERE key = 'archived_matches_count';
  v_prev_archived := COALESCE(v_prev_archived, 0);

  INSERT INTO public.mz_meta (key, value, updated_at) VALUES
    ('archived_matches_count', (v_prev_archived + v_deleted)::TEXT, NOW()),
    -- Filigran: bu tarihten eski maçlar bir daha ASLA işlenmez (çift sayım koruması)
    ('ind_min_date', p_cutoff, NOW()),
    ('last_anchor_at', NOW()::TEXT, NOW()),
    ('last_anchor_cutoff', p_cutoff, NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('deleted', v_deleted, 'anchored', v_anchored, 'cutoff', p_cutoff,
                            'archived_total', v_prev_archived + v_deleted);
END;
$$;

-- Sadece bot (service_role) çağırabilir; sitedeki anonim kullanıcılar ÇAĞIRAMAZ
REVOKE ALL ON FUNCTION public.anchor_and_prune(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.anchor_and_prune(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anchor_and_prune(TEXT) TO service_role;

-- ===================== BÖLÜM 3: DEPOLAMA İSTATİSTİĞİ ================
CREATE OR REPLACE FUNCTION public.get_storage_stats()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH sizes AS (
    SELECT
      pg_database_size(current_database())::numeric AS db_bytes,
      COALESCE(pg_total_relation_size('public.mz_ind_matches'::regclass), 0)::numeric AS matches_bytes
  )
  SELECT jsonb_build_object(
    'db_bytes', db_bytes,
    'db_size_mb', ROUND((db_bytes / (1024*1024)), 1),
    'matches_mb', ROUND((matches_bytes / (1024*1024)), 1),
    'base_mb', ROUND(((db_bytes - matches_bytes) / (1024*1024)), 1),
    'max_mb', 500,
    'percent', ROUND(((db_bytes / (500 * 1024 * 1024)) * 100), 1)
  )
  FROM sizes;
$$;

-- ===================== BÖLÜM 4: VERİ KAYIPSIZ SIKIŞTIRMA & OTOMATİK TEMİZLİK ================
-- @@COMPRESSION_V4@@
-- 1) Gereksiz home_tid / away_tid indekslerini kaldır (sorgular idx_mz_ind_matches_cat_played kullanıyor)
DROP INDEX IF EXISTS public.idx_mz_ind_matches_home_tid;
DROP INDEX IF EXISTS public.idx_mz_ind_matches_away_tid;

-- 2) Hiç kullanılmayan processed_at sütununu kaldır ve sütun tiplerini veri kayıpsız küçült
--    (BIGINT 8-byte -> INTEGER 4-byte, NUMERIC 8-byte -> REAL 4-byte)
ALTER TABLE public.mz_ind_matches
  DROP COLUMN IF EXISTS processed_at,
  ALTER COLUMN mid TYPE INTEGER,
  ALTER COLUMN home_tid TYPE INTEGER,
  ALTER COLUMN away_tid TYPE INTEGER,
  ALTER COLUMN home_delta TYPE REAL,
  ALTER COLUMN away_delta TYPE REAL;

-- 3) Otomatik Ölü Alan Temizliği (Autovacuum & HOT Update):
--    PostgreSQL'in arka planda insan müdahalesi olmadan ölü alanları %5 eşiğinde
--    otomatik temizlemesini ve takım güncellemelerini aynı sayfa içinde (HOT) yapmasını sağlar.
ALTER TABLE public.mz_teams SET (
  fillfactor = 85,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE public.mz_ind_matches SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- 4) Tek geçişli (LATERAL VALUES) ve 32MB RAM destekli hızlı get_form_rankings fonksiyonu
CREATE OR REPLACE FUNCTION public.get_form_rankings(
  p_category text DEFAULT 'senior'::text,
  p_since text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  tid bigint,
  name text,
  country text,
  form_delta numeric,
  matches_count bigint,
  hybrid_elo numeric,
  ind_elo numeric,
  snap_elo numeric,
  nat_league text,
  world_league text,
  senior_league text,
  senior_wleague text,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_search_num INTEGER;
  v_has_search BOOLEAN := (p_search IS NOT NULL AND length(trim(p_search)) > 0);
BEGIN
  SET LOCAL work_mem = '32MB';

  IF v_has_search AND p_search ~ '^[0-9]+$' THEN
    v_search_num := p_search::INTEGER;
  ELSE
    v_search_num := NULL;
  END IF;

  RETURN QUERY
  WITH team_agg AS (
    SELECT
      v.m_tid,
      ROUND(SUM(v.delta)::numeric, 1) AS f_delta,
      COUNT(*)::bigint AS f_matches
    FROM public.mz_ind_matches im
    CROSS JOIN LATERAL (
      VALUES (im.home_tid, im.home_delta), (im.away_tid, im.away_delta)
    ) AS v(m_tid, delta)
    WHERE im.category = p_category
      AND (p_since IS NULL OR im.played_at >= p_since)
      AND (v_search_num IS NULL OR v.m_tid = v_search_num)
    GROUP BY v.m_tid
  ),
  ranked AS (
    SELECT
      t.m_tid::bigint AS r_tid,
      m.name AS r_name,
      m.country AS r_country,
      t.f_delta AS r_delta,
      t.f_matches AS r_matches,
      CASE p_category
        WHEN 'u23' THEN m.u23_elo
        WHEN 'u21' THEN m.u21_elo
        WHEN 'u18' THEN m.u18_elo
        ELSE m.senior_elo
      END AS r_hybrid,
      CASE p_category
        WHEN 'u23' THEN m.ind_u23_elo
        WHEN 'u21' THEN m.ind_u21_elo
        WHEN 'u18' THEN m.ind_u18_elo
        ELSE m.ind_senior_elo
      END AS r_ind,
      CASE p_category
        WHEN 'u23' THEN m.snap_u23
        WHEN 'u21' THEN m.snap_u21
        WHEN 'u18' THEN m.snap_u18
        ELSE m.snap_senior
      END AS r_snap,
      CASE p_category
        WHEN 'u23' THEN m.league_u23
        WHEN 'u21' THEN m.league_u21
        WHEN 'u18' THEN m.league_u18
        ELSE m.league_senior
      END AS r_nat_league,
      CASE p_category
        WHEN 'u23' THEN m.wleague_u23
        WHEN 'u21' THEN m.wleague_u21
        WHEN 'u18' THEN m.wleague_u18
        ELSE m.wleague_senior
      END AS r_world_league,
      m.league_senior AS r_senior_league,
      m.wleague_senior AS r_senior_wleague,
      COUNT(*) OVER() AS r_total
    FROM team_agg t
    JOIN public.mz_teams m ON m.tid = t.m_tid
    WHERE (
      NOT v_has_search
      OR (v_search_num IS NOT NULL AND m.tid = v_search_num)
      OR (v_search_num IS NULL AND m.name ILIKE ('%' || p_search || '%'))
    )
  )
  SELECT
    r_tid,
    r_name,
    r_country,
    r_delta,
    r_matches,
    r_hybrid,
    r_ind,
    r_snap,
    r_nat_league,
    r_world_league,
    r_senior_league,
    r_senior_wleague,
    r_total
  FROM ranked
  ORDER BY r_delta DESC, r_matches DESC, r_tid ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;


-- ===================== BÖLÜM 5: PRO-ELO v4 ANALİTİK & İNAKTİVİTE RPC'LERİ ================
-- @@PRO_ELO_V4_RPCS@@

-- 1) 21+ Gün Pasif / Banlı Takım Düşüşü (Günde en fazla 1 kez çalışır, hiçbir veriyi silmez)
CREATE OR REPLACE FUNCTION public.apply_inactivity_decay()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_today TEXT := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_last_decay TEXT;
  v_cutoff TEXT;
  v_decayed BIGINT := 0;
BEGIN
  -- 18.11.2026 çapasından itibaren en az 21 gün geçmeden düşüş başlatma
  IF NOW() < ('2026-11-18T00:00:00Z'::timestamptz + interval '21 days') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'warmup_21d');
  END IF;

  SELECT value INTO v_last_decay FROM public.mz_meta WHERE key = 'last_decay_date';
  IF v_last_decay = v_today THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_applied_today');
  END IF;

  v_cutoff := to_char((NOW() AT TIME ZONE 'Europe/Stockholm') - interval '21 days', 'YYYY-MM-DD HH24:MI');

  WITH active_tids AS (
    SELECT DISTINCT v.tid
    FROM public.mz_ind_matches im
    CROSS JOIN LATERAL (VALUES (im.home_tid), (im.away_tid)) AS v(tid)
    WHERE im.played_at >= v_cutoff
  )
  UPDATE public.mz_teams t
  SET
    ind_senior_elo = CASE WHEN t.ind_senior_elo IS NOT NULL AND t.ind_senior_elo > 1200 THEN GREATEST(1200, ROUND((t.ind_senior_elo - 0.25)::numeric, 1)) ELSE t.ind_senior_elo END,
    ind_u23_elo    = CASE WHEN t.ind_u23_elo    IS NOT NULL AND t.ind_u23_elo    > 1200 THEN GREATEST(1200, ROUND((t.ind_u23_elo    - 0.25)::numeric, 1)) ELSE t.ind_u23_elo    END,
    ind_u21_elo    = CASE WHEN t.ind_u21_elo    IS NOT NULL AND t.ind_u21_elo    > 1200 THEN GREATEST(1200, ROUND((t.ind_u21_elo    - 0.25)::numeric, 1)) ELSE t.ind_u21_elo    END,
    ind_u18_elo    = CASE WHEN t.ind_u18_elo    IS NOT NULL AND t.ind_u18_elo    > 1200 THEN GREATEST(1200, ROUND((t.ind_u18_elo    - 0.25)::numeric, 1)) ELSE t.ind_u18_elo    END
  WHERE (t.ind_senior_elo IS NOT NULL OR t.ind_u23_elo IS NOT NULL OR t.ind_u21_elo IS NOT NULL OR t.ind_u18_elo IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM active_tids a WHERE a.tid = t.tid);

  GET DIAGNOSTICS v_decayed = ROW_COUNT;

  INSERT INTO public.mz_meta (key, value, updated_at)
  VALUES ('last_decay_date', v_today, NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('applied', true, 'decayed_teams', v_decayed, 'date', v_today, 'cutoff', v_cutoff);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inactivity_decay() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_inactivity_decay() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inactivity_decay() TO service_role;

-- 2) Takım Günlük ELO Gelişim Grafiği (18.11 çapasından bugüne)
CREATE OR REPLACE FUNCTION public.get_team_elo_history(
  p_tid INTEGER,
  p_category TEXT DEFAULT 'senior'
)
RETURNS TABLE(
  match_date TEXT,
  elo NUMERIC,
  day_delta NUMERIC,
  matches_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_snap NUMERIC;
  v_curr NUMERIC;
  v_total_delta NUMERIC;
  v_start_elo NUMERIC;
BEGIN
  SELECT
    CASE p_category
      WHEN 'u23' THEN t.snap_u23
      WHEN 'u21' THEN t.snap_u21
      WHEN 'u18' THEN t.snap_u18
      ELSE t.snap_senior
    END,
    CASE p_category
      WHEN 'u23' THEN t.ind_u23_elo
      WHEN 'u21' THEN t.ind_u21_elo
      WHEN 'u18' THEN t.ind_u18_elo
      ELSE t.ind_senior_elo
    END
  INTO v_snap, v_curr
  FROM public.mz_teams t
  WHERE t.tid = p_tid;

  IF v_curr IS NULL AND v_snap IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN im.home_tid = p_tid THEN im.home_delta ELSE im.away_delta END
  ), 0)::numeric
  INTO v_total_delta
  FROM public.mz_ind_matches im
  WHERE im.category = p_category
    AND (im.home_tid = p_tid OR im.away_tid = p_tid);

  v_start_elo := COALESCE(v_snap, COALESCE(v_curr, 1500) - v_total_delta);

  RETURN QUERY
  WITH daily AS (
    SELECT
      SUBSTRING(im.played_at, 1, 10) AS d_str,
      ROUND(SUM(CASE WHEN im.home_tid = p_tid THEN im.home_delta ELSE im.away_delta END)::numeric, 1) AS d_delta,
      COUNT(*)::INTEGER AS d_cnt
    FROM public.mz_ind_matches im
    WHERE im.category = p_category
      AND (im.home_tid = p_tid OR im.away_tid = p_tid)
    GROUP BY SUBSTRING(im.played_at, 1, 10)
  ),
  running AS (
    SELECT
      d.d_str,
      ROUND((v_start_elo + SUM(d.d_delta) OVER (ORDER BY d.d_str ASC))::numeric, 1) AS cum_elo,
      d.d_delta,
      d.d_cnt
    FROM daily d
  )
  SELECT '2026-11-18'::TEXT, ROUND(v_start_elo, 1), 0::NUMERIC, 0::INTEGER
  UNION ALL
  SELECT r.d_str, r.cum_elo, r.d_delta, r.d_cnt
  FROM running r
  ORDER BY 1 ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_elo_history(INTEGER, TEXT) TO anon, authenticated, service_role;

-- 3) Ülkeler Güç Sıralaması (Her Ülkenin En İyi 100 Kulübünün Ortalama Pro-ELO'su)
CREATE OR REPLACE FUNCTION public.get_country_power_rankings(
  p_category TEXT DEFAULT 'senior',
  p_top_n INTEGER DEFAULT 100
)
RETURNS TABLE(
  country TEXT,
  avg_ind_elo NUMERIC,
  avg_stats_elo NUMERIC,
  team_count BIGINT,
  counted_teams INTEGER,
  top_team_tid BIGINT,
  top_team_name TEXT,
  top_team_elo NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      UPPER(TRIM(t.country)) AS cc,
      t.tid::BIGINT AS tid,
      t.name AS tname,
      CASE p_category
        WHEN 'u23' THEN t.ind_u23_elo
        WHEN 'u21' THEN t.ind_u21_elo
        WHEN 'u18' THEN t.ind_u18_elo
        ELSE t.ind_senior_elo
      END AS i_elo,
      CASE p_category
        WHEN 'u23' THEN t.u23_elo
        WHEN 'u21' THEN t.u21_elo
        WHEN 'u18' THEN t.u18_elo
        ELSE t.senior_elo
      END AS s_elo
    FROM public.mz_teams t
    WHERE t.country IS NOT NULL AND length(TRIM(t.country)) = 2
  ),
  ranked AS (
    SELECT
      b.cc,
      b.tid,
      b.tname,
      b.i_elo,
      b.s_elo,
      ROW_NUMBER() OVER (PARTITION BY b.cc ORDER BY b.i_elo DESC NULLS LAST) AS rn,
      COUNT(*) OVER (PARTITION BY b.cc) AS total_cnt
    FROM base b
    WHERE b.i_elo IS NOT NULL
  )
  SELECT
    r.cc AS country,
    ROUND(AVG(r.i_elo)::numeric, 1) AS avg_ind_elo,
    ROUND(AVG(r.s_elo)::numeric, 1) AS avg_stats_elo,
    MAX(r.total_cnt)::BIGINT AS team_count,
    COUNT(*)::INTEGER AS counted_teams,
    MAX(CASE WHEN r.rn = 1 THEN r.tid END)::BIGINT AS top_team_tid,
    MAX(CASE WHEN r.rn = 1 THEN r.tname END)::TEXT AS top_team_name,
    MAX(CASE WHEN r.rn = 1 THEN r.i_elo END)::NUMERIC AS top_team_elo
  FROM ranked r
  WHERE r.rn <= GREATEST(1, COALESCE(p_top_n, 100))
  GROUP BY r.cc
  ORDER BY avg_ind_elo DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_country_power_rankings(TEXT, INTEGER) TO anon, authenticated, service_role;
