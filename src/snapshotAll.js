// =====================================================================
// TEK SEFERLİK ANLIK KAYIT (18.11.2026 STATSXENTE ÇAPASI)
// ---------------------------------------------------------------------
// Veritabanındaki TÜM takımların güncel Statsxente puanlarını 1 kez
// hafızaya alır:
//   - snap_senior / snap_u23 / snap_u21 / snap_u18  (Referans Çapa)
//   - ind_senior_elo / ind_u23_elo / ind_u21_elo / ind_u18_elo (Başlangıç)
//   - mz_meta.snapshot_cutoff = ManagerZone (Europe/Stockholm) saati
// Bu dakikadan sonra oynanan tüm maçlar Bağımsız Model (Model 2)
// tarafından Statsxente'ye hiç bakmadan tek tek işlenir.
// =====================================================================

const { parseVal, getMzNowString } = require('./proEloCore');
const { fetchAllTeamsBasic, upsertTeams, upsertMeta } = require('./supabaseClient');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchStatsChunk(tids, retries = 3) {
    const q = tids.map((id, idx) => `&idEquipo${idx}=${id}`).join('');
    const url = `https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer${q}`;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                return (data && data.teams) ? data.teams : (data || {});
            }
        } catch (_) {}
        await sleep(700 * (i + 1));
    }
    return {};
}

async function main() {
    const started = Date.now();
    console.log('[1/4] Veritabanındaki tüm takımlar çekiliyor...');
    const teams = await fetchAllTeamsBasic();
    console.log(`Toplam kayıtlı takım: ${teams.length}`);

    if (!teams.length) {
        console.log('Kayıtlı takım bulunamadı.');
        return;
    }

    // 25'li paketlere böl
    const chunks = [];
    for (let i = 0; i < teams.length; i += 25) {
        chunks.push(teams.slice(i, i + 25));
    }

    console.log(`[2/4] ${chunks.length} paket (${CONCURRENCY} paralel) ile Statsxente anlık kaydı alınıyor...`);
    const statsMap = new Map();
    let idx = 0;
    let doneChunks = 0;

    async function worker() {
        while (idx < chunks.length) {
            const chunk = chunks[idx++];
            const tids = chunk.map(t => t.tid);
            const data = await fetchStatsChunk(tids);
            tids.forEach(id => {
                const obj = data[id] || data[String(id)] || {};
                statsMap.set(Number(id), {
                    senior: parseVal(obj.SENIOR || obj.senior),
                    u23: parseVal(obj.U23 || obj.u23),
                    u21: parseVal(obj.U21 || obj.u21),
                    u18: parseVal(obj.U18 || obj.u18)
                });
            });
            doneChunks++;
            if (doneChunks % 100 === 0 || doneChunks === chunks.length) {
                console.log(`  İlerleme: ${doneChunks}/${chunks.length} paket (%${Math.round((doneChunks / chunks.length) * 100)})`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const mzCutoff = getMzNowString(nowDate);

    let withSenior = 0;
    const rows = teams.map(t => {
        const s = statsMap.get(Number(t.tid)) || { senior: null, u23: null, u21: null, u18: null };
        if (s.senior !== null) withSenior++;
        return {
            tid: Number(t.tid),
            name: t.name || '',
            country: t.country || '',
            senior_elo: t.senior_elo,
            u23_elo: t.u23_elo,
            u21_elo: t.u21_elo,
            u18_elo: t.u18_elo,
            senior_matches: t.senior_matches || 0,
            last_scanned_at: t.last_scanned_at,
            snap_senior: s.senior,
            snap_u23: s.u23,
            snap_u21: s.u21,
            snap_u18: s.u18,
            snap_at: nowIso,
            ind_senior_elo: s.senior,
            ind_u23_elo: s.u23,
            ind_u21_elo: s.u21,
            ind_u18_elo: s.u18,
            ind_matches: 0,
            updated_at: nowIso
        };
    });

    console.log(`[3/4] ${rows.length} takım (${withSenior} adedinde Senior Statsxente puanı var) Supabase'e yazılıyor...`);
    await upsertTeams(rows);

    console.log('[4/4] Çapa zamanı mz_meta tablosuna kaydediliyor...');
    await upsertMeta({
        snapshot_cutoff: mzCutoff,
        snapshot_at_iso: nowIso,
        snapshot_team_count: String(rows.length),
        snapshot_with_senior: String(withSenior)
    });

    const sec = Math.round((Date.now() - started) / 1000);
    console.log(`✅ ANLIK KAYIT TAMAMLANDI! Süre: ${sec} sn | MZ Çapa Saati (Stockholm): ${mzCutoff} | ISO: ${nowIso}`);
}

main().catch(err => {
    console.error('SNAPSHOT HATASI:', err);
    process.exit(1);
});
