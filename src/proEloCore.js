// =====================================================================
// PRO-ELO ÇEKİRDEK HESAPLAMA (Tampermonkey betiğinin BİREBİR kopyası)
// ---------------------------------------------------------------------
// Hem Model 1 (Hibrit: Canlı Statsxente + 30 günlük Pro-Stats farkı)
// hem Model 2 (Bağımsız: 18.11.2026 çapası + kronolojik tekil maçlar)
// birebir aynı K faktörleri, gol farkı çarpanı, 300 ELO anti-farma ve
// FIFA eleme 0-ceza kurallarını kullanır.
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

// ManagerZone XML maç tarihleri Europe/Stockholm (CET/CEST) saat dilimindedir
function getMzNowString(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Stockholm',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function isExemptMatch(rawType) {
    const t = (rawType || '').toLowerCase();
    return t === 'friendly' || t.includes('scout') || t === 'special';
}

function classifyCategory(rawType, typeName) {
    const tType = (rawType || '').toLowerCase();
    const tName = (typeName || '').toLowerCase();
    const normName = tName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\u1d1c/g, 'u');
    const isCat = (age) => {
        const re = new RegExp(`(?:^|[^a-z0-9])u-?${age}(?:$|[^a-z0-9])`);
        return tType.includes(`u${age}`) || re.test(tType) || re.test(normName);
    };
    if (isCat('18')) return 'u18';
    if (isCat('21')) return 'u21';
    if (isCat('23')) return 'u23';
    return 'senior';
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

function getKPro(mType, mTypeName, typeName, defaultLeagueMult = 0.80) {
    // Özel kupa ve dostluk ligi katsayısı 6'ya çekildi (resmi lig/kupa maçlarını ezmemesi için)
    if (mType.includes('friendly')) return 6;
    if (mType.includes('private_cup')) return 6;
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

// 1900+ puan üstü yumuşak tavan (Enflasyon Freni):
// 1900'de 1.00x, 2000'de 0.71x, 2050'de 0.625x ile sezon içi puan şişmesini önler
function getHighEloSoftFactor(rating) {
    if (rating <= 1900) return 1.0;
    return 1.0 / (1.0 + ((rating - 1900) / 250.0));
}

// =====================================================================
// MODEL 1 (HİBRİT): Canlı Statsxente + 30 günlük maçlardan Pro-Stats farkı
// =====================================================================
function computeProElo(statsElo, matches, oppElos = {}) {
    const catMatches = { senior: [], u23: [], u21: [], u18: [] };

    matches.forEach(m => {
        if (isExemptMatch(m.type)) return;
        const cat = classifyCategory(m.type, m.typeName);
        catMatches[cat].push(m);
    });

    const defaultLeagueMult = 0.80;

    function evalCategory(cat, baseElo) {
        const ms = catMatches[cat] || [];
        const isUnrankedSelf = (!baseElo || baseElo <= 0);

        // Statsxente'de o kategoride kaydı olmayan alt lig/bot kulüplere uydurma 1400 puan üretilmez
        if (isUnrankedSelf) {
            return { proElo: null, adjustment: 0, matchCount: ms.length, standalone: false };
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
            if (proDelta > 0) proDelta *= getHighEloSoftFactor(baseElo);

            const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
            if (isPlayoff && actual < 0.5 && proDelta < 0) proDelta = proDelta * 0.25;

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

// =====================================================================
// MODEL 2 (BAĞIMSIZ): Tek maç için Pro-ELO değişimi (18.11.2026+)
// Model 1 ile birebir aynı K, G, 300-ELO anti-farma ve FIFA 0-ceza kuralı
// =====================================================================
function computeIndependentMatchDelta(homeElo, awayElo, homeGoals, awayGoals, rawType, typeName, oppMissing = false) {
    const mType = (rawType || '').toLowerCase();
    const mTypeName = (typeName || '').toLowerCase();
    const age = classifyCategory(rawType, typeName);

    if (isExemptMatch(mType)) {
        return { age, k: 0, homeDelta: 0, awayDelta: 0 };
    }

    const kPro = getKPro(mType, mTypeName, typeName, 0.80);
    if (kPro === null) {
        return { age, k: 0, homeDelta: 0, awayDelta: 0 };
    }

    const isPrivateComp = mType.includes('private_cup') || mType.includes('friendly');
    const gDiff = homeGoals - awayGoals;
    const gMult = (isPrivateComp || oppMissing)
        ? 1.0
        : ProEloEngine.getGoalDiffMultiplier(gDiff, homeElo - awayElo);

    const expHome = ProEloEngine.getExpectedScore(homeElo, awayElo);
    const actualHome = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);

    let homeDelta = kPro * gMult * (actualHome - expHome);
    let awayDelta = -homeDelta;

    // 1900+ puan üstü yumuşak tavan (Enflasyon Freni — sadece pozitif artışları yumuşatır)
    if (homeDelta > 0) homeDelta *= getHighEloSoftFactor(homeElo);
    if (awayDelta > 0) awayDelta *= getHighEloSoftFactor(awayElo);

    // Eleme Koruması + Enflasyon Dengesi: Eleme maçında kaybedene 0 yerine 0.25x hafif ceza
    const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
    if (isPlayoff) {
        if (actualHome < 0.5 && homeDelta < 0) homeDelta = homeDelta * 0.25;
        if (actualHome > 0.5 && awayDelta < 0) awayDelta = awayDelta * 0.25;
    }

    return {
        age,
        k: kPro,
        homeDelta: Number(homeDelta.toFixed(2)),
        awayDelta: Number(awayDelta.toFixed(2))
    };
}

module.exports = {
    ProEloEngine,
    parseVal,
    getMzNowString,
    isExemptMatch,
    classifyCategory,
    toScriptMatches,
    getKPro,
    computeProElo,
    computeIndependentMatchDelta
};
