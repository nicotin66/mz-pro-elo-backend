// =====================================================================
// PRO-ELO SAATLİK YENİLEYİCİ (Betikle %100 aynı formül)
// ---------------------------------------------------------------------
// Her çalışmada:
//   1) En yüksek Pro-ELO'lu ilk TOP_LIMIT takım (her saat mutlaka) +
//   2) En uzun süredir güncellenmemiş ROTATE_LIMIT takım (sırayla tüm dünya)
// için ManagerZone maç listesi + CANLI Statsxente ELO'ları çekilir ve
// Pro-ELO = Statsxente + (Pro - Stats) farkı yeniden hesaplanır.
// Maçlarda keşfedilen yeni rakipler Statsxente değeriyle kuyruğa eklenir.
// =====================================================================

const { parseMatchlistXml } = require('./proEloEngine');
const { parseVal, toScriptMatches, computeProElo } = require('./proEloCore');
const {
    upsertTeams,
    insertMissingTeams,
    insertProcessedMatches,
    cleanupOldMatches
} = require('./supabaseClient');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://bggydqalllytcqwxsypj.supabase.co').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_KEY || '';
const TOP_LIMIT = parseInt(process.env.TOP_LIMIT || '300', 10);
const ROTATE_LIMIT = parseInt(process.env.ROTATE_LIMIT || '500', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);
const ONLY_TIDS = (process.env.ONLY_TIDS || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, opts);
            if (res.ok) return await res.json();
        } catch (_) {}
        await sleep(800 * (i + 1));
    }
    return null;
}

async function fetchText(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.text();
        } catch (_) {}
        await sleep(800 * (i + 1));
    }
    return null;
}

// ---- Statsxente (koşu boyunca önbellekli) ----
const statsCache = new Map(); // tid(number) -> {senior,u23,u21,u18} | null
async function ensureStats(tids) {
    const missing = [...new Set(tids.map(Number))].filter(id => id && !statsCache.has(id));
    for (let i = 0; i < missing.length; i += 25) {
        const chunk = missing.slice(i, i + 25);
        const q = chunk.map((id, idx) => `&idEquipo${idx}=${id}`).join('');
        const data = await fetchJson(`https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer${q}`);
        const teams = (data && data.teams) ? data.teams : (data || {});
        chunk.forEach(id => {
            const t = teams[id] || teams[String(id)] || {};
            // Betikle aynı: istek başarısız olsa bile null değerlerle önbelleğe alınır
            statsCache.set(id, {
                senior: parseVal(t.SENIOR || t.senior),
                u23: parseVal(t.U23 || t.u23),
                u21: parseVal(t.U21 || t.u21),
                u18: parseVal(t.U18 || t.u18)
            });
        });
    }
}

async function pickQueue() {
    if (ONLY_TIDS.length) {
        return await fetchJson(`${SUPABASE_URL}/rest/v1/mz_teams?tid=in.(${ONLY_TIDS.join(',')})&select=tid,name,country`, { headers }) || [];
    }
    const top = await fetchJson(`${SUPABASE_URL}/rest/v1/mz_teams?select=tid,name,country&order=senior_elo.desc.nullslast&limit=${TOP_LIMIT}`, { headers }) || [];
    const rot = await fetchJson(`${SUPABASE_URL}/rest/v1/mz_teams?select=tid,name,country&order=last_scanned_at.asc.nullsfirst&limit=${ROTATE_LIMIT + TOP_LIMIT}`, { headers }) || [];
    const map = new Map();
    top.forEach(t => map.set(Number(t.tid), t));
    for (const t of rot) {
        if (map.size >= TOP_LIMIT + ROTATE_LIMIT) break;
        if (!map.has(Number(t.tid))) map.set(Number(t.tid), t);
    }
    return [...map.values()];
}

