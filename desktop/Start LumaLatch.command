#!/bin/bash
set -eu
cd -- "$(dirname -- "$0")"
unset NODE_OPTIONS NODE_PATH
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This launcher is for Mac. On Windows, open LumaLatch.exe."
  exit 1
fi
if [ ! -x runtime/bin/node ]; then
  echo "The bundled runtime is missing or not executable. Extract the complete Mac ZIP again."
  read -r -p "Press Return to close. "
  exit 1
fi
exec runtime/bin/node app/mac-launcher.mjs
