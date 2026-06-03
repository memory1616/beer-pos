const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

const DISTRIBUTOR_NAME = process.env.DISTRIBUTOR_NAME || 'Bia Tuoi Gia Huy';

// GET /delivery — HTML page with server-side JSON injection
router.get('/', (req, res) => {
  const templatePath = path.join(__dirname, '..', 'views', 'delivery.html');
  fs.readFile(templatePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Template not found');

    try {
      // Lấy đơn hàng hôm nay - không cần khách có GPS
      const deliveries = db.prepare(`
        SELECT c.id, c.name, c.phone, c.lat, c.lng, s.id as sale_id, s.date, s.total
        FROM sales s
        JOIN customers c ON c.id = s.customer_id
        WHERE s.archived = 0 
          AND s.deleted = 0
          AND s.type = 'sale'
          AND DATE(s.date) = ?
          AND c.archived = 0
        ORDER BY s.date DESC
      `).all(today);

      // Map dữ liệu - thêm flag hasGPS
      const customers = deliveries.map(d => ({
        id: d.id,
        name: d.name,
        phone: d.phone,
        lat: d.lat,
        lng: d.lng,
        sale_id: d.sale_id,
        date: d.date,
        total: d.total,
        hasGPS: !!(d.lat && d.lng)
      }));

      const settings = {};
      db.prepare('SELECT `key`, value FROM settings').all().forEach(s => { settings[s.key] = s.value; });
      const numSettings = {
        delivery_cost_per_km: parseFloat(settings.delivery_cost_per_km) || 3000,
        delivery_base_cost: parseFloat(settings.delivery_base_cost) || 0,
        distributor_lat: parseFloat(settings.distributor_lat) || 10.7679,
        distributor_lng: parseFloat(settings.distributor_lng) || 106.6893,
      };
      const dataJson = JSON.stringify({
        customers,
        settings: numSettings,
        todayCount: customers.length,
        today: today,
        distributorName: DISTRIBUTOR_NAME
      });
      html = html.replace('{{DELIVERY_DATA}}', dataJson);
      res.type('text/html').send(html);
    } catch (e) {
      logger.error('Delivery page error:', e);
      res.status(500).send('Error loading delivery data');
    }
  });
});

module.exports = router;
