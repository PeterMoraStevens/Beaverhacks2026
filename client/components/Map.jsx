/* eslint-disable react-hooks/immutability */
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
  const markerClickedRef = useRef(false);
  const [points, setPoints] = useState([]);
  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-95.7129, 37.0902],
      zoom: 4
    });

    // automatically zoom to user's location on load
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      fitBoundsOptions: { maxZoom: 15 }
    });
    
    map.current.addControl(geolocate);

    map.current.doubleClickZoom.disable();

    map.current.on('load', () => {
      geolocate.trigger(); 

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
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#E63946',
          'line-width': 4,
          'line-opacity': 0.9
        }
      });

      map.current.on('click', (e) => {
        if (markerClickedRef.current) {
          markerClickedRef.current = false;
          return;
        }
        addPoint([e.lngLat.lng, e.lngLat.lat]);
      });
    });
  }, []);

  const updateRoute = (coords) => {
    if (!map.current.getSource('route')) return;
    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords }
    });
  };

  const deletePoint = (id) => {
    const index = markersRef.current.findIndex(m => m._id === id);
    if (index === -1) return;

    markersRef.current[index].remove();
    markersRef.current.splice(index, 1);
    pointsRef.current.splice(index, 1);

    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
  };

  const addPoint = (coord) => {
    const id = `marker-${Date.now()}-${Math.random()}`;

    const el = document.createElement('div');
    el.style.cssText = `
      width: 16px;
      height: 16px;
      background: #E63946;
      border: 2.5px solid white;
      border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      cursor: grab;
    `;

    const deleteBtn = document.createElement('button');
    deleteBtn.innerText = 'Remove point';
    deleteBtn.style.cssText = `
      background: #E63946;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    `;

    const popup = new mapboxgl.Popup({ offset: 20, closeButton: true })
      .setDOMContent(deleteBtn);

    const marker = new mapboxgl.Marker({ element: el, draggable: true })
      .setLngLat(coord)
      .setPopup(popup)
      .addTo(map.current);

    marker._id = id;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      markerClickedRef.current = true;
      marker.togglePopup();
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popup.remove();
      deletePoint(id);
    });

    markersRef.current.push(marker);
    pointsRef.current = [...pointsRef.current, coord];
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);

    marker.on('drag', () => {
      const index = markersRef.current.findIndex(m => m._id === id);
      if (index === -1) return;
      const lngLat = marker.getLngLat();
      pointsRef.current[index] = [lngLat.lng, lngLat.lat];
      updateRoute([...pointsRef.current]);
    });

    marker.on('dragend', () => {
      const index = markersRef.current.findIndex(m => m._id === id);
      if (index === -1) return;
      const lngLat = marker.getLngLat();
      pointsRef.current[index] = [lngLat.lng, lngLat.lat];
      setPoints([...pointsRef.current]);
      updateRoute([...pointsRef.current]);
    });
  };

  const clearRoute = () => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];
    pointsRef.current = [];
    setPoints([]);
    updateRoute([]);
  };

  const analyzeRoute = () => {
    console.log('Analyzing route:', pointsRef.current);
  };

  const handleSearch = async (value) => {
    setSearch(value);
    if (value.length < 2) { setSuggestions([]); return; }
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?types=place&country=us&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}`
    );
    const data = await res.json();
    setSuggestions(data.features || []);
  };

  const selectCity = (feature) => {
    const [lng, lat] = feature.center;
    map.current.flyTo({ center: [lng, lat], zoom: 13, duration: 1500 });
    setSearch(feature.place_name);
    setSuggestions([]);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: 'system-ui, sans-serif' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Top header bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          background: 'white',
          opacity: 1,
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          zIndex: 10,
          gap: 16,
          borderBottom: '1px solid #e0e0e0',
          color: '#111'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 10, height: 10, background: '#E63946', borderRadius: '50%' }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px', color: '#111' }}>
            SurveillanceTracker
          </span>
        </div>

        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <input
            type="text"
            placeholder="Search a city..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #ccc',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
              color: '#111',
              background: '#f5f5f5'
            }}
          />
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '110%',
              left: 0, right: 0,
              background: 'white',
              borderRadius: 8,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              overflow: 'hidden',
              zIndex: 20
            }}>
              {suggestions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => selectCity(s)}
                  style={{
                    padding: '10px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                    borderBottom: '1px solid #f0f0f0',
                    color: '#111'
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f9f9f9'}
                  onMouseLeave={e => e.currentTarget.style.background = 'white'}
                >
                  {s.place_name}
                </div>
              ))}
            </div>
          )}
        </div>

        <span style={{ fontSize: 13, color: '#444', flexShrink: 0 }}>
          {points.length === 0
            ? 'Click map to add points'
            : `${points.length} point${points.length !== 1 ? 's' : ''} · click pin to delete`}
        </span>
      </div>

      {/* Bottom action bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          bottom: 30,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 10,
          zIndex: 10
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); clearRoute(); }}
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
            gap: 6,
            color: '#111'
          }}>
          🗑️ Clear
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); if (points.length >= 2) analyzeRoute(); }}
          style={{
            background: points.length >= 2 ? '#E63946' : '#ccc',
            color: 'white',
            border: 'none',
            padding: '12px 24px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            cursor: points.length >= 2 ? 'pointer' : 'not-allowed',
            boxShadow: points.length >= 2 ? '0 2px 12px rgba(230,57,70,0.4)' : 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}>
          Analyze Route →
        </button>
      </div>
    </div>
  );
}
