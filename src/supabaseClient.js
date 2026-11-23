// =====================================================================
// SUPABASE REST İSTEMCİSİ (Sıfır Bağımlılık - Native Fetch)
// =====================================================================

const fs = require('fs');
const path = require('path');
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
            const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
        });
    }
} catch (e) {}

function getSupabaseUrl() {
    return (process.env.SUPABASE_URL || 'https://bggydqalllytcqwxsypj.supabase.co').replace(/\/+$/, '');
}

const SUPABASE_URL = getSupabaseUrl();

function getSupabaseKey() {
    return process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_KEY || '';
}

function assertEnv() {
    if (!getSupabaseUrl() || !getSupabaseKey()) {
        throw new Error('Eksik ortam değişkeni: SUPABASE_URL ve SUPABASE_SERVICE_KEY tanımlanmalıdır.');
    }
}

function getHeaders(extra = {}) {
    const key = getSupabaseKey();
    return {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, opts = {}, retries = 3) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, opts);
            if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
                return res;
            }
            lastErr = new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        } catch (err) {
            lastErr = err;
        }
        if (i < retries) await sleep(800 * (i + 1));
    }
    throw lastErr;
}

async function upsertTeams(rows) {
    assertEnv();
    if (!rows.length) return;
    const chunkSize = 300;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_teams?on_conflict=tid`, {
            method: 'POST',
            headers: getHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
            body: JSON.stringify(chunk)
        });
        if (!res.ok) {
            throw new Error(`upsertTeams hatası (${res.status}): ${await res.text()}`);
        }
    }
}

async function insertMissingTeams(rows) {
    assertEnv();
    if (!rows.length) return;
    const chunkSize = 300;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_teams?on_conflict=tid`, {
            method: 'POST',
            headers: getHeaders({ 'Prefer': 'resolution=ignore-duplicates,return=minimal' }),
            body: JSON.stringify(chunk)
        });
        if (!res.ok) {
            throw new Error(`insertMissingTeams hatası (${res.status}): ${await res.text()}`);
        }
    }
}

async function fetchTeamsByTids(tids) {
    assertEnv();
    const map = new Map();
    const unique = Array.from(new Set(tids.map(Number).filter(Boolean)));
    const chunkSize = 150;
    for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_teams?tid=in.(${chunk.join(',')})&select=*`, {
            headers: getHeaders()
        });
        if (!res.ok) {
            throw new Error(`fetchTeamsByTids hatası (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        data.forEach(r => map.set(Number(r.tid), r));
    }
    return map;
}

async function fetchAllTeamsBasic() {
    assertEnv();
    const all = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_teams?select=tid,name,country,senior_elo,u23_elo,u21_elo,u18_elo,senior_matches,last_scanned_at&order=tid.asc&limit=${pageSize}&offset=${offset}`, {
            headers: getHeaders()
        });
        if (!res.ok) {
            throw new Error(`fetchAllTeamsBasic hatası (${res.status}): ${await res.text()}`);
        }
        const rows = await res.json();
        all.push(...rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
    }
    return all;
}

async function fetchNextTeamsToScan(limit = 300) {
    assertEnv();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_teams?select=*&order=last_scanned_at.asc.nullsfirst&limit=${limit}`, {
        headers: getHeaders()
    });
    if (!res.ok) {
        throw new Error(`fetchNextTeamsToScan hatası (${res.status}): ${await res.text()}`);
    }
    return await res.json();
}

async function fetchProcessedMids(mids) {
    assertEnv();
    const set = new Set();
    const unique = Array.from(new Set(mids.map(Number).filter(Boolean)));
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_processed_matches?mid=in.(${chunk.join(',')})&select=mid`, {
            headers: getHeaders()
        });
        if (!res.ok) {
            throw new Error(`fetchProcessedMids hatası (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        data.forEach(r => set.add(Number(r.mid)));
    }
    return set;
}

async function insertProcessedMatches(rows) {
    assertEnv();
    if (!rows.length) return;
    const chunkSize = 400;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_processed_matches?on_conflict=mid`, {
            method: 'POST',
            headers: getHeaders({ 'Prefer': 'resolution=ignore-duplicates,return=minimal' }),
            body: JSON.stringify(chunk)
        });
        if (!res.ok) {
            throw new Error(`insertProcessedMatches hatası (${res.status}): ${await res.text()}`);
        }
    }
}

// ---- Bağımsız Model (v2) Yardımcıları ----
async function fetchIndProcessedMids(mids) {
    assertEnv();
    const set = new Set();
    const unique = Array.from(new Set(mids.map(Number).filter(Boolean)));
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_ind_matches?mid=in.(${chunk.join(',')})&select=mid`, {
            headers: getHeaders()
        });
        if (!res.ok) {
            throw new Error(`fetchIndProcessedMids hatası (${res.status}): ${await res.text()}`);
        }
        const data = await res.json();
        data.forEach(r => set.add(Number(r.mid)));
    }
    return set;
}

