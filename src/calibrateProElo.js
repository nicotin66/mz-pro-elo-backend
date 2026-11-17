// =====================================================================
// PRO-ELO KALİBRASYON MOTORU (30 GÜNLÜK GERÇEK MAÇ KALİBRASYONU)
// Statsxente ham başlangıç puanları üzerine, takımın son 30 günlük
// resmi maçlarındaki Lig Ağırlığı, Kupa Aşaması ve Gol Farkı çarpanlarını
// hesaplayarak gerçek PRO-ELO v1.0 puanını üretir.
// =====================================================================

const { parseMatchlistXml } = require('./proEloEngine');
const { upsertTeams } = require('./supabaseClient');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bggydqalllytcqwxsypj.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_KEY || '';

// Environment variable yoksa process.env'e ata
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY;

const ProEloEngine = {
    getGoalDiffMultiplier(goalDiff, eloDiff) {
        if (Math.abs(eloDiff) >= 300) return 1.0;
        const diff = Math.abs(goalDiff);
        if (diff <= 1) return 1.0;
        if (diff === 2) return 1.20;
        if (diff === 3) return 1.35;
        return 1.50;
    },
    getLeagueTierMultiplier(leagueName, isWorldLeague = false) {
        if (!leagueName) return 1.0;
        const l = leagueName.toLowerCase().trim();
        if (l.includes('top series')) return 1.30;
        const divMatch = l.match(/(?:\bdiv\s*|division\s*|^)(\d+)(?:\.|\s|$)/);
        if (divMatch) {
            const tier = parseInt(divMatch[1], 10);
            if (tier === 1) return 1.00;
            if (tier === 2) return 0.80;
            if (tier === 3) return 0.65;
            if (tier === 4) return 0.50;
            if (tier >= 5) return 0.35;
        }
        if (!isWorldLeague) return 1.25;
        return 0.80;
    },
    getExpectedScore(ratingA, ratingB) {
        return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
    }
};

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

async function fetchOpponentElos(tids) {
    const map = new Map();
    const chunkSize = 25;
    for (let i = 0; i < tids.length; i += chunkSize) {
        const chunk = tids.slice(i, i + chunkSize);
        const params = chunk.map((id, idx) => `idEquipo${idx}=${id}`).join('&');
        const url = `https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer&${params}`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.teams) {
                for (const [idStr, obj] of Object.entries(data.teams)) {
                    map.set(parseInt(idStr, 10), {
                        senior: parseFloat(obj.SENIOR) || null,
                        u23: parseFloat(obj.U23) || null,
                        u21: parseFloat(obj.U21) || null,
                        u18: parseFloat(obj.U18) || null
                    });
                }
            }
        } catch (e) {}
    }
    return map;
}

function calculateCategoryDiff(cat, baseElo, matches, oppElosMap, tid) {
    let officialNetDiff = 0;
    let matchCount = 0;

    for (const m of matches) {
        const t = (m.rawType || '').toLowerCase();
        const tn = (m.typeName || '').toLowerCase();
        if (t === 'friendly' || t.includes('scout') || t === 'special') continue;

        let matchCat = 'senior';
        if (t.includes('u18') || /\bu-?18\b/.test(tn)) matchCat = 'u18';
        else if (t.includes('u21') || /\bu-?21\b/.test(tn)) matchCat = 'u21';
        else if (t.includes('u23') || /\bu-?23\b/.test(tn)) matchCat = 'u23';

        if (matchCat !== cat) continue;
        matchCount++;

        const isHome = m.home.tid === tid;
        const myGoals = isHome ? m.home.goals : m.away.goals;
        const oppGoals = isHome ? m.away.goals : m.home.goals;
        const oppTid = isHome ? m.away.tid : m.home.tid;

        const oppObj = oppElosMap.get(oppTid);
        const rawOppElo = (oppObj && oppObj[cat] != null) ? oppObj[cat] : null;
        const oppElo = rawOppElo !== null ? rawOppElo : baseElo;

        const expected = ProEloEngine.getExpectedScore(baseElo, oppElo);
        const gDiff = myGoals - oppGoals;
        const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);

        let kPro = 25;
        if (t.includes('friendly')) kPro = 10;
        else if (t.includes('private_cup')) kPro = 10;
        else if (t.includes('cup_playoff') || tn.includes('final') || tn.includes('semi') || tn.includes('quarter') || tn.includes('playoff') || tn.includes('1/')) {
            if (tn.includes('final') && !tn.includes('semi') && !tn.includes('quarter')) kPro = 50;
            else if (tn.includes('semi') || tn.includes('quarter')) kPro = 45;
            else kPro = 40;
        } else if (t.includes('cup_group')) kPro = 30;
        else if (t.includes('league') || t.includes('qualification')) {
            const matchLeagueMult = m.typeName ? ProEloEngine.getLeagueTierMultiplier(m.typeName, t.includes('world')) : 1.25;
            if (matchLeagueMult >= 1.15) kPro = 35;
            else if (matchLeagueMult >= 0.65) kPro = 25;
            else kPro = 15;
        } else continue;

        const isFriendlySeries = t.includes('friendly');
        const isPrivateComp = t.includes('private_cup') || isFriendlySeries;
        const gMult = (isPrivateComp || rawOppElo === null) ? 1.0 : ProEloEngine.getGoalDiffMultiplier(gDiff, baseElo - oppElo);
        const statsK = isFriendlySeries ? 10 : (t.includes('private_cup') ? 15 : 30);

        const statsDelta = statsK * (actual - expected);
        let proDelta = kPro * gMult * (actual - expected);

        // FIFA Knockout Rule: Kupa eleme maçlarında (playoff) yenilgide ceza = 0!
        const isPlayoff = t.includes('cup_playoff') || t.includes('playoff') || t.includes('private_cup_playoff');
        if (isPlayoff && actual < 0.5) {
            proDelta = 0; // Kaybeden takım Pro-ELO'da 0 ceza alır (Puanı düşmez)
        }

        officialNetDiff += (proDelta - statsDelta);
    }

    const adj = Math.round(officialNetDiff * 10) / 10;
    return { adj, matchCount, finalElo: Number((baseElo + adj).toFixed(2)) };
}

