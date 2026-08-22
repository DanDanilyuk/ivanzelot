# Ukrainian posts are the source of truth. At build time, drop any Latin-25
# posts read from disk and recreate them by transliterating each Ukrainian
# post. English is left alone.
require_relative '../_tools/latin'

Jekyll::Hooks.register :site, :post_read do |site|
  posts = site.posts.docs
  ukr = posts.select { |d| categories(d).include?('ukr') }
  posts.reject! { |d| categories(d).include?('latin_25') }

  ukr.each do |src|
    posts << latin_doc(site, src)
  end

  posts.sort!
  site.instance_variable_set(:@categories, nil)
  site.instance_variable_set(:@tags, nil)
end

def categories(doc)
  Array(doc.data['categories']).flatten.map(&:to_s)
end

def latin_doc(site, src)
  dest = src.path.sub(%r{/ukr/_posts/}, '/latin_25/_posts/')
                .sub(/-ukr(\.md)\z/, '-latin_25\\1')
  doc = Jekyll::Document.new(dest, site: site, collection: site.posts)
  doc.content = Latin.to_latin(src.content)
  number = src.data['number']
  edits = src.data['edits']
  doc.data['layout'] = 'post'
  doc.data['number'] = number
  doc.data['edits'] = edits
  doc.data['date'] = src.data['date']
  doc.data['title'] = "#{number}-#{edits}"
  # Path already adds latin_25 first (so URLs stay /latin_25/poems/...).
  doc.send(:merge_data!, { 'categories' => ['poems'] }, source: 'latin derive')
  doc.send(:populate_categories)
  doc.send(:populate_title)
  doc
end
