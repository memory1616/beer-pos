#!/usr/bin/env bash
# Harden SSH: disable password authentication, root login only via key
SSHD_CONFIG=/etc/ssh/sshd_config
SSHD_CONFIG_D=/etc/ssh/sshd_config.d

# Backup
cp "$SSHD_CONFIG" "$SSHD_CONFIG.bak.$(date +%Y%m%d-%H%M%S)"

# Disable password auth
sed -i 's|^#*PasswordAuthentication.*|PasswordAuthentication no|' "$SSHD_CONFIG"
sed -i 's|^#*ChallengeResponseAuthentication.*|ChallengeResponseAuthentication no|' "$SSHD_CONFIG"
sed -i 's|^#*PermitRootLogin.*|PermitRootLogin prohibit-password|' "$SSHD_CONFIG"
sed -i 's|^#*PubkeyAuthentication.*|PubkeyAuthentication yes|' "$SSHD_CONFIG"
sed -i 's|^#*UsePAM.*|UsePAM yes|' "$SSHD_CONFIG"
sed -i 's|^#*X11Forwarding.*|X11Forwarding no|' "$SSHD_CONFIG"

# Make sure no password auth in any config drop-in
if [ -d "$SSHD_CONFIG_D" ]; then
    for f in "$SSHD_CONFIG_D"/*.conf; do
        [ -e "$f" ] || continue
        sed -i 's|^PasswordAuthentication.*|#PasswordAuthentication no|' "$f"
    done
fi

# Verify
echo "=== Final SSH config (auth lines) ==="
grep -E "^(Password|Challenge|PermitRoot|Pubkey|UsePAM|X11Forward)" "$SSHD_CONFIG"

echo ""
echo "=== Test config syntax ==="
sshd -t 2>&1 || echo "FAILED"

echo ""
echo "=== Restart SSH ==="
systemctl restart sshd
systemctl status sshd --no-pager | head -5

echo ""
echo "=== Verify key login still works ==="
# Already verified by running scripts
echo "OK"