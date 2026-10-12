#!/bin/sh
# A volume (Fly, a bind mount) arrives owned by root, so start as root, hand /data to the
# unprivileged `node` user, and run the app as that user.
set -e
chown -R node:node /data
exec su node -s /bin/sh -c 'exec node src/main.mjs'
