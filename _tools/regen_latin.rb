# Rewrite latin_25/_posts from ukr/_posts. Used by the static editor's
# counterpart on disk; the live site also derives Latin-25 at build time.
# Does not touch English.
require 'fileutils'
require_relative 'latin'

UKR_DIR = File.expand_path('../ukr/_posts', __dir__)
LAT_DIR = File.expand_path('../latin_25/_posts', __dir__)

FileUtils.mkdir_p(LAT_DIR)
FileUtils.rm_f(Dir[File.join(LAT_DIR, '*.md')])

Dir[File.join(UKR_DIR, '*-ukr.md')].each do |src|
  raw = File.read(src)
  fm, body = raw.split(/^---\s*$/, 3)[1..2]
  next unless fm && body

  number = fm[/^number:\s*(\S+)/, 1]
  edits = fm[/^edits:\s*(\S+)/, 1]
  dest = File.join(LAT_DIR, File.basename(src).sub(/-ukr\.md\z/, '-latin_25.md'))
  out = +"---\nlayout: post\nnumber: #{number}\nedits: #{edits}\ncategories: poems latin_25\n---\n"
  out << Latin.to_latin(body)
  File.write(dest, out)
end

puts "Wrote #{Dir[File.join(LAT_DIR, '*.md')].size} Latin-25 posts from Ukrainian."
