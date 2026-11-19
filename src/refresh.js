// =====================================================================
// PRO-ELO SAATLİK YÜKSEK HIZLI ÇİFT-MODEL YENİLEYİCİ (Model 1 + Model 2)
// ---------------------------------------------------------------------
// - Ölü/bot takımları atlar, YALNIZCA aktif (~17.500) kulüpleri döner.
// - Sayfalamalı kuyruk (1.000'erli): saatte ~9.500 aktif takım (~10 dk)
//   -> En üst 600 takım HER SAAT, tüm aktif dünya 2 SAATTE 1 yenilenir!
// - MODEL 1 (Hibrit): Canlı Statsxente + 30 günlük maç farkı (betikle aynı)
// - MODEL 2 (Bağımsız): 18.11.2026 çapası + sonrası tekil maçlar
// =====================================================================

const { parseMatchlistXml } = require('./proEloEngine');
const {
    parseVal,
    toScriptMatches,
    classifyCategory,
    computeProElo,
    computeIndependentMatchDelta
} = require('./proEloCore');
const {
    upsertTeams,
    insertMissingTeams,
    fetchTeamsByTids,
    fetchIndProcessedMids,
    insertIndMatches,
    fetchMeta,
    upsertMeta
} = require('./supabaseClient');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://bggydqalllytcqwxsypj.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_KEY || '';
const TOP_LIMIT = parseInt(process.env.TOP_LIMIT || '400', 10);
const IND_TOP_LIMIT = parseInt(process.env.IND_TOP_LIMIT || '200', 10);
const ROTATE_LIMIT = parseInt(process.env.ROTATE_LIMIT || '9000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '12', 10);
const ONLY_TIDS = (process.env.ONLY_TIDS || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, opts);
            if (res.ok) return await res.json();
        } catch (_) {}
        await sleep(700 * (i + 1));
    }
    return null;
}

async function fetchText(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.text();
        } catch (_) {}
        await sleep(700 * (i + 1));
    }
    return null;
}

