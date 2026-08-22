# Cyrillic → Latin-25. Ukrainian posts are the source of truth; Latin-25 is
# derived by mapping each character through _tools/replacement.rb.
module Latin
  module_function

  def map
    @map ||= File.read(File.join(__dir__, 'replacement.rb'))
                 .scan(/'([^']+)'\s*=>\s*'([^']*)'/).to_h.freeze
  end

  def to_latin(text)
    text.to_s.chars.map { |c| map[c] || c }.join
  end
end