async function main() {
    if (!KEY) throw new Error('SUPABASE_SERVICE_KEY tanımlı değil');
    const started = Date.now();
    const queue = await pickQueue();
    console.log(`[1/3] ${queue.length} takım yenilenecek (top=${TOP_LIMIT}, rotasyon=${ROTATE_LIMIT})`);

    const updated = [];
    const discovered = new Map();
    const seenMatches = new Map();
    let idx = 0, done = 0;

    async function worker() {
        while (idx < queue.length) {
            const team = queue[idx++];
            const tid = Number(team.tid);
            const xml = await fetchText(`https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&limit=1000`);
            const nowIso = new Date().toISOString();
            if (xml === null) continue; // MZ erişilemedi: bu takımı atla, bir sonraki koşuda tekrar denenir

            const raw = parseMatchlistXml(xml);
            const matches = toScriptMatches(raw, tid);
            let name = team.name || '';
            for (const m of raw) {
                const self = Number(m.home.tid) === tid ? m.home : m.away;
                const opp = Number(m.home.tid) === tid ? m.away : m.home;
                if (self.name) name = self.name;
                if (!discovered.has(Number(opp.tid))) discovered.set(Number(opp.tid), opp.name || '');
                if (!seenMatches.has(m.mid)) seenMatches.set(m.mid, m);
            }

            await ensureStats([tid, ...matches.map(m => m.oppTid)]);
            const self = statsCache.get(tid) || { senior: null, u23: null, u21: null, u18: null };
            const oppElos = {};
            matches.forEach(m => { oppElos[m.oppTid] = statsCache.get(Number(m.oppTid)); });

            const r = computeProElo(self, matches, oppElos);
            updated.push({
                tid,
                name,
                country: team.country || '',
                senior_elo: r.senior.proElo,
                u23_elo: r.u23.proElo,
                u21_elo: r.u21.proElo,
                u18_elo: r.u18.proElo,
                senior_matches: r.senior.matchCount,
                last_scanned_at: nowIso,
                updated_at: nowIso
            });
            done++;
            if (done % 50 === 0 || ONLY_TIDS.length) {
                console.log(`  ${done}/${queue.length} | ${name} (#${tid}) Senior: ${self.senior} ${r.senior.adjustment >= 0 ? '+' : ''}${r.senior.adjustment} = ${r.senior.proElo}`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    console.log(`[2/3] ${updated.length} takım Supabase'e yazılıyor...`);
    await upsertTeams(updated);

    // Yeni keşfedilen rakipler: Statsxente değeriyle eklenir (zaten varsa dokunulmaz)
    const knownTids = new Set(updated.map(u => u.tid));
    const newRows = [];
    for (const [tid, name] of discovered) {
        if (knownTids.has(tid)) continue;
        const s = statsCache.get(tid);
        if (!s || s.senior === null) continue; // Statsxente'de kaydı olmayanları ekleme
        newRows.push({
            tid, name, country: '',
            senior_elo: s.senior, u23_elo: s.u23, u21_elo: s.u21, u18_elo: s.u18,
            senior_matches: 0, last_scanned_at: null
        });
    }
    if (newRows.length) {
        console.log(`  ${newRows.length} yeni rakip kuyruğa eklendi (ignore-duplicates)`);
        await insertMissingTeams(newRows);
    }

    // Panodaki "Hesaplanan Toplam Maç" sayacı için maç kimlikleri
    const nowIso = new Date().toISOString();
    const matchRows = [...seenMatches.values()].map(m => ({
        mid: m.mid,
        played_at: m.date ? new Date(m.date.replace(' ', 'T') + 'Z').toISOString() : nowIso,
        category: 'refresh',
        home_tid: m.home.tid,
        away_tid: m.away.tid,
        home_delta: 0,
        away_delta: 0
    }));
    await insertProcessedMatches(matchRows);
    await cleanupOldMatches();

    console.log(`[3/3] TAMAMLANDI: ${updated.length} takım, ${matchRows.length} maç, ${Math.round((Date.now() - started) / 1000)} sn`);
}

main().catch(err => {
    console.error('REFRESH HATASI:', err);
    process.exit(1);
});
