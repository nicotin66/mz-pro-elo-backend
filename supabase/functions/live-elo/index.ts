// =====================================================================
// SUPABASE EDGE FUNCTION: live-elo
// ---------------------------------------------------------------------
// Herhangi bir ManagerZone takım ID'si (?tid=864852) için ANLIK (~1-2 sn)
// canlı Pro-ELO hesaplar, veritabanını günceller ve JSON olarak döner.
// =====================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

function parseVal(v: unknown): number | null {
  const n = parseFloat(String(v ?? ''));
  return (!isNaN(n) && n > 0) ? Math.round(n * 10) / 10 : null;
}

function getGoalDiffMultiplier(goalDiff: number, eloDiff: number): number {
  if (Math.abs(eloDiff) >= 300) return 1.0;
  const diff = Math.abs(goalDiff);
  if (diff <= 1) return 1.0;
  if (diff === 2) return 1.20;
  if (diff === 3) return 1.35;
  return 1.50;
}

function getLeagueTierMultiplier(leagueName: string, isWorldLeague = false): number {
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
}

function getExpectedScore(ratingA: number, ratingB: number): number {
  return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
}

function isExemptMatch(rawType: string): boolean {
  const t = (rawType || '').toLowerCase();
  return t === 'friendly' || t.includes('scout') || t === 'special';
}

function classifyCategory(rawType: string, typeName: string): 'senior' | 'u23' | 'u21' | 'u18' {
  const tType = (rawType || '').toLowerCase();
  const tName = (typeName || '').toLowerCase();
  const normName = tName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\u1d1c/g, 'u');
  const isCat = (age: string) => {
    const re = new RegExp(`(?:^|[^a-z0-9])u-?${age}(?:$|[^a-z0-9])`);
    return tType.includes(`u${age}`) || re.test(tType) || re.test(normName);
  };
  if (isCat('18')) return 'u18';
  if (isCat('21')) return 'u21';
  if (isCat('23')) return 'u23';
  return 'senior';
}

function getKPro(mType: string, mTypeName: string, typeName: string): number | null {
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
    const mult = typeName ? getLeagueTierMultiplier(typeName, isWorldMatch) : 0.80;
    if (mult >= 1.15) return 35;
    if (mult >= 0.65) return 25;
    return 15;
  }
  return null;
}

interface ParsedMatch {
  mid: number;
  date: string;
  type: string;
  typeName: string;
  myGoals: number;
  oppGoals: number;
  oppTid: string;
}

interface LeaguesInfo {
  league_senior: string | null;
  wleague_senior: string | null;
  league_u23: string | null;
  wleague_u23: string | null;
  league_u21: string | null;
  wleague_u21: string | null;
  league_u18: string | null;
  wleague_u18: string | null;
}

