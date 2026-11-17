-- =====================================================================
-- MZ PRO-ELO VERİTABANI ŞEMASI (SUPABASE SQL EDITOR İÇİNDİR)
-- Bu kodu Supabase -> SQL Editor -> New Query alanına yapıştırıp "Run"a basın.
-- =====================================================================

-- 1. Takımlar ve Pro-ELO Puanları Tablosu
CREATE TABLE IF NOT EXISTS public.mz_teams (
    tid BIGINT PRIMARY KEY,
    name TEXT DEFAULT '',
    country TEXT DEFAULT '',
    senior_elo NUMERIC(7,2) DEFAULT 1200.00,
    u23_elo NUMERIC(7,2) DEFAULT 1000.00,
    u21_elo NUMERIC(7,2) DEFAULT 1000.00,
    u18_elo NUMERIC(7,2) DEFAULT 1000.00,
    senior_matches INT DEFAULT 0,
    last_scanned_at TIMESTAMPTZ DEFAULT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sıralama ve hızlı sorgu indeksleri
CREATE INDEX IF NOT EXISTS idx_mz_teams_senior_elo ON public.mz_teams (senior_elo DESC);
CREATE INDEX IF NOT EXISTS idx_mz_teams_u23_elo ON public.mz_teams (u23_elo DESC);
CREATE INDEX IF NOT EXISTS idx_mz_teams_u21_elo ON public.mz_teams (u21_elo DESC);
CREATE INDEX IF NOT EXISTS idx_mz_teams_u18_elo ON public.mz_teams (u18_elo DESC);
CREATE INDEX IF NOT EXISTS idx_mz_teams_country_elo ON public.mz_teams (country, senior_elo DESC);
CREATE INDEX IF NOT EXISTS idx_mz_teams_last_scanned ON public.mz_teams (last_scanned_at ASC NULLS FIRST);

-- 2. İşlenmiş Maçlar Tablosu (Aynı maçın 2 kez ELO'ya etki etmesini önler)
CREATE TABLE IF NOT EXISTS public.mz_processed_matches (
    mid BIGINT PRIMARY KEY,
    played_at TIMESTAMPTZ NOT NULL,
    category TEXT DEFAULT 'senior',
    home_tid BIGINT,
    away_tid BIGINT,
    home_delta NUMERIC(6,2),
    away_delta NUMERIC(6,2)
);

CREATE INDEX IF NOT EXISTS idx_mz_processed_played_at ON public.mz_processed_matches (played_at);

-- 3. Güvenlik (Row Level Security):
-- Tampermonkey betikleri (anon key) SADECE OKUMA (SELECT) yapabilir.
-- Yazma/Güncelleme işlemini sadece GitHub Actions (service_role key) yapabilir.
ALTER TABLE public.mz_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mz_processed_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read mz_teams" ON public.mz_teams;
CREATE POLICY "Public read mz_teams"
    ON public.mz_teams FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Public read mz_processed_matches" ON public.mz_processed_matches;
CREATE POLICY "Public read mz_processed_matches"
    ON public.mz_processed_matches FOR SELECT
    USING (true);

-- 4. 35 Günden Eski Maç Kayıtlarını Otomatik Temizleme Fonksiyonu (500 MB sınırını korur)
CREATE OR REPLACE FUNCTION public.cleanup_old_mz_matches()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.mz_processed_matches
    WHERE played_at < NOW() - INTERVAL '35 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;
