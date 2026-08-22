# Seal the admin GitHub token with the site password so /admin/ can unlock
# it in the browser. Nothing here belongs in git or in GitHub *variables*
# (variables are public on a public repo). Use Actions *secrets*:
#   ADMIN_PASSWORD       - what the author types
#   ADMIN_GITHUB_TOKEN   - fine-grained PAT, Contents: Read and write
#
# The live site only ever receives salt + AES-GCM ciphertext. The password
# itself is never written to the built files.
require 'base64'
require 'fileutils'
require 'json'
require 'openssl'

module LockAdmin
  ITERATIONS = 310_000
  DEST = File.expand_path('../assets/js/admin-lock.js', __dir__)

  module_function

  def write!(dest = DEST)
    password, token, source = credentials
    blob = if password.empty? || token.empty?
             "window.ADMIN_LOCK = null;\n"
           else
             "window.ADMIN_LOCK = #{JSON.generate(seal(password, token))};\n"
           end
    FileUtils.mkdir_p(File.dirname(dest))
    File.write(dest, blob)
    if password.empty? || token.empty?
      warn 'lock_admin: no token to seal; /admin/ will refuse logins'
    else
      warn "lock_admin: wrote #{dest} (#{source})"
    end
  end

  def credentials
    secret_password = ENV['ADMIN_PASSWORD'].to_s
    secret_token = ENV['ADMIN_GITHUB_TOKEN'].to_s
    if !secret_password.empty? && !secret_token.empty?
      return [secret_password, secret_token, 'production secrets']
    end

    # Local jekyll serve / build: password is always "password". Never do this
    # in production — GitHub Actions sets JEKYLL_ENV=production.
    if ENV['JEKYLL_ENV'] == 'production'
      return ['', '', 'production missing secrets']
    end

    token = secret_token
    token = ENV['GITHUB_PERSONAL_ACCESS_TOKEN'].to_s if token.empty?
    ['password', token, 'local password']
  end

  def seal(password, token)
    salt = OpenSSL::Random.random_bytes(16)
    iv = OpenSSL::Random.random_bytes(12)
    key = derive(password, salt)
    cipher = OpenSSL::Cipher.new('aes-256-gcm')
    cipher.encrypt
    cipher.key = key
    cipher.iv = iv
    ciphertext = cipher.update(token) + cipher.final
    tag = cipher.auth_tag(16)
    {
      'v' => 1,
      'iterations' => ITERATIONS,
      'salt' => b64(salt),
      'iv' => b64(iv),
      'tag' => b64(tag),
      'ciphertext' => b64(ciphertext)
    }
  end

  def open(password, lock)
    key = derive(password, Base64.strict_decode64(lock['salt']))
    cipher = OpenSSL::Cipher.new('aes-256-gcm')
    cipher.decrypt
    cipher.key = key
    cipher.iv = Base64.strict_decode64(lock['iv'])
    cipher.auth_tag = Base64.strict_decode64(lock['tag'])
    cipher.update(Base64.strict_decode64(lock['ciphertext'])) + cipher.final
  end

  def derive(password, salt)
    OpenSSL::KDF.pbkdf2_hmac(
      password.encode('UTF-8'),
      salt: salt,
      iterations: ITERATIONS,
      length: 32,
      hash: OpenSSL::Digest.new('SHA256')
    )
  end

  def b64(bytes)
    Base64.strict_encode64(bytes)
  end
end

if $PROGRAM_NAME == __FILE__
  if ARGV.include?('--self-test')
    password = 'test-пароль'
    token = 'ghp_example_token'
    lock = LockAdmin.seal(password, token)
    unless LockAdmin.open(password, lock) == token
      abort 'lock_admin self-test failed'
    end
    begin
      LockAdmin.open('wrong', lock)
      abort 'lock_admin self-test: wrong password should fail'
    rescue OpenSSL::Cipher::CipherError
      puts 'lock_admin self-test ok'
    end
  else
    LockAdmin.write!
  end
end
