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
  SELECT jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_size_mb', ROUND((pg_database_size(current_database())::numeric / (1024*1024)), 1),
    'max_mb', 500,
    'percent', ROUND(((pg_database_size(current_database())::numeric / (500 * 1024 * 1024)) * 100), 1)
  );
$$;
