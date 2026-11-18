// =====================================================================
// PRO-ELO ÇEKİRDEK HESAPLAMA (Tampermonkey betiğinin BİREBİR kopyası)
// ---------------------------------------------------------------------
// Bu dosyadaki formül, betikteki computeProEloAdvanced() fonksiyonuyla
// satır satır aynıdır. Böylece site (Supabase) ile betik AYNI girdilerle
// AYNI sonucu üretir:
//   Pro-ELO = Canlı Statsxente ELO + Son maç listesindeki (Pro - Stats) farkı
// Rakip ELO'ları da betikteki gibi SAF Statsxente değerleridir.
// =====================================================================

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

// Betikteki parseVal ile aynı: 0/boş => null, aksi halde 1 ondalığa yuvarla
function parseVal(v) {
    const n = parseFloat(v);
    return (!isNaN(n) && n > 0) ? Math.round(n * 10) / 10 : null;
}

// parseMatchlistXml çıktısını betikteki maç formatına çevirir
function toScriptMatches(rawMatches, tid) {
    const t = Number(tid);
    return rawMatches.map(m => {
        const isHome = Number(m.home.tid) === t;
        return {
            id: m.mid,
            date: m.date,
            type: (m.rawType || '').toLowerCase(),
            typeName: m.typeName || '',
            isHome,
            myGoals: isHome ? m.home.goals : m.away.goals,
            oppGoals: isHome ? m.away.goals : m.home.goals,
            oppTid: String(isHome ? m.away.tid : m.home.tid)
        };
    });
}

function getKPro(mType, mTypeName, typeName, defaultLeagueMult) {
    if (mType.includes('friendly')) return 10;
    if (mType.includes('private_cup')) return 10;
    if (mType.includes('cup_playoff') || mTypeName.includes('final') || mTypeName.includes('semi') || mTypeName.includes('quarter') || mTypeName.includes('playoff') || mTypeName.includes('1/')) {
        if (mTypeName.includes('final') && !mTypeName.includes('semi') && !mTypeName.includes('quarter')) return 50;
        if (mTypeName.includes('semi') || mTypeName.includes('quarter')) return 45;
        return 40;
    }
    if (mType.includes('cup_group')) return 30;
    if (mType.includes('league') || mType.includes('qualification')) {
        const isWorldMatch = mType.includes('world');
        const mult = typeName ? ProEloEngine.getLeagueTierMultiplier(typeName, isWorldMatch) : defaultLeagueMult;
        if (mult >= 1.15) return 35;
        if (mult >= 0.65) return 25;
        return 15;
    }
    return null; // ELO'ya dahil edilmez
}

