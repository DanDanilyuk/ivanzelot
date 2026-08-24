# Reads text and images out of Apple Pages (.pages) documents.
#
# Modern Pages files are zip archives whose content lives in Index/*.iwa:
# Snappy-compressed protobuf. We decompress the chunks and recover the UTF-8
# text runs. Images are anchored in that text by U+FFFC (object replacement),
# which is what lets an image be tied to the poem it sits in.
#
# No network access of any kind.
require 'shellwords'

module PagesReader
  module_function

  # Snappy raw block decompression.
  def snappy_raw(data)
    bytes = data.bytes
    i = 0
    # preamble: varint uncompressed length (unused, but must be consumed)
    loop do
      b = bytes[i]
      i += 1
      break if b.nil? || (b & 0x80).zero?
    end
    out = []
    while i < bytes.length
      tag = bytes[i]
      i += 1
      case tag & 0x03
      when 0
        n = tag >> 2
        if n < 60
          len = n + 1
        else
          extra = n - 59
          len = 0
          extra.times { |k| len |= bytes[i + k] << (8 * k) }
          i += extra
          len += 1
        end
        out.concat(bytes[i, len] || [])
        i += len
      else
        case tag & 0x03
        when 1
          len = 4 + ((tag >> 2) & 0x07)
          off = ((tag >> 5) << 8) | bytes[i]
          i += 1
        when 2
          len = (tag >> 2) + 1
          off = bytes[i] | (bytes[i + 1] << 8)
          i += 2
        else
          len = (tag >> 2) + 1
          off = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
          i += 4
        end
        break if off.nil? || off.zero? || off > out.length
        start = out.length - off
        len.times { |k| out << out[start + k] }
      end
    end
    out.pack('C*')
  end

  # An .iwa file is a series of [1 byte flags][3 byte LE length][snappy block].
  def iwa_chunks(raw)
    out = +''
    i = 0
    while i + 4 <= raw.bytesize
      len = raw.byteslice(i + 1, 3).unpack1('C*') || 0
      b = raw.byteslice(i + 1, 3).bytes
      len = b[0] | (b[1] << 8) | (b[2] << 16)
      i += 4
      block = raw.byteslice(i, len)
      i += len
      break if block.nil? || block.empty?
      begin
        out << snappy_raw(block)
      rescue StandardError
        next
      end
    end
    out
  end

  # --- protobuf / archive plumbing -------------------------------------
  # Pages stores content as a stream of archives. Reading the text out of the
  # text-storage archives is exact; scraping printable runs out of the raw
  # bytes is not, because a run boundary can fall mid-line and silently split
  # "801-7" into "801-" and "7@@".

  def read_varint(b, i)
    result = 0
    shift = 0
    loop do
      byte = b.getbyte(i)
      return [nil, i] if byte.nil?
      i += 1
      result |= (byte & 0x7f) << shift
      return [result, i] if (byte & 0x80).zero?
      shift += 7
    end
  end

  # Yields [field_number, wire_type, value] for one protobuf message.
  def each_field(b)
    i = 0
    while i < b.bytesize
      key, i = read_varint(b, i)
      break if key.nil?
      field = key >> 3
      wire = key & 7
      case wire
      when 0
        v, i = read_varint(b, i)
        break if v.nil?
        yield field, 0, v
      when 2
        len, i = read_varint(b, i)
        break if len.nil? || i + len > b.bytesize
        yield field, 2, b.byteslice(i, len)
        i += len
      when 5 then i += 4
      when 1 then i += 8
      else break
      end
    end
  end

  TEXT_STORAGE = 2001
  DRAWABLE_ATTACHMENT = 2003
  IMAGE_ARCHIVE = 3005
  PACKAGE_METADATA = 11006

  # Concatenates the text of every text-storage archive, in document order.
  def document_text(zip_path)
    raw = `unzip -p #{Shellwords.escape(zip_path)} Index/Document.iwa`
    blob = iwa_chunks(raw.force_encoding('BINARY'))
    blob.force_encoding('BINARY')

    parts = []
    i = 0
    while i < blob.bytesize
      hlen, j = read_varint(blob, i)
      break if hlen.nil? || hlen.zero?
      info = blob.byteslice(j, hlen)
      break if info.nil?
      j += hlen
      messages = []
      each_field(info) do |f, wire, v|
        next unless f == 2 && wire == 2
        type = len = nil
        each_field(v) do |f2, w2, v2|
          type = v2 if f2 == 1 && w2.zero?
          len = v2 if f2 == 3 && w2.zero?
        end
        messages << [type, len] if type && len
      end
      break if messages.empty?
      messages.each do |type, len|
        payload = blob.byteslice(j, len)
        j += len
        next unless type == TEXT_STORAGE && payload
        chunk = +''
        each_field(payload) { |f, wire, v| chunk << v if f == 3 && wire == 2 }
        next if chunk.empty?
        chunk.force_encoding('UTF-8')
        parts << chunk if chunk.valid_encoding?
      end
      i = j
    end
    parts.join("\n")
  end

  # Full-size content images, in the order they sit in the body text.
  # Zip filenames are insertion IDs, not document position: pairing those
  # with U+FFFC in text order put the wrong picture on many poems. The
  # attachment table on the text-storage archive is the mapping Pages
  # itself uses.
  def image_entries(zip_path)
    from_text = images_from_attachments(zip_path)
    return from_text unless from_text.empty?

    zip_image_entries(zip_path)
  end

  def zip_image_entries(zip_path)
    `unzip -Z1 #{Shellwords.escape(zip_path)}`.split("\n").select do |n|
      content_image?(n)
    end.sort_by { |n| n[/(\d+)\.\w+\z/, 1].to_i }
  end

  def extract_image(zip_path, entry, dest)
    data = `unzip -p #{Shellwords.escape(zip_path)} #{Shellwords.escape(entry)}`
    File.binwrite(dest, data)
    data.bytesize
  end

  def content_image?(name)
    base = name.sub(%r{\AData/}, '')
    name.start_with?('Data/') &&
      !base.include?('Preset') &&
      !base.include?('bullet') &&
      !base.include?('-small-') &&
      !base.start_with?('tile_')
  end

  # --- attachment table -> Data/ path --------------------------------

  def images_from_attachments(zip_path)
    objects = iwa_objects(zip_path)
    return [] if objects.empty?

    by_id = {}
    objects.each { |o| by_id[o[:id]] = o if o[:id] }

    datas = {}
    objects.select { |o| o[:type] == PACKAGE_METADATA }.each do |o|
      each_field(o[:payload]) do |f, w, v|
        next unless f == 4 && w == 2
        ident = nil
        pref = fname = nil
        each_field(v) do |f2, w2, v2|
          ident = v2 if f2 == 1 && w2.zero?
          pref = utf8(v2) if f2 == 3 && w2 == 2
          fname = utf8(v2) if f2 == 4 && w2 == 2
        end
        next unless ident
        name = fname.to_s.empty? ? pref.to_s : fname
        next if name.empty?
        datas[ident] = "Data/#{name}"
      end
    end

    entries = []
    objects.select { |o| o[:type] == TEXT_STORAGE }.each do |storage|
      each_field(storage[:payload]) do |f, w, v|
        next unless f == 9 && w == 2
        each_field(v) do |f2, w2, v2|
          next unless f2 == 1 && w2 == 2
          att_id = nil
          each_field(v2) do |f3, w3, v3|
            att_id = tsp_id(v3) if f3 == 2 && w3 == 2
          end
          path = image_path_for_attachment(by_id, datas, att_id)
          entries << path if path
        end
      end
    end
    entries
  end

  def image_path_for_attachment(by_id, datas, att_id)
    att = by_id[att_id]
    return nil unless att && att[:type] == DRAWABLE_ATTACHMENT
    drawable_id = nil
    each_field(att[:payload]) do |f, w, v|
      drawable_id = tsp_id(v) if f == 1 && w == 2
    end
    drawable = by_id[drawable_id]
    return nil unless drawable && drawable[:type] == IMAGE_ARCHIVE

    data_id = nil
    each_field(drawable[:payload]) do |f, w, v|
      data_id = tsp_id(v) if f == 11 && w == 2
    end
    if data_id.nil?
      refs = drawable[:data_refs] || []
      data_id = refs.find { |r| datas[r] && content_image?(datas[r]) } ||
                refs.find { |r| datas[r] }
    end
    path = datas[data_id]
    path if path && content_image?(path)
  end

  def tsp_id(bytes)
    ident = nil
    each_field(bytes) { |f, w, v| ident = v if f == 1 && w.zero? }
    ident
  end

  def utf8(bytes)
    bytes.to_s.dup.force_encoding('UTF-8')
  end

  def unpack_packed(bytes)
    out = []
    i = 0
    while i < bytes.bytesize
      v, i = read_varint(bytes, i)
      break if v.nil?
      out << v
    end
    out
  end

  def iwa_objects(zip_path)
    names = `unzip -Z1 #{Shellwords.escape(zip_path)}`.split("\n")
    objs = []
    names.each do |entry|
      next unless entry.end_with?('.iwa')
      raw = `unzip -p #{Shellwords.escape(zip_path)} #{Shellwords.escape(entry)}`
      next if raw.nil? || raw.empty?
      objs.concat(parse_iwa_objects(iwa_chunks(raw.force_encoding('BINARY'))))
    end
    objs
  end

  def parse_iwa_objects(blob)
    blob = blob.dup.force_encoding('BINARY')
    objs = []
    i = 0
    while i < blob.bytesize
      hlen, j = read_varint(blob, i)
      break if hlen.nil? || hlen.zero?
      info = blob.byteslice(j, hlen)
      break if info.nil?
      j += hlen
      identifier = nil
      messages = []
      each_field(info) do |f, wire, v|
        identifier = v if f == 1 && wire.zero?
        next unless f == 2 && wire == 2
        type = len = nil
        obj_refs = []
        data_refs = []
        each_field(v) do |f2, w2, v2|
          type = v2 if f2 == 1 && w2.zero?
          len = v2 if f2 == 3 && w2.zero?
          obj_refs.concat(unpack_packed(v2)) if f2 == 5 && w2 == 2
          data_refs.concat(unpack_packed(v2)) if f2 == 6 && w2 == 2
          obj_refs << v2 if f2 == 5 && w2.zero?
          data_refs << v2 if f2 == 6 && w2.zero?
        end
        messages << { type: type, len: len, obj_refs: obj_refs, data_refs: data_refs }
      end
      break if messages.empty?
      messages.each do |m|
        payload = blob.byteslice(j, m[:len] || 0)
        j += m[:len] || 0
        objs << { id: identifier, type: m[:type], obj_refs: m[:obj_refs],
                  data_refs: m[:data_refs], payload: payload }
      end
      i = j
    end
    objs
  end
end
