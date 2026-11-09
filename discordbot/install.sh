#!/usr/bin/env bash
# =========================================================
# Ivorist Discord bot — one-shot installer for AWS Lightsail
# (Ubuntu 22.04/24.04 VM, or any Debian/Ubuntu host; Amazon
#  Linux 2023 falls back to dnf).
#
#   git clone --depth 1 https://github.com/JHPate1/ivorist-toolchain.git /tmp/ivorist-toolchain
#   sudo bash /tmp/ivorist-toolchain/discordbot/install.sh <BOT_TOKEN> <RUNNER_TOKEN> [WORKER_BASE]
#
# No git login needed: the repo is public.
# Installs Node 20 if missing, clones the repo, writes the
# config, registers a systemd service "ivorist-bot", starts it.
# =========================================================
set -euo pipefail

BOT_TOKEN="${1:?usage: install.sh <BOT_TOKEN> <RUNNER_TOKEN> [WORKER_BASE]}"
RUNNER_TOKEN="${2:?runner token is required}"
WORKER_BASE="${3:-https://ivorist-gateway.hemalviral2011.workers.dev}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
fi

# Run commands as the ivorist service user, whether this script is
# root (runuser) or a privileged sudoer (sudo -u).
run_as_ivorist() {
    if [ "$(id -u)" -eq 0 ]; then
        runuser -u ivorist -- "$@"
    else
        $SUDO -u ivorist -- "$@"
    fi
}

echo "==> 1/6 installing node + git (if missing)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)')" -lt 18 ]; then
    if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null
        $SUDO apt-get install -y nodejs git curl ca-certificates >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
        # curl/curl-minimal is already present on AL2023; installing the full
        # curl package conflicts with curl-minimal, so it is never named here.
        $SUDO dnf install -y nodejs20 git 2>/dev/null || $SUDO dnf install -y nodejs git 2>/dev/null || $SUDO dnf install -y nodejs20 git --allowerasing
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y nodejs20 git 2>/dev/null || $SUDO yum install -y nodejs git 2>/dev/null || $SUDO yum install -y nodejs20 git --allowerasing
    else
        echo "no supported package manager found (need apt-get/dnf/yum)" >&2
        exit 1
    fi
fi
echo "node: $(node -v)"

echo "==> 2/6 service user"
id ivorist >/dev/null 2>&1 || $SUDO useradd -m -s /bin/bash ivorist

echo "==> 3/6 cloning the public toolchain repo"
if [ -d /home/ivorist/toolchain/.git ]; then
    run_as_ivorist git -C /home/ivorist/toolchain fetch --all -q
    run_as_ivorist git -C /home/ivorist/toolchain reset --hard origin/main -q
else
    $SUDO rm -rf /home/ivorist/toolchain
    run_as_ivorist git clone --depth 1 https://github.com/JHPate1/ivorist-toolchain.git /home/ivorist/toolchain -q
fi
$SUDO chown -R ivorist:ivorist /home/ivorist/toolchain

echo "==> 4/6 writing config.json"
cat > /tmp/ivorist-bot-config.json <<EOF
{
    "token": "$BOT_TOKEN",
    "workerBase": "$WORKER_BASE",
    "runnerToken": "$RUNNER_TOKEN",
    "applicationId": "",
    "channels": {
        "app": "1569366033389588523",
        "project": "1569366921961545780",
        "change": "1569367133685678182",
        "bank": "1569367283879387346"
    }
}
EOF
$SUDO mv /tmp/ivorist-bot-config.json /home/ivorist/toolchain/discordbot/config.json
$SUDO chown ivorist:ivorist /home/ivorist/toolchain/discordbot/config.json

echo "==> 5/6 npm install"
run_as_ivorist bash -c "cd /home/ivorist/toolchain/discordbot && npm install --no-audit --no-fund"

echo "==> 6/6 systemd service + start"
cat > /tmp/ivorist-bot.service <<EOF
[Unit]
Description=Ivorist Discord ops bot (gateway + queueing)
After=network-online.target
Wants=network-online.target

[Service]
User=ivorist
WorkingDirectory=/home/ivorist/toolchain/discordbot
ExecStart=$(command -v node) /home/ivorist/toolchain/discordbot/bot.js
Restart=always
RestartSec=8
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
$SUDO mv /tmp/ivorist-bot.service /etc/systemd/system/ivorist-bot.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now ivorist-bot >/dev/null 2>&1 || $SUDO systemctl restart ivorist-bot

sleep 3
echo "================ service state ================"
systemctl is-active ivorist-bot && echo "ivorist-bot is running" || $SUDO journalctl -u ivorist-bot -n 25 --no-pager
echo "latest log lines:"
$SUDO journalctl -u ivorist-bot -n 12 --no-pager || true
echo
echo "tail logs any time:  journalctl -u ivorist-bot -f"
