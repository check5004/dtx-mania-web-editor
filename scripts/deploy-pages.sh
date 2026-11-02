#!/usr/bin/env bash
# dist をビルドして gh-pages ブランチに置く（GitHub Pages の「Deploy from a branch」用）。
# 使い方: npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
npm run build
touch dist/.nojekyll
rev=$(git rev-parse --short HEAD)
tmp=$(mktemp -d)
cp -r dist/. "$tmp/"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name || echo deploy)" -c user.email="$(git -C "$OLDPWD" config user.email || echo deploy@localhost)" \
  commit -q -m "Pages: ${rev} をデプロイ"
git push -f "$(git -C "$OLDPWD" remote get-url origin)" gh-pages:gh-pages
rm -rf "$tmp"