// statsElo: {senior,u23,u21,u18} (parseVal uygulanmış), matches: toScriptMatches çıktısı,
// oppElos: { [tidStr]: {senior,u23,u21,u18} }
function computeProElo(statsElo, matches, oppElos = {}) {
    const catMatches = { senior: [], u23: [], u21: [], u18: [] };

    matches.forEach(m => {
        if (m.type === 'friendly' || m.type.includes('scout') || m.type === 'special') return;
        const tName = m.typeName.toLowerCase();
        const tType = m.type.toLowerCase();
        const normName = tName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\u1d1c/g, 'u');
        const isCat = (age) => {
            const re = new RegExp(`(?:^|[^a-z0-9])u-?${age}(?:$|[^a-z0-9])`);
            return tType.includes(`u${age}`) || re.test(tType) || re.test(normName);
        };
        if (isCat('18')) catMatches.u18.push(m);
        else if (isCat('21')) catMatches.u21.push(m);
        else if (isCat('23')) catMatches.u23.push(m);
        else catMatches.senior.push(m);
    });

    // Sunucu tarafında takım sayfası DOM'u yok; betikte de lig bilgisi bulunamazsa 0.80 kullanılır
    const defaultLeagueMult = 0.80;

    function evalCategory(cat, baseElo) {
        const ms = catMatches[cat] || [];
        const isUnrankedSelf = (!baseElo || baseElo <= 0);

        if (isUnrankedSelf && ms.length === 0) {
            return { proElo: null, adjustment: 0, matchCount: 0, standalone: false };
        }

        // Statsxente kaydı yok: kronolojik bağımsız simülasyon (betikle aynı)
        if (isUnrankedSelf) {
            const rankedOppElos = ms
                .map(m => (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null)
                .filter(v => v !== null);
            let simElo = rankedOppElos.length > 0
                ? (rankedOppElos.reduce((a, b) => a + b, 0) / rankedOppElos.length)
                : (cat === 'senior' ? (defaultLeagueMult >= 1.15 ? 1650 : (defaultLeagueMult >= 0.65 ? 1400 : 1100)) : 1000);

            const chronoMs = [...ms].sort((a, b) => String(a.date).localeCompare(String(b.date)));
            chronoMs.forEach(m => {
                const mType = (m.type || '').toLowerCase();
                const mTypeName = (m.typeName || '').toLowerCase();
                const kPro = getKPro(mType, mTypeName, m.typeName, defaultLeagueMult);
                if (kPro === null) return;
                const rawOppElo = (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null;
                const oppElo = rawOppElo !== null ? rawOppElo : simElo;
                const expected = ProEloEngine.getExpectedScore(simElo, oppElo);
                const gDiff = m.myGoals - m.oppGoals;
                const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);
                const isPrivateComp = mType.includes('private_cup') || mType.includes('friendly');
                const gMult = (isPrivateComp || rawOppElo === null) ? 1.0 : ProEloEngine.getGoalDiffMultiplier(gDiff, simElo - oppElo);
                let proDelta = kPro * gMult * (actual - expected);
                const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
                if (isPlayoff && actual < 0.5) proDelta = 0;
                simElo = Math.max(100, simElo + proDelta);
            });
            return { proElo: Math.round(simElo * 10) / 10, adjustment: 0, matchCount: ms.length, standalone: true };
        }

        let officialNetDiff = 0;
        ms.forEach(m => {
            const rawOppElo = (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null;
            const oppElo = rawOppElo !== null ? rawOppElo : baseElo;
            const expected = ProEloEngine.getExpectedScore(baseElo, oppElo);
            const gDiff = m.myGoals - m.oppGoals;
            const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);
            const mType = (m.type || '').toLowerCase();
            const mTypeName = (m.typeName || '').toLowerCase();

            const kPro = getKPro(mType, mTypeName, m.typeName, defaultLeagueMult);
            if (kPro === null) return;

            const isFriendlySeries = mType.includes('friendly');
            const isPrivateComp = mType.includes('private_cup') || isFriendlySeries;
            const gMult = (isPrivateComp || rawOppElo === null) ? 1.0 : ProEloEngine.getGoalDiffMultiplier(gDiff, baseElo - oppElo);
            const statsK = isFriendlySeries ? 10 : (mType.includes('private_cup') ? 15 : 30);
            const statsDelta = statsK * (actual - expected);
            let proDelta = kPro * gMult * (actual - expected);

            const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
            if (isPlayoff && actual < 0.5) proDelta = 0;

            officialNetDiff += (proDelta - statsDelta);
        });

        const adjustment = Math.round(officialNetDiff * 10) / 10;
        return {
            proElo: Math.round((baseElo + adjustment) * 10) / 10,
            adjustment,
            matchCount: ms.length,
            standalone: false
        };
    }

    return {
        senior: evalCategory('senior', statsElo.senior),
        u23: evalCategory('u23', statsElo.u23),
        u21: evalCategory('u21', statsElo.u21),
        u18: evalCategory('u18', statsElo.u18)
    };
}

module.exports = { ProEloEngine, parseVal, toScriptMatches, computeProElo };
