/**
 * ============================================================
 * Beer POS Pro — Login Page Logic
 * Binance Design System v2.0
 * ============================================================
 * Features:
 * - Enter key → login
 * - Autofocus username
 * - Remember username (localStorage)
 * - Loading state with spinner
 * - Error state (only on submit fail)
 * ============================================================
 */
(function () {
  'use strict';

  var USERNAME_KEY = 'beer_login_username';
  var SESSION_KEY  = 'beer_session_token';
  var AUTH_UID_KEY = 'auth_uid';

  // ── DOM References ───────────────────────────────────────
  var formEl      = document.getElementById('loginForm');
  var usernameEl  = document.getElementById('username');
  var passwordEl  = document.getElementById('password');
  var submitBtn   = document.getElementById('submitBtn');
  var errorEl     = document.getElementById('errorMsg');
  var rememberEl   = document.getElementById('rememberMe');

  // ── Autofocus username on load ───────────────────────────
  if (usernameEl) {
    // Small delay ensures page is painted before focus
    setTimeout(function () { usernameEl.focus(); }, 120);
  }

  // ── Restore remembered username ───────────────────────────
  if (usernameEl && rememberEl) {
    var savedUsername = localStorage.getItem(USERNAME_KEY);
    if (savedUsername) {
      usernameEl.value = savedUsername;
      rememberEl.checked = true;
    }
  }

  // ── Already logged in? Verify and redirect ────────────────
  (async function checkSession() {
    var token = localStorage.getItem(SESSION_KEY);
    if (!token) return;

    try {
      var res = await fetch('/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token },
        credentials: 'include'
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
    } catch (_) {}
    // Token invalid or expired — clear it
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(AUTH_UID_KEY);
  })();

  // ── Clear error state on input ───────────────────────────
  function clearError() {
    if (errorEl) {
      errorEl.classList.remove('is-visible');
      errorEl.textContent = '';
    }
    if (usernameEl) usernameEl.classList.remove('is-error');
    if (passwordEl) passwordEl.classList.remove('is-error');
  }

  if (usernameEl) {
    usernameEl.addEventListener('input', clearError);
    usernameEl.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') { passwordEl && passwordEl.focus(); }
    });
  }

  if (passwordEl) {
    passwordEl.addEventListener('input', clearError);
    passwordEl.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        formEl && formEl.dispatchEvent(new Event('submit'));
      }
    });
  }

  // ── Set loading state ────────────────────────────────────
  function setLoading(loading) {
    if (!submitBtn) return;
    if (loading) {
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<div class="login-spinner"></div><span>Đang đăng nhập...</span>';
    } else {
      submitBtn.disabled = false;
      submitBtn.innerHTML =
        '<span>Đăng nhập</span>';
    }
  }

  // ── Show error state ────────────────────────────────────
  function showError(msg) {
    if (!errorEl) return;
    errorEl.innerHTML =
      '<span class="login-error-icon">⚠️</span><span>' + msg + '</span>';
    errorEl.classList.add('is-visible');
    // Shake inputs for visual feedback
    if (usernameEl) usernameEl.classList.add('is-error');
    if (passwordEl) passwordEl.classList.add('is-error');
  }

  // ── Handle login submit ─────────────────────────────────
  async function handleLogin(e) {
    e.preventDefault();

    var username = usernameEl ? usernameEl.value.trim() : '';
    var password = passwordEl ? passwordEl.value : '';

    if (!username) {
      showError('Vui lòng nhập tên đăng nhập');
      usernameEl && usernameEl.focus();
      return;
    }
    if (!password) {
      showError('Vui lòng nhập mật khẩu');
      passwordEl && passwordEl.focus();
      return;
    }

    clearError();
    setLoading(true);

    try {
      var res = await fetch('/auth/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: username, password: password })
      });

      var data = await res.json();

      if (res.status === 429) {
        showError('Quá nhiều yêu cầu. Vui lòng đợi khoảng 15 phút rồi thử lại.');
        setLoading(false);
        return;
      }

      if (data.success) {
        // Remember username?
        if (rememberEl && rememberEl.checked) {
          localStorage.setItem(USERNAME_KEY, username);
        } else {
          localStorage.removeItem(USERNAME_KEY);
        }

        // Store token
        if (data.token) {
          localStorage.setItem(SESSION_KEY, data.token);
        }
        localStorage.setItem(AUTH_UID_KEY, '1');

        // Redirect
        window.location.href = data.redirect || '/';
      } else {
        showError(data.error || 'Tên đăng nhập hoặc mật khẩu không đúng.');
        setLoading(false);
        // Focus password so user can retry
        passwordEl && passwordEl.focus();
        passwordEl && passwordEl.select();
      }
    } catch (err) {
      showError('Lỗi kết nối. Vui lòng kiểm tra mạng và thử lại.');
      setLoading(false);
    }
  }

  if (formEl) {
    formEl.addEventListener('submit', handleLogin);
  }

  // ── Register Service Worker ───────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) {
        var swVer = (typeof window !== 'undefined' && window.APP_VERSION)
          ? window.APP_VERSION
          : Date.now();
        navigator.serviceWorker.register('/sw.js?v=' + swVer)
          .catch(function (e) { console.log('[SW] Register failed:', e.message); });
      }
    });
  }

})();
