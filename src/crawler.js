// =====================================================================
// ARTalan / SÜREKLİ PRO-ELO TARAYICI (INCREMENTAL CRAWLER)
// Her çalışmada sıradaki takımların maçlarını çeker, yeni rakipleri
// otomatik keşfeder ve sadece yeni oynanan maçları Pro-ELO v1.0
// formülüyle hesaplayıp Supabase veritabanını günceller.
// =====================================================================

const { computeMatchDelta, parseMatchlistXml } = require('./proEloEngine');
const {
    upsertTeams,
    insertMissingTeams,
    fetchTeamsByTids,
    fetchNextTeamsToScan,
    fetchProcessedMids,
    insertProcessedMatches,
    cleanupOldMatches
} = require('./supabaseClient');

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '600', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);

async function fetchMatchlist(tid) {
    const url = `https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&match_status=1&limit=200`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const xml = await res.text();
        return parseMatchlistXml(xml);
    } catch (e) {
        return [];
    }
}

async function main() {
    console.log(`[1/5] Sıradaki ${SCAN_LIMIT} takım Supabase'den alınıyor...`);
    const queue = await fetchNextTeamsToScan(SCAN_LIMIT);
    if (!queue.length) {
        console.log('Taranacak takım bulunamadı. Önce "npm run seed" çalıştırın.');
        return;
    }

    const scannedTids = new Set(queue.map(t => Number(t.tid)));
    const allMatchesMap = new Map();
    const discoveredTeams = new Map();

    console.log(`[2/5] ${queue.length} takımın ManagerZone maç geçmişi taranıyor...`);
    let idx = 0;
    async function worker() {
        while (idx < queue.length) {
            const i = idx++;
            const team = queue[i];
            const matches = await fetchMatchlist(team.tid);
            for (const m of matches) {
                allMatchesMap.set(m.mid, m);
                for (const side of [m.home, m.away]) {
                    if (!discoveredTeams.has(side.tid)) {
                        discoveredTeams.set(side.tid, {
                            tid: side.tid,
                            name: side.name || '',
                            country: side.country || ''
                        });
                    }
                }
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const allMids = Array.from(allMatchesMap.keys());
    console.log(`[3/5] Toplam ${allMids.length} maç bulundu. Daha önce işlenmiş maçlar filtreleniyor...`);
    const alreadyProcessed = await fetchProcessedMids(allMids);
    const newMatches = Array.from(allMatchesMap.values())
        .filter(m => !alreadyProcessed.has(m.mid))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    console.log(`Yeni işlenecek maç sayısı: ${newMatches.length}`);

    // Tüm ilgili takımların mevcut ELO kayıtlarını getir
    const allInvolvedTids = Array.from(new Set([
        ...scannedTids,
        ...Array.from(discoveredTeams.keys())
    ]));
    const existingTeamsMap = await fetchTeamsByTids(allInvolvedTids);

    // Yeni keşfedilen (veritabanında henüz olmayan) takımları ekle
    const missingTeamRows = [];
    for (const [tid, meta] of discoveredTeams.entries()) {
        if (!existingTeamsMap.has(tid)) {
            const newRow = {
                tid,
                name: meta.name,
                country: meta.country,
                senior_elo: 1200.00,
                u23_elo: 1000.00,
                u21_elo: 1000.00,
                u18_elo: 1000.00,
                senior_matches: 0,
                last_scanned_at: null
            };
            existingTeamsMap.set(tid, newRow);
            missingTeamRows.push(newRow);
        }
    }
    if (missingTeamRows.length > 0) {
        console.log(`Yeni keşfedilen ${missingTeamRows.length} rakip takım kuyruğa ekleniyor...`);
        await insertMissingTeams(missingTeamRows);
    }

    // [4/5] Yeni maçları kronolojik sırayla Pro-ELO v1.0 motorundan geçir
    const dirtyTids = new Set(scannedTids);
    const processedMatchRows = [];
    const nowIso = new Date().toISOString();

    for (const m of newMatches) {
        const homeObj = existingTeamsMap.get(m.home.tid);
        const awayObj = existingTeamsMap.get(m.away.tid);
        if (!homeObj || !awayObj) continue;

        if (m.home.name) homeObj.name = m.home.name;
        if (m.home.country) homeObj.country = m.home.country;
        if (m.away.name) awayObj.name = m.away.name;
        if (m.away.country) awayObj.country = m.away.country;

        const prelim = computeMatchDelta(1200, 1200, m.home.goals, m.away.goals, m.rawType, m.typeName);
        const ageCol = `${prelim.age}_elo`;

        const homeElo = Number(homeObj[ageCol] ?? (prelim.age === 'senior' ? 1200 : 1000));
        const awayElo = Number(awayObj[ageCol] ?? (prelim.age === 'senior' ? 1200 : 1000));

        const res = computeMatchDelta(homeElo, awayElo, m.home.goals, m.away.goals, m.rawType, m.typeName, false);
        if (res.k > 0) {
            homeObj[ageCol] = Number((homeElo + res.homeDelta).toFixed(2));
            awayObj[ageCol] = Number((awayElo + res.awayDelta).toFixed(2));
            if (res.age === 'senior') {
                homeObj.senior_matches = (homeObj.senior_matches || 0) + 1;
                awayObj.senior_matches = (awayObj.senior_matches || 0) + 1;
            }
            dirtyTids.add(m.home.tid);
            dirtyTids.add(m.away.tid);
        }

        processedMatchRows.push({
            mid: m.mid,
            played_at: m.date ? new Date(m.date.replace(' ', 'T') + 'Z').toISOString() : nowIso,
            category: res.age,
            home_tid: m.home.tid,
            away_tid: m.away.tid,
            home_delta: res.homeDelta,
            away_delta: res.awayDelta
        });
    }

    const teamsToUpdate = [];
    for (const tid of dirtyTids) {
        const t = existingTeamsMap.get(tid);
        if (!t) continue;
        teamsToUpdate.push({
            tid: t.tid,
            name: t.name || '',
            country: t.country || '',
            senior_elo: Number(Number(t.senior_elo).toFixed(2)),
            u23_elo: Number(Number(t.u23_elo).toFixed(2)),
            u21_elo: Number(Number(t.u21_elo).toFixed(2)),
            u18_elo: Number(Number(t.u18_elo).toFixed(2)),
            senior_matches: t.senior_matches || 0,
            last_scanned_at: scannedTids.has(tid) ? nowIso : t.last_scanned_at,
            updated_at: nowIso
        });
    }

    console.log(`[5/5] ${teamsToUpdate.length} takım ve ${processedMatchRows.length} yeni maç Supabase'e kaydediliyor...`);
    await upsertTeams(teamsToUpdate);
    await insertProcessedMatches(processedMatchRows);
    await cleanupOldMatches();

    console.log('TARAMA BAŞARIYLA TAMAMLANDI!');
}

main().catch(err => {
    console.error('CRAWLER HATASI:', err);
    process.exit(1);
});
