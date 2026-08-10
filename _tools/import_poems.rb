#!/usr/bin/env ruby
# Bulk-import Ukrainian originals from Apple Pages documents into ukr/_posts,
# and optionally the local Latin-25 transliteration into latin_25/_posts.
#
# THIS TOOL NEVER CONTACTS AWS TRANSLATE. English posts are produced by a
# separate manual step the author runs; nothing here touches the network.
#
# Usage:
#   ruby _tools/import_poems.rb --source new_poems_raw --dry-run
#   ruby _tools/import_poems.rb --source new_poems_raw --write --latin
#
# Conventions recovered from the corpus:
#   "@@"  separates individual poems
#   "@"   divides one block into continuation parts, which become separate
#         posts numbered <n>-1, <n>-2, ... in order
#   N-E   closes a poem: N = number, E = edits. A trailing "*" is recorded
#         in the log for the author to confirm; it does not change the post.
#   U+FFFC marks where an image sits, which is how images map to a poem.
require 'date'
require 'fileutils'
require_relative 'pages_reader'

OPTS = {
  source: 'new_poems_raw',
  write: false,
  latin: false,
  date: Date.today.strftime('%Y-%m-%d'),
  images_dir: 'assets/poem_images',
  log: '_tools/import_log.txt',
  limit: nil
}
ARGV.each_with_index do |a, i|
  case a
  when '--source' then OPTS[:source] = ARGV[i + 1]
  when '--write' then OPTS[:write] = true
  when '--dry-run' then OPTS[:write] = false
  when '--latin' then OPTS[:latin] = true
  when '--date' then OPTS[:date] = ARGV[i + 1]
  when '--limit' then OPTS[:limit] = ARGV[i + 1].to_i
  end
end

# A closing marker is "number - edits", but the author also writes variants:
#   447-7(9)      edits with a parenthetical
#   558-Х         edits as a letter rather than a digit
#   565-(note)    a note where the edits belong
#   732-  /  731-*  no edits at all
# Anything non-numeric in the edits slot is kept out of the post and reported
# in the log instead, so the front matter stays clean.
MARKER = /\A(\d+)\s*[-–—]\s*(\d{1,3}|[^\s()*]{1,2})?\s*(\([^)]*\))?\s*(\*?)\s*\z/
ANCHOR = "￼"

Poem = Struct.new(:number, :edits, :starred, :text, :images, :source, :part, :parts)

def normalize(line)
  # Non-breaking spaces become ordinary ones; C0 control characters (Pages
  # leaves the odd U+0005 beside a separator) are dropped outright.
  line.gsub("\u00a0", " ").gsub(/[\u0000-\u0008\u000b-\u001f\u007f]/, "").rstrip
end

def marker_of(line)
  MARKER.match(line.strip)
end