function parseMatchlistXml(xmlText: string, selfTid: number) {
  const matches: ParsedMatch[] = [];
  let teamName = '';
  let country = '';
  const leagues: LeaguesInfo = {
    league_senior: null,
    wleague_senior: null,
    league_u23: null,
    wleague_u23: null,
    league_u21: null,
    wleague_u21: null,
    league_u18: null,
    wleague_u18: null
  };
  if (!xmlText || !xmlText.includes('<Match')) return { matches, teamName, country, leagues };

  const matchRegex = /<Match\b([^>]*)>([\s\S]*?)<\/Match>/gi;
  let m;
  const getAttr = (str: string, name: string) => {
    const r = new RegExp(`${name}="([^"]*)"`, 'i').exec(str);
    return r ? r[1] : '';
  };

  while ((m = matchRegex.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const mid = parseInt(getAttr(attrs, 'id'), 10);
    const date = getAttr(attrs, 'date');
    const status = getAttr(attrs, 'status');
    const rawType = getAttr(attrs, 'type').toLowerCase();
    const typeName = getAttr(attrs, 'typeName');
    if (!mid || (status && status !== 'played' && status !== '1')) continue;

    if (rawType === 'league' && !leagues.league_senior && typeName) leagues.league_senior = typeName;
    else if (rawType === 'world_league' && !leagues.wleague_senior && typeName) leagues.wleague_senior = typeName;
    else if (rawType === 'u23_league' && !leagues.league_u23 && typeName) leagues.league_u23 = typeName;
    else if (rawType === 'u23_world_league' && !leagues.wleague_u23 && typeName) leagues.wleague_u23 = typeName;
    else if (rawType === 'u21_league' && !leagues.league_u21 && typeName) leagues.league_u21 = typeName;
    else if (rawType === 'u21_world_league' && !leagues.wleague_u21 && typeName) leagues.wleague_u21 = typeName;
    else if (rawType === 'u18_league' && !leagues.league_u18 && typeName) leagues.league_u18 = typeName;
    else if (rawType === 'u18_world_league' && !leagues.wleague_u18 && typeName) leagues.wleague_u18 = typeName;

    const teamRegex = /<Team\b([^>]*)\/?>/gi;
    const teams: Array<{ tid: number; name: string; country: string; field: string; goals: number }> = [];
    let tm;
    while ((tm = teamRegex.exec(body)) !== null) {
      const a = tm[1];
      teams.push({
        tid: parseInt(getAttr(a, 'teamId') || getAttr(a, 'id'), 10),
        name: getAttr(a, 'teamName') || getAttr(a, 'name'),
        country: (getAttr(a, 'countryShortname') || getAttr(a, 'country') || '').toUpperCase(),
        field: getAttr(a, 'field'),
        goals: parseInt(getAttr(a, 'goals') || '0', 10)
      });
    }
    if (teams.length < 2) continue;

    const home = teams.find(t => t.field === 'home') || teams[0];
    const away = teams.find(t => t.field === 'away') || teams[1];
    const isHome = home.tid === selfTid;
    const self = isHome ? home : away;
    const opp = isHome ? away : home;
    if (self.name && !teamName) teamName = self.name;
    if (self.country && !country) country = self.country;

    matches.push({
      mid,
      date,
      type: rawType,
      typeName,
      myGoals: self.goals,
      oppGoals: opp.goals,
      oppTid: String(opp.tid)
    });
  }
  return { matches, teamName, country, leagues };
}

type EloSet = { senior: number | null; u23: number | null; u21: number | null; u18: number | null };

async function fetchStatsBatch(tids: number[]): Promise<Record<string, EloSet>> {
  const unique = [...new Set(tids.filter(Boolean))];
  const out: Record<string, EloSet> = {};
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += 25) chunks.push(unique.slice(i, i + 25));

  await Promise.all(chunks.map(async (chunk) => {
    const q = chunk.map((id, idx) => `&idEquipo${idx}=${id}`).join('');
    try {
      const res = await fetch(`https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer${q}`);
      if (!res.ok) return;
      const data = await res.json();
      const teams = (data && data.teams) ? data.teams : (data || {});
      for (const id of chunk) {
        const t = teams[id] || teams[String(id)] || {};
        out[String(id)] = {
          senior: parseVal(t.SENIOR || t.senior),
          u23: parseVal(t.U23 || t.u23),
          u21: parseVal(t.U21 || t.u21),
          u18: parseVal(t.U18 || t.u18)
        };
      }
    } catch (_) {}
  }));
  return out;
}

