// =====================================================================
// SUPABASE REST İSTEMCİSİ (Sıfır Bağımlılık - Native Fetch)
// =====================================================================

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function assertEnv() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Eksik ortam değişkeni: SUPABASE_URL ve SUPABASE_SERVICE_KEY tanımlanmalıdır.');
    }
}

function getHeaders(extra = {}) {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

async function upsertTeams(rows) {
    assertEnv();
    if (!rows.length) return;
    const chunkSize = 400;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_teams?on_conflict=tid`, {
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
    const chunkSize = 400;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_teams?on_conflict=tid`, {
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
        const res = await fetch(`${SUPABASE_URL}/rest/v1/mz_teams?tid=in.(${chunk.join(',')})&select=*`, {
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

async function cleanupOldMatches() {
    assertEnv();
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_old_mz_matches`, {
        method: 'POST',
        headers: getHeaders(),
        body: '{}'
    }).catch(() => {});
}

module.exports = {
    upsertTeams,
    insertMissingTeams,
    fetchTeamsByTids,
    fetchNextTeamsToScan,
    fetchProcessedMids,
    insertProcessedMatches,
    cleanupOldMatches
};
