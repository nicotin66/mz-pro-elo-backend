// ==UserScript==
// @name         MZ - Pro ELO & Statsxente Karşılaştırma Laboratuvarı
// @namespace    nicotin.proelo
// @version      2.1
// @description  ManagerZone için yeni nesil dinamik Pro-ELO motoru (FIFA Kupa Eleme Koruması, Gol farkı tavanı, Anti-Farma, Lig zorluğu çarpanı, As kadro koruması). Statsxente ELO'su ile Pro-ELO'yu takım ve fikstür sayfalarında yan yana karşılaştırır.
// @author       alex66 & Antigravity
// @match        https://www.managerzone.com/*
// @match        https://managerzone.com/*
// @icon         https://flagcdn.com/16x12/tr.png
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      statsxente.com
// @connect      bggydqalllytcqwxsypj.supabase.co
// @connect      managerzone.com
// @connect      www.managerzone.com
// @updateURL    https://update.greasyfork.org/scripts/505242/MZ%20-%20Pro%20ELO%20%26%20Statsxente%20Kar%C5%9F%C4%B1la%C5%9Ft%C4%B1rma%20Laboratuvar%C4%B1.meta.js
// @downloadURL  https://update.greasyfork.org/scripts/505242/MZ%20-%20Pro%20ELO%20%26%20Statsxente%20Kar%C5%9F%C4%B1la%C5%9Ft%C4%B1rma%20Laboratuvar%C4%B1.user.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    console.log('[MZ Pro-ELO] Laboratuvarı Başlatıldı.');

    // =========================================================================
    // 1. PRO-ELO HESAPLAMA MOTORU (ÇEKİRDEK MATEMATİK)
    // =========================================================================
    const ProEloEngine = {
        HOME_ADVANTAGE: 0, // MZ oyun motorunda iç saha/deplasman etkisi ihmal edilebilir düzeydedir (Nötr)
        BASE_K: {
            LEAGUE_CUP: 35,     // Resmi Lig ve Resmi Kupalar
            FEDERATION: 20,     // Federasyon Ligleri
            FRIENDLY: 0         // Hazırlık / Dostluk maçları ELO'yu kirletmez
        },

        // Gol Farkı Çarpanı (Anti-Farma ve Doyum Tavanı Korumalı)
        getGoalDiffMultiplier(goalDiff, eloDiff) {
            // Kural 1: Anti-Farma Sönümlemesi
            // Eğer iki takım arasında 300+ ELO farkı varsa gol farkı çarpanı iptal edilir
            if (Math.abs(eloDiff) >= 300) {
                return 1.0;
            }

            const diff = Math.abs(goalDiff);
            if (diff <= 1) return 1.0;
            if (diff === 2) return 1.20;
            if (diff === 3) return 1.35;
            return 1.50; // Kural 2: Tavan Sınırı (Cap) - İsterse 10 fark olsun en fazla 1.50x
        },

        // Lig Seviyesi / Kalite Çarpanı (Farma Koruması)
        getLeagueTierMultiplier(leagueName, isWorldLeague = false) {
            if (!leagueName) return 1.0;
            const l = leagueName.toLowerCase().trim();

            if (l.includes('top series')) return 1.30;

            // "div1.3", "div 1", "1. Liga" gibi tüm formatlardan ana lig kademesini (1, 2, 3, 4, 5+) çıkar
            const divMatch = l.match(/(?:\bdiv\s*|division\s*|^)(\d+)(?:\.|\s|$)/);
            if (divMatch) {
                const tier = parseInt(divMatch[1], 10);
                if (tier === 1) return 1.00;
                if (tier === 2) return 0.80;
                if (tier === 3) return 0.65;
                if (tier === 4) return 0.50;
                if (tier >= 5) return 0.35;
            }

            // ManagerZone'da "divX.Y" içermeyen tüm ulusal ligler (Eredivisie, Ligue 1, CSL, Super Lig vb.) o ülkenin En Üst Ligidir
            if (!isWorldLeague) return 1.25;

            return 0.80; // Tanımlanamayan dünya ligi adları için güvenli orta seviye
        },

        // Beklenen Skor (Kazanma Olasılığı) Hesaplama
        getExpectedScore(ratingA, ratingB, isHomeA = false) {
            const adjustedA = ratingA + (isHomeA ? this.HOME_ADVANTAGE : 0);
            return 1.0 / (1.0 + Math.pow(10, (ratingB - adjustedA) / 400.0));
        },

        // Tek Bir Maçı Hesaplama Fonksiyonu
        calculateMatch(ratingA, ratingB, goalsA, goalsB, opts = {}) {
            const isHomeA = opts.isHomeA || false;
            const isSenior = opts.category === 'SENIOR' || !opts.category;
            const lineupAvgAgeA = opts.lineupAvgAgeA || null;
            const lineupAvgAgeB = opts.lineupAvgAgeB || null;
            const leagueName = opts.leagueName || '';
            const isWorld = opts.isWorldLeague || false;

            // Kural 3: As Kadro / Taktik Kazası Dedektörü (U18 Çıkma Koruması)
            let isAnomalyA = false;
            let isAnomalyB = false;
            if (isSenior) {
                if (lineupAvgAgeA && lineupAvgAgeA <= 19.5) isAnomalyA = true;
                if (lineupAvgAgeB && lineupAvgAgeB <= 19.5) isAnomalyB = true;
            }

            // Gerçek Maç Sonucu (1: A yendi, 0.5: Berabere, 0: B yendi)
            let actualA = 0.5;
            if (goalsA > goalsB) actualA = 1.0;
            else if (goalsA < goalsB) actualA = 0.0;
            const actualB = 1.0 - actualA;

            const expectedA = this.getExpectedScore(ratingA, ratingB, isHomeA);
            const expectedB = 1.0 - expectedA;

            // Katsayılar
            const baseK = opts.baseK || this.BASE_K.LEAGUE_CUP;
            const leagueMult = this.getLeagueTierMultiplier(leagueName, isWorld);
            const goalDiff = goalsA - goalsB;
            const eloDiff = ratingA - ratingB;
            const goalMult = this.getGoalDiffMultiplier(goalDiff, eloDiff);

            let effectiveKA = baseK * leagueMult * goalMult;
            let effectiveKB = baseK * leagueMult * goalMult;

            let anomalyNoteA = null;
            let anomalyNoteB = null;

            // Kaza Koruması Devredeyse:
            if (isAnomalyA && actualA < 1.0) {
                effectiveKA = effectiveKA * 0.1; // Cezayı %90 sönümle
                anomalyNoteA = '🚨 As Kadro Kazası Tespit Edildi (U18 Kadrosu - Ceza Sönümlendi)';
            }
            if (isAnomalyB && actualB < 1.0) {
                effectiveKB = effectiveKB * 0.1;
                anomalyNoteB = '🚨 As Kadro Kazası Tespit Edildi (U18 Kadrosu - Ceza Sönümlendi)';
            }

            let deltaA = effectiveKA * (actualA - expectedA);
            let deltaB = effectiveKB * (actualB - expectedB);

            // FIFA Knockout Rule: Kupa eleme turlarında (Play-off / Knockout) kaybeden takımdan puan düşülmez (0 Ceza!)
            if (opts.isPlayoff) {
                if (deltaA < 0) deltaA = 0;
                if (deltaB < 0) deltaB = 0;
            }

            return {
                newRatingA: Math.round((ratingA + deltaA) * 10) / 10,
                newRatingB: Math.round((ratingB + deltaB) * 10) / 10,
                deltaA: Math.round(deltaA * 10) / 10,
                deltaB: Math.round(deltaB * 10) / 10,
                expectedA: Math.round(expectedA * 1000) / 10, // Yüzde
                expectedB: Math.round(expectedB * 1000) / 10,
                leagueMultiplier: leagueMult,
                goalMultiplier: goalMult,
                anomalyNoteA,
                anomalyNoteB
            };
        }
    };

    const SUPABASE_CONFIG = {
        url: 'https://bggydqalllytcqwxsypj.supabase.co',
        anonKey: 'sb_publishable_STh8YlqTIwHyCCNP9YFp_Q_YF3TpRKC'
    };

    // =========================================================================
    // 2. SUPABASE PRO-ELO & STATSXENTE VERİ ÇEKİCİ (SENIOR, U23, U21, U18)
    // =========================================================================
    const StatsxenteAPI = {
        cache: {},

        // Supabase REST üzerinden takımları sorgula (Hızlı & Bağımsız)
        async fetchFromSupabase(tids) {
            const unique = [...new Set(tids.map(Number).filter(Boolean))];
            if (!unique.length) return {};
            const result = {};
            try {
                const res = await new Promise((resolve) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `${SUPABASE_CONFIG.url}/rest/v1/mz_teams?tid=in.(${unique.join(',')})&select=tid,senior_elo,u23_elo,u21_elo,u18_elo`,
                        headers: {
                            'apikey': SUPABASE_CONFIG.anonKey,
                            'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`
                        },
                        timeout: 5000,
                        onload: (r) => resolve(r.responseText),
                        onerror: () => resolve(null),
                        ontimeout: () => resolve(null)
                    });
                });
                if (res) {
                    const rows = JSON.parse(res);
                    if (Array.isArray(rows)) {
                        rows.forEach(r => {
                            result[r.tid] = {
                                senior: r.senior_elo ? Math.round(Number(r.senior_elo) * 10) / 10 : null,
                                u23: r.u23_elo ? Math.round(Number(r.u23_elo) * 10) / 10 : null,
                                u21: r.u21_elo ? Math.round(Number(r.u21_elo) * 10) / 10 : null,
                                u18: r.u18_elo ? Math.round(Number(r.u18_elo) * 10) / 10 : null
                            };
                        });
                    }
                }
            } catch (_) {}
            return result;
        },

        async fetchTeamElo(tid) {
            if (this.cache[tid]) return this.cache[tid];

            const cacheKey = `mz_stats_elo_v3_${tid}`;
            try {
                const stored = localStorage.getItem(cacheKey);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (parsed && parsed.data && (Date.now() - parsed.timestamp < 10 * 60 * 1000)) {
                        this.cache[tid] = parsed.data;
                        return parsed.data;
                    }
                }
            } catch (_) {}

            // 1. Önce kendi bağımsız Supabase veritabanımıza bak
            const supaData = await this.fetchFromSupabase([tid]);
            if (supaData && supaData[tid] && (supaData[tid].senior || supaData[tid].u23 || supaData[tid].u21 || supaData[tid].u18)) {
                this.cache[tid] = supaData[tid];
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: supaData[tid] }));
                } catch (_) {}
                return supaData[tid];
            }

            // 2. Bulunamazsa Statsxente fallback
            const parseVal = (v) => {
                const n = parseFloat(v);
                return (!isNaN(n) && n > 0) ? Math.round(n * 10) / 10 : null;
            };

            return new Promise((resolve) => {
                const url = `https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer&idEquipo0=${tid}`;
                if (typeof GM_xmlhttpRequest !== 'function') {
                    resolve(null);
                    return;
                }

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: 8000,
                    onload: (res) => {
                        try {
                            const data = JSON.parse(res.responseText);
                            const teams = (data && data.teams) ? data.teams : (data || {});
                            const tData = teams[tid] || {};
                            const result = {
                                senior: parseVal(tData.SENIOR || tData.senior || tData.elo),
                                u23: parseVal(tData.U23 || tData.u23 || tData.elo23),
                                u21: parseVal(tData.U21 || tData.u21 || tData.elo21),
                                u18: parseVal(tData.U18 || tData.u18 || tData.elo18)
                            };
                            this.cache[tid] = result;
                            try {
                                localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: result }));
                            } catch (_) {}
                            resolve(result);
                        } catch (e) {
                            console.error('[MZ Pro-ELO] Statsxente parse error:', e);
                            resolve(null);
                        }
                    },
                    onerror: (err) => {
                        console.error('[MZ Pro-ELO] Statsxente request error:', err);
                        resolve(null);
                    }
                });
            });
        },

        // Toplu Rakip ELO Çekici (Önce Supabase toplu, eksikler Statsxente'den)
        async fetchBatchTeamElos(tids) {
            const uniqueTids = [...new Set(tids.filter(id => id && !this.cache[id]))];
            if (uniqueTids.length === 0) return this.cache;

            // 1. Önce Supabase'den topluca al
            const supaResults = await this.fetchFromSupabase(uniqueTids);
            const missingTids = [];
            uniqueTids.forEach(id => {
                if (supaResults[id]) {
                    this.cache[id] = supaResults[id];
                } else {
                    missingTids.push(id);
                }
            });

            if (missingTids.length === 0) return this.cache;

            // 2. Veritabanında henüz olmayan yeni takımları Statsxente'den tamamla
            const parseVal = (v) => {
                const n = parseFloat(v);
                return (!isNaN(n) && n > 0) ? Math.round(n * 10) / 10 : null;
            };

            const chunkSize = 25;
            for (let i = 0; i < missingTids.length; i += chunkSize) {
                const chunk = missingTids.slice(i, i + chunkSize);
                const query = chunk.map((id, idx) => `&idEquipo${idx}=${id}`).join('');
                const url = `https://statsxente.com/MZ1/Functions/tamper_elo_values.php?sport=soccer${query}`;

                await new Promise((resolve) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        timeout: 10000,
                        onload: (res) => {
                            try {
                                const data = JSON.parse(res.responseText);
                                const teams = (data && data.teams) ? data.teams : (data || {});
                                chunk.forEach(id => {
                                    const tData = teams[id] || {};
                                    this.cache[id] = {
                                        senior: parseVal(tData.SENIOR || tData.senior),
                                        u23: parseVal(tData.U23 || tData.u23),
                                        u21: parseVal(tData.U21 || tData.u21),
                                        u18: parseVal(tData.U18 || tData.u18)
                                    };
                                });
                            } catch (_) {}
                            resolve();
                        },
                        onerror: () => resolve()
                    });
                });
            }
            return this.cache;
        }
    };

    // =========================================================================
    // 3. GERÇEK MAÇ LİSTESİ (SON 30 GÜN / 1000 MAÇA KADAR) VE FİFA/ELO MOTORU
    // =========================================================================
    async function fetchTeamMatchList(tid) {
        return new Promise((resolve) => {
            // limit=1000 ile son 30 tam günün TÜM maçlarını (400-700+ maç) çeker
            const url = `https://www.managerzone.com/xml/team_matchlist.php?sport_id=1&team_id=${tid}&limit=1000`;
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 8000,
                onload: (res) => {
                    try {
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(res.responseText, 'text/xml');
                        const matchNodes = Array.from(xmlDoc.querySelectorAll('Match'));
                        const matches = [];

                        matchNodes.forEach(m => {
                            if (m.getAttribute('status') !== 'played') return;
                            const type = (m.getAttribute('type') || '').toLowerCase();
                            const typeName = m.getAttribute('typeName') || '';
                            const teams = m.querySelectorAll('Team');
                            if (teams.length < 2) return;

                            const home = teams[0];
                            const away = teams[1];

                            const homeTid = home.getAttribute('teamId');
                            const awayTid = away.getAttribute('teamId');
                            const homeGoals = parseInt(home.getAttribute('goals') || '0', 10);
                            const awayGoals = parseInt(away.getAttribute('goals') || '0', 10);
                            const isHome = (homeTid === String(tid));

                            matches.push({
                                id: m.getAttribute('id'),
                                date: m.getAttribute('date'),
                                type: type,
                                typeName: typeName,
                                isHome: isHome,
                                myGoals: isHome ? homeGoals : awayGoals,
                                oppGoals: isHome ? awayGoals : homeGoals,
                                oppTid: isHome ? awayTid : homeTid,
                                oppName: isHome ? away.getAttribute('teamName') : home.getAttribute('teamName')
                            });
                        });
                        resolve(matches);
                    } catch (e) {
                        console.error('[MZ Pro-ELO] MatchList parse error:', e);
                        resolve([]);
                    }
                },
                onerror: () => resolve([])
            });
        });
    }

    // Takım profilindeki lig bilgilerini #infoAboutTeam içinden tam ayrıştır
    function extractTeamLeaguesFromDOM() {
        const leagues = {
            seniorNational: '',
            seniorWorld: '',
            u23National: '',
            u23World: '',
            u21National: '',
            u21World: '',
            u18National: '',
            u18World: ''
        };
        const dl = document.getElementById('infoAboutTeam');
        if (!dl) return leagues;

        const dds = Array.from(dl.querySelectorAll('dd'));
        dds.forEach(dd => {
            const labelEl = dd.querySelector('.teamExpText');
            const aEl = dd.querySelector('a');
            if (!labelEl || !aEl) return;
            const label = labelEl.textContent.toLowerCase().trim();
            const name = aEl.textContent.trim();

            if (label.includes('dünya ligi') && label.includes('u23')) leagues.u23World = name;
            else if (label.includes('dünya ligi') && label.includes('u21')) leagues.u21World = name;
            else if (label.includes('dünya ligi') && label.includes('u18')) leagues.u18World = name;
            else if (label.includes('dünya ligi')) leagues.seniorWorld = name;
            else if (label.includes('u23 ligi')) leagues.u23National = name;
            else if (label.includes('u21 ligi')) leagues.u21National = name;
            else if (label.includes('u18 ligi')) leagues.u18National = name;
            else if (label.startsWith('lig')) leagues.seniorNational = name;
        });
        return leagues;
    }

    // Pro-ELO'yu Gerçek Maçlar, Rakip ELO'ları ve FIFA/ELO Matematiği Üzerinden Hesapla
    function computeProEloAdvanced(statsElo, matches, leagues, oppElos = {}) {
        if (!statsElo) return null;

        // 1. Kategorilere Göre Maçları Sınıflandır
        const catMatches = {
            senior: [],
            u23: [],
            u21: [],
            u18: []
        };
        const friendlyMatches = [];       // Bireysel hazırlık, scout, special (K=0)
        let friendlySeriesCount = 0;      // Dostluk Ligi sayacı

        matches.forEach(m => {
            if (m.type === 'friendly' || m.type.includes('scout') || m.type === 'special') {
                friendlyMatches.push(m);
                return; // Bireysel hazırlık, gözlemci (scout/u18_scout/federation_clash_scout) ve özel etkinlik maçları ELO'dan muaf (K=0)
            }
            if (m.type.includes('friendly')) {
                friendlySeriesCount += 1;
            }

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

        // 2. Her Kategori İçin Gerçek FIFA/ELO Fark Hesabı
        function evalCategory(cat, baseElo, natLeague, worldLeague) {
            const ms = catMatches[cat] || [];
            const isUnrankedSelf = (!baseElo || baseElo <= 0);

            if (isUnrankedSelf && ms.length === 0) {
                return {
                    proElo: null,
                    isStandalone: false,
                    adjustment: 0,
                    notes: ['⚠️ Bu kategoride Statsxente kaydı ve son 30 gün maçı yok'],
                    details: [],
                    totalAnalyzed: 0,
                    matchCount: 0,
                    reportData: {
                        statsElo: null, proElo: null, diff: 0,
                        matches: 0, unrankedOpps: 0, byType: {}, topSwings: [], recent5: []
                    }
                };
            }

            // Statsxente'de ELO=0 (kayıtsız) ama son 30 günde maçı varsa: kronolojik bağımsız Pro-ELO simülasyonu yap
            if (isUnrankedSelf && ms.length > 0) {
                const natMult = natLeague ? ProEloEngine.getLeagueTierMultiplier(natLeague, false) : null;
                const worldMult = worldLeague ? ProEloEngine.getLeagueTierMultiplier(worldLeague, true) : null;
                const defaultLeagueMult = (natMult !== null && worldMult !== null)
                    ? (natMult + worldMult) / 2.0
                    : (natMult !== null ? natMult : (worldMult !== null ? worldMult : 0.80));

                const rankedOppElos = ms
                    .map(m => (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null)
                    .filter(v => v !== null);
                let simElo = rankedOppElos.length > 0
                    ? (rankedOppElos.reduce((a, b) => a + b, 0) / rankedOppElos.length)
                    : (cat === 'senior' ? (defaultLeagueMult >= 1.15 ? 1650 : (defaultLeagueMult >= 0.65 ? 1400 : 1100)) : 1000);

                const chronoMs = [...ms].sort((a, b) => String(a.date).localeCompare(String(b.date)));
                const allDetails = [];
                const rawLogs = [];
                const byType = {};
                let unrankedCount = 0;

                chronoMs.forEach((m, idx) => {
                    const mType = (m.type || '').toLowerCase();
                    const mTypeName = (m.typeName || '').toLowerCase();
                    let kPro = 25;
                    let badgeLabel = `⚽ ${m.typeName || mType}`;

                    if (mType.includes('friendly')) {
                        kPro = 10; badgeLabel = `🤝 Dostluk Ligi`;
                    } else if (mType.includes('private_cup')) {
                        kPro = 10; badgeLabel = `🏆 Özel Kupa (${m.typeName || 'Grup'})`;
                    } else if (mType.includes('cup_playoff') || mTypeName.includes('final') || mTypeName.includes('semi') || mTypeName.includes('quarter') || mTypeName.includes('playoff') || mTypeName.includes('1/')) {
                        if (mTypeName.includes('final') && !mTypeName.includes('semi') && !mTypeName.includes('quarter')) { kPro = 50; badgeLabel = `👑 Kupa Finali`; }
                        else if (mTypeName.includes('semi') || mTypeName.includes('quarter')) { kPro = 45; badgeLabel = `🔥 Kupa Çeyrek/Yarı Final`; }
                        else { kPro = 40; badgeLabel = `⚔️ Kupa Eleme Turu`; }
                    } else if (mType.includes('cup_group')) {
                        kPro = 30; badgeLabel = `🛡️ Kupa Grup Aşaması`;
                    } else if (mType.includes('league') || mType.includes('qualification')) {
                        const isWorldMatch = mType.includes('world');
                        const matchLeagueMult = m.typeName ? ProEloEngine.getLeagueTierMultiplier(m.typeName, isWorldMatch) : defaultLeagueMult;
                        if (matchLeagueMult >= 1.15) { kPro = 35; badgeLabel = `🌟 Üst Lig (${m.typeName || 'Elit'})`; }
                        else if (matchLeagueMult >= 0.65) { kPro = 25; badgeLabel = `⚖️ Orta Lig (${m.typeName || 'Div 1-3'})`; }
                        else { kPro = 15; badgeLabel = `⚠️ Alt Lig (${m.typeName || 'Div 4+'})`; }
                    } else {
                        return;
                    }

                    const rawOppElo = (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null;
                    if (rawOppElo === null) unrankedCount += 1;
                    const oppElo = rawOppElo !== null ? rawOppElo : simElo;
                    const oppEloLabel = rawOppElo !== null ? `${Math.round(oppElo)}` : `Kayıtsız (~${Math.round(oppElo)})`;
                    const expected = ProEloEngine.getExpectedScore(simElo, oppElo, false);
                    const gDiff = m.myGoals - m.oppGoals;
                    const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);
                    const isPrivateComp = mType.includes('private_cup') || mType.includes('friendly');
                    const gMult = (isPrivateComp || rawOppElo === null) ? 1.0 : ProEloEngine.getGoalDiffMultiplier(gDiff, simElo - oppElo);
                    let proDelta = kPro * gMult * (actual - expected);
                    const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
                    if (isPlayoff && actual < 0.5) {
                        proDelta = 0; // FIFA Eleme Koruması: Kaybedene 0 ceza
                    }
                    simElo = Math.max(100, simElo + proDelta);

                    const typeBucket = mType.includes('friendly') ? 'friendly_series'
                        : (mType.includes('private_cup') ? 'private_cup'
                        : (mType.includes('cup_playoff') ? 'cup_playoff'
                        : (mType.includes('cup_group') ? 'cup_group'
                        : (mType.includes('world') ? `world:${m.typeName || '?'}` : `league:${m.typeName || '?'}`))));
                    if (!byType[typeBucket]) byType[typeBucket] = { count: 0, kPro: kPro, statsSum: 0, proSum: 0, netDiff: 0 };
                    byType[typeBucket].count += 1;
                    byType[typeBucket].proSum = Math.round((byType[typeBucket].proSum + proDelta) * 10) / 10;

                    const dRounded = Math.round(proDelta * 10) / 10;
                    const scoreStr = m.isHome ? `${m.myGoals} - ${m.oppGoals}` : `${m.oppGoals} - ${m.myGoals}`;
                    const matchTitle = m.isHome ? `Bu Takım (${scoreStr}) ${m.oppName}` : `${m.oppName} (${scoreStr}) Bu Takım`;
                    allDetails.push({
                        idx, absDiff: Math.abs(proDelta), date: m.date, typeLabel: badgeLabel, matchTitle,
                        impact: dRounded > 0 ? `+${dRounded}` : `${dRounded}`,
                        impactColor: dRounded > 0 ? '#4ade80' : (dRounded < 0 ? '#f87171' : '#94a3b8'),
                        reason: `Rakip ELO: ${oppEloLabel} | Beklenti: %${Math.round(expected * 100)} | Bağımsız Pro (K=${kPro}, G=${gMult.toFixed(2)}x): ${dRounded >= 0 ? '+' : ''}${dRounded}`
                    });
                    rawLogs.push({
                        d: m.date, t: m.type, tn: m.typeName || '', sc: `${m.myGoals}-${m.oppGoals}`, opp: m.oppTid,
                        oElo: Math.round(oppElo), miss: rawOppElo === null ? 1 : 0, exp: Math.round(expected * 100),
                        k: kPro, g: Math.round(gMult * 100) / 100, st: 0, pr: dRounded, df: dRounded
                    });
                });

                const finalPro = Math.round(simElo * 10) / 10;
                const details = [...allDetails].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 20);
                return {
                    proElo: finalPro,
                    isStandalone: true,
                    adjustment: 0,
                    notes: [`🆕 Statsxente kaydı yok (0); son 30 günün ${ms.length} maçından bağımsız hesaplandı`],
                    details,
                    totalAnalyzed: ms.length,
                    matchCount: ms.length,
                    reportData: {
                        statsElo: null, proElo: finalPro, diff: 0, isStandalone: true,
                        matches: ms.length, unrankedOpps: unrankedCount, byType,
                        topSwings: [...rawLogs].sort((a, b) => Math.abs(b.pr) - Math.abs(a.pr)).slice(0, 8),
                        recent5: [...rawLogs].sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 5)
                    }
                };
            }

            const notes = [];
            const allDetails = [];
            const safeBaseElo = baseElo;

            let friendlySeriesNetDiff = 0;
            let officialNetDiff = 0;
            let unrankedCount = 0;
            const byType = {};
            const rawLogs = [];

            function addTypeStat(key, kProVal, statsDelta, proDelta, diff) {
                if (!byType[key]) byType[key] = { count: 0, kPro: kProVal, statsSum: 0, proSum: 0, netDiff: 0 };
                byType[key].count += 1;
                byType[key].statsSum = Math.round((byType[key].statsSum + statsDelta) * 10) / 10;
                byType[key].proSum = Math.round((byType[key].proSum + proDelta) * 10) / 10;
                byType[key].netDiff = Math.round((byType[key].netDiff + diff) * 10) / 10;
            }

            // A) Bireysel Hazırlık / Scout / Special Notu
            if (cat === 'senior' && friendlyMatches.length > 0) {
                notes.push(`🛡️ ${friendlyMatches.length} Bireysel Hazırlık/Etkinlik Maçı (Stats & Pro: K=0)`);
            }

            // B) Gerçek FIFA/ELO K & G Çarpanı ile Resmi Maçlar (Lig Kademesi & Kupa Turu)
            const natMult = natLeague ? ProEloEngine.getLeagueTierMultiplier(natLeague, false) : null;
            const worldMult = worldLeague ? ProEloEngine.getLeagueTierMultiplier(worldLeague, true) : null;
            const defaultLeagueMult = (natMult !== null && worldMult !== null)
                ? (natMult + worldMult) / 2.0
                : (natMult !== null ? natMult : (worldMult !== null ? worldMult : 0.80));

            ms.forEach((m, idx) => {
                const rawOppElo = (oppElos[m.oppTid] && oppElos[m.oppTid][cat] != null) ? oppElos[m.oppTid][cat] : null;
                const oppElo = rawOppElo !== null ? rawOppElo : safeBaseElo;
                const oppEloLabel = rawOppElo !== null ? `${Math.round(oppElo)}` : `Kayıtsız (~${Math.round(oppElo)})`;
                const expected = ProEloEngine.getExpectedScore(safeBaseElo, oppElo, false);
                const gDiff = m.myGoals - m.oppGoals;
                const actual = gDiff > 0 ? 1 : (gDiff < 0 ? 0 : 0.5);

                const mType = (m.type || '').toLowerCase();
                const mTypeName = (m.typeName || '').toLowerCase();

                let kPro = 25;
                let badgeLabel = `⚽ ${m.typeName || mType}`;

                if (mType.includes('friendly')) {
                    kPro = 10;
                    badgeLabel = `🤝 Dostluk Ligi`;
                } else if (mType.includes('private_cup')) {
                    kPro = 10;
                    badgeLabel = `🏆 Özel Kupa (${m.typeName || 'Grup'})`;
                } else if (mType.includes('cup_playoff') || mTypeName.includes('final') || mTypeName.includes('semi') || mTypeName.includes('quarter') || mTypeName.includes('playoff') || mTypeName.includes('1/')) {
                    if (mTypeName.includes('final') && !mTypeName.includes('semi') && !mTypeName.includes('quarter')) {
                        kPro = 50;
                        badgeLabel = `👑 Kupa Finali`;
                    } else if (mTypeName.includes('semi') || mTypeName.includes('quarter')) {
                        kPro = 45;
                        badgeLabel = `🔥 Kupa Çeyrek/Yarı Final`;
                    } else {
                        kPro = 40;
                        badgeLabel = `⚔️ Kupa Eleme Turu`;
                    }
                } else if (mType.includes('cup_group')) {
                    kPro = 30;
                    badgeLabel = `🛡️ Kupa Grup Aşaması`;
                } else if (mType.includes('league') || mType.includes('qualification')) {
                    const isWorldMatch = mType.includes('world');
                    const matchLeagueMult = m.typeName ? ProEloEngine.getLeagueTierMultiplier(m.typeName, isWorldMatch) : defaultLeagueMult;

                    if (matchLeagueMult >= 1.15) {
                        kPro = 35;
                        badgeLabel = `🌟 Üst Lig (${m.typeName || 'Elit'})`;
                    } else if (matchLeagueMult >= 0.65) {
                        kPro = 25;
                        badgeLabel = `⚖️ Orta Lig (${m.typeName || 'Div 1-3'})`;
                    } else {
                        kPro = 15;
                        badgeLabel = `⚠️ Alt Lig (${m.typeName || 'Div 4+'})`;
                    }
                } else {
                    // Tanımsız/resmi olmayan türler ELO'ya dahil edilmez
                    return;
                }

                const isFriendlySeries = mType.includes('friendly');
                const isPrivateComp = mType.includes('private_cup') || isFriendlySeries;
                const gMult = (isPrivateComp || rawOppElo === null) ? 1.0 : ProEloEngine.getGoalDiffMultiplier(gDiff, safeBaseElo - oppElo);
                const statsK = isFriendlySeries ? 10 : (mType.includes('private_cup') ? 15 : 30);
                const statsDelta = statsK * (actual - expected);
                let proDelta = kPro * gMult * (actual - expected);

                // FIFA Knockout Rule: Kupa eleme turlarında (Play-off / Knockout) kaybeden takıma 0 ceza!
                const isPlayoff = mType.includes('cup_playoff') || mType.includes('playoff') || mType.includes('private_cup_playoff');
                let isKnockoutProtected = false;
                if (isPlayoff && actual < 0.5) {
                    proDelta = 0; // Kaybeden takıma 0 ceza
                    isKnockoutProtected = true;
                }

                const diff = proDelta - statsDelta;
                officialNetDiff += diff;
                if (rawOppElo === null) unrankedCount += 1;
                const typeBucket = isFriendlySeries ? 'friendly_series'
                    : (mType.includes('private_cup') ? 'private_cup'
                    : (mType.includes('cup_playoff') ? 'cup_playoff'
                    : (mType.includes('cup_group') ? 'cup_group'
                    : (mType.includes('world') ? `world:${m.typeName || '?'}` : `league:${m.typeName || '?'}`))));
                addTypeStat(typeBucket, kPro, statsDelta, proDelta, diff);
                rawLogs.push({
                    d: m.date, t: m.type, tn: m.typeName || '',
                    sc: `${m.myGoals}-${m.oppGoals}`, opp: m.oppTid,
                    oElo: Math.round(oppElo), miss: rawOppElo === null ? 1 : 0,
                    exp: Math.round(expected * 100), k: kPro, g: Math.round(gMult * 100) / 100,
                    st: Math.round(statsDelta * 10) / 10, pr: Math.round(proDelta * 10) / 10,
                    df: Math.round(diff * 10) / 10
                });

                const scoreStr = m.isHome ? `${m.myGoals} - ${m.oppGoals}` : `${m.oppGoals} - ${m.myGoals}`;
                const matchTitle = m.isHome ? `Bu Takım (${scoreStr}) ${m.oppName}` : `${m.oppName} (${scoreStr}) Bu Takım`;
                const diffRounded = Math.round(diff * 10) / 10;

                allDetails.push({
                    idx: idx + 10000,
                    absDiff: Math.abs(diff),
                    date: m.date,
                    typeLabel: badgeLabel,
                    matchTitle: matchTitle,
                    impact: diffRounded > 0 ? `+${diffRounded}` : `${diffRounded}`,
                    impactColor: diffRounded > 0 ? '#4ade80' : (diffRounded < 0 ? '#f87171' : '#94a3b8'),
                    reason: `Rakip ELO: ${oppEloLabel} | Beklenti: %${Math.round(expected * 100)} | Stats (K=${statsK}): ${statsDelta >= 0 ? '+' : ''}${statsDelta.toFixed(1)} → Pro (K=${kPro}, G=${gMult.toFixed(2)}x): ${proDelta >= 0 ? '+' : ''}${proDelta.toFixed(1)}${isKnockoutProtected ? ' 🛡️ [FIFA Eleme Koruması: Kayıp Sıfırlandı (0)]' : ''}`
                });
            });

            if (ms.length > 0) {
                const oRounded = Math.round(officialNetDiff * 10) / 10;
                notes.push(`📐 ${ms.length} Resmi Maç (FIFA K/G & Rakip ELO): ${oRounded > 0 ? '+' : ''}${oRounded}`);
            }

            if (notes.length === 0) notes.push('Standart kalibrasyon dengeli');

            // En yüksek etkili 15 maç + en güncel 10 maçı birleştir (tekrarsız, max 25 satır)
            const byImpact = [...allDetails].sort((a, b) => b.absDiff - a.absDiff).slice(0, 15);
            const byRecent = [...allDetails].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10);
            const seen = new Set();
            const details = [];
            [...byRecent, ...byImpact].forEach(item => {
                const key = `${item.date}_${item.matchTitle}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    details.push(item);
                }
            });
            details.sort((a, b) => String(b.date).localeCompare(String(a.date)));

            const adjustment = Math.round(officialNetDiff * 10) / 10;
            const topSwings = [...rawLogs].sort((a, b) => Math.abs(b.df) - Math.abs(a.df)).slice(0, 8);
            const recent5 = [...rawLogs].sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 5);

            return {
                proElo: Math.round((safeBaseElo + adjustment) * 10) / 10,
                adjustment: adjustment,
                notes: notes,
                details: details,
                totalAnalyzed: ms.length,
                matchCount: ms.length,
                reportData: {
                    statsElo: safeBaseElo,
                    proElo: Math.round((safeBaseElo + adjustment) * 10) / 10,
                    diff: adjustment,
                    matches: ms.length,
                    unrankedOpps: unrankedCount,
                    byType: byType,
                    topSwings: topSwings,
                    recent5: recent5
                }
            };
        }

        const resSenior = evalCategory('senior', statsElo.senior, leagues.seniorNational, leagues.seniorWorld);
        const resU23 = evalCategory('u23', statsElo.u23, leagues.u23National, leagues.u23World);
        const resU21 = evalCategory('u21', statsElo.u21, leagues.u21National, leagues.u21World);
        const resU18 = evalCategory('u18', statsElo.u18, leagues.u18National, leagues.u18World);

        return {
            senior: resSenior,
            u23: resU23,
            u21: resU21,
            u18: resU18,
            friendlyCount: friendlyMatches.length,
            friendlySeriesCount: friendlySeriesCount
        };
    }

    // =========================================================================
    // 4. ARAYÜZ (UI): TAKIM SAYFASINDA KARŞILAŞTIRMA TABLOSU
    // =========================================================================
    async function renderTeamPageComparison() {
        const urlParams = new URLSearchParams(window.location.search);
        let tid = urlParams.get('tid');
        if (!tid) {
            const m = window.location.href.match(/tid=(\d+)/);
            if (m) tid = m[1];
        }

        function findTidFromDOM() {
            const links = Array.from(document.querySelectorAll('a[href*="p=team&tid="], a[href*="tid="]'));
            for (const a of links) {
                const m = (a.getAttribute('href') || a.href || '').match(/tid=(\d+)/);
                if (m) return m[1];
            }
            return null;
        }

        function findTarget() {
            return document.querySelector('#infoAboutTeam') || 
                   document.querySelector('#contentDiv') || 
                   document.querySelector('.mainContent') || 
                   document.querySelector('#mainContent') ||
                   document.querySelector('#team_view');
        }

        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (!tid) tid = findTidFromDOM();
            const targetEl = findTarget();
            if (targetEl && tid) {
                clearInterval(timer);
                mountCard(targetEl, tid);
            } else if (attempts >= 15) {
                clearInterval(timer);
            }
        }, 200);
    }

    async function mountCard(targetEl, tid) {
        if (document.getElementById('mz-pro-elo-card')) return;

        const card = document.createElement('div');
        card.id = 'mz-pro-elo-card';
        card.style.cssText = `
            margin: 14px 0 18px 0;
            padding: 16px 20px;
            background: linear-gradient(135deg, #0b1329 0%, #172554 100%);
            border: 2px solid #2563eb;
            border-radius: 12px;
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            clear: both;
            box-sizing: border-box;
            max-width: 100%;
            overflow: hidden;
        `;
        card.innerHTML = `
            <div style="border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 10px; margin-bottom: 14px;">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 20px; flex-shrink: 0;">🔬</span>
                        <div style="font-weight: 900; font-size: 15px; letter-spacing: 0.5px; color: #38bdf8; white-space: nowrap;">
                            MZ ELO LABORATUVARI <span style="font-size: 11px; background: rgba(56, 189, 248, 0.2); color: #7dd3fc; border: 1px solid #38bdf8; padding: 2px 7px; border-radius: 4px; margin-left: 6px;">PRO-ELO v1.0</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex-shrink: 0;">
                        <button id="mz-copy-report-btn" disabled style="padding: 5px 10px; background: rgba(168, 85, 247, 0.2); color: #d8b4fe; border: 1px solid #a855f7; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: not-allowed; opacity: 0.6; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                            <span>📋</span> JSON Rapor
                        </button>
                        <button id="mz-open-lab-modal-btn" style="padding: 5px 11px; background: #38bdf8; color: #0f172a; border: none; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                            <span>⚡</span> Canlı Simülatör & Top Tablo
                        </button>
                    </div>
                </div>
                <div style="font-size: 11px; color: #94a3b8; margin-top: 5px; line-height: 1.35; white-space: normal;">
                    Statsxente ve Akıllı Pro-ELO (Lig Ağırlığı, Farma Sönümlemesi ve As Kadro Koruması) Karşılaştırma Tablosu
                </div>
            </div>
            <div id="mz-elo-card-content" style="min-height: 80px; display: flex; align-items: center; justify-content: center;">
                <span style="color: #94a3b8; font-size: 13px;"><i class="fa fa-spinner fa-spin"></i> Takımın ELO verileri taranıyor ve Pro-ELO hesaplanıyor...</span>
            </div>
        `;

        if (targetEl.id === 'infoAboutTeam') {
            targetEl.parentNode.insertBefore(card, targetEl);
        } else {
            targetEl.prepend(card);
        }

        const openBtn = card.querySelector('#mz-open-lab-modal-btn');
        if (openBtn) openBtn.onclick = () => openSimulatorModal();

        // 1. Takım lig bilgilerini sayfadaki #infoAboutTeam içinden eksiksiz oku
        const leagues = extractTeamLeaguesFromDOM();

        // 2. Hem Statsxente ELO'sunu hem de Takımın Gerçek Son Maçlarını (MZ XML) Çek
        const [statsElo, matches] = await Promise.all([
            StatsxenteAPI.fetchTeamElo(tid),
            fetchTeamMatchList(tid)
        ]);

        // Eğer profil sayfasındaysak ve #infoAboutTeam yoksa, ligleri XML maçlarından doldur
        if (!leagues.seniorWorld || !leagues.seniorNational) {
            matches.forEach(m => {
                if (!leagues.seniorNational && m.type === 'league' && m.typeName) leagues.seniorNational = m.typeName;
                if (!leagues.seniorWorld && m.type === 'world_league' && m.typeName) leagues.seniorWorld = m.typeName;
                if (!leagues.u23World && m.type === 'u23_world_league' && m.typeName) leagues.u23World = m.typeName;
                if (!leagues.u21World && m.type === 'u21_world_league' && m.typeName) leagues.u21World = m.typeName;
                if (!leagues.u18World && m.type === 'u18_world_league' && m.typeName) leagues.u18World = m.typeName;
            });
        }

        const contentEl = document.getElementById('mz-elo-card-content');
        if (!contentEl) return;

        if (!statsElo) {
            contentEl.innerHTML = `
                <div style="padding: 16px; text-align: center; color: #f87171; font-size: 12px;">
                    ⚠️ Takımın ELO verisi Statsxente veritabanında bulunamadı veya henüz resmi maç verisi işlenmemiş.
                </div>
            `;
            return;
        }

        // 2.5. Son 30 gündeki tüm rakiplerin gerçek ELO değerlerini toplu olarak çek
        const uniqueOppTids = [...new Set(matches.map(m => m.oppTid).filter(Boolean))];
        contentEl.innerHTML = `<span style="color: #94a3b8; font-size: 13px;"><i class="fa fa-spinner fa-spin"></i> Son 30 günün ${matches.length} maçındaki ${uniqueOppTids.length} rakibin ELO verileri çekiliyor...</span>`;
        const oppElos = await StatsxenteAPI.fetchBatchTeamElos(uniqueOppTids);

        // 3. Pro-ELO Motorunu Çalıştır (Gerçek FIFA/ELO matematiği ve rakip ELO'ları ile)
        const proRes = computeProEloAdvanced(statsElo, matches, leagues, oppElos);

        // JSON Rapor Kopyalama Butonunu Aktifleştir
        const copyBtn = card.querySelector('#mz-copy-report-btn');
        if (copyBtn) {
            copyBtn.disabled = false;
            copyBtn.style.cursor = 'pointer';
            copyBtn.style.opacity = '1';
            copyBtn.onclick = async () => {
                const reportObj = {
                    tid: String(tid),
                    leagues: leagues,
                    summary: {
                        totalMatches: matches.length,
                        friendlyCount: proRes.friendlyCount,
                        friendlySeriesCount: proRes.friendlySeriesCount
                    },
                    categories: {
                        senior: proRes.senior.reportData,
                        u23: proRes.u23.reportData,
                        u21: proRes.u21.reportData,
                        u18: proRes.u18.reportData
                    }
                };
                const jsonStr = JSON.stringify(reportObj);
                try {
                    await navigator.clipboard.writeText(jsonStr);
                    const origHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<span>✅</span> Kopyalandı!';
                    copyBtn.style.background = 'rgba(34, 197, 94, 0.25)';
                    copyBtn.style.borderColor = '#22c55e';
                    copyBtn.style.color = '#86efac';
                    setTimeout(() => {
                        copyBtn.innerHTML = origHtml;
                        copyBtn.style.background = 'rgba(168, 85, 247, 0.2)';
                        copyBtn.style.borderColor = '#a855f7';
                        copyBtn.style.color = '#d8b4fe';
                    }, 2000);
                } catch (_) {
                    window.prompt('JSON Raporu (Ctrl+C ile kopyalayın):', jsonStr);
                }
            };
        }

        const rowsData = [
            { id: 'senior', label: '🏆 Senior (A Takım)', stats: statsElo.senior, proObj: proRes.senior, isKey: true },
            { id: 'u23', label: '🥇 U23 (23 Yaş Altı)', stats: statsElo.u23, proObj: proRes.u23 },
            { id: 'u21', label: '🥈 U21 (21 Yaş Altı)', stats: statsElo.u21, proObj: proRes.u21 },
            { id: 'u18', label: '🥉 U18 (Gençler)', stats: statsElo.u18, proObj: proRes.u18 }
        ];

        let tableRowsHtml = '';
        rowsData.forEach(r => {
            const isStandalone = Boolean(r.proObj.isStandalone);
            const hasStats = (r.stats !== null && r.stats !== undefined && r.stats > 0);
            const hasPro = (r.proObj.proElo !== null && r.proObj.proElo !== undefined);
            const statsVal = hasStats ? r.stats : 'Kayıtsız';
            const proVal = hasPro ? (isStandalone ? `~${r.proObj.proElo}` : r.proObj.proElo) : '-';
            const delta = (hasStats && hasPro) ? Math.round((r.proObj.proElo - r.stats) * 10) / 10 : 0;
            const deltaSign = isStandalone ? 'Bağımsız' : ((hasStats && hasPro) ? (delta > 0 ? `+${delta}` : `${delta}`) : '-');
            const deltaColor = isStandalone ? '#38bdf8' : ((!hasStats || !hasPro) ? '#64748b' : (delta > 0 ? '#4ade80' : (delta < 0 ? '#f87171' : '#94a3b8')));
            const analysisHtml = r.proObj.notes.map(n => `<div style="margin-bottom: 2px;">${n}</div>`).join('');

            const bgRow = r.isKey ? 'background: rgba(56, 189, 248, 0.08); font-weight: 700;' : 'background: rgba(15, 23, 42, 0.4);';

            tableRowsHtml += `
                <tr class="mz-elo-row" data-cat="${r.id}" style="${bgRow} border-bottom: 1px solid rgba(255,255,255,0.06); transition: background 0.15s; cursor: pointer;" title="Maç bazlı detayları görmek için tıklayın">
                    <td style="padding: 10px 8px; font-weight: 700; color: #f8fafc; word-wrap: break-word;">${r.label}</td>
                    <td style="padding: 10px 6px; text-align: center; color: #38bdf8; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums;">${statsVal}</td>
                    <td style="padding: 10px 6px; text-align: center; color: #facc15; font-size: 15px; font-weight: 900; font-variant-numeric: tabular-nums; text-shadow: 0 0 10px rgba(250, 204, 21, 0.3);">${proVal}</td>
                    <td style="padding: 10px 6px; text-align: center; font-weight: 900; color: ${deltaColor}; font-size: 14px; font-variant-numeric: tabular-nums;">${deltaSign}</td>
                    <td style="padding: 10px 8px; color: #cbd5e1; font-size: 11px; line-height: 1.4; white-space: normal; word-break: break-word;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                            <div style="flex: 1; min-width: 0;">${analysisHtml}</div>
                            <button class="mz-elo-detail-btn" data-cat="${r.id}" style="padding: 3px 7px; font-size: 10px; font-weight: 800; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 4px; cursor: pointer; white-space: nowrap; flex-shrink: 0;">🔍 Detay (${r.proObj.details.length})</button>
                        </div>
                    </td>
                </tr>
            `;
        });

        contentEl.innerHTML = `
            <div style="width: 100%; overflow: hidden; box-sizing: border-box;">
                <table style="width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; text-align: left;">
                    <thead>
                        <tr style="background: rgba(15, 23, 42, 0.9); color: #94a3b8; font-size: 10px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.4px; border-bottom: 2px solid #334155;">
                            <th style="padding: 8px; width: 125px;">Kategori</th>
                            <th style="padding: 8px 6px; width: 80px; text-align: center;">Stats ELO</th>
                            <th style="padding: 8px 6px; width: 90px; text-align: center; color: #facc15;">✨ Pro-ELO</th>
                            <th style="padding: 8px 6px; width: 60px; text-align: center;">Fark</th>
                            <th style="padding: 8px; width: auto;">Algoritma Analizi & Kararlar</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRowsHtml}
                    </tbody>
                </table>

                <!-- Genişletilebilir Detay Çekmecesi -->
                <div id="mz-elo-detail-drawer" style="display: none; margin-top: 12px; background: rgba(10, 15, 30, 0.85); border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; overflow-x: hidden; overflow-y: auto; max-height: 380px; box-sizing: border-box;"></div>

                <div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                    <div>
                        <span>📊 Taranan Veri: <b>Son 30 Gün / ${matches.length} Maç</b> (${proRes.friendlyCount} Bireysel Hazırlık + ${proRes.friendlySeriesCount} Dostluk Ligi)</span>
                    </div>
                    <div>
                        <span>Lig: <b style="color: #38bdf8;">${leagues.seniorNational || 'Bilinmiyor'}</b> | Dünya Ligi: <b style="color: #38bdf8;">${leagues.seniorWorld || 'Bilinmiyor'}</b></span>
                    </div>
                </div>
            </div>
        `;

        // Detay açma / kapama işlevi
        let activeDrawerCat = null;
        const drawer = contentEl.querySelector('#mz-elo-detail-drawer');

        function toggleDrawer(cat) {
            if (activeDrawerCat === cat && drawer.style.display === 'block') {
                drawer.style.display = 'none';
                activeDrawerCat = null;
                return;
            }
            activeDrawerCat = cat;
            const rowObj = rowsData.find(x => x.id === cat);
            if (!rowObj) return;

            const details = rowObj.proObj.details || [];
            if (details.length === 0) {
                drawer.innerHTML = `<div style="font-size: 12px; color: #94a3b8; text-align: center; padding: 8px;">Bu kategori için son maçlarda ekstra düzeltme kaydı bulunmuyor.</div>`;
            } else {
                let dHtml = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #334155;">
                        <b style="color: #38bdf8; font-size: 12px;">🔍 ${rowObj.label} — Maç Bazlı Pro-ELO Karar Dökümü</b>
                        <button id="mz-close-drawer" style="background: transparent; border: none; color: #94a3b8; cursor: pointer; font-size: 14px;">&times; Kapat</button>
                    </div>
                    <table style="width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11px;">
                        <thead>
                            <tr style="color: #64748b; text-align: left; border-bottom: 1px solid #1e293b;">
                                <th style="padding: 5px 4px; width: 15%; white-space: normal;">Tarih</th>
                                <th style="padding: 5px 4px; width: 19%; white-space: normal;">Tür / Lig</th>
                                <th style="padding: 5px 4px; width: 27%; white-space: normal;">Maç & Skor</th>
                                <th style="padding: 5px 4px; width: 7%; text-align: center; white-space: normal;">Etki</th>
                                <th style="padding: 5px 4px; width: 32%; white-space: normal;">Pro-ELO Kararı</th>
                            </tr>
                        </thead>
                        <tbody>
                `;
                details.forEach(d => {
                    dHtml += `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.04);">
                            <td style="padding: 6px 4px; color: #64748b; white-space: normal; word-break: break-word; overflow-wrap: anywhere; vertical-align: top;">${d.date}</td>
                            <td style="padding: 6px 4px; color: #cbd5e1; font-weight: 700; white-space: normal; word-break: break-word; overflow-wrap: anywhere; vertical-align: top;">${d.typeLabel}</td>
                            <td style="padding: 6px 4px; color: #f8fafc; white-space: normal; word-break: break-word; overflow-wrap: anywhere; vertical-align: top;">${d.matchTitle}</td>
                            <td style="padding: 6px 4px; text-align: center; font-weight: 900; color: ${d.impactColor}; white-space: normal; vertical-align: top;">${d.impact}</td>
                            <td style="padding: 6px 4px; color: #94a3b8; white-space: normal; word-break: break-word; overflow-wrap: anywhere; vertical-align: top; line-height: 1.35;">${d.reason}</td>
                        </tr>
                    `;
                });
                dHtml += `</tbody></table>`;
                drawer.innerHTML = dHtml;
                drawer.querySelector('#mz-close-drawer').onclick = () => {
                    drawer.style.display = 'none';
                    activeDrawerCat = null;
                };
            }
            drawer.style.display = 'block';
        }

        contentEl.querySelectorAll('.mz-elo-row').forEach(tr => {
            tr.onclick = () => toggleDrawer(tr.getAttribute('data-cat'));
        });
    }

    // =========================================================================
    // 5. İNTERAKTİF SİMÜLATÖR POPUP (LABORATUVAR)
    // =========================================================================
    function injectFloatingLabButton() {
        if (document.getElementById('mz-pro-elo-lab-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'mz-pro-elo-lab-btn';
        btn.title = 'Pro-ELO & Statsxente Karşılaştırma Laboratuvarını Aç';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            z-index: 999998;
            background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
            color: #fff;
            border: 2px solid rgba(255,255,255,0.25);
            border-radius: 50px;
            padding: 8px 16px;
            font-size: 12px;
            font-weight: 800;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 7px;
            transition: transform 0.2s ease;
        `;
        btn.innerHTML = `<span>🔬</span> ELO Laboratuvarı`;
        btn.onmouseover = () => { btn.style.transform = 'scale(1.08)'; };
        btn.onmouseout = () => { btn.style.transform = 'scale(1)'; };

        btn.onclick = () => openSimulatorModal();
        document.body.appendChild(btn);
    }

    function openSimulatorModal() {
        if (document.getElementById('mz-pro-elo-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'mz-pro-elo-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.8);
            backdrop-filter: blur(5px);
            z-index: 9999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

        modal.innerHTML = `
            <div style="background: #0f172a; border: 2px solid #334155; border-radius: 14px; width: 850px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column; padding: 22px; color: #f8fafc; box-shadow: 0 20px 50px rgba(0,0,0,0.7);">
                <!-- Modal Başlığı -->
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 14px; margin-bottom: 14px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 24px;">🔬</span>
                        <div>
                            <b style="font-size: 16px; color: #38bdf8;">MZ ELO Laboratuvarı & Karşılaştırma Merkezi</b>
                            <div style="font-size: 11px; color: #94a3b8;">Statsxente Klasik ELO vs Yeni Nesil Dinamik Pro-ELO</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div style="display: flex; background: #1e293b; padding: 3px; border-radius: 8px; border: 1px solid #475569;">
                            <button id="mz-tab-top-table" style="padding: 5px 12px; font-size: 12px; font-weight: 800; border: none; border-radius: 6px; background: #38bdf8; color: #0f172a; cursor: pointer;">📊 Canlı Top Karşılaştırma Tablosu</button>
                            <button id="mz-tab-simulator" style="padding: 5px 12px; font-size: 12px; font-weight: 800; border: none; border-radius: 6px; background: transparent; color: #94a3b8; cursor: pointer;">⚡ Maç Simülatörü</button>
                        </div>
                        <button id="mz-modal-close" style="background: transparent; border: none; color: #94a3b8; font-size: 22px; cursor: pointer; margin-left: 6px;">&times;</button>
                    </div>
                </div>

                <!-- Modal Gövdesi (Scroll Edilebilir) -->
                <div id="mz-modal-body" style="overflow-y: auto; flex: 1; padding-right: 4px;">
                    <!-- Varsayılan: Top Tablosu Yüklenecek -->
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('#mz-modal-close').onclick = () => modal.remove();

        const tabTopTableBtn = modal.querySelector('#mz-tab-top-table');
        const tabSimBtn = modal.querySelector('#mz-tab-simulator');
        const modalBody = modal.querySelector('#mz-modal-body');

        // Sekme Değişimi
        tabTopTableBtn.onclick = () => {
            tabTopTableBtn.style.background = '#38bdf8';
            tabTopTableBtn.style.color = '#0f172a';
            tabSimBtn.style.background = 'transparent';
            tabSimBtn.style.color = '#94a3b8';
            renderLiveTopComparisonTable(modalBody);
        };

        tabSimBtn.onclick = () => {
            tabSimBtn.style.background = '#38bdf8';
            tabSimBtn.style.color = '#0f172a';
            tabTopTableBtn.style.background = 'transparent';
            tabTopTableBtn.style.color = '#94a3b8';
            renderSimulatorView(modalBody);
        };

        // İlk açılış: Top Karşılaştırma Tablosu
        renderLiveTopComparisonTable(modalBody);
    }

    // 1. Sekme: Canlı Dünya Top ELO Karşılaştırma Tablosu
    function renderLiveTopComparisonTable(container) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa fa-spinner fa-spin" style="font-size: 26px; color: #38bdf8;"></i>
                <div style="margin-top: 10px; font-size: 13px;">Statsxente verileri çekiliyor ve Pro-ELO ile karşılaştırılıyor...</div>
            </div>
        `;

        const queryUrl = `https://statsxente.com/MZ1/Functions/lecturaEquipos2.0.php?noheader=true&idioma=tr&divisa=0&eloButtonType=2&eloButtonCat=SENIOR&equipo=&limite=50&ordenar=elo`;

        GM_xmlhttpRequest({
            method: 'GET',
            url: queryUrl,
            timeout: 10000,
            onload: (res) => {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(res.responseText, 'text/html');
                    const rows = Array.from(doc.querySelectorAll('table tr')).slice(1); // başlığı atla

                    if (rows.length === 0) {
                        container.innerHTML = `<div style="padding: 30px; text-align: center; color: #f87171;">Veri ayrıştırılamadı.</div>`;
                        return;
                    }

                    let tableHtml = `
                        <div style="margin-bottom: 12px; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between;">
                            <span>Dünya Sıralamasındaki İlk 50 Takım (Statsxente ELO vs Akıllı Pro-ELO)</span>
                            <span style="color: #facc15; font-weight: 700;">★ Pro-ELO: Lig Zorluğu & Farma Korumalı</span>
                        </div>
                        <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
                            <thead>
                                <tr style="background: #1e293b; color: #94a3b8; font-weight: 700; text-transform: uppercase; font-size: 11px;">
                                    <th style="padding: 8px 10px; width: 35px; text-align: center;">#</th>
                                    <th style="padding: 8px 10px;">Takım</th>
                                    <th style="padding: 8px 10px;">Lig</th>
                                    <th style="padding: 8px 10px; text-align: center; width: 95px;">Statsxente</th>
                                    <th style="padding: 8px 10px; text-align: center; width: 95px; color: #facc15;">✨ Pro-ELO</th>
                                    <th style="padding: 8px 10px; text-align: center; width: 75px;">Fark</th>
                                    <th style="padding: 8px 10px;">Analiz</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;

                    rows.forEach((r, idx) => {
                        const tds = r.querySelectorAll('td');
                        if (tds.length < 5) return;

                        const teamName = tds[1].textContent.trim();
                        const teamLink = tds[1].querySelector('a');
                        const tid = teamLink ? (teamLink.href.match(/idEquipo=(\d+)/) || teamLink.href.match(/tid=(\d+)/) || [])[1] : '';
                        const statsEloVal = parseFloat(tds[2].textContent.replace(',', '.').trim()) || 1500;
                        const leagueName = tds[4] ? tds[4].textContent.trim() : '';

                        // Pro-ELO Hesabı
                        const proObj = computeProEloComposite({ senior: statsEloVal }, { league: leagueName });
                        const proVal = proObj.senior;
                        const delta = Math.round((proVal - statsEloVal) * 10) / 10;
                        const deltaSign = delta > 0 ? `+${delta}` : `${delta}`;
                        const deltaColor = delta > 0 ? '#4ade80' : (delta < 0 ? '#f87171' : '#94a3b8');

                        let note = 'Standart dengeli';
                        if (delta > 0) note = '🌟 Elit Lig Primi';
                        else if (delta < 0) note = '⚠️ Alt Lig Sönümlemesi';

                        const bg = (idx % 2 === 0) ? '#0f172a' : '#141e33';

                        tableHtml += `
                            <tr style="background: ${bg}; border-bottom: 1px solid rgba(255,255,255,0.04);">
                                <td style="padding: 7px 10px; text-align: center; color: #94a3b8; font-weight: 700;">${idx + 1}</td>
                                <td style="padding: 7px 10px;">
                                    <a href="/?p=team&tid=${tid}" target="_blank" style="color: #38bdf8; text-decoration: none; font-weight: 700;">${teamName}</a>
                                </td>
                                <td style="padding: 7px 10px; color: #cbd5e1;">${leagueName}</td>
                                <td style="padding: 7px 10px; text-align: center; font-weight: 800; color: #38bdf8;">${statsEloVal.toFixed(2)}</td>
                                <td style="padding: 7px 10px; text-align: center; font-weight: 900; color: #facc15;">${proVal.toFixed(2)}</td>
                                <td style="padding: 7px 10px; text-align: center; font-weight: 800; color: ${deltaColor};">${deltaSign}</td>
                                <td style="padding: 7px 10px; font-size: 11px; color: #94a3b8;">${note}</td>
                            </tr>
                        `;
                    });

                    tableHtml += `</tbody></table>`;
                    container.innerHTML = tableHtml;
                } catch (err) {
                    container.innerHTML = `<div style="padding: 30px; text-align: center; color: #f87171;">Hata: ${err.message}</div>`;
                }
            },
            onerror: () => {
                container.innerHTML = `<div style="padding: 30px; text-align: center; color: #f87171;">Statsxente bağlantısı kurulamadı.</div>`;
            }
        });
    }

    // 2. Sekme: Maç Simülatörü Görünümü
    function renderSimulatorView(container) {
        container.innerHTML = `
            <div style="background: #1e293b; padding: 16px; border-radius: 10px; border: 1px solid #334155; margin-bottom: 16px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
                    <div>
                        <label style="font-size: 11px; color: #94a3b8; font-weight: 700;">Takım A (Ev Sahibi) ELO</label>
                        <input id="sim-elo-a" type="number" value="1900" style="width: 100%; padding: 7px 10px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-weight: 700; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="font-size: 11px; color: #94a3b8; font-weight: 700;">Takım B (Deplasman) ELO</label>
                        <input id="sim-elo-b" type="number" value="1200" style="width: 100%; padding: 7px 10px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-weight: 700; box-sizing: border-box;">
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 16px;">
                    <div>
                        <label style="font-size: 11px; color: #94a3b8; font-weight: 700;">Skor A</label>
                        <input id="sim-goals-a" type="number" value="8" style="width: 100%; padding: 7px 10px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-weight: 700; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="font-size: 11px; color: #94a3b8; font-weight: 700;">Skor B</label>
                        <input id="sim-goals-b" type="number" value="0" style="width: 100%; padding: 7px 10px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-weight: 700; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="font-size: 11px; color: #94a3b8; font-weight: 700;">Lig Seviyesi</label>
                        <select id="sim-league" style="width: 100%; padding: 7px 10px; margin-top: 4px; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #fff; font-weight: 700; box-sizing: border-box;">
                            <option value="super">Süper Lig / Top Series (1.30x)</option>
                            <option value="div1" selected>Division 1 (1.00x)</option>
                            <option value="div2">Division 2 (0.80x)</option>
                            <option value="div5">Division 5+ (0.35x)</option>
                        </select>
                    </div>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #cbd5e1; cursor: pointer;">
                        <input type="checkbox" id="sim-anomaly-a" style="cursor: pointer;">
                        🚨 Takım A sahaya yanlışlıkla U18 kadrosuyla çıktı (As Kadro Kazası)
                    </label>
                </div>

                <button id="sim-calculate-btn" style="width: 100%; padding: 10px; background: #38bdf8; border: none; border-radius: 6px; color: #0f172a; font-weight: 800; font-size: 13px; cursor: pointer; transition: opacity 0.2s;">
                    ⚡ Sonuçları Karşılaştır (Statsxente vs Pro-ELO)
                </button>
            </div>

            <div id="sim-results"></div>
        `;

        function runSim() {
            const eloA = parseFloat(container.querySelector('#sim-elo-a').value) || 1500;
            const eloB = parseFloat(container.querySelector('#sim-elo-b').value) || 1500;
            const gA = parseInt(container.querySelector('#sim-goals-a').value, 10) || 0;
            const gB = parseInt(container.querySelector('#sim-goals-b').value, 10) || 0;
            const isAnomalyA = container.querySelector('#sim-anomaly-a').checked;
            const leagueVal = container.querySelector('#sim-league').value;

            const statsExpA = 1.0 / (1.0 + Math.pow(10, (eloB - eloA) / 400.0));
            const statsActualA = gA > gB ? 1.0 : (gA < gB ? 0.0 : 0.5);
            const statsDeltaA = Math.round(30.0 * (statsActualA - statsExpA) * 10) / 10;
            const statsDeltaB = -statsDeltaA;

            const proRes = ProEloEngine.calculateMatch(eloA, eloB, gA, gB, {
                isHomeA: true,
                leagueName: leagueVal,
                lineupAvgAgeA: isAnomalyA ? 17.5 : 26.0
            });

            const resultsContainer = container.querySelector('#sim-results');
            resultsContainer.innerHTML = `
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
                    <!-- Statsxente Sonucu -->
                    <div style="background: #1e293b; padding: 14px; border-radius: 8px; border: 1px solid #475569;">
                        <b style="color: #94a3b8; font-size: 12px;">📊 STATSXENTE HESABI</b>
                        <div style="margin-top: 8px; font-size: 13px;">
                            Takım A Değişimi: <b style="color: ${statsDeltaA >= 0 ? '#4ade80' : '#f87171'}">${statsDeltaA >= 0 ? '+' : ''}${statsDeltaA}</b><br>
                            Takım B Değişimi: <b style="color: ${statsDeltaB >= 0 ? '#4ade80' : '#f87171'}">${statsDeltaB >= 0 ? '+' : ''}${statsDeltaB}</b>
                        </div>
                        <div style="font-size: 11px; color: #64748b; margin-top: 8px; line-height: 1.4;">
                            ❌ Gol farkı tavanı yok (Aşırı puan şişer)<br>
                            ❌ As kadro kazasını algılayamaz
                        </div>
                    </div>

                    <!-- Pro-ELO Sonucu -->
                    <div style="background: rgba(129, 140, 248, 0.1); padding: 14px; border-radius: 8px; border: 1px solid #818cf8;">
                        <b style="color: #facc15; font-size: 12px;">✨ PRO-ELO (BİZİMKİ)</b>
                        <div style="margin-top: 8px; font-size: 13px;">
                            Takım A Değişimi: <b style="color: ${proRes.deltaA >= 0 ? '#4ade80' : '#f87171'}">${proRes.deltaA >= 0 ? '+' : ''}${proRes.deltaA}</b><br>
                            Takım B Değişimi: <b style="color: ${proRes.deltaB >= 0 ? '#4ade80' : '#f87171'}">${proRes.deltaB >= 0 ? '+' : ''}${proRes.deltaB}</b>
                        </div>
                        <div style="font-size: 11px; color: #c7d2fe; margin-top: 8px; line-height: 1.4;">
                            ✔️ Anti-farma ve lig zorluk çarpanı aktif<br>
                            ${proRes.anomalyNoteA ? `<b style="color: #fca5a5;">${proRes.anomalyNoteA}</b>` : '✔️ As kadro onaylandı'}
                        </div>
                    </div>
                </div>
            `;
        }

        container.querySelector('#sim-calculate-btn').onclick = runSim;
        runSim();
    }

    // =========================================================================
    // 6. SAYFA YÜKLENME TETİKLEYİCİSİ
    // =========================================================================
    const urlParams = new URLSearchParams(window.location.search);
    const p = urlParams.get('p');

    injectFloatingLabButton();

    if (p === 'team' || p === 'profile') {
        renderTeamPageComparison();
    }
})();