# Split one document into poems. Returns [poems, issues].
def parse_document(text, source, image_entries)
  poems = []
  issues = []
  buffer = []          # lines of the current block
  anchors_seen = 0     # running index into image_entries

  flush = lambda do |m|
    parts = [[]]
    part_images = [[]]
    buffer.each do |line|
      if line.strip == '@'
        parts << []
        part_images << []
      else
        n = line.count(ANCHOR)
        if n.positive?
          n.times do
            part_images.last << image_entries[anchors_seen] if image_entries[anchors_seen]
            anchors_seen += 1
          end
          line = line.delete(ANCHOR)
        end
        parts.last << line
      end
    end

    # Trim blank lines only - leading spaces are the poet's layout and
    # must survive.
    bodies = parts.map do |p|
      p.join("\n")
       .gsub(/\A(?:#{BLANK}*\n)+/, '')
       .gsub(/(?:\n#{BLANK}*)+\z/, '')
       .sub(/#{BLANK}+\z/, '')
    end
    total = bodies.count { |b| !b.empty? }

    if m.nil?
      bodies.reject(&:empty?).each do |body|
        # Stray marks such as a lone "*" are not poems.
        next if body.gsub(/[[:punct:][:space:]]/, '').empty?
        poems << Poem.new(nil, nil, false, body, [], source, nil, 1)
      end
      buffer = []
      next
    end

    number = m[1]
    raw_edits = m[2]
    note = m[3]
    star = m[4].to_s
    # Non-numeric edits are not written into the post; they are reported.
    edits = raw_edits.to_s.match?(/\A\d+\z/) ? raw_edits : '0'
    if raw_edits.to_s != '' && !raw_edits.to_s.match?(/\A\d+\z/)
      issues << { kind: 'odd_edits', source: source,
                  detail: "marker #{number}-#{raw_edits} has non-numeric edits; imported as edits: 0", raw: @raw_marker }
    elsif raw_edits.to_s == ''
      issues << { kind: 'odd_edits', source: source,
                  detail: "marker #{number}- has no edits value; imported as edits: 0", raw: @raw_marker }
    end
    if note
      issues << { kind: 'marker_note', source: source,
                  detail: "marker #{number} carries a note: #{note}", raw: @raw_marker }
    end
    if total.zero?
      issues << { kind: 'empty', source: source, detail: "marker #{number}-#{edits} has no text" }
      buffer = []
      next
    end

    bodies.each_with_index do |body, idx|
      next if body.empty?
      label = bodies.size > 1 ? "#{number}-#{idx + 1}" : number
      poems << Poem.new(label, edits, !star.empty?, body, part_images[idx] || [],
                        source, bodies.size > 1 ? idx + 1 : nil, bodies.size)
    end

    if bodies.size > 1
      issues << { kind: 'split', source: source,
                  detail: "block #{number}-#{edits} contained #{bodies.size - 1} '@' divider(s) " \
                          "-> #{bodies.size} posts: #{bodies.each_index.map { |i| "#{number}-#{i + 1}" }.join(', ')}" }
    end
    issues << { kind: 'starred', source: source, detail: "marker #{number}-#{edits}* carries an asterisk" } unless star.empty?
    buffer = []
  end

  text.split("\n").each do |raw|
    line = normalize(raw)
    anchors = line.count(ANCHOR)
    # Compare separators and markers on the line WITHOUT its image anchors and
    # invisible characters: an image anchored on a "@@" line would otherwise
    # stop it being recognised as a separator and leak "@@" into the poem.
    bare = line.delete(ANCHOR).gsub(/[​‌‍﻿]/, '').strip

    # "@@" may carry the author's uncertainty marks, e.g. "@@?" / "@@??".
    if bare.match?(/\A@{2,}\?*\z/)
      issues << { kind: 'uncertain_sep', source: source,
                  detail: "separator written as #{bare.inspect} (author uncertainty mark)" } if bare != '@@'
      # "@@" precedes each poem, so it normally arrives with an empty buffer.
      # Arriving with text pending means the poem just read never got its
      # closing number - close it here rather than merging it into the next
      # poem, and report it so the author can supply the number.
      flush.call(nil) if buffer.any? { |l| l.strip != '' }
      buffer << (ANCHOR * anchors) if anchors.positive?
      next
    end

    if (m = marker_of(bare))
      # An anchor sitting on the closing marker belongs to the poem just ending.
      buffer << (ANCHOR * anchors) if anchors.positive?
      @raw_marker = bare
      flush.call(m)
    else
      buffer << line
    end
  end
  flush.call(nil) unless buffer.all? { |l| l.strip.empty? }

  # A block with no number sits between two numbered poems. Numbering runs
  # strictly downwards, so if exactly one number is missing across that gap,
  # the block can only be that poem. Anything less certain is reported.
  poems.each_with_index do |p, i|
    next unless p.number.nil?
    before = poems[0...i].reverse.find { |x| x.number }
    after  = poems[(i + 1)..].to_a.find { |x| x.number }
    hi = before&.number.to_s[/\A\d+/]&.to_i
    lo = after&.number.to_s[/\A\d+/]&.to_i
    candidates = if hi && lo && hi > lo
                   ((lo + 1)..(hi - 1)).to_a
                 elsif hi && lo.nil?
                   # Last block in a document: numbering descends, so the only
                   # candidate is one below the poem above it.
                   [hi - 1]
                 else
                   []
                 end
    used = poems.map { |x| x.number.to_s[/\A\d+/]&.to_i }.compact
    candidates -= used
    if candidates.size == 1
      p.number = candidates.first.to_s
      p.edits = '0'
      issues << { kind: 'inferred', source: source,
                  detail: "a poem had no number; it sits between #{hi} and #{lo}, so it must be #{p.number}",
                  preview: p.text.lines.first(2).map(&:strip).join(' / ') }
    elsif after
      # No gap to fill: this is a note or dedication, not a poem of its own.
      # Put it back on the poem that follows, which is where it sat before,
      # so nothing is dropped from the text.
      after.text = "#{p.text}\n\n#{after.text}"
      issues << { kind: 'reattached', source: source,
                  detail: "a note with no number was kept with poem #{after.number}",
                  preview: p.text.lines.first(2).map(&:strip).join(' / ') }
    else
      issues << { kind: 'unterminated', source: source,
                  detail: candidates.empty? ? 'text with no number, and no gap nearby to place it' :
                          "text with no number; it could be any of #{candidates.join(', ')}",
                  preview: p.text.lines.first(3).map(&:strip).join(' / ') }
    end
  end
  poems.reject! { |p| p.number.nil? }

  if anchors_seen < image_entries.size
    issues << { kind: 'orphan_image', source: source,
                detail: "#{image_entries.size - anchors_seen} image(s) had no anchor in the text" }
  end
  [poems, issues]
end

LATIN = File.read(File.join(__dir__, 'replacement.rb'))
             .scan(/'([^']+)'\s*=>\s*'([^']*)'/).to_h

def to_latin(s)
  s.chars.map { |c| LATIN[c] || c }.join
end

# Two or more blank lines in a row are a deliberate pause, not a stanza break.
# Markdown collapses any run of blank lines into one paragraph break, so the
# gap is emitted as an explicit block that CSS gives the height of 3 lines.
GAP = '<div class="poem-gap"></div>'
# A line is "blank" if it shows nothing: spaces, non-breaking spaces, and the
# invisible emoji machinery (zero-width joiners, variation selectors) that some
# poems leave behind all count as empty.
BLANK = "[ \t\u00a0\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]"

def mark_gaps(text)
  text.gsub(/\n#{BLANK}*\n(?:#{BLANK}*\n)+/, "\n\n#{GAP}\n\n")
end

# Leading spaces collapse in HTML, so the poet's indentation would be lost.
# Non-breaking spaces preserve it exactly, and also stop a 4-space indent
# being read as a markdown code block.
def preserve_indent(text)
  text.lines.map { |l|
    l.sub(/\A[ \t]+/) { |ws| '&nbsp;' * ws.gsub("\t", '    ').length }
  }.join
end

# Latin letters typed by accident inside Cyrillic words. They look identical
# on screen but differ in bytes, so search misses them and the Latin-25 map
# (which only covers Cyrillic) passes them through untranslated. Only letters
# with an exact Cyrillic twin are mapped, and only when the surrounding word
# is already Cyrillic - the transliterated and foreign-script poems are left
# alone. Case is preserved so the poet's stress capitals survive.
HOMOGLYPHS = {
  'A' => 'А', 'a' => 'а', 'B' => 'В', 'C' => 'С', 'c' => 'с', 'E' => 'Е', 'e' => 'е',
  'H' => 'Н', 'I' => 'І', 'i' => 'і', 'K' => 'К', 'M' => 'М', 'O' => 'О', 'o' => 'о',
  'P' => 'Р', 'p' => 'р', 'T' => 'Т', 'X' => 'Х', 'x' => 'х', 'Y' => 'У', 'y' => 'у'
}.freeze

CYRILLIC = /[\u0400-\u04ff]/

def fix_homoglyphs(text, changes)
  text.lines.map { |line|
    # Whole words that are otherwise Cyrillic.
    out = line.gsub(/\p{L}[\p{L}\u2019']*/) do |word|
      next word unless word.match?(/[A-Za-z]/)
      next word if word.scan(CYRILLIC).size < 2
      fixed = word.chars.map { |c| HOMOGLYPHS[c] || c }.join
      changes << [word, fixed] unless fixed == word
      fixed
    end
    # One-letter words ("i", "B", "A") can never satisfy the test above, so
    # they are judged by the line around them instead.
    if out.scan(CYRILLIC).size >= 5
      out = out.gsub(/(?<!\p{L})([A-Za-z])(?!\p{L})/) do
        c = Regexp.last_match(1)
        twin = HOMOGLYPHS[c]
        if twin
          changes << ["#{c} (on its own)", twin]
          twin
        else
          c
        end
      end
    end
    out
  }.join
end

def front_matter(poem, category)
  fm = +"---\nlayout: post\nnumber: #{poem.number}\nedits: #{poem.edits}\ncategories: poems #{category}\n"
  unless poem.images.empty?
    fm << "images:\n"
    poem.images.each_index { |i| fm << "  - #{poem.number}-#{i + 1}#{File.extname(poem.images[i])}\n" }
  end
  fm << "---\n\n"
  fm
end

# ---------------------------------------------------------------- run

sources = Dir[File.join(OPTS[:source], '*.pages')].sort
sources = sources.first(OPTS[:limit]) if OPTS[:limit]
abort "No .pages files under #{OPTS[:source]}" if sources.empty?

all_poems = []
all_issues = []
read_failures = []

sources.each do |pg|
  begin
    text = PagesReader.document_text(pg)
    imgs = PagesReader.image_entries(pg)
  rescue StandardError => e
    read_failures << { source: File.basename(pg), detail: e.message }
    next
  end
  if text.strip.empty?
    read_failures << { source: File.basename(pg), detail: 'no text recovered' }
    next
  end
  poems, issues = parse_document(text, File.basename(pg), imgs)
  all_poems.concat(poems)
  all_issues.concat(issues)
end

# Repair Latin letters sitting inside Cyrillic words before anything else
# reads the text, so both the Ukrainian post and the Latin-25 transliteration
# are built from the corrected form.
homoglyph_changes = []
all_poems.each { |p| p.text = fix_homoglyphs(p.text, homoglyph_changes) }
homoglyph_changes.uniq!

# duplicates
seen = Hash.new { |h, k| h[k] = [] }
all_poems.each { |p| seen[p.number] << p.source }
# When two DIFFERENT poems share a number, the later write would silently
# destroy the earlier one. Keep the copy from the document whose filename
# range covers that number, and record the discarded text in full in the log
# so nothing is lost while the author decides.
discarded = []
seen.select { |_, v| v.size > 1 }.each do |num, _|
  rivals = all_poems.select { |p| p.number == num }
  identical = rivals.map(&:text).uniq.size == 1
  canonical = rivals.find { |p| (p.source[/(\d+)-(\d+)/, 1].to_i..p.source[/(\d+)-(\d+)/, 2].to_i).cover?(num.to_i) } || rivals.first
  losers = rivals - [canonical]
  all_issues << { kind: 'duplicate', source: rivals.map(&:source).uniq.join(', '),
                  detail: (identical ? "number #{num} appears #{rivals.size} times with IDENTICAL text; kept one" :
                    "number #{num} is used by #{rivals.size} DIFFERENT poems - kept the copy from #{canonical.source}; " \
                    "the other is reproduced below and was NOT written") }
  unless identical
    losers.each { |l| discarded << { number: num, source: l.source, text: l.text } }
  end
  losers.each { |l| all_poems.delete(l) }
end

# compare against what is published now
existing = {}
Dir['ukr/_posts_bak/*.md'].each do |f|
  body = File.read(f)
  num = body[/^number:\s*(\S+)/, 1]
  txt = body.split(/^---\s*$/, 3)[2].to_s.strip
  existing[num] = txt if num
end
added = all_poems.reject { |p| existing.key?(p.number.to_s) }
changed = all_poems.select { |p| existing.key?(p.number.to_s) && existing[p.number.to_s] != p.text }
unchanged = all_poems.select { |p| existing[p.number.to_s] == p.text }

if OPTS[:write]
  # The import replaces the collection wholesale. Filenames carry today's date,
  # so without clearing first every poem would exist twice (old date + new).
  # ukr/_posts_bak and latin_25/_posts_bak hold the previous contents.
  abort 'Refusing to write: ukr/_posts_bak missing - make a backup first.' unless Dir.exist?('ukr/_posts_bak')
  FileUtils.rm_f(Dir['ukr/_posts/*.md'])
  FileUtils.rm_f(Dir['latin_25/_posts/*.md']) if OPTS[:latin]
  FileUtils.mkdir_p('ukr/_posts')
  FileUtils.mkdir_p(OPTS[:images_dir])
  FileUtils.mkdir_p('latin_25/_posts') if OPTS[:latin]
  all_poems.each do |p|
    p.images.each_with_index do |entry, i|
      dest = File.join(OPTS[:images_dir], "#{p.number}-#{i + 1}#{File.extname(entry)}")
      PagesReader.extract_image(File.join(OPTS[:source], p.source), entry, dest)
    end
    File.write("ukr/_posts/#{OPTS[:date]}-#{p.number}-ukr.md", front_matter(p, 'ukr') + preserve_indent(mark_gaps(p.text)) + "\n")
    next unless OPTS[:latin]
    lp = p.dup
    lp.text = to_latin(p.text)
    File.write("latin_25/_posts/#{OPTS[:date]}-#{p.number}-latin_25.md", front_matter(lp, 'latin_25') + preserve_indent(mark_gaps(lp.text)) + "\n")
  end
end

# ---------------------------------------------------------------- log

log = +''
log << "Poem import report\n"
log << "Generated: #{OPTS[:date]}   mode: #{OPTS[:write] ? 'WRITE' : 'DRY RUN (nothing written)'}\n"
log << "Source: #{OPTS[:source]} (#{sources.size} documents)\n"
log << ('=' * 72) << "\n\n"
log << "SUMMARY\n"
log << "  poems found          #{all_poems.size}\n"
log << "  new (not published)  #{added.size}\n"
log << "  changed text         #{changed.size}\n"
log << "  unchanged            #{unchanged.size}\n"
log << "  images linked        #{all_poems.sum { |p| p.images.size }}\n"
log << "  latin letters fixed  #{homoglyph_changes.size} distinct words\n"
log << "  documents unreadable #{read_failures.size}\n\n"

unless read_failures.empty?
  log << "DOCUMENTS THAT COULD NOT BE READ\n"
  read_failures.each { |f| log << "  #{f[:source]}: #{f[:detail]}\n" }
  log << "\n"
end

%w[unterminated inferred reattached empty duplicate orphan_image split starred].each do |kind|
  rows = all_issues.select { |i| i[:kind] == kind }
  next if rows.empty?
  titles = {
    'unterminated' => 'TEXT THAT DID NOT MAP TO A POEM (no closing N-E marker)',
    'empty' => 'MARKERS WITH NO POEM TEXT',
    'inferred' => 'POEMS WHOSE NUMBER WAS MISSING AND WAS INFERRED FROM ITS NEIGHBOURS',
    'reattached' => 'NOTES WITH NO NUMBER, KEPT WITH THE POEM THAT FOLLOWS',
    'duplicate' => 'DUPLICATE POEM NUMBERS',
    'orphan_image' => 'IMAGES WITH NO ANCHOR IN THE TEXT',
    'split' => "BLOCKS SPLIT ON '@' INTO CONTINUATION POSTS",
    'starred' => "MARKERS ENDING IN '*' (meaning unconfirmed - please advise)",
    'uncertain_sep' => "SEPARATORS CARRYING '?' (author uncertainty - please confirm)",
    'odd_edits' => 'MARKERS WITH MISSING OR NON-NUMERIC EDITS (imported as edits: 0)',
    'marker_note' => 'MARKERS CARRYING A NOTE (note not imported - please confirm)'
  }
  log << "#{titles[kind]}  [#{rows.size}]\n"
  rows.each do |r|
    log << "  #{r[:source]}: #{r[:detail]}\n"
    log << "      #{r[:preview]}\n" if r[:preview]
  end
  log << "\n"
end

unless discarded.empty?
  log << "FULL TEXT OF POEMS NOT WRITTEN BECAUSE THEIR NUMBER WAS TAKEN  [#{discarded.size}]\n"
  log << "(nothing is lost - assign each a free number and re-run)\n"
  discarded.each do |d|
    log << "  --- number #{d[:number]} from #{d[:source]}\n"
    d[:text].lines.each { |l| log << "      #{l}" }
    log << "\n\n"
  end
end

unless homoglyph_changes.empty?
  log << "LATIN LETTERS REPLACED WITH THEIR CYRILLIC TWINS  [#{homoglyph_changes.size}]\n"
  homoglyph_changes.sort.each { |a, b| log << "  #{a}  ->  #{b}\n" }
  log << "\n"
end

log << "CHANGED POEMS (text differs from what is published)  [#{changed.size}]\n"
changed.first(60).each { |p| log << "  #{p.number} (#{p.source})\n" }
log << "  ... #{changed.size - 60} more\n" if changed.size > 60
log << "\nNEW POEMS  [#{added.size}]\n"
log << '  ' << added.map(&:number).first(80).join(', ') << "\n"
log << "  ... #{added.size - 80} more\n" if added.size > 80

# ---------------------------------------------------------------- author report
# Plain-language version for the poet: numbered questions, nothing else.
nums_written = all_poems.map { |p| p.number.to_s.split('-').first.to_i }.uniq
gaps = (1..nums_written.max).to_a - nums_written
inferred = all_issues.select { |i| i[:kind] == 'inferred' }
reattached = all_issues.select { |i| i[:kind] == 'reattached' }
starred_n = all_issues.count { |i| i[:kind] == 'starred' }
splits = all_issues.select { |i| i[:kind] == 'split' }
odd = all_issues.select { |i| i[:kind] == 'odd_edits' || i[:kind] == 'marker_note' }
unc_n = all_issues.count { |i| i[:kind] == 'uncertain_sep' }

n = 0
nxt = -> { n += 1 }

r = +"POEMS - QUESTIONS\n#{Date.today.strftime('%-d %B %Y')}\n\n"
r << "#{all_poems.size} poems read. Nothing is lost. I just need answers to these.\n\n"

unless gaps.empty?
  r << "#{nxt.call}. #{gaps.size == 1 ? "Does a poem numbered #{gaps.first} exist?" : "Do poems numbered #{gaps.join(', ')} exist?"} I could not find #{gaps.size == 1 ? 'one' : 'them'}.\n\n"
end

discarded.each do |d|
  kept = all_poems.find { |p| p.number.to_s == d[:number].to_s }
  r << "#{nxt.call}. Two different poems are numbered #{d[:number]}."
  r << " I kept \"#{kept.text.lines.first.to_s.strip}\"." if kept
  r << "\n   What number should this one have?\n\n"
  body = d[:text].sub(/\A\d/, '').lines
  body.first(4).each { |l| r << "      #{l}" }
  r << "      (...)\n" if body.size > 4
  r << "\n"
end

unless inferred.empty?
  got = inferred.map { |i| i[:detail][/must be (\S+)/, 1] }.compact
  subject = got.size == 1 ? "A poem had no number. I read it as #{got.first}" :
                            "#{got.size} poems had no number. I read them as #{got.join(' and ')}"
  r << "#{nxt.call}. #{subject}. Correct?\n\n"
end

if starred_n.positive?
  r << "#{nxt.call}. What does the star mean? #{starred_n} poems end 1-7* instead of 1-7.\n\n"
end

unless splits.empty?
  which = splits.map { |i| i[:detail][/block (\d+)/, 1] }.compact
  r << "#{nxt.call}. Poems #{which.join(' and ')} have a single @ inside. I made each part a\n"
  r << "   separate poem (#{which.first}-1, #{which.first}-2). Correct?\n\n"
end

# The Latin "y" is the one repair with two defensible readings: it looks like
# "у", but in the poet's own Latynka-25 it stands for "и".
ambiguous = homoglyph_changes.select { |a, _| a.match?(/y/) && !a.include?('on its own') }
unless ambiguous.empty?
  ambiguous.each do |was, now|
    alt = now.sub(/у(?!.*у)/, 'и')
    r << "#{nxt.call}. You wrote \"#{was}\". Should it be \"#{now}\" or \"#{alt}\"?\n\n"
  end
end

unless odd.empty?
  r << "#{nxt.call}. What are the right numbers for these endings?\n"
  odd.map { |i| i[:raw] }.compact.uniq.sort.each { |d| r << "      #{d}\n" }
  r << "\n"
end



# Reflect how many English translations are actually live.
eng_live = Dir['eng/_posts/*.md'].size
if eng_live.zero?
  r << "Ukrainian and Latynka-25 are complete (#{all_poems.size} each).\n"
  r << "English is being redone and is not on the site yet.\n\n"
else
  r << "Ukrainian and Latynka-25 are complete (#{all_poems.size} each).\n"
  r << "English is being redone - #{eng_live} on the site so far.\n\n"
end

notes = []
notes << "#{reattached.size} notes had no number; kept with poems #{reattached.map { |i| i[:detail][/poem (\S+)/, 1] }.compact.sort.join(', ')}." unless reattached.empty?
notes << "#{unc_n} dividers were written @@?; treated as normal." if unc_n.positive?
unless notes.empty?
  r << "Notes: #{notes.first}\n"
  notes.drop(1).each { |x| r << "       #{x}\n" }
end

File.write('_tools/author_report.txt', r)

File.write(OPTS[:log], log)
puts log
puts "\nLog written to #{OPTS[:log]}"
puts "Author report written to _tools/author_report.txt"
