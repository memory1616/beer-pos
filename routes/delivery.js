const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

const DISTRIBUTOR_NAME = process.env.DISTRIBUTOR_NAME || 'Bia Tuoi Gia Huy';

// PERFORMANCE: Serve HTML template, inject data via JSON
// Old version built entire HTML page with string concatenation — O(n²) for large customer lists
// New version serves a static template, injects data via <script>window.__DELIVERY_DATA__</script>

// GET /delivery — HTML page with server-side JSON injection
router.get('/', (req, res) => {
  const templatePath = path.join(__dirname, '..', 'views', 'delivery.html');
  fs.readFile(templatePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Template not found');

    try {
      const customers = db.prepare(
        'SELECT id, name, phone, lat, lng FROM customers WHERE archived = 0 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name'
      ).all();
      const settings = {};
      db.prepare('SELECT `key`, value FROM settings').all().forEach(s => { settings[s.key] = s.value; });
      const numSettings = {
        delivery_cost_per_km: parseFloat(settings.delivery_cost_per_km) || 3000,
        delivery_base_cost: parseFloat(settings.delivery_base_cost) || 0,
        distributor_lat: parseFloat(settings.distributor_lat) || 10.8231,
        distributor_lng: parseFloat(settings.distributor_lng) || 106.6297,
      };
      const dataJson = JSON.stringify({
        customers,
        settings: numSettings,
        hasGoogleApi: !!(process.env.GOOGLE_MAPS_API_KEY),
        distributorName: DISTRIBUTOR_NAME
      });
      html = html.replace('{{DELIVERY_DATA}}', dataJson);
      res.type('text/html').send(html);
    } catch (e) {
      res.status(500).send('Error loading delivery data');
    }
  });
});

module.exports = router;
