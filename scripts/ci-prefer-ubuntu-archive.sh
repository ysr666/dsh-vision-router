#!/usr/bin/env bash
# CI-only: replace GitHub Azure Ubuntu mirror with the official canonical mirror
# while retaining apt package signatures, package names and dependency checks.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo "Ubuntu apt mirror override is Linux-only"
  exit 0
fi
for source in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [[ -f "$source" ]] && grep -q 'azure.archive.ubuntu.com/ubuntu' "$source"; then
    sudo sed -i 's#http://azure.archive.ubuntu.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' "$source"
    echo "Using canonical Ubuntu archive instead of Azure runner mirror: $source"
  fi
done
printf 'Acquire::Retries "3";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n' \
  | sudo tee /etc/apt/apt.conf.d/99-dvr-ci-network-retries >/dev/null
echo "Ubuntu official apt sources retained; GPG signature validation unchanged"
