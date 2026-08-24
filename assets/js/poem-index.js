/* Search + pagination for the poem listing. Progressive enhancement:
   without JS the page renders every poem exactly as it did before. */
(function () {
  'use strict';

  var PER_PAGE = 10;
  var WINDOW = 1; // page numbers shown either side of the current page

  var root = document.querySelector('[data-poem-index]');
  if (!root) return;

  // UI strings come from _data/i18n.yml via the include.
  var units = (root.getAttribute('data-units') || 'poem|poems').split('|');
  var ofWord = root.getAttribute('data-of') || 'of';
  var emptyTemplate = root.getAttribute('data-empty') || 'No poems match “{q}”.';
  var pluralRule = root.getAttribute('data-plural') || 'en';
  var pageLabel = root.getAttribute('data-page-label') || 'Page';

  var search = root.querySelector('[data-poem-search-row]');
  var input = root.querySelector('[data-poem-search]');
  var count = root.querySelector('[data-poem-count]');
  var empty = root.querySelector('[data-poem-empty]');
  var emptyText = root.querySelector('[data-poem-empty-text]');
  var clear = root.querySelector('[data-poem-clear]');
  var pager = root.querySelector('[data-poem-pager]');
  var numbers = root.querySelector('[data-poem-numbers]');
  var prev = root.querySelector('[data-poem-prev]');
  var next = root.querySelector('[data-poem-next]');

  // Index the poem text once. The number and "@@" marks are excluded so a
  // query matches the poem itself; numbers are searched separately.
  var items = [].map.call(root.querySelectorAll('.post-data'), function (el) {
    var text = '';
    [].forEach.call(el.children, function (child) {
      if (child.classList.contains('number-field')) return;
      if (child.classList.contains('type-field')) return;
      if (child.classList.contains('poem-images')) return;
      text += ' ' + child.textContent;
    });
    return {
      el: el,
      number: el.getAttribute('data-number') || '',
      text: text.toLowerCase().replace(/\s+/g, ' ')
    };
  });

  var matches = items;
  var page = 0;
  var applyingUrl = false;

  // English: one|many. Ukrainian: one|few|many, by the usual 1 / 2-4 / rest rule.
  function unit(n) {
    if (pluralRule === 'uk' && units.length >= 3) {
      var mod10 = n % 10;
      var mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return units[0];
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return units[1];
      return units[2];
    }
    return n === 1 ? units[0] : units[units.length - 1];
  }

  // First and last page are always present; the current page is surrounded by
  // WINDOW neighbours, and any gap collapses to an ellipsis.
  function pageList(current, total) {
    var out = [];
    for (var i = 1; i <= total; i++) {
      var keep =
        i === 1 ||
        i === total ||
        (i >= current - WINDOW && i <= current + WINDOW);
      if (keep) {
        out.push(i);
      } else if (out[out.length - 1] !== '…') {
        out.push('…');
      }
    }
    return out;
  }

  function hrefFor(pageIndex) {
    var params = new URLSearchParams();
    var q = input.value.trim();
    if (q) params.set('q', q);
    if (pageIndex > 0) params.set('page', String(pageIndex + 1));
    var qs = params.toString();
    return location.pathname + (qs ? '?' + qs : '');
  }

  function renderNumbers(current, total) {
    numbers.textContent = '';
    pageList(current, total).forEach(function (entry) {
      if (entry === '…') {
        var gap = document.createElement('span');
        gap.className = 'poem-pager__gap';
        gap.setAttribute('aria-hidden', 'true');
        gap.textContent = '…';
        numbers.appendChild(gap);
        return;
      }
      if (entry === current) {
        var here = document.createElement('span');
        here.className = 'poem-pager__num is-current';
        here.setAttribute('aria-current', 'page');
        here.textContent = entry;
        numbers.appendChild(here);
        return;
      }
      var link = document.createElement('a');
      link.className = 'poem-pager__num';
      link.href = hrefFor(entry - 1);
      link.textContent = entry;
      link.setAttribute('aria-label', pageLabel + ' ' + entry);
      link.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        turn(entry - 1);
      });
      numbers.appendChild(link);
    });
  }

  function render() {
    var total = matches.length;
    var pages = Math.max(1, Math.ceil(total / PER_PAGE));
    page = Math.min(Math.max(page, 0), pages - 1);

    var start = page * PER_PAGE;
    var shown = matches.slice(start, start + PER_PAGE);

    items.forEach(function (item) {
      item.el.classList.add('is-hidden');
    });
    shown.forEach(function (item) {
      item.el.classList.remove('is-hidden');
    });

    var query = input.value.trim();
    count.textContent = query
      ? total + ' ' + ofWord + ' ' + items.length + ' ' + unit(items.length)
      : items.length + ' ' + unit(items.length);

    if (total === 0) {
      emptyText.textContent = emptyTemplate.replace('{q}', query);
      empty.hidden = false;
      pager.hidden = true;
      return;
    }

    empty.hidden = true;
    pager.hidden = false;

    renderNumbers(page + 1, pages);
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  }

  function applyFilter() {
    var query = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
    matches = query
      ? items.filter(function (item) {
          return item.text.indexOf(query) !== -1 || item.number.indexOf(query) === 0;
        })
      : items;
  }

  function filter() {
    applyFilter();
    page = 0;
    render();
    writeUrl(false);
  }

  function turn(to) {
    page = to;
    render();
    writeUrl(true);
    root.scrollIntoView({ block: 'start' });
  }

  function readUrl() {
    var params = new URLSearchParams(location.search);
    var q = params.get('q') || '';
    var raw = parseInt(params.get('page'), 10);
    return {
      query: q,
      page: !raw || raw < 1 ? 0 : raw - 1
    };
  }

  function writeUrl(push) {
    if (applyingUrl) return;
    var params = new URLSearchParams();
    var q = input.value.trim();
    if (q) params.set('q', q);
    if (page > 0) params.set('page', String(page + 1));
    var qs = params.toString();
    var url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    var current = location.pathname + location.search + location.hash;
    if (url === current) return;
    var state = { poemIndex: true, page: page, q: q };
    if (push) history.pushState(state, '', url);
    else history.replaceState(state, '', url);
  }

  function applyFromUrl() {
    applyingUrl = true;
    var u = readUrl();
    input.value = u.query;
    applyFilter();
    var pages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
    page = Math.min(Math.max(u.page, 0), pages - 1);
    render();
    applyingUrl = false;
    writeUrl(false);
  }

  var pending;
  input.addEventListener('input', function () {
    clearTimeout(pending);
    pending = setTimeout(filter, 120);
  });

  clear.addEventListener('click', function () {
    input.value = '';
    filter();
    input.focus();
  });

  prev.addEventListener('click', function () {
    turn(page - 1);
  });

  next.addEventListener('click', function () {
    turn(page + 1);
  });

  window.addEventListener('popstate', function () {
    applyFromUrl();
  });

  // Nothing to search or page through: leave the controls hidden rather than
  // showing an empty search box and a "no matches" message.
  if (items.length === 0) return;

  search.hidden = false;
  applyFromUrl();
})();
