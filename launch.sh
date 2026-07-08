#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8934
cd "$DIR"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" > /dev/null 2>&1
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

if ! /usr/sbin/lsof -i tcp:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  nohup "$NODE_BIN" server.mjs >> server.log 2>&1 &
  disown
  for i in $(seq 1 30); do
    if /usr/bin/curl -s -o /dev/null "http://localhost:$PORT"; then break; fi
    sleep 0.2
  done
fi

/usr/bin/open "http://localhost:$PORT"
