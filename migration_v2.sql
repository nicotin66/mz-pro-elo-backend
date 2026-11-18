-- =====================================================================
-- MZ PRO-ELO v2: ÇİFT MODEL (Stats+Fark  &  18.11.2026 Bağımsız Model)
-- Supabase -> SQL Editor -> New query -> bu dosyanın tamamını yapıştır -> Run
-- =====================================================================

-- 1) Takım tablosuna anlık kayıt (snapshot) ve bağımsız model sütunları
ALTER TABLE public.mz_teams
    ADD COLUMN IF NOT EXISTS snap_senior NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS snap_u23 NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS snap_u21 NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS snap_u18 NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS snap_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ind_senior_elo NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS ind_u23_elo NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS ind_u21_elo NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS ind_u18_elo NUMERIC(7,2),
    ADD COLUMN IF NOT EXISTS ind_matches INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_senior ON public.mz_teams (ind_senior_elo DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u23 ON public.mz_teams (ind_u23_elo DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u21 ON public.mz_teams (ind_u21_elo DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mz_teams_ind_u18 ON public.mz_teams (ind_u18_elo DESC NULLS LAST);

-- 2) Bağımsız modelde İŞLENMİŞ maçlar (her maç sadece 1 kez puana etki eder)
CREATE TABLE IF NOT EXISTS public.mz_ind_matches (
    mid BIGINT PRIMARY KEY,
    played_at TEXT NOT NULL,          -- ManagerZone XML tarih biçimi: 'YYYY-MM-DD HH:MM'
    category TEXT,
    home_tid BIGINT,
    away_tid BIGINT,
    home_delta NUMERIC(6,2),
    away_delta NUMERIC(6,2),
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mz_ind_matches_processed ON public.mz_ind_matches (processed_at);

-- 3) Sistem ayarları (anlık kayıt zamanı vb.)
CREATE TABLE IF NOT EXISTS public.mz_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4) Güvenlik: herkes okuyabilir, sadece GitHub Actions (service key) yazabilir
ALTER TABLE public.mz_ind_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mz_meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read mz_ind_matches" ON public.mz_ind_matches;
CREATE POLICY "Public read mz_ind_matches" ON public.mz_ind_matches FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read mz_meta" ON public.mz_meta;
CREATE POLICY "Public read mz_meta" ON public.mz_meta FOR SELECT USING (true);

-- 5) Eski sayaç tablosu artık kullanılmıyor: 500 MB ücretsiz kotayı korumak için boşalt
TRUNCATE public.mz_processed_matches;
