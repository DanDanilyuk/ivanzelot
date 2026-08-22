/* Static GitHub Pages editor. Ukrainian is the source of truth; Save writes
   the Ukrainian post and creates or updates the matching Latin-25 post.
   English is never written. A site password unwraps a GitHub token that was
   encrypted at build time from Actions secrets (never GitHub variables). */
(function () {
  'use strict';

  var root = document.querySelector('[data-admin]');
  if (!root) {
    document.body && document.body.insertAdjacentHTML('afterbegin', '<p>Admin markup missing.</p>');
    return;
  }

  var repo = root.getAttribute('data-repo');
  var branch = root.getAttribute('data-branch') || 'main';
  var TOKEN_KEY = 'ivanzelot-github-token';

  var loginPanel = root.querySelector('[data-login]');
  var shell = root.querySelector('[data-shell]');
  var passwordInput = root.querySelector('[data-password]');
  var statusEl = root.querySelector('[data-status]');
  var listEl = root.querySelector('[data-list]');
  var searchEl = root.querySelector('[data-search]');
  var pathEl = root.querySelector('[data-path]');
  var numberEl = root.querySelector('[data-number]');
  var editsEl = root.querySelector('[data-edits]');
  var bodyEl = root.querySelector('[data-body]');
  var saveBtn = root.querySelector('[data-save]');
  var newBtn = root.querySelector('[data-new]');
  var logoutBtn = root.querySelector('[data-logout]');
  var loginBtn = root.querySelector('[data-login-btn]');

  var posts = [];
  var current = null;
  var latinMap = null;
  var saving = false;
  var loggingIn = false;

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'admin-status' + (kind ? ' is-' + kind : '');
    statusEl.classList.toggle('hidden', !msg);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token(),
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + repo + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
          throw new Error(msg);
        }
        return data;
      }, function () {
        throw new Error('HTTP ' + res.status);
      });
    });
  }

  function b64ToBytes(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function unlockToken(password, lock) {
    var enc = new TextEncoder();
    var salt = b64ToBytes(lock.salt);
    var iv = b64ToBytes(lock.iv);
    var tag = b64ToBytes(lock.tag);
    var data = b64ToBytes(lock.ciphertext);
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (material) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: lock.iterations, hash: 'SHA-256' },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
      })
      .then(function (key) {
        var buf = new Uint8Array(data.length + tag.length);
        buf.set(data, 0);
        buf.set(tag, data.length);
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, key, buf);
      })
      .then(function (plain) {
        return new TextDecoder().decode(plain);
      });
  }

  function decodeUtf8(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parsePost(raw) {
    var m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { number: '', edits: '', images: [], body: raw };
    var fm = m[1];
    var images = [];
    var imgBlock = fm.match(/^images:\n((?:  - .+\n?)*)/m);
    if (imgBlock) {
      imgBlock[1].split('\n').forEach(function (line) {
        var im = line.match(/^\s*-\s+(\S+)/);
        if (im) images.push(im[1]);
      });
    }
    return {
      number: (fm.match(/^number:\s*(\S+)/m) || [])[1] || '',
      edits: (fm.match(/^edits:\s*(\S+)/m) || [])[1] || '',
      images: images,
      body: m[2].replace(/^\n/, '').replace(/\n$/, '')
    };
  }

  function forEditor(body) {
    return body.replace(/&nbsp;/g, ' ');
  }

  function forSave(body) {
    return body.split('\n').map(function (line) {
      var m = line.match(/^( +)/);
      if (!m) return line;
      return '&nbsp;'.repeat(m[1].length) + line.slice(m[1].length);
    }).join('\n');
  }

  function serialize(kind, parsed, body) {
    var cats = kind === 'ukr' ? 'poems ukr' : 'poems latin_25';
    var out = '---\nlayout: post\nnumber: ' + parsed.number + '\nedits: ' + parsed.edits +
      '\ncategories: ' + cats + '\n';
    if (kind === 'ukr' && parsed.images && parsed.images.length) {
      out += 'images:\n';
      parsed.images.forEach(function (img) { out += '  - ' + img + '\n'; });
    }
    out += '---\n\n' + body.replace(/\s+$/, '') + '\n';
    return out;
  }

  function loadMap(rbText) {
    var map = {};
    var re = /'([^']+)'\s*=>\s*'([^']*)'/g;
    var m;
    while ((m = re.exec(rbText))) map[m[1]] = m[2];
    return map;
  }

  function toLatin(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      out += Object.prototype.hasOwnProperty.call(latinMap, c) ? latinMap[c] : c;
    }
    return out;
  }

  function numberFromPath(path) {
    var m = path.match(/\/\d{4}-\d{2}-\d{2}-(.+)-ukr\.md$/);
    return m ? m[1] : '';
  }

  function latinPathFromUkr(path) {
    return path.replace(/^ukr\/_posts\//, 'latin_25/_posts/').replace(/-ukr\.md$/, '-latin_25.md');
  }

  function todayStamp() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function renderList(filter) {
    var q = (filter || '').trim().toLowerCase();
    listEl.innerHTML = '';
    posts.forEach(function (p) {
      if (q && p.number.toLowerCase().indexOf(q) !== 0 && p.path.toLowerCase().indexOf(q) === -1) {
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = p.number;
      if (current && current.path === p.path) btn.className = 'is-current';
      btn.addEventListener('click', function () { openPost(p); });
      listEl.appendChild(btn);
    });
  }

  function fillForm(parsed, path, isNew) {
    current = {
      path: path,
      number: parsed.number,
      edits: parsed.edits,
      images: parsed.images || [],
      isNew: !!isNew
    };
    pathEl.textContent = path || '(новий)';
    numberEl.value = parsed.number;
    numberEl.readOnly = !isNew;
    editsEl.value = parsed.edits;
    bodyEl.value = forEditor(parsed.body || '');
    renderList(searchEl.value);
  }

  function openPost(p) {
    setStatus('Завантаження ' + p.number + '…');
    api('/contents/' + p.path + '?ref=' + encodeURIComponent(branch)).then(function (file) {
      var parsed = parsePost(decodeUtf8(file.content));
      fillForm(parsed, p.path, false);
      setStatus('');
    }).catch(function (err) {
      setStatus(err.message, 'error');
    });
  }

  function commitFiles(message, files) {
    return api('/git/ref/heads/' + encodeURIComponent(branch)).then(function (ref) {
      var commitSha = ref.object.sha;
      return api('/git/commits/' + commitSha).then(function (commit) {
        return api('/git/trees', {
          method: 'POST',
          body: {
            base_tree: commit.tree.sha,
            tree: files.map(function (f) {
              return { path: f.path, mode: '100644', type: 'blob', content: f.content };
            })
          }
        }).then(function (tree) {
          return api('/git/commits', {
            method: 'POST',
            body: { message: message, tree: tree.sha, parents: [commitSha] }
          });
        }).then(function (newCommit) {
          return api('/git/refs/heads/' + encodeURIComponent(branch), {
            method: 'PATCH',
            body: { sha: newCommit.sha }
          });
        });
      });
    });
  }

  function save() {
    if (saving) return;
    var number = numberEl.value.trim();
    var edits = editsEl.value.trim();
    var body = forSave(bodyEl.value);
    if (!number) {
      setStatus('Потрібен номер вірша.', 'error');
      return;
    }
    if (!/^\d+(-\d+)?$/.test(number)) {
      setStatus('Номер має бути як 809 або 111-1.', 'error');
      return;
    }
    if (!edits) {
      setStatus('Потрібна кількість правок (edits).', 'error');
      return;
    }
    if (!latinMap) {
      setStatus('Немає таблиці латинки-25. Оновіть сторінку і увійдіть знову.', 'error');
      return;
    }

    var parsed = {
      number: number,
      edits: edits,
      images: current && !current.isNew ? current.images : []
    };
    var ukrPath = (current && current.path && !current.isNew)
      ? current.path
      : 'ukr/_posts/' + todayStamp() + '-' + number + '-ukr.md';
    var existing = posts.find(function (p) { return p.number === number; });
    if (current && current.isNew && existing) {
      ukrPath = existing.path;
    }
    var latPath = latinPathFromUkr(ukrPath);
    var ukrFile = serialize('ukr', parsed, body);
    var latFile = serialize('latin_25', parsed, toLatin(body));

    saving = true;
    saveBtn.disabled = true;
    setStatus('Збереження ' + number + '…');

    commitFiles('Update poem ' + number, [
      { path: ukrPath, content: ukrFile },
      { path: latPath, content: latFile }
    ]).then(function () {
      if (!posts.some(function (p) { return p.path === ukrPath; })) {
        posts.push({ path: ukrPath, number: number });
        posts.sort(function (a, b) {
          return parseFloat(b.number) - parseFloat(a.number);
        });
      }
      fillForm(parsed, ukrPath, false);
      setStatus('Збережено ' + number + '. Latin-25 оновлено. Сайт збереться за хвилину-дві.', 'ok');
    }).catch(function (err) {
      setStatus(err.message, 'error');
    }).then(function () {
      saving = false;
      saveBtn.disabled = false;
    });
  }

  function newPoem() {
    fillForm({ number: '', edits: '1', images: [], body: '' }, '', true);
    numberEl.focus();
    setStatus('Новий вірш. Після збереження з’явиться українською і латинкою-25.');
  }

  function boot() {
    setStatus('Завантаження списку…');
    Promise.all([
      api('/git/trees/' + encodeURIComponent(branch) + '?recursive=1'),
      api('/contents/_tools/replacement.rb?ref=' + encodeURIComponent(branch))
    ]).then(function (pair) {
      var tree = pair[0];
      latinMap = loadMap(decodeUtf8(pair[1].content));
      posts = tree.tree
        .filter(function (t) {
          return t.type === 'blob' && /^ukr\/_posts\/.+-ukr\.md$/.test(t.path);
        })
        .map(function (t) { return { path: t.path, number: numberFromPath(t.path) }; })
        .sort(function (a, b) { return parseFloat(b.number) - parseFloat(a.number); });
      loginPanel.classList.add('hidden');
      shell.classList.remove('hidden');
      renderList('');
      setStatus('Віршів: ' + posts.length + '. Англійська в редакторі не змінюється.');
    }).catch(function (err) {
      setStatus('Не вдалося увійти: ' + err.message, 'error');
      sessionStorage.removeItem(TOKEN_KEY);
      loginPanel.classList.remove('hidden');
      shell.classList.add('hidden');
    });
  }

  function login() {
    if (loggingIn) return;
    var password = passwordInput.value;
    var lock = window.ADMIN_LOCK;
    if (!lock) {
      setStatus('Редактор не налаштовано: у збірці немає пароля (GitHub Secrets).', 'error');
      return;
    }
    if (!password) {
      setStatus('Введіть пароль.', 'error');
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      setStatus('Потрібен HTTPS і сучасний браузер (Web Crypto).', 'error');
      return;
    }
    loggingIn = true;
    loginBtn.disabled = true;
    setStatus('Перевірка пароля… це може зайняти кілька секунд.');
    // Let the status line paint before PBKDF2 blocks the main thread.
    window.setTimeout(function () {
      unlockToken(password, lock).then(function (t) {
        sessionStorage.setItem(TOKEN_KEY, t);
        passwordInput.value = '';
        setStatus('Пароль прийнято. Завантаження віршів…', 'ok');
        boot();
      }).catch(function (err) {
        var msg = (err && err.message) ? String(err.message) : '';
        if (/operation-specific|OperationError|decrypt/i.test(msg) || !msg) {
          setStatus('Невірний пароль.', 'error');
        } else {
          setStatus('Помилка входу: ' + msg, 'error');
        }
      }).then(function () {
        loggingIn = false;
        loginBtn.disabled = false;
      });
    }, 50);
  }

  window.adminLogin = login;

  var loginForm = root.querySelector('[data-login-form]');
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopPropagation();
      login();
    });
    // Password managers often call HTMLFormElement.submit(), which does not
    // fire a submit event and would reload /admin/.
    loginForm.submit = function () {
      login();
    };
  }
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.getAttribute && e.target.hasAttribute('data-login-form')) {
      e.preventDefault();
      e.stopPropagation();
      login();
    }
  }, true);
  loginBtn.addEventListener('click', function (e) {
    e.preventDefault();
    login();
  });

  logoutBtn.addEventListener('click', function () {
    sessionStorage.removeItem(TOKEN_KEY);
    current = null;
    posts = [];
    shell.classList.add('hidden');
    loginPanel.classList.remove('hidden');
    setStatus('Вихід.');
  });

  searchEl.addEventListener('input', function () { renderList(searchEl.value); });
  saveBtn.addEventListener('click', save);
  newBtn.addEventListener('click', newPoem);

  if (token()) boot();
})();
