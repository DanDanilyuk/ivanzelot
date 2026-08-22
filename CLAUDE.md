# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Jekyll site (minima theme, GitHub Pages) publishing poems by Michael Kavchak / Іван Зелот in three parallel renderings: Ukrainian, a Latin-25 transliteration, and a machine translation into English. Live at ivanzelot.com.

## Never call AWS Translate automatically

`_tools/translate_page.rb` and `_tools/translate_page_refactored.rb` call AWS Translate. **Do not run them.** Translation is a manual step the repo owner triggers after the writer reviews. Never invoke AWS Translate as part of an import, a build, a bulk regeneration, or "just to test" - not for one poem, not for all of them. If a task seems to need translated English output, stop and ask.

## Commands

```bash
bundle exec jekyll serve   # local preview
bundle exec jekyll build   # build to _site/
make serve                 # serve with --livereload --watch --open-url
make serve-network         # same, bound to 192.168.0.55 for LAN testing
make clean                 # DELETES ukr/_posts, latin_25/_posts, eng/_posts, _site
```

There are no tests and no linter.

Ruby is pinned by `.ruby-version` (4.0.6); gems come from the repo `Gemfile` (Jekyll 4.x). Run `bundle install` after changing Ruby versions.

## Content pipeline

**Ukrainian posts (`ukr/_posts`) are the source of truth.** Latin-25 is derived from them; do not hand-edit `latin_25/_posts`. English is a separate later step and is not produced by the editor or the importer.

The author edits Ukrainian at `/admin/`. That page is static GitHub Pages (no extra server). A site password unwraps a GitHub token that was encrypted at build time. Use repository **Secrets**, never **Variables** (variables are visible on a public repo):

- `ADMIN_PASSWORD` — what the author types
- `ADMIN_GITHUB_TOKEN` — fine-grained PAT with Contents: Read and write on this repo

`_plugins/seal_admin.rb` writes `assets/js/admin-lock.js` (gitignored ciphertext) during `jekyll build`. Save writes the Ukrainian file and creates or updates the matching Latin-25 file. `_plugins/derive_latin_25.rb` also rebuilds every Latin-25 post from Ukrainian at build, so the published Latin-25 listing cannot drift. English is not written.

A bulk import from `poems_raw/*.pages` still exists (`ruby _tools/import_poems.rb --source poems_raw --write --latin`) but it overwrites Ukrainian posts. Do not run it after the author has started editing in `/admin/`.

Filename convention: `YYYY-MM-DD-<number>-<lang>.md`.

## Post and page conventions

Posts carry no `title`. They are keyed by two front-matter fields:

```yaml
---
layout: post
number: 1      # poem id, shared across all three languages
edits: 7       # revision count, rendered as "1-7" on listings
categories: poems ukr
---
```

Jekyll also derives a category from the containing directory, so a post in `ukr/_posts/` is in `site.categories.ukr` regardless of its front matter. That is why soft-delete works the way it does: setting `categories: delete` does *not* remove a post from its language listing, so every listing loop and `sitemap.xml` explicitly skips `post.categories contains 'delete'`. Any new listing must repeat that check.

Listing pages render through one shared partial, `_includes/poem-index.html`, called with the category to list:

```liquid
{% include poem-index.html category="ukr" %}
```

It sorts that category by `number` descending, renders each post's full content inline with a `.number-field` permalink and a `@@` `.type-field` divider, and wires up client-side search and 10-per-page pagination (`assets/js/poem-index.js`, styles in `_sass/minima/_base.scss`). Change the listing markup there, once. `index.markdown` and `eng.markdown` both pass `category="eng"` - the homepage is the English listing.

`aphorisms.markdown` is the one page still carrying its own inline copy of the old loop; it is unpublished, so it was left alone.

The JS is progressive enhancement: it hides the search row and pager by default and reveals them on load, so with JS off every poem renders exactly as it did before pagination existed.

## UI language

All chrome (site title, heading, search, pagination, footer description, `<title>`) is localized from `_data/i18n.yml`, keyed `en` / `ukr` / `latin_25`.

- Listing pages declare `lang:` in front matter. Poem posts have none, so `_layouts/default.html` falls back to their category and assigns `t` for every include to use.
- `_includes/poem-index.html` renders inside page content, before the layout runs, so it resolves `t` from `page.lang` itself rather than relying on the layout's assign.
- Strings the JS needs are passed through `data-*` attributes on `.poem-index` (units, of, empty template, plural rule, page label). Ukrainian uses the 1 / 2-4 / rest plural rule.
- `_includes/head.html` disables seo-tag's `<title>` (`{% seo title=false %}`) and emits a per-language one, because seo-tag always builds it from the fixed `site.title`.

**Do not hand-edit `_data/i18n.yml`.** Run `ruby _tools/gen_i18n.rb`; it derives the whole `latin_25` block from the Ukrainian strings using the transliteration map in `_tools/replacement.rb`, so the UI always matches the site's own rules. That script touches no network services.

The transliteration map lives in `_tools/replacement.rb` (used by the importer and by `gen_i18n.rb`). It currently matches `~/Projects/ukrainian_to_mike_translator/script.js`.

Front matter that drives chrome, set per listing page:

- `weight` - nav order; `_includes/header.html` sorts `site.pages` by weight and links only pages that have a `title`.
- `heading` - the `<h2>` subtitle under the site title (defaults to "Poems").
- `permalink` - listings use flat pretty paths (`/poems-english/`, `/poems-ukrainian/`, `/poems-latin-25/`, `/aphorisms/`). Individual posts inherit the global `permalink: pretty` plus their folder category, giving `/ukr/poems/2024/09/29/1-ukr/`.

`_layouts/default.html` picks the `<html lang>` from the page path (`ukr` → uk, `latin_25` → latin, `eng` → en, else uk).

## Formatting

`kramdown.hard_wrap: true` in `_config.yml` turns every single newline into `<br>`. This is what keeps poem line breaks intact - do not "clean up" poem bodies by rewrapping lines or collapsing blank lines, and do not disable hard_wrap.

## Theme overrides

`_layouts/`, `_includes/`, and `_sass/minima/` are local copies that shadow the minima gem. Custom rules (`.post-data`, `.number-field`, `.type-field`, `.stars-field`) live at the bottom of `_sass/minima/_base.scss`; `assets/main.scss` just imports minima.

## Deployment

`gh-pages` is the default branch and GitHub Pages builds it directly - pushing to it publishes. `_site/` is gitignored; do not commit build output.

## Note on README.md

The README describes an older layout (`poems/_posts`, `title:` and `stars:` front matter) that no longer matches the repo. Trust the current trees over the README.
