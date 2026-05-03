'use client';
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { clearCamerasFromStorage } from '@/lib/cameras';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Distance in meters between a point and a line segment using flat-earth approximation.
// Accurate enough for sub-kilometer distances.
function distanceToSegmentMeters(camLat, camLon, p1Lat, p1Lon, p2Lat, p2Lon) {
  const R = 6371000;
  const cosLat = Math.cos(((p1Lat + p2Lat) / 2) * (Math.PI / 180));

  const px = (camLon - p1Lon) * (Math.PI / 180) * R * cosLat;
  const py = (camLat - p1Lat) * (Math.PI / 180) * R;
  const dx = (p2Lon - p1Lon) * (Math.PI / 180) * R * cosLat;
  const dy = (p2Lat - p1Lat) * (Math.PI / 180) * R;

  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt(px * px + py * py);

  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
  return Math.sqrt((px - t * dx) ** 2 + (py - t * dy) ** 2);
}

function isCameraNearPath(camLat, camLon, pathCoords, thresholdMeters) {
  // pathCoords: [[lon, lat], ...] (GeoJSON / Mapbox order)
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const [lon1, lat1] = pathCoords[i];
    const [lon2, lat2] = pathCoords[i + 1];
    if (distanceToSegmentMeters(camLat, camLon, lat1, lon1, lat2, lon2) <= thresholdMeters) {
      return true;
    }
  }
  return false;
}

// Convert meters to degrees of latitude
function metersToDegLat(meters) {
  return meters / 111000;
}

// Convert meters to degrees of longitude at a given latitude
function metersToDegLon(meters, latDeg) {
  return meters / (111000 * Math.cos(latDeg * (Math.PI / 180)));
}

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const cameraMarkersRef = useRef([]);
  const pointsRef = useRef([]);
  const [points, setPoints] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-95.7129, 37.0902],
      zoom: 4
    });

    map.current.on('load', () => {
      map.current.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [] }
        }
      });

      map.current.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#E63946',
          'line-width': 4,
          'line-opacity': 0.9,
          'line-cap': 'round',
          'line-join': 'round'
        }
      });

      map.current.on('click', (e) => {
        const coord = [e.lngLat.lng, e.lngLat.lat];

        const el = document.createElement('div');
        el.style.cssText = `
          width: 14px;
          height: 14px;
          background: #E63946;
          border: 2.5px solid white;
          border-radius: 50%;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          cursor: pointer;
        `;

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat(coord)
          .addTo(map.current);

        markersRef.current.push(marker);
        pointsRef.current = [...pointsRef.current, coord];
        setPoints([...pointsRef.current]);

        map.current.getSource('route').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: pointsRef.current }
        });
      });

    });
  }, []);

  const clearRoute = () => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];
    pointsRef.current = [];
    setPoints([]);
    setCameras([]);
    clearCamerasFromStorage();
    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [] }
    });
  };

  const analyzeRoute = async () => {
    if (pointsRef.current.length < 2 || analyzing) return;
    setAnalyzing(true);

    // Clear previous camera markers before re-analyzing
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];

    const coords = pointsRef.current; // [[lon, lat], ...]
    const lons = coords.map(p => p[0]);
    const lats = coords.map(p => p[1]);

    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const midLat = (minLat + maxLat) / 2;

    // 25ft = 7.62m bbox padding
    const PAD_M = 7.62;
    const south = minLat - metersToDegLat(PAD_M);
    const north = maxLat + metersToDegLat(PAD_M);
    const west = minLon - metersToDegLon(PAD_M, midLat);
    const east = maxLon + metersToDegLon(PAD_M, midLat);

    try {
      const res = await fetch(
        `/api/cameras?south=${south}&west=${west}&north=${north}&east=${east}`
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { cameras: allCameras } = await res.json();

      // Keep cameras within 50m of any path segment
      // (cameras can surveil the path from up to ~50m away)
      const WATCH_RADIUS_M = 50;
      const nearby = allCameras.filter(cam =>
        isCameraNearPath(cam.lat, cam.lon, coords, WATCH_RADIUS_M)
      );

      // Persist to localStorage (merge by ID)
      const existing = JSON.parse(localStorage.getItem('surveillance_cameras') || '[]');
      const byId = new Map(existing.map(c => [c.id, c]));
      for (const c of nearby) {
        byId.set(c.id, { ...c, queriedAt: new Date().toISOString() });
      }
      localStorage.setItem('surveillance_cameras', JSON.stringify([...byId.values()]));

      // Render camera markers
      for (const cam of nearby) {
        const el = document.createElement('div');
        el.style.cssText = `
          width: 22px;
          height: 22px;
          background: #FFB703;
          border: 2px solid #c47c00;
          border-radius: 5px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.35);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          cursor: pointer;
        `;
        el.innerHTML = '📷';

        const popup = new mapboxgl.Popup({ offset: 14, closeButton: false })
          .setHTML(`
            <div style="font-size:12px;line-height:1.6;">
              <strong>Surveillance Camera</strong><br/>
              ${cam.tags?.name ? `Name: ${cam.tags.name}<br/>` : ''}
              ${cam.tags?.['surveillance:type'] ? `Type: ${cam.tags['surveillance:type']}<br/>` : ''}
              ${cam.tags?.operator ? `Operator: ${cam.tags.operator}<br/>` : ''}
              <span style="color:#888;">${cam.lat.toFixed(6)}, ${cam.lon.toFixed(6)}</span>
            </div>
          `);

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([cam.lon, cam.lat])
          .setPopup(popup)
          .addTo(map.current);

        cameraMarkersRef.current.push(marker);
      }

      setCameras(nearby);
    } catch (err) {
      console.error('Route analysis failed:', err);
    } finally {
      setAnalyzing(false);
    }
  };

  const statusText = () => {
    if (cameras.length > 0) {
      return `${cameras.length} camera${cameras.length !== 1 ? 's' : ''} watching your route`;
    }
    if (analyzing) return 'Querying surveillance data…';
    if (points.length === 0) return 'Click the map to start your route';
    return `${points.length} point${points.length !== 1 ? 's' : ''} · click to add more`;
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: 'system-ui, sans-serif' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Top header bar */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(8px)',
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 10, background: '#E63946', borderRadius: '50%' }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' }}>
            SurveillanceTracker
          </span>
        </div>
        <span style={{ fontSize: 13, color: cameras.length > 0 ? '#c47c00' : '#666', fontWeight: cameras.length > 0 ? 600 : 400 }}>
          {statusText()}
        </span>
      </div>

      {/* Bottom action bar */}
      {points.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: 30,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 10,
          zIndex: 10
        }}>
          <button
            onClick={clearRoute}
            style={{
              background: 'white',
              border: '1px solid #e0e0e0',
              padding: '12px 20px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}>
            🗑️ Clear
          </button>

          {points.length >= 2 && (
            <button
              onClick={analyzeRoute}
              disabled={analyzing}
              style={{
                background: analyzing ? '#999' : '#E63946',
                color: 'white',
                border: 'none',
                padding: '12px 24px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                cursor: analyzing ? 'default' : 'pointer',
                boxShadow: analyzing ? 'none' : '0 2px 12px rgba(230,57,70,0.4)',
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}>
              {analyzing ? 'Analyzing…' : 'Analyze Route →'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
