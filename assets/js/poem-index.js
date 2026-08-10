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
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'poem-pager__num';
      btn.textContent = entry;
      if (entry === current) {
        btn.classList.add('is-current');
        btn.setAttribute('aria-current', 'page');
        btn.disabled = true;
      } else {
        btn.setAttribute('aria-label', pageLabel + ' ' + entry);
        btn.addEventListener('click', function () {
          turn(entry - 1);
        });
      }
      numbers.appendChild(btn);
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

  function filter() {
    var query = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
    matches = query
      ? items.filter(function (item) {
          return item.text.indexOf(query) !== -1 || item.number.indexOf(query) === 0;
        })
      : items;
    page = 0;
    render();
  }

  function turn(to) {
    page = to;
    render();
    root.scrollIntoView({ block: 'start' });
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

  // Nothing to search or page through: leave the controls hidden rather than
  // showing an empty search box and a "no matches" message.
  if (items.length === 0) return;

  search.hidden = false;
  render();
})();
