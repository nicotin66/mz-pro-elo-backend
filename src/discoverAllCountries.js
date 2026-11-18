// =====================================================================
// TÜM 100 ÜLKE LİG KEŞFİ & EKSİK AKTİF TAKIM ÇAPALAMA
// ---------------------------------------------------------------------
// ManagerZone'daki 100 ülkenin tamamının lig piramitlerini
// (Üst Lig + Div 1..Div 4) doğrudan resmi MZ XML'inden tarar.
// 1) Mevcut takımların eksik ülke kodlarını doldurur.
// 2) Veritabanında henüz olmayan aktif takımları Statsxente'den
//    çapalayarak hem Hibrit hem Bağımsız (18.11) havuzuna ekler.
// =====================================================================

const { parseVal } = require('./proEloCore');
const { fetchAllTeamsBasic, upsertTeams, fetchMeta, upsertMeta } = require('./supabaseClient');

const COUNTRIES = [
    { name: 'Suecia', cc: 'SE', topId: 43, major: true },
    { name: 'EE.UU', cc: 'US', topId: 9885, major: true },
    { name: 'Inglaterra', cc: 'GB', topId: 10017, major: true },
    { name: 'Italia', cc: 'IT', topId: 10625, major: true },
    { name: 'Espana', cc: 'ES', topId: 10746, major: true },
    { name: 'Francia', cc: 'FR', topId: 10872, major: true },
    { name: 'Finlandia', cc: 'FI', topId: 11722, major: true },
    { name: 'Alemania', cc: 'DE', topId: 12086, major: true },
    { name: 'Dinamarca', cc: 'DK', topId: 12451, major: true },
    { name: 'Grecia', cc: 'GR', topId: 12817, major: true },
    { name: 'Polonia', cc: 'PL', topId: 13181, major: true },
    { name: 'Noruega', cc: 'NO', topId: 13545, major: true },
    { name: 'Suiza', cc: 'CH', topId: 13909, major: true },
    { name: 'Paises Bajos', cc: 'NL', topId: 15004, major: true },
    { name: 'Belgica', cc: 'BE', topId: 15368, major: true },
    { name: 'Canada', cc: 'CA', topId: 15732, major: false },
    { name: 'Argentina', cc: 'AR', topId: 16096, major: true },
    { name: 'Austria', cc: 'AT', topId: 16473, major: true },
    { name: 'Portugal', cc: 'PT', topId: 17566, major: true },
    { name: 'Hungria', cc: 'HU', topId: 17687, major: true },
    { name: 'Australia', cc: 'AU', topId: 17808, major: false },
    { name: 'Rumania', cc: 'RO', topId: 17929, major: true },
    { name: 'Gales', cc: 'GB', topId: 18050, major: false },
    { name: 'Irlanda', cc: 'IE', topId: 18171, major: false },
    { name: 'Letonia', cc: 'LV', topId: 18292, major: false },
    { name: 'Indonesia', cc: 'ID', topId: 18423, major: true },
    { name: 'Estonia', cc: 'EE', topId: 18534, major: false },
    { name: 'Turquia', cc: 'TR', topId: 20356, major: true },
    { name: 'Escocia', cc: 'GB', topId: 20477, major: false },
    { name: 'Brasil', cc: 'BR', topId: 26187, major: true },
    { name: 'Israel', cc: 'IL', topId: 43562, major: false },
    { name: 'Republica Checa', cc: 'CZ', topId: 43926, major: true },
    { name: 'Mexico', cc: 'MX', topId: 44290, major: true },
    { name: 'Lituania', cc: 'LT', topId: 44654, major: false },
    { name: 'Bolivia', cc: 'BO', topId: 59598, major: false },
    { name: 'Paraguay', cc: 'PY', topId: 59719, major: false },
    { name: 'Uruguay', cc: 'UY', topId: 59840, major: true },
    { name: 'Rusia', cc: 'RU', topId: 59961, major: true },
    { name: 'Bulgaria', cc: 'BG', topId: 60085, major: true },
    { name: 'Islandia', cc: 'IS', topId: 60206, major: false },
    { name: 'Egipto', cc: 'EG', topId: 60327, major: false },
    { name: 'Ecuador', cc: 'EC', topId: 60449, major: false },
    { name: 'Venezuela', cc: 'VE', topId: 60813, major: false },
    { name: 'Peru', cc: 'PE', topId: 60935, major: true },
    { name: 'Chile', cc: 'CL', topId: 60975, major: true },
    { name: 'Colombia', cc: 'CO', topId: 61015, major: true },
    { name: 'Sudafrica', cc: 'ZA', topId: 61055, major: false },
    { name: 'Tailandia', cc: 'TH', topId: 61257, major: false },
    { name: 'Pais MZ', cc: 'MZ', topId: 69507, major: false },
    { name: 'China', cc: 'CN', topId: 70847, major: true },
    { name: 'Eslovenia', cc: 'SI', topId: 87616, major: true },
    { name: 'Croacia', cc: 'HR', topId: 87739, major: true },
    { name: 'Bosnia', cc: 'BA', topId: 89966, major: false },
    { name: 'Eslovaquia', cc: 'SK', topId: 89979, major: true },
    { name: 'Ucrania', cc: 'UA', topId: 90019, major: true },
    { name: 'Malasia', cc: 'MY', topId: 90032, major: false },
    { name: 'Singapur', cc: 'SG', topId: 90045, major: false },
    { name: 'Panama', cc: 'PA', topId: 90058, major: false },
    { name: 'Malta', cc: 'MT', topId: 90071, major: false },
    { name: 'Islas Feroe', cc: 'FO', topId: 90072, major: false },
    { name: 'Chipre', cc: 'CY', topId: 90073, major: false },
    { name: 'Macedonia Norte', cc: 'MK', topId: 90111, major: false },
    { name: 'Moldavia', cc: 'MD', topId: 90112, major: false },
    { name: 'Bielorrusia', cc: 'BY', topId: 90113, major: false },
    { name: 'Vietnam', cc: 'VN', topId: 90150, major: false },
    { name: 'Costa Rica', cc: 'CR', topId: 90151, major: false },
    { name: 'Luxemburgo', cc: 'LU', topId: 90152, major: false },
    { name: 'India', cc: 'IN', topId: 90189, major: false },
    { name: 'Filipinas', cc: 'PH', topId: 90190, major: false },
    { name: 'Iran', cc: 'IR', topId: 90191, major: false },
    { name: 'Liechtenstein', cc: 'LI', topId: 90228, major: false },
    { name: 'Marruecos', cc: 'MA', topId: 90229, major: false },
    { name: 'Guatemala', cc: 'GT', topId: 90230, major: false },
    { name: 'EAU', cc: 'AE', topId: 90267, major: false },
    { name: 'Andorra', cc: 'AD', topId: 90268, major: false },
    { name: 'Albania', cc: 'AL', topId: 90269, major: false },
    { name: 'Corea del Sur', cc: 'KR', topId: 90306, major: false },
    { name: 'Rep Dominicana', cc: 'DO', topId: 90307, major: false },
    { name: 'Tunez', cc: 'TN', topId: 90308, major: false },
    { name: 'Kazajistan', cc: 'KZ', topId: 90345, major: false },
    { name: 'Argelia', cc: 'DZ', topId: 90346, major: false },
    { name: 'Kirguistan', cc: 'KG', topId: 90347, major: false },
    { name: 'Azerbaiyan', cc: 'AZ', topId: 90384, major: false },
    { name: 'El Salvador', cc: 'SV', topId: 90385, major: false },
    { name: 'Pakistan', cc: 'PK', topId: 90386, major: false },
    { name: 'Honduras', cc: 'HN', topId: 90424, major: false },
    { name: 'Georgia', cc: 'GE', topId: 90425, major: false },
    { name: 'Jordania', cc: 'JO', topId: 90426, major: false },
    { name: 'Kenia', cc: 'KE', topId: 90463, major: false },
    { name: 'Kuwait', cc: 'KW', topId: 90464, major: false },
    { name: 'Arabia Saudi', cc: 'SA', topId: 90465, major: false },
    { name: 'Trinidad y Tobago', cc: 'TT', topId: 90502, major: false },
    { name: 'Angola', cc: 'AO', topId: 90503, major: false },
    { name: 'Nigeria', cc: 'NG', topId: 90504, major: false },
    { name: 'Senegal', cc: 'SN', topId: 90541, major: false },
    { name: 'Libano', cc: 'LB', topId: 90554, major: false },
    { name: 'Bangladesh', cc: 'BD', topId: 90567, major: false },
    { name: 'Serbia', cc: 'RS', topId: 90580, major: true },
    { name: 'Montenegro', cc: 'ME', topId: 90581, major: false },
    { name: 'Irlanda Norte', cc: 'GB', topId: 90582, major: false }
];