async function calibrateBatch(limit = 100, offset = 0) {
    console.log(`[Kalibrasyon] Sıradaki ${limit} takım Supabase'den çekiliyor (offset=${offset})...`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_teams?select=tid,name,country,senior_elo,u23_elo,u21_elo,u18_elo&order=senior_elo.desc&limit=${limit}&offset=${offset}`, {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    const teams = await res.json();
    if (!teams.length) {
        console.log('Kalibre edilecek takım kalmadı.');
        return;
    }

    console.log(`[Kalibrasyon] ${teams.length} takımın maçları analiz ediliyor...`);
    const updatedRows = [];
    const concurrency = 5;
    let idx = 0;

    async function worker() {
        while (idx < teams.length) {
            const i = idx++;
            const t = teams[i];
            const matches = await fetchMatchlist(t.tid);
            if (!matches.length) continue;

            const allTidsToFetch = [t.tid, ...new Set(matches.map(m => m.home.tid === t.tid ? m.away.tid : m.home.tid))];
            const oppElos = await fetchOpponentElos(allTidsToFetch);

            const selfObj = oppElos.get(t.tid) || {};
            const baseSenior = selfObj.senior != null ? selfObj.senior : t.senior_elo;
            const baseU23 = selfObj.u23 != null ? selfObj.u23 : t.u23_elo;
            const baseU21 = selfObj.u21 != null ? selfObj.u21 : t.u21_elo;
            const baseU18 = selfObj.u18 != null ? selfObj.u18 : t.u18_elo;

            const seniorRes = calculateCategoryDiff('senior', baseSenior, matches, oppElos, t.tid);
            const u23Res = calculateCategoryDiff('u23', baseU23, matches, oppElos, t.tid);
            const u21Res = calculateCategoryDiff('u21', baseU21, matches, oppElos, t.tid);
            const u18Res = calculateCategoryDiff('u18', baseU18, matches, oppElos, t.tid);

            updatedRows.push({
                tid: t.tid,
                name: t.name,
                country: t.country,
                senior_elo: seniorRes.finalElo,
                u23_elo: u23Res.finalElo,
                u21_elo: u21Res.finalElo,
                u18_elo: u18Res.finalElo,
                senior_matches: seniorRes.matchCount,
                updated_at: new Date().toISOString()
            });

            console.log(`  [${i + 1}/${teams.length}] ${t.name} (#${t.tid}) -> Senior: ${baseSenior} + (${seniorRes.adj}) = ${seniorRes.finalElo}`);
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (updatedRows.length > 0) {
        console.log(`[Kalibrasyon] ${updatedRows.length} takım Supabase'e güncelleniyor...`);
        await upsertTeams(updatedRows);
        console.log('Kalibrasyon grubu başarıyla tamamlandı!');
    }
}

const argLimit = parseInt(process.argv[2] || '50', 10);
const argOffset = parseInt(process.argv[3] || '0', 10);
calibrateBatch(argLimit, argOffset).catch(console.error);
