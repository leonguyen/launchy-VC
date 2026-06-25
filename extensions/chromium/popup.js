let serverUrl = '';
let token = '';
let selectedWidgetId = null;
let currentTab = null;

const $ = id => document.getElementById(id);

async function init() {
  try {
    const stored = await chrome.storage.local.get(['serverUrl', 'token']);
    serverUrl = stored.serverUrl || '';
    token = stored.token || '';

    if (serverUrl && token) {
      try {
        await apiFetch('/auth/me');
        await showMainView();
        return;
      } catch {
        token = '';
        await chrome.storage.local.remove('token');
      }
    }

    showLoginView(stored.serverUrl || 'http://localhost:3080');
  } catch (err) {
    console.error('Launchy init error:', err);
    showLoginView('http://localhost:3080');
  }
}

function showLoginView(defaultUrl) {
  $('login-view').style.display = '';
  $('main-view').style.display = 'none';
  $('server-url').value = defaultUrl || '';
  $('login-error').classList.remove('show');
}

async function showMainView() {
  $('login-view').style.display = 'none';
  $('main-view').style.display = '';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];

    if (currentTab) {
      $('tab-title').textContent = currentTab.title || 'Sans titre';
      $('tab-url').textContent = currentTab.url || '';
      const favicon = $('tab-favicon');
      if (currentTab.favIconUrl) {
        favicon.src = currentTab.favIconUrl;
        favicon.onerror = () => { favicon.src = 'icons/icon-48.png'; };
      } else {
        favicon.src = 'icons/icon-48.png';
      }
    }
  } catch (err) {
    console.error('Tab query error:', err);
  }

  await loadDashboard();
}

async function loadDashboard() {
  const tree = $('widget-tree');
  tree.innerHTML = '<div class="loading">Chargement...</div>';

  try {
    const pages = await apiFetch('/dashboard');
    let html = '';
    let hasWidgets = false;

    for (const page of pages) {
      const bookmarkWidgets = [];
      for (const col of (page.columns || [])) {
        for (const w of (col.widgets || [])) {
          if (w.type === 'bookmarks') {
            const bmCount = w.bookmarks ? w.bookmarks.length : 0;
            bookmarkWidgets.push({ id: w.id, title: w.title, count: bmCount });
          }
        }
      }

      if (bookmarkWidgets.length === 0) continue;
      hasWidgets = true;

      html += '<div class="page-group">';
      html += '<div class="page-title">' + esc(page.title) + '</div>';
      for (const w of bookmarkWidgets) {
        html += '<div class="widget-item" data-widget-id="' + w.id + '">' +
          '<span class="widget-item-icon">&#9733;</span>' +
          '<span class="widget-item-name">' + esc(w.title) + '</span>' +
          '<span class="widget-item-count">' + w.count + '</span>' +
          '</div>';
      }
      html += '</div>';
    }

    if (!hasWidgets) {
      tree.innerHTML = '<div class="no-widgets">Aucun widget favoris trouve</div>';
      return;
    }

    tree.innerHTML = html;

    tree.querySelectorAll('.widget-item').forEach(el => {
      el.addEventListener('click', () => {
        tree.querySelectorAll('.widget-item').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        selectedWidgetId = parseInt(el.dataset.widgetId);
        $('add-btn').disabled = false;
      });
    });

  } catch (err) {
    tree.innerHTML = '<div class="no-widgets">Erreur : ' + esc(err.message) + '</div>';
  }
}

async function addBookmark() {
  if (!selectedWidgetId || !currentTab) return;

  const btn = $('add-btn');
  const status = $('status-msg');
  btn.disabled = true;
  btn.textContent = 'Ajout en cours...';
  status.className = 'status-msg';
  status.style.display = 'none';

  try {
    await apiFetch('/widgets/' + selectedWidgetId + '/bookmarks', {
      method: 'POST',
      body: {
        title: currentTab.title || currentTab.url,
        url: currentTab.url,
        icon: ''
      }
    });

    status.textContent = 'Favori ajoute avec succes !';
    status.className = 'status-msg show success';
    btn.textContent = 'Ajoute !';

    setTimeout(() => window.close(), 1500);

  } catch (err) {
    status.textContent = 'Erreur : ' + err.message;
    status.className = 'status-msg show error';
    btn.disabled = false;
    btn.textContent = 'Ajouter le favori';
  }
}

async function apiFetch(path, opts) {
  opts = opts || {};
  const url = serverUrl.replace(/\/+$/, '') + '/api' + path;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  if (res.status === 401) {
    token = '';
    await chrome.storage.local.remove('token');
    showLoginView(serverUrl);
    throw new Error('Session expiree');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erreur serveur');
  return data;
}

function esc(str) {
  if (!str) return '';
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

document.addEventListener('DOMContentLoaded', function() {
  $('login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var error = $('login-error');
    error.classList.remove('show');

    var btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Connexion...';

    serverUrl = $('server-url').value.replace(/\/+$/, '');
    var username = $('login-user').value.trim();
    var password = $('login-pass').value;

    try {
      var data = await apiFetch('/auth/login', {
        method: 'POST',
        body: { username: username, password: password }
      });

      token = data.token;
      await chrome.storage.local.set({ serverUrl: serverUrl, token: token });
      await showMainView();

    } catch (err) {
      error.textContent = err.message;
      error.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Se connecter';
    }
  });

  $('logout-btn').addEventListener('click', async function() {
    token = '';
    await chrome.storage.local.remove('token');
    showLoginView(serverUrl);
  });

  $('add-btn').addEventListener('click', addBookmark);

  init();
});