const LEAGUE_CONCURRENCY = parseInt(process.env.LEAGUE_CONCURRENCY || '18', 10);
const STATS_CONCURRENCY = parseInt(process.env.STATS_CONCURRENCY || '10', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchLeagueTeams(leagueId, retries = 2) {
    const url = `https://www.managerzone.com/xml/team_league.php?sport_id=1&league_id=${leagueId}`;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const xml = await res.text();
            if (!xml.includes('<Team ')) return [];
            const teams = [];
            const re = /<Team\b([^>]*)\/?>/gi;
            let m;
            while ((m = re.exec(xml)) !== null) {
                const a = m[1];
                const idM = /teamId="(\d+)"/i.exec(a);
                const nameM = /teamName="([^"]*)"/i.exec(a);
                if (idM) {
                    teams.push({
                        tid: parseInt(idM[1], 10),
                        name: nameM ? nameM[1] : ''
                    });
                }
            }
            return teams;
        } catch (_) {}
        await sleep(500 * (i + 1));
    }
    return [];
}

async function fetchStatsChunk(tids, retries = 2) {
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
    const tasks = [];
    for (let i = 0; i < COUNTRIES.length; i++) {
        const c = COUNTRIES[i];
        const nextTop = (i + 1 < COUNTRIES.length) ? COUNTRIES[i + 1].topId : (c.topId + 13);
        const gap = Math.max(1, nextTop - c.topId);
        const depth = Math.min(gap, c.major ? 121 : 40);
        for (let off = 0; off < depth; off++) {
            tasks.push({
                leagueId: c.topId + off,
                cc: c.cc,
                isHighTier: off < 13 // Üst Lig + Div 1 + Div 2
            });
        }
    }

    console.log(`[1/4] 100 ülkeden toplam ${tasks.length} lig taranıyor (${LEAGUE_CONCURRENCY} paralel)...`);
    const found = new Map(); // tid -> { tid, name, cc, isHighTier }
    let idx = 0, done = 0;

    async function leagueWorker() {
        while (idx < tasks.length) {
            const task = tasks[idx++];
            const teams = await fetchLeagueTeams(task.leagueId);
            for (const t of teams) {
                if (!found.has(t.tid)) {
                    found.set(t.tid, { tid: t.tid, name: t.name, cc: task.cc, isHighTier: task.isHighTier });
                } else if (task.isHighTier) {
                    found.get(t.tid).isHighTier = true;
                }
            }
            done++;
            if (done % 500 === 0 || done === tasks.length) {
                console.log(`  Ligler: ${done}/${tasks.length} (%${Math.round((done / tasks.length) * 100)}) | Benzersiz takım: ${found.size}`);
            }
        }
    }
    await Promise.all(Array.from({ length: LEAGUE_CONCURRENCY }, () => leagueWorker()));

    console.log(`[2/4] Mevcut veritabanı takımları ile karşılaştırılıyor...`);
    const existingList = await fetchAllTeamsBasic();
    const existingMap = new Map(existingList.map(t => [Number(t.tid), t]));

    const missingTeams = [];
    const countryUpdates = [];
    for (const [tid, info] of found.entries()) {
        const ex = existingMap.get(tid);
        if (!ex) {
            missingTeams.push(info);
        } else if (!ex.country && info.cc) {
            countryUpdates.push({
                tid,
                name: ex.name || info.name || '',
                country: info.cc,
                senior_elo: ex.senior_elo,
                u23_elo: ex.u23_elo,
                u21_elo: ex.u21_elo,
                u18_elo: ex.u18_elo,
                senior_matches: ex.senior_matches || 0,
                last_scanned_at: ex.last_scanned_at
            });
        }
    }
    console.log(`  Veritabanında zaten var: ${found.size - missingTeams.length} | Ülkesi tamamlanacak: ${countryUpdates.length} | Yeni keşfedilen aday: ${missingTeams.length}`);

    // Yeni adayların Statsxente puanlarını toplu kontrol et
    console.log(`[3/4] ${missingTeams.length} yeni adayın Statsxente ELO kayıtları sorgulanıyor...`);
    const chunks = [];
    for (let i = 0; i < missingTeams.length; i += 25) {
        chunks.push(missingTeams.slice(i, i + 25));
    }

    const meta = await fetchMeta().catch(() => ({}));
    const snapIso = meta.snapshot_at_iso || new Date().toISOString();
    const nowIso = new Date().toISOString();
    const newActiveRows = [];
    let cIdx = 0, cDone = 0;

    async function statsWorker() {
        while (cIdx < chunks.length) {
            const chunk = chunks[cIdx++];
            const data = await fetchStatsChunk(chunk.map(t => t.tid));
            for (const t of chunk) {
                const obj = data[t.tid] || data[String(t.tid)] || {};
                const s = {
                    senior: parseVal(obj.SENIOR || obj.senior),
                    u23: parseVal(obj.U23 || obj.u23),
                    u21: parseVal(obj.U21 || obj.u21),
                    u18: parseVal(obj.U18 || obj.u18)
                };
                const hasAnyStats = s.senior !== null || s.u23 !== null || s.u21 !== null || s.u18 !== null;
                if (!hasAnyStats && !t.isHighTier) continue; // Alt lig ölü/bot kulüplerini alma

                newActiveRows.push({
                    tid: t.tid,
                    name: t.name || '',
                    country: t.cc || '',
                    senior_elo: s.senior,
                    u23_elo: s.u23,
                    u21_elo: s.u21,
                    u18_elo: s.u18,
                    senior_matches: 0,
                    last_scanned_at: null,
                    snap_senior: s.senior,
                    snap_u23: s.u23,
                    snap_u21: s.u21,
                    snap_u18: s.u18,
                    snap_at: snapIso,
                    ind_senior_elo: s.senior,
                    ind_u23_elo: s.u23,
                    ind_u21_elo: s.u21,
                    ind_u18_elo: s.u18,
                    ind_matches: 0,
                    updated_at: nowIso
                });
            }
            cDone++;
            if (cDone % 200 === 0 || cDone === chunks.length) {
                console.log(`  Statsxente: ${cDone}/${chunks.length} paket | Aktif yeni takım: ${newActiveRows.length}`);
            }
        }
    }
    await Promise.all(Array.from({ length: STATS_CONCURRENCY }, () => statsWorker()));

    console.log(`[4/4] Supabase'e yazılıyor: ${newActiveRows.length} yeni aktif takım + ${countryUpdates.length} ülke güncellemesi...`);
    if (countryUpdates.length > 0) await upsertTeams(countryUpdates);
    if (newActiveRows.length > 0) await upsertTeams(newActiveRows);

    await upsertMeta({
        all_countries_discovered_at: nowIso,
        all_countries_added: String(newActiveRows.length)
    }).catch(() => {});

    const sec = Math.round((Date.now() - started) / 1000);
    console.log(`✅ 100 ÜLKE TARAMASI BİTTİ! Toplam lig: ${tasks.length} | Yeni aktif takım: ${newActiveRows.length} | Ülke düzeltme: ${countryUpdates.length} | Süre: ${sec} sn`);
}

main().catch(err => {
    console.error('DISCOVER HATASI:', err);
    process.exit(1);
});