// Supabase PostgREST tek istekte 1000 satır sınırı olduğundan sayfalamalı çekim
async function fetchPaged(baseQuery, totalWanted) {
    const out = [];
    const pageSize = 1000;
    let offset = 0;
    while (out.length < totalWanted) {
        const take = Math.min(pageSize, totalWanted - out.length);
        const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/${baseQuery}&limit=${take}&offset=${offset}`, { headers });
        if (!Array.isArray(rows) || rows.length === 0) break;
        out.push(...rows);
        if (rows.length < take) break;
        offset += take;
    }
    return out;
}

// ---- Statsxente (koşu boyunca önbellekli, 25'li paketler) ----
const statsCache = new Map();
const inFlightStats = new Map();
async function ensureStats(tids) {
    const missing = [...new Set(tids.map(Number))].filter(id => id && !statsCache.has(id) && !inFlightStats.has(id));
    if (missing.length === 0) {
        const pending = [...new Set(tids.map(Number))].map(id => inFlightStats.get(id)).filter(Boolean);
        if (pending.length) await Promise.all(pending);
        return;
    }

    const promises = [];
    for (let i = 0; i < missing.length; i += 25) {
        const chunk = missing.slice(i, i + 25);
        const q = chunk.map((id, idx) => `&idEquipo${idx}=${id}`).join('');
        const p = (async () => {
            const data = await fetchJson(`https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer${q}`);
            const teams = (data && data.teams) ? data.teams : (data || {});
            chunk.forEach(id => {
                const t = teams[id] || teams[String(id)] || {};
                statsCache.set(id, {
                    senior: parseVal(t.SENIOR || t.senior),
                    u23: parseVal(t.U23 || t.u23),
                    u21: parseVal(t.U21 || t.u21),
                    u18: parseVal(t.U18 || t.u18)
                });
                inFlightStats.delete(id);
            });
        })();
        chunk.forEach(id => inFlightStats.set(id, p));
        promises.push(p);
    }
    await Promise.all(promises);
}

async function pickQueue(hasIndColumns) {
    if (ONLY_TIDS.length) {
        return await fetchJson(`${SUPABASE_URL}/rest/v1/mz_teams?tid=in.(${ONLY_TIDS.join(',')})&select=tid,name,country`, { headers }) || [];
    }
    const map = new Map();

    // 1) En üst Hibrit takımlar (her saat mutlaka)
    const topHybrid = await fetchPaged('mz_teams?select=tid,name,country&order=senior_elo.desc.nullslast', TOP_LIMIT);
    topHybrid.forEach(t => map.set(Number(t.tid), t));

    // 2) En üst Bağımsız takımlar (her saat mutlaka)
    if (hasIndColumns && IND_TOP_LIMIT > 0) {
        const topInd = await fetchPaged('mz_teams?select=tid,name,country&order=ind_senior_elo.desc.nullslast', IND_TOP_LIMIT);
        topInd.forEach(t => {
            if (!map.has(Number(t.tid))) map.set(Number(t.tid), t);
        });
    }

    // 3) Aktif takımlardan en uzun süredir taranmamış olanlar (bot/ölü kulüpler hariç!)
    const activeFilter = hasIndColumns
        ? '&or=(snap_senior.not.is.null,snap_u23.not.is.null,snap_u21.not.is.null,snap_u18.not.is.null)'
        : '&senior_elo=not.is.null';
    const targetTotal = map.size + ROTATE_LIMIT;
    const rot = await fetchPaged(
        `mz_teams?select=tid,name,country${activeFilter}&order=last_scanned_at.asc.nullsfirst`,
        ROTATE_LIMIT + map.size
    );
    for (const t of rot) {
        if (map.size >= targetTotal) break;
        if (!map.has(Number(t.tid))) map.set(Number(t.tid), t);
    }
    return [...map.values()];
}

async function main() {
    if (!KEY) throw new Error('SUPABASE_SERVICE_KEY tanımlı değil');
    const started = Date.now();

    let meta = {};
    let hasV2 = false;
    try {
        meta = await fetchMeta();
        hasV2 = true;
    } catch (_) {
        console.log('[Bilgi] mz_meta tablosu henüz yok — sadece Model 1 (Hibrit) çalışacak.');
    }
    const snapshotCutoff = meta.snapshot_cutoff || null;

    const queue = await pickQueue(hasV2);
    console.log(`[1/4] ${queue.length} AKTİF takım taranacak (top=${TOP_LIMIT}, indTop=${hasV2 ? IND_TOP_LIMIT : 0}, rotasyon=${ROTATE_LIMIT}, paralel=${CONCURRENCY}, çapa=${snapshotCutoff || 'YOK'})`);

    const hybridResults = new Map();    // tid -> Model 1 hesap sonuçları
    const discovered = new Map();       // tid -> { name, country }
    const postCutoffMatches = new Map();// Sadece çapa sonrası maçlar (RAM tasarrufu!)
    let idx = 0, done = 0;

    async function worker() {
        while (idx < queue.length) {
            const team = queue[idx++];
            const tid = Number(team.tid);
            const xml = await fetchText(`https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&limit=1000`);
            const nowIso = new Date().toISOString();
            if (xml === null) continue;

            const raw = parseMatchlistXml(xml);
            const matches = toScriptMatches(raw, tid);
            let name = team.name || '';
            let country = team.country || '';
            let leagueSenior = team.league_senior || null;
            let wleagueSenior = team.wleague_senior || null;
            let leagueU23 = team.league_u23 || null;
            let wleagueU23 = team.wleague_u23 || null;
            let leagueU21 = team.league_u21 || null;
            let wleagueU21 = team.wleague_u21 || null;
            let leagueU18 = team.league_u18 || null;
            let wleagueU18 = team.wleague_u18 || null;

            for (const m of raw) {
                const self = Number(m.home.tid) === tid ? m.home : m.away;
                const opp = Number(m.home.tid) === tid ? m.away : m.home;
                if (self.name) name = self.name;
                if (self.country) country = self.country;
                const oppTid = Number(opp.tid);
                if (!discovered.has(oppTid)) {
                    discovered.set(oppTid, { name: opp.name || '', country: opp.country || '' });
                } else {
                    const d = discovered.get(oppTid);
                    if (!d.name && opp.name) d.name = opp.name;
                    if (!d.country && opp.country) d.country = opp.country;
                }
                const rawType = (m.rawType || '').toLowerCase();
                const typeName = m.typeName || '';
                if (rawType === 'league' && typeName) leagueSenior = typeName;
                else if (rawType === 'world_league' && typeName) wleagueSenior = typeName;
                else if (rawType === 'u23_league' && typeName) leagueU23 = typeName;
                else if (rawType === 'u23_world_league' && typeName) wleagueU23 = typeName;
                else if (rawType === 'u21_league' && typeName) leagueU21 = typeName;
                else if (rawType === 'u21_world_league' && typeName) wleagueU21 = typeName;
                else if (rawType === 'u18_league' && typeName) leagueU18 = typeName;
                else if (rawType === 'u18_world_league' && typeName) wleagueU18 = typeName;

                if (snapshotCutoff && m.date && String(m.date) >= snapshotCutoff && !postCutoffMatches.has(m.mid)) {
                    postCutoffMatches.set(m.mid, m);
                }
            }

            // ---- MODEL 1 (Hibrit: Canlı Statsxente + 30 günlük Pro-Stats farkı) ----
            await ensureStats([tid, ...matches.map(m => m.oppTid)]);
            const selfStats = statsCache.get(tid) || { senior: null, u23: null, u21: null, u18: null };
            const oppElos = {};
            matches.forEach(m => { oppElos[m.oppTid] = statsCache.get(Number(m.oppTid)); });

            const r = computeProElo(selfStats, matches, oppElos);
            hybridResults.set(tid, {
                tid,
                name,
                country,
                senior_elo: r.senior.proElo,
                u23_elo: r.u23.proElo,
                u21_elo: r.u21.proElo,
                u18_elo: r.u18.proElo,
                senior_matches: r.senior.matchCount,
                league_senior: leagueSenior,
                wleague_senior: wleagueSenior,
                league_u23: leagueU23,
                wleague_u23: wleagueU23,
                league_u21: leagueU21,
                wleague_u21: wleagueU21,
                league_u18: leagueU18,
                wleague_u18: wleagueU18,
                last_scanned_at: nowIso,
                updated_at: nowIso
            });

            done++;
            if (done % 500 === 0 || ONLY_TIDS.length) {
                const elapsed = Math.round((Date.now() - started) / 1000);
                console.log(`  ${done}/${queue.length} (${elapsed}s) | ${name} (#${tid}) Hibrit Senior: ${selfStats.senior} ${r.senior.adjustment >= 0 ? '+' : ''}${r.senior.adjustment} = ${r.senior.proElo}`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // ---- MODEL 2 (Bağımsız: snapshotCutoff sonrası tekil maçlar) ----
    let newIndMatches = [];
    if (hasV2 && snapshotCutoff) {
        const candidates = [...postCutoffMatches.values()];
        if (candidates.length > 0) {
            const alreadyProcessed = await fetchIndProcessedMids(candidates.map(m => m.mid));
            newIndMatches = candidates
                .filter(m => !alreadyProcessed.has(m.mid))
                .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.mid - b.mid));
        }
        console.log(`[2/4] Model 2 (Bağımsız): Çapa (${snapshotCutoff}) sonrası ${candidates.length} aday maçtan ${newIndMatches.length} yeni maç işlenecek.`);
    } else {
        console.log('[2/4] Model 2 (Bağımsız): Çapa henüz alınmadığı için atlandı.');
    }

    const allInvolvedTids = new Set(hybridResults.keys());
    for (const m of newIndMatches) {
        allInvolvedTids.add(Number(m.home.tid));
        allInvolvedTids.add(Number(m.away.tid));
    }
    const teamStateMap = await fetchTeamsByTids([...allInvolvedTids]);
    const dirtyTids = new Set();
    const nowIso = new Date().toISOString();

    // Model 2 için henüz çapa almamış yeni takımlar varsa 1 kerelik Statsxente çapası al
    if (hasV2 && newIndMatches.length > 0) {
        const needSnapTids = [];
        for (const m of newIndMatches) {
            for (const side of [m.home, m.away]) {
                const tid = Number(side.tid);
                const row = teamStateMap.get(tid);
                if (!row || !row.snap_at) needSnapTids.push(tid);
            }
        }
        if (needSnapTids.length > 0) {
            await ensureStats(needSnapTids);
            for (const tid of new Set(needSnapTids)) {
                const s = statsCache.get(tid) || { senior: null, u23: null, u21: null, u18: null };
                const metaInfo = discovered.get(tid) || { name: '', country: '' };
                const existing = teamStateMap.get(tid);
                if (!existing) {
                    teamStateMap.set(tid, {
                        tid,
                        name: metaInfo.name,
                        country: metaInfo.country,
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
                        snap_at: nowIso,
                        ind_senior_elo: s.senior,
                        ind_u23_elo: s.u23,
                        ind_u21_elo: s.u21,
                        ind_u18_elo: s.u18,
                        ind_matches: 0,
                        updated_at: nowIso
                    });
                } else if (!existing.snap_at) {
                    existing.snap_senior = s.senior;
                    existing.snap_u23 = s.u23;
                    existing.snap_u21 = s.u21;
                    existing.snap_u18 = s.u18;
                    existing.snap_at = nowIso;
                    existing.ind_senior_elo = s.senior;
                    existing.ind_u23_elo = s.u23;
                    existing.ind_u21_elo = s.u21;
                    existing.ind_u18_elo = s.u18;
                    existing.ind_matches = existing.ind_matches || 0;
                }
                dirtyTids.add(tid);
            }
        }
    }

    // Model 2 maçlarını kronolojik işle
    const indMatchRows = [];
    let indScoredCount = 0;
    for (const m of newIndMatches) {
        const homeTid = Number(m.home.tid);
        const awayTid = Number(m.away.tid);
        const homeRow = teamStateMap.get(homeTid);
        const awayRow = teamStateMap.get(awayTid);
        if (!homeRow || !awayRow) continue;

        if (m.home.name) homeRow.name = m.home.name;
        if (m.home.country) homeRow.country = m.home.country;
        if (m.away.name) awayRow.name = m.away.name;
        if (m.away.country) awayRow.country = m.away.country;

        const age = classifyCategory(m.rawType, m.typeName);
        const col = `ind_${age}_elo`;
        const defaultStart = age === 'senior' ? 1200 : 1000;

        const homeHad = homeRow[col] != null;
        const awayHad = awayRow[col] != null;
        const homeElo = homeHad ? Number(homeRow[col]) : defaultStart;
        const awayElo = awayHad ? Number(awayRow[col]) : defaultStart;
        const oppMissing = !homeHad || !awayHad;

        const res = computeIndependentMatchDelta(homeElo, awayElo, m.home.goals, m.away.goals, m.rawType, m.typeName, oppMissing);
        if (res.k > 0) {
            homeRow[col] = Math.max(100, Number((homeElo + res.homeDelta).toFixed(2)));
            awayRow[col] = Math.max(100, Number((awayElo + res.awayDelta).toFixed(2)));
            homeRow.ind_matches = (homeRow.ind_matches || 0) + 1;
            awayRow.ind_matches = (awayRow.ind_matches || 0) + 1;
            homeRow.updated_at = nowIso;
            awayRow.updated_at = nowIso;
            dirtyTids.add(homeTid);
            dirtyTids.add(awayTid);
            indScoredCount++;
        }

        indMatchRows.push({
            mid: m.mid,
            played_at: String(m.date),
            category: res.age,
            home_tid: homeTid,
            away_tid: awayTid,
            home_delta: res.homeDelta,
            away_delta: res.awayDelta
        });
    }

    // Model 1 sonuçlarını güvenle birleştir (snap_* ve ind_* korunur!)
    for (const [tid, h] of hybridResults.entries()) {
        const existing = teamStateMap.get(tid);
        if (existing) {
            existing.name = h.name || existing.name || '';
            existing.country = h.country || existing.country || '';
            existing.senior_elo = h.senior_elo;
            existing.u23_elo = h.u23_elo;
            existing.u21_elo = h.u21_elo;
            existing.u18_elo = h.u18_elo;
            existing.senior_matches = h.senior_matches;
            existing.last_scanned_at = h.last_scanned_at;
            existing.updated_at = h.updated_at;
        } else {
            teamStateMap.set(tid, h);
        }
        dirtyTids.add(tid);
    }

    const rowsToUpsert = [];
    for (const tid of dirtyTids) {
        const row = teamStateMap.get(tid);
        if (!row) continue;
        const payload = {
            tid: Number(row.tid),
            name: row.name || '',
            country: row.country || '',
            senior_elo: row.senior_elo,
            u23_elo: row.u23_elo,
            u21_elo: row.u21_elo,
            u18_elo: row.u18_elo,
            senior_matches: row.senior_matches || 0,
            league_senior: row.league_senior || null,
            wleague_senior: row.wleague_senior || null,
            league_u23: row.league_u23 || null,
            wleague_u23: row.wleague_u23 || null,
            league_u21: row.league_u21 || null,
            wleague_u21: row.wleague_u21 || null,
            league_u18: row.league_u18 || null,
            wleague_u18: row.wleague_u18 || null,
            last_scanned_at: row.last_scanned_at || null,
            updated_at: row.updated_at || nowIso
        };
        if (hasV2) {
            payload.snap_senior = row.snap_senior ?? null;
            payload.snap_u23 = row.snap_u23 ?? null;
            payload.snap_u21 = row.snap_u21 ?? null;
            payload.snap_u18 = row.snap_u18 ?? null;
            payload.snap_at = row.snap_at ?? null;
            payload.ind_senior_elo = row.ind_senior_elo ?? null;
            payload.ind_u23_elo = row.ind_u23_elo ?? null;
            payload.ind_u21_elo = row.ind_u21_elo ?? null;
            payload.ind_u18_elo = row.ind_u18_elo ?? null;
            payload.ind_matches = row.ind_matches || 0;
        }
        rowsToUpsert.push(payload);
    }

    console.log(`[3/4] ${rowsToUpsert.length} takım ve ${indMatchRows.length} bağımsız maç Supabase'e yazılıyor...`);
    await upsertTeams(rowsToUpsert);
    if (hasV2 && indMatchRows.length > 0) {
        await insertIndMatches(indMatchRows);
    }

    // Yeni keşfedilen aktif rakipleri (Statsxente kaydı olanları) ekle
    const newRows = [];
    for (const [tid, info] of discovered.entries()) {
        if (teamStateMap.has(tid)) continue;
        const s = statsCache.get(tid);
        if (!s || (s.senior === null && s.u23 === null && s.u21 === null && s.u18 === null)) continue;
        const row = {
            tid,
            name: info.name || '',
            country: info.country || '',
            senior_elo: s.senior,
            u23_elo: s.u23,
            u21_elo: s.u21,
            u18_elo: s.u18,
            senior_matches: 0,
            last_scanned_at: null
        };
        if (hasV2) {
            row.snap_senior = s.senior;
            row.snap_u23 = s.u23;
            row.snap_u21 = s.u21;
            row.snap_u18 = s.u18;
            row.snap_at = nowIso;
            row.ind_senior_elo = s.senior;
            row.ind_u23_elo = s.u23;
            row.ind_u21_elo = s.u21;
            row.ind_u18_elo = s.u18;
            row.ind_matches = 0;
        }
        newRows.push(row);
    }
    if (newRows.length > 0) {
        await insertMissingTeams(newRows);
    }

    const durationSec = Math.round((Date.now() - started) / 1000);
    if (hasV2) {
        await upsertMeta({
            last_refresh_at: nowIso,
            last_refresh_stats: JSON.stringify({
                scannedTeams: hybridResults.size,
                updatedTeams: rowsToUpsert.length,
                indNewMatches: indMatchRows.length,
                indScoredMatches: indScoredCount,
                durationSec
            })
        });
    }

    console.log(`[4/4] ✅ TAMAMLANDI: ${hybridResults.size} hibrit takım | ${indScoredCount}/${indMatchRows.length} bağımsız maç | ${durationSec} sn`);
}

main().catch(err => {
    console.error('REFRESH HATASI:', err);
    process.exit(1);
});
