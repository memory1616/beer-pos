ln -sf /etc/nginx/sites-available/beerpos.conf /etc/nginx/sites-enabled/beerpos.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1
systemctl enable nginx
systemctl restart nginx
systemctl status nginx --no-pager | head -5
echo === Ports ===
ss -tlnp | head -20