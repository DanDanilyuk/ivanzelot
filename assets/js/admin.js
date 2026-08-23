/* Static GitHub Pages editor. Ukrainian is the source of truth; Save writes
   the Ukrainian post, the matching Latin-25 post, and (when provided) the
   English post. English is entered by hand — this tool never translates.
   A poem may have one optional image, which can be added, replaced, or
   removed. A site password unwraps a GitHub token that was encrypted at
   build time from Actions secrets (never GitHub variables). */
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
  var IMAGE_DIR = 'assets/poem_images/';
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  var IMAGE_EXTS = {
    png: '.png',
    jpg: '.jpeg',
    jpeg: '.jpeg',
    gif: '.gif',
    webp: '.webp',
    heic: '.heic',
    heif: '.heif'
  };

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
  var bodyEngEl = root.querySelector('[data-body-eng]');
  var imageFileEl = root.querySelector('[data-image-file]');
  var imagePreviewEl = root.querySelector('[data-image-preview]');
  var imageImgEl = root.querySelector('[data-image-img]');
  var imageNameEl = root.querySelector('[data-image-name]');
  var imageEmptyEl = root.querySelector('[data-image-empty]');
  var imagePickEl = root.querySelector('[data-image-pick]');
  var imageRemoveEl = root.querySelector('[data-image-remove]');
  var saveBtn = root.querySelector('[data-save]');
  var deleteBtn = root.querySelector('[data-delete]');
  var newBtn = root.querySelector('[data-new]');
  var logoutBtn = root.querySelector('[data-logout]');
  var loginBtn = root.querySelector('[data-login-btn]');

  var posts = [];
  var engByNumber = {};
  var imageOnDisk = {};
  var current = null;
  var latinMap = null;
  var saving = false;
  var loggingIn = false;
  var pendingFile = null;
  var imageRemoved = false;
  var previewUrl = null;

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
      images: images.slice(0, 1),
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
    var cats = kind === 'ukr' ? 'poems ukr' : kind === 'eng' ? 'poems eng' : 'poems latin_25';
    var out = '---\nlayout: post\nnumber: ' + parsed.number + '\nedits: ' + parsed.edits +
      '\ncategories: ' + cats + '\n';
    if (kind === 'ukr' && parsed.images && parsed.images.length) {
      out += 'images:\n  - ' + parsed.images[0] + '\n';
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

  function numberFromEngPath(path) {
    var m = path.match(/\/\d{4}-\d{2}-\d{2}-(.+)-eng\s*\.md$/);
    return m ? m[1] : '';
  }

  function latinPathFromUkr(path) {
    return path.replace(/^ukr\/_posts\//, 'latin_25/_posts/').replace(/-ukr\.md$/, '-latin_25.md');
  }

  function imageRepoPath(name) {
    return IMAGE_DIR + name;
  }

  function extOf(filename) {
    var m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    if (!m) return '';
    return IMAGE_EXTS[m[1]] || '';
  }

  function extOfFile(file) {
    if (!file) return '';
    var fromName = extOf(file.name);
    if (fromName) return fromName;
    var t = String(file.type || '').toLowerCase();
    if (t === 'image/jpeg') return '.jpeg';
    if (t === 'image/png') return '.png';
    if (t === 'image/gif') return '.gif';
    if (t === 'image/webp') return '.webp';
    if (t === 'image/heic' || t === 'image/heif') return '.heic';
    return '';
  }

  function todayStamp() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function revokePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  function savedImageName() {
    return current && current.images && current.images[0] ? current.images[0] : '';
  }

  function renderImage() {
    var name = '';
    var src = '';
    if (pendingFile) {
      name = pendingFile.name;
      revokePreview();
      previewUrl = URL.createObjectURL(pendingFile);
      src = previewUrl;
    } else if (!imageRemoved && savedImageName()) {
      name = savedImageName();
      src = '/' + imageRepoPath(name);
    }

    if (!src) {
      if (imageImgEl) {
        imageImgEl.removeAttribute('src');
        imageImgEl.classList.remove('is-broken');
      }
      if (imageNameEl) imageNameEl.textContent = '';
      if (imagePreviewEl) imagePreviewEl.classList.add('hidden');
      if (imageEmptyEl) imageEmptyEl.classList.remove('hidden');
      if (imageRemoveEl) imageRemoveEl.classList.add('hidden');
      if (imagePickEl) imagePickEl.textContent = 'Додати зображення';
      return;
    }

    if (imageImgEl) {
      imageImgEl.classList.remove('is-broken');
      imageImgEl.alt = name;
      imageImgEl.src = src;
    }
    if (imageNameEl) imageNameEl.textContent = pendingFile ? (savedImageName() ? 'Заміна: ' + name : name) : name;
    if (imagePreviewEl) imagePreviewEl.classList.remove('hidden');
    if (imageEmptyEl) imageEmptyEl.classList.add('hidden');
    if (imageRemoveEl) imageRemoveEl.classList.remove('hidden');
    if (imagePickEl) imagePickEl.textContent = 'Замінити';
  }

  function resetImageState() {
    pendingFile = null;
    imageRemoved = false;
    if (imageFileEl) imageFileEl.value = '';
    revokePreview();
  }

  function onImagePicked() {
    var file = imageFileEl && imageFileEl.files && imageFileEl.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus('Зображення має бути до 10 МБ.', 'error');
      imageFileEl.value = '';
      return;
    }
    if (!extOfFile(file)) {
      setStatus('Потрібен файл png, jpeg, gif, webp або heic.', 'error');
      imageFileEl.value = '';
      return;
    }
    pendingFile = file;
    imageRemoved = false;
    renderImage();
    setStatus('');
  }

  function onImageRemove() {
    pendingFile = null;
    imageRemoved = true;
    if (imageFileEl) imageFileEl.value = '';
    revokePreview();
    renderImage();
    setStatus('Зображення приберуть при збереженні.');
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = function () {
        reject(new Error('Не вдалося прочитати зображення.'));
      };
      reader.readAsDataURL(file);
    });
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

  function fillForm(parsed, path, isNew, eng) {
    current = {
      path: path,
      number: parsed.number,
      edits: parsed.edits,
      images: (parsed.images || []).slice(0, 1),
      isNew: !!isNew,
      engPath: eng && eng.path ? eng.path : ''
    };
    resetImageState();
    pathEl.textContent = path || '(новий)';
    numberEl.value = parsed.number;
    numberEl.readOnly = !isNew;
    editsEl.value = parsed.edits;
    bodyEl.value = forEditor(parsed.body || '');
    bodyEngEl.value = forEditor(eng && eng.body ? eng.body : '');
    if (deleteBtn) deleteBtn.classList.toggle('hidden', !!isNew || !path);
    renderImage();
    renderList(searchEl.value);
    var cur = listEl.querySelector('.is-current');
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }

  function openPost(p) {
    setStatus('Завантаження ' + p.number + '…');
    api('/contents/' + p.path + '?ref=' + encodeURIComponent(branch)).then(function (file) {
      var parsed = parsePost(decodeUtf8(file.content));
      var engPath = engByNumber[p.number];
      if (!engPath) {
        fillForm(parsed, p.path, false, null);
        setStatus('');
        return;
      }
      return api('/contents/' + engPath + '?ref=' + encodeURIComponent(branch)).then(function (engFile) {
        var ep = parsePost(decodeUtf8(engFile.content));
        fillForm(parsed, p.path, false, { path: engPath, body: ep.body });
        setStatus('');
      }).catch(function (err) {
        fillForm(parsed, p.path, false, null);
        setStatus('Українську відкрито. Англійську не вдалося завантажити: ' + err.message, 'error');
      });
    }).catch(function (err) {
      setStatus(err.message, 'error');
    });
  }

  function commitFiles(message, files) {
    var prepared = files.map(function (f) { return f; });
    var blobJobs = prepared.filter(function (f) { return f.base64 && !f.delete; });
    return Promise.all(blobJobs.map(function (f) {
      return api('/git/blobs', {
        method: 'POST',
        body: { content: f.base64, encoding: 'base64' }
      }).then(function (blob) {
        f.sha = blob.sha;
        return f;
      });
    })).then(function () {
      return api('/git/ref/heads/' + encodeURIComponent(branch)).then(function (ref) {
        var commitSha = ref.object.sha;
        return api('/git/commits/' + commitSha).then(function (commit) {
          return api('/git/trees', {
            method: 'POST',
            body: {
              base_tree: commit.tree.sha,
              tree: prepared.map(function (f) {
                if (f.delete) {
                  return { path: f.path, mode: '100644', type: 'blob', sha: null };
                }
                if (f.sha) {
                  return { path: f.path, mode: '100644', type: 'blob', sha: f.sha };
                }
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
    });
  }

  function imagesForSave(number) {
    if (pendingFile) {
      var ext = extOfFile(pendingFile);
      return ext ? [number + '-1' + ext] : [];
    }
    if (imageRemoved) return [];
    return savedImageName() ? [savedImageName()] : [];
  }

  function save() {
    if (saving) return;
    var number = numberEl.value.trim();
    var edits = editsEl.value.trim();
    var ukrRaw = bodyEl.value;
    var engRaw = bodyEngEl.value;
    var body = forSave(ukrRaw);
    var engBody = forSave(engRaw);
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
    if (!ukrRaw.trim()) {
      setStatus('Потрібен текст українською.', 'error');
      return;
    }
    var isNew = !current || current.isNew;
    var hadEnglish = !!(current && current.engPath);
    if (isNew && !engRaw.trim()) {
      setStatus('Потрібен текст англійською.', 'error');
      return;
    }
    if (hadEnglish && !engRaw.trim()) {
      setStatus('Потрібен текст англійською.', 'error');
      return;
    }
    if (!latinMap) {
      setStatus('Немає таблиці латинки-25. Оновіть сторінку і увійдіть знову.', 'error');
      return;
    }
    if (pendingFile && !extOfFile(pendingFile)) {
      setStatus('Потрібен файл png, jpeg, gif, webp або heic.', 'error');
      return;
    }

    var existing = posts.find(function (p) { return p.number === number; });
    var editingSame = current && !current.isNew && existing && existing.path === current.path;
    if (existing && !editingSame) {
      setStatus('Вірш ' + number + ' уже є. Відкрийте його зі списку, змініть або видаліть. Новий з тим самим номером не створюється.', 'error');
      return;
    }

    var newImages = imagesForSave(number);
    var oldImages = (current && current.images) ? current.images.slice() : [];
    var parsed = {
      number: number,
      edits: edits,
      images: newImages
    };
    var ukrPath = (current && current.path && !current.isNew)
      ? current.path
      : 'ukr/_posts/' + todayStamp() + '-' + number + '-ukr.md';
    var latPath = latinPathFromUkr(ukrPath);
    var ukrFile = serialize('ukr', parsed, body);
    var latFile = serialize('latin_25', parsed, toLatin(body));
    var files = [
      { path: ukrPath, content: ukrFile },
      { path: latPath, content: latFile }
    ];

    var engPath = '';
    if (engRaw.trim()) {
      engPath = (current && current.engPath)
        ? current.engPath
        : 'eng/_posts/' + todayStamp() + '-' + number + '-eng.md';
      files.push({ path: engPath, content: serialize('eng', parsed, engBody) });
    }

    oldImages.forEach(function (name) {
      if (newImages.indexOf(name) === -1 && imageOnDisk[name]) {
        files.push({ path: imageRepoPath(name), delete: true });
      }
    });

    saving = true;
    saveBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    setStatus('Збереження ' + number + '…');

    var ready = pendingFile ? fileToBase64(pendingFile).then(function (b64) {
      files.push({ path: imageRepoPath(newImages[0]), base64: b64 });
    }) : Promise.resolve();

    ready.then(function () {
      return commitFiles('Update poem ' + number, files);
    }).then(function () {
      if (!posts.some(function (p) { return p.path === ukrPath; })) {
        posts.push({ path: ukrPath, number: number });
        posts.sort(function (a, b) {
          return parseFloat(b.number) - parseFloat(a.number);
        });
      }
      if (engPath) engByNumber[number] = engPath;
      oldImages.forEach(function (name) {
        if (newImages.indexOf(name) === -1) delete imageOnDisk[name];
      });
      newImages.forEach(function (name) { imageOnDisk[name] = true; });
      fillForm(parsed, ukrPath, false, engPath ? { path: engPath, body: engBody } : null);
      var bits = ['Збережено ' + number + '.', 'Latin-25 оновлено.'];
      if (engPath) bits.push('Англійську збережено.');
      bits.push('Сайт збереться за хвилину-дві.');
      setStatus(bits.join(' '), 'ok');
    }).catch(function (err) {
      setStatus(err.message, 'error');
    }).then(function () {
      saving = false;
      saveBtn.disabled = false;
      if (deleteBtn) deleteBtn.disabled = false;
    });
  }

  function newPoem() {
    fillForm({ number: '', edits: '1', images: [], body: '' }, '', true, null);
    numberEl.focus();
    setStatus('Новий вірш. Потрібні український і англійський текст. Зображення — за бажанням. Номер не може збігатися з уже існуючим.');
  }

  function deleteCurrent() {
    if (saving || loggingIn) return;
    if (!current || current.isNew || !current.path) {
      setStatus('Немає збереженого вірша, щоб видалити.', 'error');
      return;
    }
    var number = current.number;
    if (!window.confirm('Видалити вірш ' + number + ' українською, англійською і латинкою-25' + (savedImageName() ? ', разом із зображенням' : '') + '?')) return;

    var files = [
      { path: current.path, delete: true },
      { path: latinPathFromUkr(current.path), delete: true }
    ];
    if (current.engPath) files.push({ path: current.engPath, delete: true });
    (current.images || []).forEach(function (name) {
      if (imageOnDisk[name]) files.push({ path: imageRepoPath(name), delete: true });
    });

    saving = true;
    saveBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    setStatus('Видалення ' + number + '…');
    commitFiles('Delete poem ' + number, files).then(function () {
      posts = posts.filter(function (p) { return p.path !== current.path; });
      delete engByNumber[number];
      (current.images || []).forEach(function (name) { delete imageOnDisk[name]; });
      fillForm({ number: '', edits: '1', images: [], body: '' }, '', true, null);
      setStatus('Вірш ' + number + ' видалено. Сайт збереться за хвилину-дві.', 'ok');
    }).catch(function (err) {
      setStatus(err.message, 'error');
    }).then(function () {
      saving = false;
      saveBtn.disabled = false;
      if (deleteBtn) deleteBtn.disabled = false;
    });
  }

  function boot() {
    setStatus('Завантаження списку…');
    Promise.all([
      api('/git/trees/' + encodeURIComponent(branch) + '?recursive=1'),
      api('/contents/_tools/replacement.rb?ref=' + encodeURIComponent(branch))
    ]).then(function (pair) {
      var tree = pair[0];
      latinMap = loadMap(decodeUtf8(pair[1].content));
      posts = [];
      engByNumber = {};
      imageOnDisk = {};
      tree.tree.forEach(function (t) {
        if (t.type !== 'blob') return;
        if (/^ukr\/_posts\/.+-ukr\.md$/.test(t.path)) {
          posts.push({ path: t.path, number: numberFromPath(t.path) });
        } else if (/^eng\/_posts\/.+-eng\s*\.md$/.test(t.path)) {
          var n = numberFromEngPath(t.path);
          if (n) engByNumber[n] = t.path;
        } else if (t.path.indexOf(IMAGE_DIR) === 0) {
          imageOnDisk[t.path.slice(IMAGE_DIR.length)] = true;
        }
      });
      posts.sort(function (a, b) { return parseFloat(b.number) - parseFloat(a.number); });
      loginPanel.classList.add('hidden');
      shell.classList.remove('hidden');
      renderList('');
      setStatus('Віршів: ' + posts.length + '. Англійську вводите вручну.', 'ok');
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
    engByNumber = {};
    resetImageState();
    shell.classList.add('hidden');
    loginPanel.classList.remove('hidden');
    setStatus('Вихід.');
  });

  searchEl.addEventListener('input', function () { renderList(searchEl.value); });
  saveBtn.addEventListener('click', save);
  if (deleteBtn) deleteBtn.addEventListener('click', deleteCurrent);
  newBtn.addEventListener('click', newPoem);
  if (imageFileEl) imageFileEl.addEventListener('change', onImagePicked);
  if (imageRemoveEl) imageRemoveEl.addEventListener('click', onImageRemove);
  if (imageImgEl) {
    imageImgEl.addEventListener('error', function () { imageImgEl.classList.add('is-broken'); });
    imageImgEl.addEventListener('load', function () { imageImgEl.classList.remove('is-broken'); });
  }

  if (token()) boot();
})();
