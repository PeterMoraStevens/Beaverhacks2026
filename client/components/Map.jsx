'use client';
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export default function Map() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const pointsRef = useRef([]);
  const [points, setPoints] = useState([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-95.7129, 37.0902], // USA center
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
          geometry: {
            type: 'LineString',
            coordinates: pointsRef.current
          }
        });
      });

      setIsReady(true);
    });
  }, []);

  const clearRoute = () => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    pointsRef.current = [];
    setPoints([]);
    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [] }
    });
  };

  const analyzeRoute = () => {
    console.log('Analyzing route:', pointsRef.current);
    // Scoring logic plugs in here
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
          <div style={{
            width: 10, height: 10,
            background: '#E63946',
            borderRadius: '50%'
          }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' }}>
            SurveillanceTracker
          </span>
        </div>
        <span style={{ fontSize: 13, color: '#666' }}>
          {points.length === 0
            ? 'Click the map to start your route'
            : `${points.length} point${points.length !== 1 ? 's' : ''} · click to add more`}
        </span>
      </div>

      {/* Bottom action bar — only shows when points exist */}
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
              style={{
                background: '#E63946',
                color: 'white',
                border: 'none',
                padding: '12px 24px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 2px 12px rgba(230,57,70,0.4)',
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}>
              Analyze Route →
            </button>
          )}
        </div>
      )}
    </div>
  );
}