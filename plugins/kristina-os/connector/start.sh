#!/bin/sh
# Starts the library connector: picks the program for this Mac's chip and
# unpacks it the first time. Uses only tools built into macOS.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "The library connector runs on Macs only (this machine is $(uname -sm))." >&2; exit 1 ;;
esac
bin="$here/library-$arch"
if [ ! -x "$bin" ]; then
  if [ ! -w "$here" ]; then
    bin="${TMPDIR:-/tmp}/storyeq-library-$(basename "$(dirname "$here")")-$arch"
  fi
  if [ ! -x "$bin" ]; then
    /usr/bin/gunzip -c "$here/library-$arch.gz" > "$bin.partial"
    chmod 700 "$bin.partial"
    mv "$bin.partial" "$bin"
  fi
fi
exec "$bin" "$@"
