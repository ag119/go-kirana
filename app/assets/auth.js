/* ==========================================================================
   Go-Kirana Staff Console — auth overlay + session guard
   Shared by the shell across all 3 internal tools (Agent Hub, Admin,
   Record Order). Login happens once here; every view just calls GK.api
   which already carries the session token.
   ========================================================================== */
(function (global) {
    'use strict';

    function showOverlay() {
        document.getElementById('login-overlay').style.display = 'flex';
    }

    function hideOverlay() {
        document.getElementById('login-overlay').style.display = 'none';
    }

    async function executeLogin() {
        const u = document.getElementById('loginUsername').value.trim();
        const p = document.getElementById('loginPassword').value.trim();
        const btn = document.getElementById('loginSubmitBtn');
        const err = document.getElementById('login-error-msg');

        if (!u || !p) {
            err.innerText = 'Please enter both username and password.';
            err.style.display = 'block';
            return;
        }

        btn.disabled = true;
        btn.innerText = '⏳ Verifying...';
        err.style.display = 'none';

        try {
            await GK.api.login(u, p);
            hideOverlay();
            document.dispatchEvent(new CustomEvent('gk:login'));
        } catch (e) {
            err.innerText = e.message || 'Authentication error. Please check connection.';
            err.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerText = '🔓 Sign In';
        }
    }

    function logout() {
        GK.api.logout();
        location.hash = '';
        location.reload();
    }

    // Returns true if logged in (and hides the overlay); otherwise shows
    // the overlay and returns false. Call this before rendering any route.
    function guard() {
        if (GK.api.isLoggedIn()) {
            hideOverlay();
            return true;
        }
        showOverlay();
        return false;
    }

    function init() {
        document.getElementById('loginSubmitBtn').addEventListener('click', executeLogin);
        document.getElementById('loginPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeLogin();
        });
        document.getElementById('loginUsername').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeLogin();
        });
    }

    global.GK = global.GK || {};
    global.GK.auth = { init, guard, logout };
})(window);
