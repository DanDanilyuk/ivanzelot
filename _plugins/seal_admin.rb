# Bake the admin lock file during every build. Production CI passes
# ADMIN_PASSWORD and ADMIN_GITHUB_TOKEN as secrets; locally they may be unset
# and /admin/ then stays locked.
require_relative '../_tools/lock_admin'
require 'fileutils'

Jekyll::Hooks.register :site, :after_init do |_site|
  LockAdmin.write!
end
