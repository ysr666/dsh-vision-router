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
# Hosted runner DNS can fail for both the Azure and canonical Ubuntu mirrors.
# Verify the official repository with HTTPS before trusting an address. If DNS
# is broken, test three A records observed in Ubuntu's public DNS on 2026-11-11.
# curl still authenticates archive.ubuntu.com's TLS certificate, and apt still
# checks signed repository metadata and signed .deb package indexes.
if ! curl --fail --silent --show-error --location --head \
  --noproxy archive.ubuntu.com --connect-timeout 3 --max-time 8 \
  https://archive.ubuntu.com/ubuntu/dists/noble/InRelease >/dev/null 2>&1; then
  archive_ip=''
  for candidate in 185.125.190.81 185.125.190.82 91.189.91.81; do
    if curl --fail --silent --show-error --location --head \
      --noproxy archive.ubuntu.com --resolve "archive.ubuntu.com:443:$candidate" \
      --connect-timeout 3 --max-time 8 \
      https://archive.ubuntu.com/ubuntu/dists/noble/InRelease >/dev/null 2>&1; then
      archive_ip="$candidate"
      break
    fi
  done
  if [[ -z "$archive_ip" ]]; then
    echo "::error::Official Ubuntu archive unreachable by DNS or verified HTTPS address; CI cannot install trusted system dependencies"
    exit 1
  fi
  printf '%s archive.ubuntu.com\n' "$archive_ip" | sudo tee -a /etc/hosts >/dev/null
  echo "Recovered official Ubuntu archive using TLS-verified IPv4 address"
fi

printf 'Acquire::Retries "3";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n' \
  | sudo tee /etc/apt/apt.conf.d/99-dvr-ci-network-retries >/dev/null
echo "Ubuntu official apt sources retained; GPG signature validation unchanged"
