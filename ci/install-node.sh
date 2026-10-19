#!/usr/bin/env bash
# Install the pinned Node.js 26 release on a CodeBuild host, verifying the official SHA-256.
# (The CodeBuild standard image does not ship Node 26.) Usage: source ci/install-node.sh
# NODE_INSTALL_DIR overrides the install root (default /opt).
set -euo pipefail
NODE_VERSION=26.12.0
case "$(uname -m)" in
  x86_64) arch=x64; sha=fd47865ecd6391ebb431fc815e01b9135bf83ded5cf373247e9331e196b7aded ;;
  aarch64) arch=arm64; sha=fd6cc729fa4448c2ac27c3fca5606019ced63c65a15c152c8df03e0cbce7f4c5 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
dir="${NODE_INSTALL_DIR:-/opt}/node-v${NODE_VERSION}-linux-${arch}"
if [[ ! -x "$dir/bin/node" ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  echo "${sha}  $tmp/node.tar.xz" | sha256sum -c -
  tar -xJf "$tmp/node.tar.xz" -C "${NODE_INSTALL_DIR:-/opt}"
  rm -rf "$tmp"
fi
export PATH="$dir/bin:$PATH"
node --version
