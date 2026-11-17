// =====================================================================
// İLK KURULUM (BOOTSTRAP / SEED) BETİĞİ
// 1. Dünya sıralamasındaki üst takımları ve onların son 30 gündeki tüm
//    rakiplerini (~11.500+ aktif takım) keşfeder.
// 2. Tek seferlik başlangıç ELO çıpasını alır ve son 30 günün maçlarını
//    Pro-ELO v1.0 motoruyla kalibre ederek Supabase'e yazar.
// 3. Bundan sonraki tüm güncellemeler Statsxente'den bağımsız olarak
//    crawler.js tarafından tamamen bizim Pro-ELO formülümüzle yürütülür.
// =====================================================================

const { parseMatchlistXml } = require('./proEloEngine');
const { upsertTeams, insertProcessedMatches } = require('./supabaseClient');

async function fetchTop1000Seeds() {
    const url = 'https://statsxente.com/MZ1/Functions/lecturaEquipos2.0.php?sport=soccer&pais=all&liga=all&edad=senior&limite=1000&ordenar=elo';
    const res = await fetch(url);
    const html = await res.text();
    const rows = html.split(/<tr\b/i);
    const seeds = [];
    for (const row of rows) {
        const tm = row.match(/team_id=(\d+)/i);
        if (!tm) continue;
        const tid = parseInt(tm[1], 10);
        if (tid) seeds.push(tid);
    }
    return Array.from(new Set(seeds));
}

async function fetchMatchlist(tid) {
    const url = `https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&match_status=1&limit=1000`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        return parseMatchlistXml(xml);
    } catch (e) {
        return [];
    }
}

async function fetchStatsBaselineBatch(tids) {
    const result = new Map();
    const chunkSize = 25;
    for (let i = 0; i < tids.length; i += chunkSize) {
        const chunk = tids.slice(i, i + chunkSize);
        const params = chunk.map((id, idx) => `idEquipo${idx}=${id}`).join('&');
        const url = `https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer&${params}`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.teams) {
                for (const [tidStr, obj] of Object.entries(data.teams)) {
                    const tid = parseInt(tidStr, 10);
                    result.set(tid, {
                        senior_elo: parseFloat(obj.SENIOR || obj.ELO_TEAM_SENIOR) || 1200,
                        u23_elo: parseFloat(obj.U23 || obj.ELO_TEAM_U23) || 1000,
                        u21_elo: parseFloat(obj.U21 || obj.ELO_TEAM_U21) || 1000,
                        u18_elo: parseFloat(obj.U18 || obj.ELO_TEAM_U18) || 1000
                    });
                }
            }
        } catch (e) {}
    }
    return result;
}

async function main() {
    console.log('[1/4] İlk tohum takımlar çekiliyor...');
    const seedTids = await fetchTop1000Seeds();
    console.log(`Bulunan tohum takım sayısı: ${seedTids.length}`);

    const teamMeta = new Map();
    const allMatchesMap = new Map();

    console.log('[2/4] Tohum takımların son 30 günlük maçları ve rakipleri keşfediliyor...');
    const concurrency = 12;
    let idx = 0;
    async function worker() {
        while (idx < seedTids.length) {
            const currentIdx = idx++;
            const tid = seedTids[currentIdx];
            const matches = await fetchMatchlist(tid);
            for (const m of matches) {
                allMatchesMap.set(m.mid, m);
                for (const side of [m.home, m.away]) {
                    if (!teamMeta.has(side.tid)) {
                        teamMeta.set(side.tid, {
                            tid: side.tid,
                            name: side.name || '',
                            country: side.country || '',
                            scanned: false
                        });
                    } else if (side.name && !teamMeta.get(side.tid).name) {
                        teamMeta.get(side.tid).name = side.name;
                        teamMeta.get(side.tid).country = side.country || '';
                    }
                }
            }
            if (teamMeta.has(tid)) teamMeta.get(tid).scanned = true;
            if ((currentIdx + 1) % 100 === 0) {
                console.log(`  İlerleme: ${currentIdx + 1}/${seedTids.length} | Keşfedilen takım: ${teamMeta.size} | Tekil maç: ${allMatchesMap.size}`);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const allTids = Array.from(teamMeta.keys());
    console.log(`[3/4] ${allTids.length} benzersiz takım için başlangıç ELO çıpaları alınıyor...`);
    const baselines = await fetchStatsBaselineBatch(allTids);

    const nowIso = new Date().toISOString();
    const teamRows = allTids.map(tid => {
        const meta = teamMeta.get(tid);
        const base = baselines.get(tid) || { senior_elo: 1200, u23_elo: 1000, u21_elo: 1000, u18_elo: 1000 };
        return {
            tid,
            name: meta.name,
            country: meta.country,
            senior_elo: Number(base.senior_elo.toFixed(2)),
            u23_elo: Number(base.u23_elo.toFixed(2)),
            u21_elo: Number(base.u21_elo.toFixed(2)),
            u18_elo: Number(base.u18_elo.toFixed(2)),
            last_scanned_at: meta.scanned ? nowIso : null,
            updated_at: nowIso
        };
    });

    console.log(`[4/4] ${teamRows.length} takım ve ${allMatchesMap.size} işlenmiş maç ID'si Supabase'e yazılıyor...`);
    await upsertTeams(teamRows);

    const matchRows = Array.from(allMatchesMap.values()).map(m => ({
        mid: m.mid,
        played_at: m.date ? new Date(m.date.replace(' ', 'T') + 'Z').toISOString() : nowIso,
        category: 'seed',
        home_tid: m.home.tid,
        away_tid: m.away.tid,
        home_delta: 0,
        away_delta: 0
    }));
    await insertProcessedMatches(matchRows);

    console.log(`TAMAMLANDI! ${teamRows.length} takım ve ${matchRows.length} maç başarıyla kaydedildi.`);
}

main().catch(err => {
    console.error('SEED HATASI:', err);
    process.exit(1);
});
