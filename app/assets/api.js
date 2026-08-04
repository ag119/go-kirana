/* ==========================================================================
   Go-Kirana Staff Console — API layer
   Talks only to the Apps Script Web App below. The Sheet ID never appears
   here or anywhere else in browser-visible code — it lives server-side in
   apps-script/Code.gs. All data reads/writes require a valid session token.
   ========================================================================== */
(function (global) {
    'use strict';

    // Deployed Apps Script Web App /exec URL. Not secret (it's just an
    // endpoint) — every action except 'login' requires a valid session token.
    const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycby8S-xJfePRaCezAlM8onrl5FOSq4VC1l_JS0_pBwdznIM2NV1uwy2hgeGXbqAomsgYUA/exec';

    const SESSION_KEY = 'gk_session';

    function getSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const session = JSON.parse(raw);
            if (!session || !session.token || !session.expiresAt) return null;
            if (Date.now() >= session.expiresAt) {
                localStorage.removeItem(SESSION_KEY);
                return null;
            }
            return session;
        } catch (e) {
            return null;
        }
    }

    function setSession(session) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    function clearSession() {
        localStorage.removeItem(SESSION_KEY);
    }

    // Sheet-data cache: switching between Agent Hub / Admin / Record Order
    // used to re-fetch Customers/Orders/Order Details/Products from Apps
    // Script on every single navigation. Cache each sheet in localStorage
    // for CACHE_TTL_MS so tab-switching reuses recent data instead of
    // re-syncing; the shell's Refresh button passes {force:true} to bypass it.
    const CACHE_PREFIX = 'gk_cache_';
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    function readCache(key) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (!entry || entry.ts === undefined || Date.now() - entry.ts > CACHE_TTL_MS) return null;
            return entry;
        } catch (e) {
            return null;
        }
    }

    function writeCache(key, data) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
        } catch (e) {
            // localStorage full/unavailable — caching is best-effort, ignore
        }
    }

    function clearCache() {
        Object.keys(localStorage)
            .filter(k => k.startsWith(CACHE_PREFIX))
            .forEach(k => localStorage.removeItem(k));
    }

    // Apps Script Web Apps have real concurrency/cold-start limits — under
    // load a request can fail outright (fetch throws) or come back as an
    // HTML error page instead of JSON (res.json() throws). Read-only
    // actions are safe to silently retry a couple of times with backoff;
    // writes are NOT retried here since a lost response doesn't mean the
    // write didn't happen server-side — blindly retrying could double it.
    const RETRYABLE_ACTIONS = new Set(['getSheet', 'getSheets', 'getDraftOrders', 'getAgentList']);
    const RETRY_DELAYS_MS = [500, 1500];

    async function callOnce(payload) {
        const res = await fetch(WEB_APP_URL, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data && data.code === 'AUTH_REQUIRED') {
            clearSession();
        }
        return data;
    }

    async function call(payload) {
        if (!RETRYABLE_ACTIONS.has(payload.action)) {
            return callOnce(payload);
        }

        let lastErr;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await callOnce(payload);
            } catch (err) {
                lastErr = err;
                if (attempt < RETRY_DELAYS_MS.length) {
                    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
                }
            }
        }
        throw lastErr;
    }

    async function login(username, password) {
        const data = await call({ action: 'login', username, password });
        if (data && data.status === 'success' && data.token) {
            setSession({ token: data.token, user: username, role: data.role || 'agent', expiresAt: data.expiresAt });
            return true;
        }
        throw new Error((data && data.message) || 'Invalid username or password.');
    }

    function logout() {
        clearSession();
    }

    function requireToken() {
        const session = getSession();
        if (!session) throw new Error('Not logged in.');
        return session.token;
    }

    // Returns rows in the same shape the old gviz JSONP fetch produced:
    // an array of { columnHeader: value, ... } objects. Pass {force:true}
    // to bypass the cache (used by the shell's Refresh button).
    async function getSheet(sheetName, opts) {
        const cacheKey = 'sheet:' + sheetName;
        if (!(opts && opts.force)) {
            const cached = readCache(cacheKey);
            if (cached) return cached.data;
        }

        const token = requireToken();
        const data = await call({ action: 'getSheet', token, sheet: sheetName });
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || `Failed to load "${sheetName}"`);
        }
        writeCache(cacheKey, data.rows || []);
        return data.rows || [];
    }

    // Fetch several tabs in one round trip.
    async function getSheets(sheetNames, opts) {
        const cacheKey = 'sheets:' + sheetNames.slice().sort().join(',');
        if (!(opts && opts.force)) {
            const cached = readCache(cacheKey);
            if (cached) return cached.data;
        }

        const token = requireToken();
        const data = await call({ action: 'getSheets', token, sheets: sheetNames });
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to load sheet data');
        }
        writeCache(cacheKey, data.data || {});
        // Also populate each sheet's own single-sheet cache entry, so a
        // later plain getSheet(name) call (e.g. a one-off refresh) can
        // reuse this batch instead of re-fetching it alone.
        Object.keys(data.data || {}).forEach(name => writeCache('sheet:' + name, data.data[name]));
        return data.data || {};
    }

    async function createOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'createOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to record order.');
        }
        clearCache(); // Orders/Order Details/Customers stats just changed server-side
        return data;
    }

    // Draft Orders: frequently-mutated, multi-user data, so this always
    // hits the network — a stale localStorage cache here would actively
    // mislead (e.g. admin deletes a draft, agent's view stays wrong for
    // up to CACHE_TTL_MS).
    async function getDraftOrders() {
        const token = requireToken();
        const data = await call({ action: 'getDraftOrders', token });
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to load draft orders.');
        }
        return data.rows || [];
    }

    async function createDraftOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'createDraftOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to save draft order.');
        }
        clearCache();
        return data;
    }

    async function updateDraftOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'updateDraftOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to update draft order.');
        }
        clearCache();
        return data;
    }

    async function deleteDraftOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'deleteDraftOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to delete draft order.');
        }
        clearCache();
        return data;
    }

    async function submitDraftOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'submitDraftOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to finalize order.');
        }
        clearCache(); // Orders/Order Details/Customers stats just changed server-side
        return data;
    }

    async function reassignDraftOrder(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'reassignDraftOrder', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to reassign order.');
        }
        clearCache();
        return data;
    }

    // Not cached — the agent list is tiny and this keeps the "Assign To"
    // picker simple; never includes passwords (unlike a raw
    // getSheet('AgentCreds') would), see handleGetAgentList_ in Code.gs.
    async function getAgentList() {
        const token = requireToken();
        const data = await call({ action: 'getAgentList', token });
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to load agent list.');
        }
        return data.agents || [];
    }

    async function addInventoryStock(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'addInventoryStock', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to add inventory stock.');
        }
        clearCache();
        return data;
    }

    async function bulkAddInventoryStock(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'bulkAddInventoryStock', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to submit inventory list.');
        }
        clearCache();
        return data;
    }

    async function updateInventoryItem(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'updateInventoryItem', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to update inventory item.');
        }
        clearCache();
        return data;
    }

    async function deleteInventoryItem(payload) {
        const token = requireToken();
        const data = await call(Object.assign({ action: 'deleteInventoryItem', token }, payload));
        if (!data || data.status !== 'success') {
            throw new Error((data && data.message) || 'Failed to delete inventory item.');
        }
        clearCache();
        return data;
    }

    global.GK = global.GK || {};
    global.GK.api = {
        login,
        logout,
        getSheet,
        getSheets,
        createOrder,
        getDraftOrders,
        createDraftOrder,
        updateDraftOrder,
        deleteDraftOrder,
        submitDraftOrder,
        reassignDraftOrder,
        getAgentList,
        addInventoryStock,
        bulkAddInventoryStock,
        updateInventoryItem,
        deleteInventoryItem,
        isLoggedIn: () => !!getSession(),
        currentUser: () => (getSession() || {}).user || null,
        currentRole: () => (getSession() || {}).role || 'agent'
    };
})(window);
