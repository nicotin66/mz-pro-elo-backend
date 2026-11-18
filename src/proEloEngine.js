// =====================================================================
// MZ PRO-ELO v1.0 HESAPLAMA MOTORU (610 Takım Doğrulamalı)
// =====================================================================

const K_FACTORS = {
    FRIENDLY: 0,
    FRIENDLY_SERIES: 10,
    PRIVATE_CUP: 10,
    LEAGUE_LOW: 15,      // div4 ve altı
    LEAGUE_MID: 25,      // div1, div2, div3
    LEAGUE_TOP: 35,      // Top Series, Süper Lig ve ülke en üst ligleri
    CUP_GROUP: 30,
    CUP_PLAYOFF: 40,
    CUP_SEMI: 45,
    CUP_FINAL: 50
};

function normalizeLeagueText(str) {
    return (str || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u1d1c/g, 'u')
        .toLowerCase();
}

function getLeagueK(typeName) {
    const tn = normalizeLeagueText(typeName).trim();
    if (!tn) return K_FACTORS.LEAGUE_MID;
    const divMatch = tn.match(/\bdiv(?:ision)?[\s._-]*(\d+)/i);
    if (divMatch) {
        const d = parseInt(divMatch[1], 10);
        if (d >= 4) return K_FACTORS.LEAGUE_LOW;
        if (d >= 1) return K_FACTORS.LEAGUE_MID;
    }
    return K_FACTORS.LEAGUE_TOP;
}

function classifyMatch(rawType, typeName) {
    const t = (rawType || '').toLowerCase().trim();
    const tn = normalizeLeagueText(typeName);

    let age = 'senior';
    if (t.includes('u18') || /\bu[\s._-]*18\b/.test(tn)) age = 'u18';
    else if (t.includes('u21') || /\bu[\s._-]*21\b/.test(tn)) age = 'u21';
    else if (t.includes('u23') || /\bu[\s._-]*23\b/.test(tn)) age = 'u23';

    if (t === 'friendly' || t === 'scout' || t === 'special' || t.startsWith('qualification')) {
        return { age, kind: 'friendly', k: 0, useGoalMult: false };
    }
    if (t.includes('friendly_series')) {
        return { age, kind: 'friendly_series', k: K_FACTORS.FRIENDLY_SERIES, useGoalMult: false };
    }
    if (t.includes('private_cup')) {
        return { age, kind: 'private_cup', k: K_FACTORS.PRIVATE_CUP, useGoalMult: false };
    }
    if (t === 'cup_group') {
        return { age, kind: 'cup_group', k: K_FACTORS.CUP_GROUP, useGoalMult: true };
    }
    if (t === 'cup_playoff') {
        let k = K_FACTORS.CUP_PLAYOFF;
        if (/\bfinal\b/i.test(tn) && !/semi|quarter|1\/|8th|16th/i.test(tn)) k = K_FACTORS.CUP_FINAL;
        else if (/semi/i.test(tn)) k = K_FACTORS.CUP_SEMI;
        return { age, kind: 'cup_playoff', k, useGoalMult: true };
    }
    if (t.includes('world_league') || t.includes('league')) {
        return { age, kind: 'league', k: getLeagueK(typeName), useGoalMult: true };
    }
    return { age, kind: 'other', k: 20, useGoalMult: true };
}

function getGoalMultiplier(goalDiff, useGoalMult, oppMissing) {
    if (!useGoalMult || oppMissing) return 1.0;
    const gd = Math.abs(goalDiff);
    if (gd <= 1) return 1.0;
    if (gd === 2) return 1.2;
    if (gd === 3) return 1.35;
    return 1.5;
}

function expectedScore(eloA, eloB) {
    return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function computeMatchDelta(homeElo, awayElo, homeGoals, awayGoals, rawType, typeName, oppMissing = false) {
    const info = classifyMatch(rawType, typeName);
    if (info.k === 0) {
        return { age: info.age, k: 0, homeDelta: 0, awayDelta: 0 };
    }
    const expHome = expectedScore(homeElo, awayElo);
    const actualHome = homeGoals > awayGoals ? 1 : (homeGoals < awayGoals ? 0 : 0.5);
    const g = getGoalMultiplier(homeGoals - awayGoals, info.useGoalMult, oppMissing);

    let homeDelta = Number((info.k * g * (actualHome - expHome)).toFixed(2));
    let awayDelta = Number((-homeDelta).toFixed(2));

    // FIFA Knockout Rule: Kupa eleme turlarında (Play-off / Knockout) kaybeden takımdan puan düşülmez (0 Ceza!)
    const isPlayoff = (rawType || '').toLowerCase().includes('playoff') || info.kind === 'cup_playoff' || (rawType || '').toLowerCase().includes('private_cup_playoff');
    if (isPlayoff) {
        if (homeDelta < 0) homeDelta = 0;
        if (awayDelta < 0) awayDelta = 0;
    }

    return { age: info.age, k: info.k, homeDelta, awayDelta };
}

function parseMatchlistXml(xmlText) {
    const matches = [];
    if (!xmlText || !xmlText.includes('<Match')) return matches;

    const matchRegex = /<Match\b([^>]*)>([\s\S]*?)<\/Match>/gi;
    let m;
    while ((m = matchRegex.exec(xmlText)) !== null) {
        const attrs = m[1];
        const body = m[2];
        const getAttr = (str, name) => {
            const r = new RegExp(`${name}="([^"]*)"`, 'i').exec(str);
            return r ? r[1] : '';
        };
        const mid = parseInt(getAttr(attrs, 'id'), 10);
        const dateStr = getAttr(attrs, 'date');
        const status = getAttr(attrs, 'status');
        const rawType = getAttr(attrs, 'type');
        const typeName = getAttr(attrs, 'typeName');
        if (!mid || (status && status !== 'played' && status !== '1')) continue;

        const teamRegex = /<Team\b([^>]*)\/?>/gi;
        const teams = [];
        let tm;
        while ((tm = teamRegex.exec(body)) !== null) {
            const tAttrs = tm[1];
            teams.push({
                tid: parseInt(getAttr(tAttrs, 'teamId') || getAttr(tAttrs, 'id'), 10),
                name: getAttr(tAttrs, 'teamName') || getAttr(tAttrs, 'name'),
                country: (getAttr(tAttrs, 'countryShortname') || getAttr(tAttrs, 'country') || '').toUpperCase(),
                field: getAttr(tAttrs, 'field'),
                goals: parseInt(getAttr(tAttrs, 'goals') || '0', 10)
            });
        }
        if (teams.length < 2 || !teams[0].tid || !teams[1].tid) continue;

        const home = teams.find(t => t.field === 'home') || teams[0];
        const away = teams.find(t => t.field === 'away') || teams[1];
        matches.push({
            mid,
            date: dateStr,
            rawType,
            typeName,
            home,
            away
        });
    }
    return matches;
}

module.exports = {
    classifyMatch,
    computeMatchDelta,
    parseMatchlistXml
};
