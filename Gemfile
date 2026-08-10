source "https://rubygems.org"

# The site is built and deployed by .github/workflows/pages.yml, so these
# versions are the ones that actually publish the site. (GitHub Pages' own
# branch build is no longer used; it pinned Jekyll 3.10 via the github-pages
# gem, which caps Ruby at < 4.0.)
gem "jekyll", "~> 4.4"
gem "minima", "~> 2.5"

group :jekyll_plugins do
  gem "jekyll-seo-tag", "~> 2.7"
  gem "jekyll-feed", "~> 0.17"
end

# Required to run `jekyll serve` on Ruby 3+.
gem "webrick", "~> 1.9"

# Windows and JRuby do not include zoneinfo files.
platforms :mingw, :x64_mingw, :mswin, :jruby do
  gem "tzinfo", ">= 1", "< 3"
  gem "tzinfo-data"
end
