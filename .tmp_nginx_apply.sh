#!/bin/bash
set -e
CONF=/etc/nginx/sites-available/beerpos.conf
cp "$CONF" "$CONF.bak.$(date +%Y%m%d_%H%M%S)"
cp /root/beerpos.conf.new "$CONF"
rm -f /root/beerpos.conf.new
nginx -t 2>&1
echo '--- reload ---'
systemctl reload nginx && echo 'nginx reloaded OK'
