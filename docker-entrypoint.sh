#!/bin/sh
# Runs as root (the image's default user) so it can fix ownership of the
# bind-mounted host volumes, then drops to an unprivileged user matching
# the host's PUID/PGID before actually starting the app.
set -e

APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"

# Make the image's built-in "node" user/group match the host UID/GID
# passed in via PUID/PGID (default 1000, i.e. the usual first regular
# user on most Linux hosts). This keeps whatever the container writes
# into the bind-mounted volumes owned by the same host user that owns
# the directories, instead of some arbitrary container-internal id.
if [ "$(id -u node)" != "$APP_UID" ] || [ "$(id -g node)" != "$APP_GID" ]; then
  deluser node >/dev/null 2>&1 || true
  delgroup node >/dev/null 2>&1 || true
  addgroup -g "$APP_GID" node
  adduser -D -H -u "$APP_UID" -G node node
fi

# First-run bootstrap: any of the four external volumes that is
# completely empty gets seeded with the sample config/content/photos
# shipped in the image, so the site works out of the box on a fresh
# host. A volume the operator has already populated (even partially)
# is left exactly as-is.
#
# "Empty" ignores dotfiles (find ... -not -name '.*') so a placeholder
# like a stray .gitkeep - there only to keep an otherwise-empty
# directory around in git or in a zip archive - doesn't itself count as
# real content and block seeding.
for dir in config content galleries photos; do
  target="/app/$dir"
  seed="/app/.seed/$dir"
  if [ -d "$target" ] && [ -z "$(find "$target" -mindepth 1 -not -name '.*' -print -quit 2>/dev/null)" ]; then
    echo "[entrypoint] /app/$dir has no real content yet - copying in the sample $dir/ as a starting point"
    cp -r "$seed"/. "$target"/
  fi
done

chown -R "$APP_UID:$APP_GID" /app/config /app/content /app/galleries /app/photos

exec su-exec "$APP_UID:$APP_GID" "$@"
