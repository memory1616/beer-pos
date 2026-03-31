const express = require('express');
const router = express.Router();
const db = require('../../database');
const routingService = require('../../src/services/routingService');
const logger = require('../../src/utils/logger');

const { decodePolyline } = routingService;

/**
 * GET /api/routing/route - Get route between two points
 * Query: originLat, originLng, destLat, destLng
 */
router.get('/route', async (req, res) => {
  try {
    const { originLat, originLng, destLat, destLng } = req.query;

    if (!originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    const result = await routingService.getRoute(
      { lat: parseFloat(originLat), lng: parseFloat(originLng) },
      { lat: parseFloat(destLat), lng: parseFloat(destLng) }
    );

    res.json(result);
  } catch (err) {
    logger.error('GET /api/routing/route failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routing/optimize - Optimize multi-stop delivery route
 * Body: { warehouse: { lat, lng }, customers: [{ id, lat, lng, name }] }
 */
router.post('/optimize', async (req, res) => {
  try {
    const { warehouse, customers } = req.body;

    if (!warehouse || !warehouse.lat || !warehouse.lng) {
      return res.status(400).json({ error: 'Missing warehouse coordinates' });
    }

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: 'Missing customers array' });
    }

    // Filter customers with valid coordinates
    const validCustomers = customers.filter(c => c.lat && c.lng);
    
    if (validCustomers.length === 0) {
      return res.status(400).json({ error: 'No valid customer coordinates' });
    }

    // Use nearest neighbor for optimization
    const optimized = routingService.optimizeRoute(warehouse, validCustomers);

    res.json({
      success: true,
      optimizedRoute: optimized,
      totalStops: optimized.length
    });
  } catch (err) {
    logger.error('POST /api/routing/optimize failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routing/calculate-total - Calculate total distance & duration for route
 * Body: { warehouse: { lat, lng }, customers: [{ id, lat, lng, name }] }
 */
router.post('/calculate-total', async (req, res) => {
  try {
    const { warehouse, customers } = req.body;

    if (!warehouse || !warehouse.lat || !warehouse.lng) {
      return res.status(400).json({ error: 'Missing warehouse coordinates' });
    }

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: 'Missing customers array' });
    }

    const validCustomers = customers.filter(c => c.lat && c.lng);
    
    // First optimize the route
    const optimized = routingService.optimizeRoute(warehouse, validCustomers);
    
    // Then calculate total distance and duration
    const totals = await routingService.calculateTotalRoute(warehouse, optimized);

    res.json({
      ...totals,
      totalStops: optimized.length,
      costPerKm: parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_cost_per_km')?.value || 3000),
      baseCost: parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_base_cost')?.value || 0)
    });
  } catch (err) {
    logger.error('POST /api/routing/calculate-total failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/routing/settings - Get warehouse location
 */
router.get('/settings', (req, res) => {
  try {
    const distLat = db.prepare('SELECT value FROM settings WHERE key = ?').get('distributor_lat');
    const distLng = db.prepare('SELECT value FROM settings WHERE key = ?').get('distributor_lng');

    res.json({
      warehouse: {
        lat: distLat ? parseFloat(distLat.value) : 10.8231,
        lng: distLng ? parseFloat(distLng.value) : 106.6297
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/routing/save-route - Save route data to sale order
 * Body: { saleId, distance_km, duration_min, route_index, route_polyline }
 */
router.post('/save-route', (req, res) => {
  try {
    const { saleId, distance_km, duration_min, route_index, route_polyline } = req.body;

    if (!saleId) {
      return res.status(400).json({ error: 'Missing saleId' });
    }

    const updates = [];
    const values = [];

    if (distance_km !== undefined) {
      updates.push('distance_km = ?');
      values.push(distance_km);
    }
    if (duration_min !== undefined) {
      updates.push('duration_min = ?');
      values.push(duration_min);
    }
    if (route_index !== undefined) {
      updates.push('route_index = ?');
      values.push(route_index);
    }
    if (route_polyline !== undefined) {
      updates.push('route_polyline = ?');
      values.push(route_polyline);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(saleId);
    db.prepare(`UPDATE sales SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ success: true });
  } catch (err) {
    logger.error('POST /api/routing/save-route failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;