#!/usr/bin/env bash
# setup.sh — turn a fresh Ubuntu 24 VPS into the agent's home.
# Run as root ONCE:  bash setup.sh <public-git-remote-url>
#
# Design: the agent runs as its own user with full write over ITS home only.
# "Root on its own machine" in practice = full freedom inside /home/agent,
# resource caps so it can't melt the box, firewall so only the gate port is open.

set -euo pipefail
REMOTE="${1:?usage: setup.sh <git-remote-url>}"

# 1. The agent's user + home
adduser --disabled-password --gecos "" agent || true
AGENT_HOME=/home/agent/persona-agent

# 2. System deps
apt-get update -qq && apt-get install -y -qq git curl ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs

# 3. Firewall: SSH + gate port only
ufw allow OpenSSH
ufw allow 8787/tcp
ufw --force enable

# 4. Clone its body
sudo -u agent git clone "$REMOTE" "$AGENT_HOME" || true
cd "$AGENT_HOME" && sudo -u agent npm install --omit=dev

# 5. Env — fill this in, then chmod 600
sudo -u agent tee "$AGENT_HOME/.env" >/dev/null <<'EOF'
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
VENICE_API_KEY=
ADMIN_TOKEN=
AGENT_MODEL=claude-sonnet-4-6
AGENT_HOME=/home/agent/persona-agent
PORT=8787
EOF
chmod 600 "$AGENT_HOME/.env"
echo ">>> EDIT $AGENT_HOME/.env NOW — keys go there, never in the repo <<<"

# 6. systemd: gate (always on) + cycle timer + executor timer, with caps
cat >/etc/systemd/system/agent-gate.service <<EOF
[Unit]
Description=persona-agent gate
After=network.target
[Service]
User=agent
WorkingDirectory=$AGENT_HOME
EnvironmentFile=$AGENT_HOME/.env
ExecStart=/usr/bin/node agent/gate.js
Restart=always
MemoryMax=512M
CPUQuota=50%
[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/agent-cycle.service <<EOF
[Unit]
Description=persona-agent wake cycle
[Service]
Type=oneshot
User=agent
WorkingDirectory=$AGENT_HOME
EnvironmentFile=$AGENT_HOME/.env
ExecStart=/usr/bin/node agent/loop.js
MemoryMax=1G
CPUQuota=75%
EOF

cat >/etc/systemd/system/agent-cycle.timer <<EOF
[Unit]
Description=wake the agent every 2 hours
[Timer]
OnCalendar=*-*-* 0/2:11:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

cat >/etc/systemd/system/agent-executor.service <<EOF
[Unit]
Description=persona-agent executor (approved actions only)
[Service]
Type=oneshot
User=agent
WorkingDirectory=$AGENT_HOME
EnvironmentFile=$AGENT_HOME/.env
ExecStart=/usr/bin/node agent/executor.js
MemoryMax=1G
CPUQuota=75%
EOF

cat >/etc/systemd/system/agent-executor.timer <<EOF
[Unit]
Description=run approved actions every 10 minutes
[Timer]
OnCalendar=*:0/10
Persistent=true
[Install]
WantedBy=timers.target
EOF

# The design run. This is the only thing that produces a converged character rather than
# a single roll of the dice, and until now it had no timer at all — it existed solely as a
# script somebody ran by hand, so the cast got designed exactly as often as someone
# remembered to design it. It needs a real timeout: a session is a dozen renders plus a
# judging call, and the 90s systemd default would SIGTERM it half way through, leaving the
# published git tree in exactly the state the script is written to avoid.
cat >/etc/systemd/system/agent-design.service <<EOF
[Unit]
Description=persona-agent character design session
[Service]
Type=oneshot
User=agent
WorkingDirectory=$AGENT_HOME
EnvironmentFile=$AGENT_HOME/.env
ExecStart=/usr/bin/node agent/design-run.js
TimeoutStartSec=3600
MemoryMax=1G
CPUQuota=75%
EOF

cat >/etc/systemd/system/agent-design.timer <<EOF
[Unit]
Description=refine a character design every 3 hours, bounded by the daily venice credits
[Timer]
OnCalendar=*-*-* 00/3:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now agent-gate.service agent-cycle.timer agent-executor.timer agent-design.timer

echo "done. next:"
echo "  1. fill $AGENT_HOME/.env"
echo "  2. run db/schema.sql in Supabase"
echo "  3. set the identity row (name + personality seed)"
echo "  4. systemctl start agent-cycle.service   # first breath, watch: journalctl -u agent-cycle -f"
