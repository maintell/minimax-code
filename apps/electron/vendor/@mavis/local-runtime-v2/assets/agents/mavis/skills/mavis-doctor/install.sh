#!/usr/bin/env bash
# install.sh — Install the `mavis-session-log` bakery command owned by mavis-doctor.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/bin/mavis-session-log"
TARGET_DIR="${MAVIS_BIN_DIR:-${MINIMAX_DATA_DIR:-$HOME/.minimax}/bin}"
TARGET="$TARGET_DIR/mavis-session-log"

if [[ ! -x "$SOURCE" ]]; then
  echo "install.sh: source script not executable: $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

if [[ -L "$TARGET" && "$(readlink "$TARGET")" == "$SOURCE" ]]; then
  echo "mavis-session-log: already installed (symlink -> $SOURCE)"
  exit 0
fi

ln -snf "$SOURCE" "$TARGET"
echo "mavis-session-log: installed -> $TARGET"

case ":$PATH:" in
  *":$TARGET_DIR:"*)
    ;;
  *)
    cat >&2 <<EOF

NOTE: $TARGET_DIR is not on \$PATH in this shell.
      You can either:
        (a) call the script by absolute path:
              $TARGET <session-id>
        (b) add this line to ~/.zshrc or ~/.bashrc:
              export PATH="$TARGET_DIR:\$PATH"
EOF
    ;;
esac
