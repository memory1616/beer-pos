/**
 * Routing Service - Real driving distance & route optimization
 * Uses Google Maps Directions API with simple caching
 */

const https = require('https');

// Simple in-memory cache (would be better with Redis in production)
const routeCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Decode Google Maps encoded polyline to array of [lat, lng] coordinates
 * @param {string} encoded - Encoded polyline string
 * @returns {Array} Array of [lat, lng] coordinates
 */
function decodePolyline(encoded) {
  const poly = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    poly.push([lat / 1e5, lng / 1e5]);
  }

  return poly;
}

/**
 * Get route between two points using Google Maps Directions API
 * @param {Object} origin - { lat, lng }
 * @param {Object} destination - { lat, lng }
 * @returns {Promise<{distance_km: number, duration_min: number, polyline: string}>}
 */
async function getRoute(origin, destination) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY not configured');
  }

  // Create cache key
  const cacheKey = `${origin.lat},${origin.lng}-${destination.lat},${destination.lng}`;
  
  // Check cache
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const originStr = `${origin.lat},${origin.lng}`;
  const destStr = `${destination.lat},${destination.lng}`;
  
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originStr}&destination=${destStr}&mode=driving&key=${apiKey}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          
          if (result.status === 'OK' && result.routes.length > 0) {
            const route = result.routes[0];
            const leg = route.legs[0];
            
            const response = {
              distance_km: leg.distance.value / 1000, // Convert meters to km
              duration_min: Math.round(leg.duration.value / 60), // Convert seconds to minutes
              polyline: route.overview_polyline.points,
              decodedPath: decodePolyline(route.overview_polyline.points) // Array of [lat, lng]
            };
            
            // Cache the result
            routeCache.set(cacheKey, {
              timestamp: Date.now(),
              data: response
            });
            
            resolve(response);
          } else if (result.status === 'ZERO_RESULTS') {
            reject(new Error('No driving route found between these points'));
          } else {
            reject(new Error(`Google API error: ${result.status}`));
          }
        } catch (e) {
          reject(new Error('Failed to parse Google API response'));
        }
      });
    }).on('error', (e) => {
      reject(new Error('Network error calling Google API: ' + e.message));
    });
  });
}

/**
 * Optimize multi-stop delivery route using Nearest Neighbor algorithm
 * @param {Object} warehouse - { lat, lng }
 * @param {Array} customers - Array of { id, lat, lng, name }
 * @returns {Array} Ordered list of customers with route index
 */
function optimizeRoute(warehouse, customers) {
  if (!customers || customers.length === 0) return [];
  if (customers.length === 1) {
    return [{ ...customers[0], routeIndex: 0 }];
  }

  const remaining = customers.map(c => ({ ...c }));
  const optimized = [];
  
  let currentLat = warehouse.lat;
  let currentLng = warehouse.lng;

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineDistance(currentLat, currentLng, remaining[i].lat, remaining[i].lng);
      if (dist < nearestDistance) {
        nearestDistance = dist;
        nearestIndex = i;
      }
    }

    const nearest = remaining.splice(nearestIndex, 1)[0];
    optimized.push({
      ...nearest,
      routeIndex: optimized.length,
      distanceFromPrevious: nearestDistance
    });

    currentLat = nearest.lat;
    currentLng = nearest.lng;
  }

  return optimized;
}

/**
 * Calculate total route distance and duration
 * @param {Object} warehouse - { lat, lng }
 * @param {Array} orderedCustomers - Array of customers from optimizeRoute
 * @returns {Promise<{totalDistanceKm: number, totalDurationMin: number}>}
 */
async function calculateTotalRoute(warehouse, orderedCustomers) {
  let totalDistance = 0;
  let totalDuration = 0;

  // Distance from warehouse to first customer
  if (orderedCustomers.length > 0) {
    const firstRoute = await getRoute(warehouse, {
      lat: orderedCustomers[0].lat,
      lng: orderedCustomers[0].lng
    });
    totalDistance += firstRoute.distance_km;
    totalDuration += firstRoute.duration_min;
  }

  // Distance between consecutive customers
  for (let i = 0; i < orderedCustomers.length - 1; i++) {
    const current = orderedCustomers[i];
    const next = orderedCustomers[i + 1];

    const route = await getRoute(
      { lat: current.lat, lng: current.lng },
      { lat: next.lat, lng: next.lng }
    );

    totalDistance += route.distance_km;
    totalDuration += route.duration_min;
  }

  return {
    totalDistanceKm: Math.round(totalDistance * 10) / 10,
    totalDurationMin: Math.round(totalDuration)
  };
}

/**
 * Haversine distance calculation (for nearest neighbor algorithm)
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Clear route cache
 */
function clearCache() {
  routeCache.clear();
}

module.exports = {
  getRoute,
  optimizeRoute,
  calculateTotalRoute,
  clearCache,
  decodePolyline
};