function computeHybrid(statsElo: EloSet, matches: ParsedMatch[], oppElos: Record<string, EloSet>) {
  const catMatches: Record<'senior' | 'u23' | 'u21' | 'u18', ParsedMatch[]> = {
    senior: [], u23: [], u21: [], u18: []
  };
  for (const m of matches) {
    if (isExemptMatch(m.type)) continue;
    catMatches[classifyCategory(m.type, m.typeName)].push(m);
  }

  function evalCat(cat: 'senior' | 'u23' | 'u21' | 'u18', baseElo: number | null) {
    const ms = catMatches[cat];
    if (!baseElo || baseElo <= 0) {
      return { proElo: null, diff: 0, matchCount: ms.length };
    }

    let netDiff = 0;
    for (const m of ms) {
      const rawOpp = oppElos[m.oppTid]?.[cat] ?? null;
      const oppElo = rawOpp !== null ? rawOpp : baseElo;
      const expected = getExpectedScore(baseElo, oppElo);
      const gDiff = m.myGoals - m.oppGoals;
      const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);
      const kPro = getKPro(m.type, m.typeName.toLowerCase(), m.typeName);
      if (kPro === null) continue;
      const isFriendlySeries = m.type.includes('friendly');
      const isPriv = m.type.includes('private_cup') || isFriendlySeries;
      const gMult = (isPriv || rawOpp === null) ? 1.0 : getGoalDiffMultiplier(gDiff, baseElo - oppElo);
      const statsK = isFriendlySeries ? 10 : (m.type.includes('private_cup') ? 15 : 30);
      const statsDelta = statsK * (actual - expected);
      let proDelta = kPro * gMult * (actual - expected);
      const isPlayoff = m.type.includes('cup_playoff') || m.type.includes('playoff') || m.type.includes('private_cup_playoff');
      if (isPlayoff && actual < 0.5) proDelta = 0;
      netDiff += (proDelta - statsDelta);
    }
    const diff = Math.round(netDiff * 10) / 10;
    return { proElo: Math.round((baseElo + diff) * 10) / 10, diff, matchCount: ms.length };
  }

  return {
    senior: evalCat('senior', statsElo.senior),
    u23: evalCat('u23', statsElo.u23),
    u21: evalCat('u21', statsElo.u21),
    u18: evalCat('u18', statsElo.u18)
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const action = (url.searchParams.get('action') || '').toLowerCase();
    const tidsParam = (url.searchParams.get('tids') || '').trim();

    // ---- TOPLU LİG SEVİYESİ SORGULAMA (?action=leagues&tids=1247785,1004200) ----
    if (action === 'leagues' || (tidsParam && !url.searchParams.get('tid') && !url.searchParams.get('username'))) {
      const tids = tidsParam
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n > 0)
        .slice(0, 50);

      if (tids.length === 0) {
        return new Response(JSON.stringify({ error: 'Geçerli tids parametresi gerekli' }), {
          status: 400, headers: CORS_HEADERS
        });
      }

      const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

      const leagueResults: Record<number, any> = {};
      const dbUpdates: any[] = [];

      await Promise.all(tids.map(async (tId) => {
        try {
          const res = await fetch(`https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tId}&limit=25`);
          if (!res.ok) return;
          const xml = await res.text();
          const { leagues, teamName, country } = parseMatchlistXml(xml, tId);
          leagueResults[tId] = {
            senior: { national: leagues.league_senior, world: leagues.wleague_senior },
            u23: { national: leagues.league_u23, world: leagues.wleague_u23 },
            u21: { national: leagues.league_u21, world: leagues.wleague_u21 },
            u18: { national: leagues.league_u18, world: leagues.wleague_u18 }
          };
          if (leagues.league_senior || leagues.wleague_senior || leagues.league_u23 || leagues.league_u21 || leagues.league_u18) {
            dbUpdates.push({
              tid: tId,
              name: teamName || undefined,
              country: country || undefined,
              league_senior: leagues.league_senior,
              wleague_senior: leagues.wleague_senior,
              league_u23: leagues.league_u23,
              wleague_u23: leagues.wleague_u23,
              league_u21: leagues.league_u21,
              wleague_u21: leagues.wleague_u21,
              league_u18: leagues.league_u18,
              wleague_u18: leagues.wleague_u18
            });
          }
        } catch (_) {}
      }));

      // Arka planda Supabase DB'ye kaydet
      if (supabaseUrl && serviceKey && dbUpdates.length > 0) {
        fetch(`${supabaseUrl}/rest/v1/mz_teams`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(dbUpdates)
        }).catch(() => {});
      }

      return new Response(JSON.stringify({ success: true, count: Object.keys(leagueResults).length, leagues: leagueResults }), {
        status: 200, headers: CORS_HEADERS
      });
    }

    const tidStr = (url.searchParams.get('tid') || '').trim();
    const userParam = (url.searchParams.get('username') || url.searchParams.get('user') || '').trim();
    let tid = parseInt(tidStr, 10);
    let managerUsername = userParam;

    // Eğer sayısal Takım ID girilmemişse, kullanıcı adından futbol takımı ID'sini tespit et
    if (isNaN(tid) || tid <= 0) {
      if (!userParam) {
        return new Response(JSON.stringify({ error: 'Geçerli bir tid veya username parametresi gerekli (?tid=864852 veya ?username=alex66)' }), {
          status: 400, headers: CORS_HEADERS
        });
      }

      try {
        const mzUserXml = await fetch(`https://www.managerzone.com/xml/manager_data.php?sport_id=1&username=${encodeURIComponent(userParam)}`)
          .then(r => r.ok ? r.text() : '')
          .catch(() => '');

        if (!mzUserXml || mzUserXml.includes('Invalid parameters') || mzUserXml.includes('ManagerZone_Error')) {
          return new Response(JSON.stringify({ error: `'${userParam}' isimli kullanıcı ManagerZone'da bulunamadı.` }), {
            status: 404, headers: CORS_HEADERS
          });
        }

        const teamMatch = mzUserXml.match(/<Team\s+[^>]*sport="soccer"[^>]*teamId="(\d+)"/i) || mzUserXml.match(/<Team\s+[^>]*teamId="(\d+)"/i);
        if (!teamMatch) {
          return new Response(JSON.stringify({ error: `'${userParam}' isimli menajerin aktif bir futbol takımı bulunamadı.` }), {
            status: 404, headers: CORS_HEADERS
          });
        }
        tid = parseInt(teamMatch[1], 10);
        const userAttrMatch = mzUserXml.match(/<UserData\s+[^>]*username="([^"]+)"/i);
        if (userAttrMatch) managerUsername = userAttrMatch[1];
      } catch (err) {
        return new Response(JSON.stringify({ error: `Kullanıcı sorgulanırken hata: ${String(err)}` }), {
          status: 500, headers: CORS_HEADERS
        });
      }
    }

    const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    // 1) ManagerZone maç listesini ve mevcut DB kaydını paralel çek
    const [xmlRes, existingRes] = await Promise.all([
      fetch(`https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&limit=1000`),
      supabaseUrl && serviceKey
        ? fetch(`${supabaseUrl}/rest/v1/mz_teams?tid=eq.${tid}&select=*`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
          }).then(r => r.ok ? r.json() : []).catch(() => [])
        : Promise.resolve([])
    ]);

    const xml = xmlRes.ok ? await xmlRes.text() : '';
    const { matches, teamName, country, leagues } = parseMatchlistXml(xml, tid);
    const existing = Array.isArray(existingRes) && existingRes.length ? existingRes[0] : null;

    // 2) Takım + tüm rakiplerin canlı Statsxente ELO'larını paralel çek
    const allTids = [tid, ...matches.map(m => parseInt(m.oppTid, 10))];
    const oppElos = await fetchStatsBatch(allTids);
    const selfStats: EloSet = oppElos[String(tid)] || { senior: null, u23: null, u21: null, u18: null };

    if (!matches.length && !selfStats.senior && !selfStats.u23 && !selfStats.u21 && !selfStats.u18 && !existing) {
      return new Response(JSON.stringify({ error: `Takım #${tid} bulunamadı veya son 30 günde maçı yok.` }), {
        status: 404, headers: CORS_HEADERS
      });
    }

    // 3) Hibrit Pro-ELO hesapla
    const res = computeHybrid(selfStats, matches, oppElos);
    const nowIso = new Date().toISOString();

    // 4) Supabase'e anında kaydet (mevcut snap_* ve ind_* alanlarını koruyarak)
    const row: Record<string, unknown> = {
      tid,
      name: teamName || existing?.name || `Takım #${tid}`,
      country: country || existing?.country || '',
      senior_elo: selfStats.senior,
      u23_elo: selfStats.u23,
      u21_elo: selfStats.u21,
      u18_elo: selfStats.u18,
      senior_matches: matches.length,
      last_scanned_at: nowIso,
      updated_at: nowIso
    };
    if (leagues?.league_senior) row.league_senior = leagues.league_senior;
    if (leagues?.wleague_senior) row.wleague_senior = leagues.wleague_senior;
    if (leagues?.league_u23) row.league_u23 = leagues.league_u23;
    if (leagues?.wleague_u23) row.wleague_u23 = leagues.wleague_u23;
    if (leagues?.league_u21) row.league_u21 = leagues.league_u21;
    if (leagues?.wleague_u21) row.wleague_u21 = leagues.wleague_u21;
    if (leagues?.league_u18) row.league_u18 = leagues.league_u18;
    if (leagues?.wleague_u18) row.wleague_u18 = leagues.wleague_u18;
    // Takımın henüz çapası yoksa ilk kez buradan çapa başlat
    if (!existing || !existing.snap_at) {
      row.snap_senior = selfStats.senior;
      row.snap_u23 = selfStats.u23;
      row.snap_u21 = selfStats.u21;
      row.snap_u18 = selfStats.u18;
      row.snap_at = nowIso;
      row.ind_senior_elo = selfStats.senior;
      row.ind_u23_elo = selfStats.u23;
      row.ind_u21_elo = selfStats.u21;
      row.ind_u18_elo = selfStats.u18;
      row.ind_matches = existing?.ind_matches || 0;
    }

    if (supabaseUrl && serviceKey) {
      await fetch(`${supabaseUrl}/rest/v1/mz_teams?on_conflict=tid`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([row])
      }).catch(() => {});
    }

    return new Response(JSON.stringify({
      tid,
      name: row.name,
      country: row.country,
      user: managerUsername || null,
      stats: selfStats,
      hybrid: {
        senior: res.senior.proElo,
        u23: res.u23.proElo,
        u21: res.u21.proElo,
        u18: res.u18.proElo
      },
      diffs: {
        senior: res.senior.diff,
        u23: res.u23.diff,
        u21: res.u21.diff,
        u18: res.u18.diff
      },
      snap: {
        senior: existing?.snap_senior ?? selfStats.senior,
        u23: existing?.snap_u23 ?? selfStats.u23,
        u21: existing?.snap_u21 ?? selfStats.u21,
        u18: existing?.snap_u18 ?? selfStats.u18
      },
      independent: {
        senior: existing?.ind_senior_elo ?? selfStats.senior,
        u23: existing?.ind_u23_elo ?? selfStats.u23,
        u21: existing?.ind_u21_elo ?? selfStats.u21,
        u18: existing?.ind_u18_elo ?? selfStats.u18,
        matches: existing?.ind_matches || 0
      },
      totalMatchesScanned: matches.length,
      leagues: {
        senior: {
          national: row.league_senior || existing?.league_senior || null,
          world: row.wleague_senior || existing?.wleague_senior || null
        },
        u23: {
          national: row.league_u23 || existing?.league_u23 || null,
          world: row.wleague_u23 || existing?.wleague_u23 || null
        },
        u21: {
          national: row.league_u21 || existing?.league_u21 || null,
          world: row.wleague_u21 || existing?.wleague_u21 || null
        },
        u18: {
          national: row.league_u18 || existing?.league_u18 || null,
          world: row.wleague_u18 || existing?.wleague_u18 || null
        }
      },
      computedAt: nowIso
    }), { status: 200, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: CORS_HEADERS
    });
  }
});