async function insertIndMatches(rows) {
    assertEnv();
    if (!rows.length) return;
    const chunkSize = 300;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_ind_matches?on_conflict=mid`, {
            method: 'POST',
            headers: getHeaders({ 'Prefer': 'resolution=ignore-duplicates,return=minimal' }),
            body: JSON.stringify(chunk)
        });
        if (!res.ok) {
            throw new Error(`insertIndMatches hatası (${res.status}): ${await res.text()}`);
        }
    }
}

async function fetchMeta() {
    assertEnv();
    const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_meta?select=key,value`, {
        headers: getHeaders()
    });
    if (!res.ok) {
        throw new Error(`fetchMeta hatası (${res.status}): ${await res.text()}`);
    }
    const rows = await res.json();
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
}

async function upsertMeta(entries) {
    assertEnv();
    const nowIso = new Date().toISOString();
    const rows = Object.entries(entries).map(([key, value]) => ({
        key,
        value: String(value),
        updated_at: nowIso
    }));
    if (!rows.length) return;
    const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/mz_meta?on_conflict=key`, {
        method: 'POST',
        headers: getHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows)
    });
    if (!res.ok) {
        throw new Error(`upsertMeta hatası (${res.status}): ${await res.text()}`);
    }
}

async function cleanupOldMatches() {
    assertEnv();
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_old_mz_matches`, {
        method: 'POST',
        headers: getHeaders(),
        body: '{}'
    }).catch(() => {});
}

function getMzSeasonInfo(date = new Date()) {
    const baseDate = new Date('2026-09-29T00:00:00Z');
    const targetDate = new Date(date.toISOString().split('T')[0] + 'T00:00:00Z');
    const dayDiff = Math.round((targetDate - baseDate) / 86400000);
    const season = 100 + Math.floor(dayDiff / 91);
    const day = ((dayDiff % 91) + 91) % 91 + 1;
    const week = Math.floor((day - 1) / 7) + 1;
    const remainingDays = 91 - day;
    const seasonStartDate = new Date(targetDate.getTime() - ((day - 1) * 86400000));
    return { season, week, day, remainingDays, seasonStartDate };
}

async function archiveAndPruneOldMatches(meta = {}) {
    assertEnv();
    const sInfo = getMzSeasonInfo();
    const seasonStart = sInfo.seasonStartDate;
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000);

    // KORUMA: "Bu Sezon" (91 gün) ve "Son 2 Ay" (60 gün) maçlarını asla silme!
    // Cutoff: seasonStart ve sixtyDaysAgo arasından DAHA ESKİ olanı seçilir.
    const cutoffDate = seasonStart < sixtyDaysAgo ? seasonStart : sixtyDaysAgo;
    const cutoffY = cutoffDate.getFullYear();
    const cutoffM = String(cutoffDate.getMonth() + 1).padStart(2, '0');
    const cutoffD = String(cutoffDate.getDate()).padStart(2, '0');
    const cutoffStr = `${cutoffY}-${cutoffM}-${cutoffD} 00:00`;

    try {
        const countRes = await fetch(`${SUPABASE_URL}/rest/v1/mz_ind_matches?played_at=lt.${encodeURIComponent(cutoffStr)}&select=mid`, {
            headers: getHeaders({ 'Prefer': 'count=exact', 'Range-Unit': 'items' })
        });
        const range = countRes.headers.get('content-range');
        const match = range ? range.match(/\/(\d+)/) : null;
        const toDeleteCount = match ? parseInt(match[1], 10) : 0;

        if (toDeleteCount > 0) {
            console.log(`[Arşiv] ${cutoffStr} öncesine ait ${toDeleteCount} eski sezon maçı siliniyor ve arşive aktarılıyor...`);
            const delRes = await fetch(`${SUPABASE_URL}/rest/v1/mz_ind_matches?played_at=lt.${encodeURIComponent(cutoffStr)}`, {
                method: 'DELETE',
                headers: getHeaders({ 'Prefer': 'return=minimal' })
            });
            if (delRes.ok) {
                const currentArchived = parseInt(meta.archived_matches_count || '0', 10);
                const newArchived = currentArchived + toDeleteCount;
                await upsertMeta({ archived_matches_count: String(newArchived) });
                console.log(`[Arşiv] ✅ ${toDeleteCount} maç arşivlendi. Toplam arşivlenmiş maç: ${newArchived}`);
                return toDeleteCount;
            }
        }
    } catch (err) {
        console.error('[Arşiv Hatası]', err);
    }
    return 0;
}

module.exports = {
    upsertTeams,
    insertMissingTeams,
    fetchTeamsByTids,
    fetchAllTeamsBasic,
    fetchNextTeamsToScan,
    fetchProcessedMids,
    insertProcessedMatches,
    fetchIndProcessedMids,
    insertIndMatches,
    fetchMeta,
    upsertMeta,
    cleanupOldMatches,
    archiveAndPruneOldMatches,
    getMzSeasonInfo
};
