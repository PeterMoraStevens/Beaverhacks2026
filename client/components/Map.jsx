/* eslint-disable react-hooks/exhaustive-deps */
'use client';
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { clearCamerasFromStorage } from '@/lib/cameras';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import * as turf from '@turf/turf';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

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
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const [lon1, lat1] = pathCoords[i];
    const [lon2, lat2] = pathCoords[i + 1];
    if (distanceToSegmentMeters(camLat, camLon, lat1, lon1, lat2, lon2) <= thresholdMeters) return true;
  }
  return false;
}

function metersToDegLat(meters) { return meters / 111000; }
function metersToDegLon(meters, latDeg) { return meters / (111000 * Math.cos(latDeg * (Math.PI / 180))); }

function segmentLengthMeters(p1, p2) {
  const dx = (p2[0] - p1[0]) * Math.cos(p1[1] * Math.PI / 180) * 111000;
  const dy = (p2[1] - p1[1]) * 111000;
  return Math.sqrt(dx * dx + dy * dy);
}

function intensityToColor(normalized) {
  if (normalized < 0.25) return '#00C853';
  if (normalized < 0.5)  return '#FFD600';
  if (normalized < 0.75) return '#FF6D00';
  return '#E63946';
}

function computeRouteAnalysis(coords, cameras) {
  const THRESHOLD = 50;
  const segLengths = coords.slice(0, -1).map((p1, i) => segmentLengthMeters(p1, coords[i + 1]));
  const totalLength = segLengths.reduce((a, b) => a + b, 0);
  const segCameraCounts = coords.slice(0, -1).map((p1, i) => {
    const p2 = coords[i + 1];
    return cameras.filter(cam =>
      distanceToSegmentMeters(cam.lat, cam.lon, p1[1], p1[0], p2[1], p2[0]) <= THRESHOLD
    ).length;
  });
  const maxCount = Math.max(...segCameraCounts, 1);
  const positions = [0];
  let cumLen = 0;
  for (let i = 0; i < segLengths.length; i++) {
    cumLen += segLengths[i];
    positions.push(Math.min(cumLen / totalLength, 1));
  }
  const gradientStops = [];
  for (let i = 0; i < segCameraCounts.length; i++) {
    const color = intensityToColor(segCameraCounts[i] / maxCount);
    if (i === 0) gradientStops.push(0, color);
    gradientStops.push(positions[i + 1], color);
  }
  const graphData = coords.map((_, i) => ({
    distanceMi: parseFloat(((positions[i] * totalLength) / 1609.34).toFixed(2)),
    cameras: i < segCameraCounts.length ? segCameraCounts[i] : segCameraCounts[segCameraCounts.length - 1],
  }));
  const totalCameras = cameras.length;
  const routeMiles = totalLength / 1609.34;
  const score = Math.min(100, Math.round((totalCameras / Math.max(routeMiles, 0.05)) * 8));
  const worstCount = Math.max(...segCameraCounts);
  const worstIdx = segCameraCounts.indexOf(worstCount);
  return { gradientStops, graphData, score, totalCameras, worstCount, worstIdx, routeMiles: routeMiles.toFixed(2), segCameraCounts, maxCount };
}

// Mini route map drawn on canvas — colored by surveillance intensity
function MiniRouteMap({ coords, analysisData }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !coords || coords.length < 2) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 400;
    const H = canvas.offsetHeight || 120;
    canvas.width = W;
    canvas.height = H;

    ctx.clearRect(0, 0, W, H);

    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const pad = 20;

    const toX = (lng) => pad + ((lng - minLng) / (maxLng - minLng || 1)) * (W - pad * 2);
    const toY = (lat) => H - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (H - pad * 2);

    const counts = analysisData.segCameraCounts || analysisData.graphData.map(d => d.cameras);
    const maxCount = analysisData.maxCount || Math.max(...counts, 1);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;

    for (let i = 0; i < coords.length - 1; i++) {
      const normalized = (counts[i] || 0) / maxCount;
      ctx.strokeStyle = intensityToColor(normalized);
      ctx.beginPath();
      ctx.moveTo(toX(coords[i][0]), toY(coords[i][1]));
      ctx.lineTo(toX(coords[i + 1][0]), toY(coords[i + 1][1]));
      ctx.stroke();
    }

    // Start dot — white
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(toX(coords[0][0]), toY(coords[0][1]), 5, 0, Math.PI * 2);
    ctx.fill();

    // End dot — red
    ctx.fillStyle = '#E63946';
    ctx.beginPath();
    ctx.arc(toX(coords[coords.length - 1][0]), toY(coords[coords.length - 1][1]), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

  }, [coords, analysisData]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '120px', borderRadius: 12, background: 'rgba(255,255,255,0.07)', display: 'block' }}
    />
  );
}

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const cameraMarkersRef = useRef([]);
  const pointsRef = useRef([]);
  const markerClickedRef = useRef(false);
  const activeEndpointRef = useRef(null);
  const prependModeRef = useRef(false);
  const [points, setPoints] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [activeEndpointId, setActiveEndpointId] = useState(null);
  const [analysisData, setAnalysisData] = useState(null);
  const [showResults, setShowResults] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);

  useEffect(() => {
    if (showResults) {
      setTimeout(() => setPanelVisible(true), 30);
    } else {
      setPanelVisible(false);
    }
  }, [showResults]);

  useEffect(() => {
    if (map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-95.7129, 37.0902],
      zoom: 4
    });
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
        lineMetrics: true,
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
      });
      map.current.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#E63946', 1, '#E63946'],
          'line-width': 5,
          'line-opacity': 0.95
        }
      });
      map.current.on('click', 'route-line', (e) => {
        e.preventDefault();
        markerClickedRef.current = true;
        const coord = [e.lngLat.lng, e.lngLat.lat];
        const coords = pointsRef.current;
        let closestSegment = 0, closestDist = Infinity;
        for (let i = 0; i < coords.length - 1; i++) {
          const [x1, y1] = coords[i], [x2, y2] = coords[i + 1], [cx, cy] = coord;
          const dx = x2 - x1, dy = y2 - y1;
          const lenSq = dx * dx + dy * dy;
          const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / lenSq));
          const dist = Math.sqrt((cx - x1 - t * dx) ** 2 + (cy - y1 - t * dy) ** 2);
          if (dist < closestDist) { closestDist = dist; closestSegment = i; }
        }
        insertPoint(coord, closestSegment + 1);
      });
      map.current.on('mouseenter', 'route-line', () => { map.current.getCanvas().style.cursor = 'crosshair'; });
      map.current.on('mouseleave', 'route-line', () => { map.current.getCanvas().style.cursor = ''; });
      map.current.on('click', (e) => {
        if (markerClickedRef.current) { markerClickedRef.current = false; return; }
        addPoint([e.lngLat.lng, e.lngLat.lat]);
      });
    });
  }, []);

  const animateRouteDraw = (coords, gradientStops, onComplete) => {
    setAnimating(true);
    const line = turf.lineString(coords);
    const totalLengthKm = turf.length(line, { units: 'kilometers' });
    const DURATION = 1800;
    const start = performance.now();

    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [coords[0], coords[0]] }
    });
    map.current.setPaintProperty('route-line', 'line-gradient', [
      'interpolate', ['linear'], ['line-progress'], 0, '#E63946', 1, '#E63946'
    ]);

    const frame = (now) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / DURATION, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const distance = eased * totalLengthKm;
      try {
        const sliced = turf.lineSliceAlong(line, 0, Math.max(distance, 0.0001), { units: 'kilometers' });
        map.current.getSource('route').setData(sliced);
      } catch (e) { /* ignore */ }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        map.current.getSource('route').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords }
        });
        if (gradientStops.length >= 2) {
          map.current.setPaintProperty('route-line', 'line-gradient', [
            'interpolate', ['linear'], ['line-progress'], ...gradientStops
          ]);
        }
        setAnimating(false);
        onComplete();
      }
    };
    requestAnimationFrame(frame);
  };

  const updateRoute = (coords) => {
    if (!map.current.getSource('route')) return;
    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords }
    });
  };

  const resetRouteColor = () => {
    if (!map.current.getLayer('route-line')) return;
    map.current.setPaintProperty('route-line', 'line-gradient', [
      'interpolate', ['linear'], ['line-progress'], 0, '#E63946', 1, '#E63946'
    ]);
  };

  const setActiveEndpoint = (id) => {
    if (activeEndpointRef.current) {
      const prev = markersRef.current.find(m => m._id === activeEndpointRef.current);
      if (prev) prev._el.style.border = '2.5px solid white';
    }
    if (id) {
      const next = markersRef.current.find(m => m._id === id);
      if (next) next._el.style.border = '3px solid #2196F3';
    }
    activeEndpointRef.current = id;
    setActiveEndpointId(id);
  };

  const setPrependMode = (id) => { prependModeRef.current = true; setActiveEndpoint(id); };

  const deletePoint = (id) => {
    const index = markersRef.current.findIndex(m => m._id === id);
    if (index === -1) return;
    markersRef.current[index].remove();
    markersRef.current.splice(index, 1);
    pointsRef.current.splice(index, 1);
    if (activeEndpointRef.current === id) {
      const lastId = markersRef.current.length > 0 ? markersRef.current[markersRef.current.length - 1]._id : null;
      setActiveEndpoint(lastId);
    }
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };

  const createMarkerElement = () => {
    const el = document.createElement('div');
    el.style.cssText = `width:16px;height:16px;background:#E63946;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:grab;`;
    return el;
  };

  const createPopupContent = (onDelete, onSetEndpoint, onPrepend) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:2px;';
    if (onPrepend) {
      const btn = document.createElement('button');
      btn.innerText = '⬆️ Add point before this';
      btn.style.cssText = `background:#9C27B0;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); onPrepend(); });
      wrapper.appendChild(btn);
    }
    const extendBtn = document.createElement('button');
    extendBtn.innerText = '📍 Extend from here';
    extendBtn.style.cssText = `background:#2196F3;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;`;
    extendBtn.addEventListener('click', (e) => { e.stopPropagation(); onSetEndpoint(); });
    const deleteBtn = document.createElement('button');
    deleteBtn.innerText = 'Remove point';
    deleteBtn.style.cssText = `background:#E63946;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;`;
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    wrapper.appendChild(extendBtn);
    wrapper.appendChild(deleteBtn);
    return wrapper;
  };

  const attachDragListeners = (marker, id) => {
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

  const createMarker = (coord) => {
    const id = `marker-${Date.now()}-${Math.random()}`;
    const el = createMarkerElement();
    const popup = new mapboxgl.Popup({ offset: 20, closeButton: true });
    const marker = new mapboxgl.Marker({ element: el, draggable: true })
      .setLngLat(coord).setPopup(popup).addTo(map.current);
    marker._id = id;
    marker._el = el;
    const refreshPopup = () => {
      const isFirst = markersRef.current[0]?._id === id;
      popup.setDOMContent(createPopupContent(
        () => { popup.remove(); deletePoint(id); },
        () => { popup.remove(); setActiveEndpoint(id); },
        isFirst ? () => { popup.remove(); setPrependMode(id); } : null
      ));
    };
    refreshPopup();
    marker._refreshPopup = refreshPopup;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      markerClickedRef.current = true;
      refreshPopup();
      marker.togglePopup();
    });
    attachDragListeners(marker, id);
    return { marker, id };
  };

  const insertPoint = (coord, insertIndex) => {
    const { marker, id } = createMarker(coord);
    markersRef.current.splice(insertIndex, 0, marker);
    pointsRef.current.splice(insertIndex, 0, coord);
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };

  const addPoint = (coord) => {
    const { marker, id } = createMarker(coord);
    if (prependModeRef.current) {
      prependModeRef.current = false;
      markersRef.current.splice(0, 0, marker);
      pointsRef.current.splice(0, 0, coord);
      setPoints([...pointsRef.current]);
      updateRoute([...pointsRef.current]);
      setActiveEndpoint(id);
      markersRef.current.forEach(m => m._refreshPopup?.());
      return;
    }
    if (activeEndpointRef.current && markersRef.current.length > 0) {
      const activeIndex = markersRef.current.findIndex(m => m._id === activeEndpointRef.current);
      if (activeIndex !== -1 && activeIndex < markersRef.current.length - 1) {
        markersRef.current.splice(activeIndex + 1, 0, marker);
        pointsRef.current.splice(activeIndex + 1, 0, coord);
        setPoints([...pointsRef.current]);
        updateRoute([...pointsRef.current]);
        setActiveEndpoint(id);
        markersRef.current.forEach(m => m._refreshPopup?.());
        return;
      }
    }
    markersRef.current.push(marker);
    pointsRef.current = [...pointsRef.current, coord];
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };

  const clearRoute = () => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];
    pointsRef.current = [];
    prependModeRef.current = false;
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    setAnalysisData(null);
    setShowResults(false);
    setAnimating(false);
    clearCamerasFromStorage();
    updateRoute([]);
    resetRouteColor();
  };

  const analyzeRoute = async () => {
    if (pointsRef.current.length < 2 || analyzing || animating) return;
    setAnalyzing(true);
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];

    const coords = pointsRef.current;
    const lons = coords.map(p => p[0]), lats = coords.map(p => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const midLat = (minLat + maxLat) / 2;
    const PAD_M = 7.62;
    const south = minLat - metersToDegLat(PAD_M);
    const north = maxLat + metersToDegLat(PAD_M);
    const west  = minLon - metersToDegLon(PAD_M, midLat);
    const east  = maxLon + metersToDegLon(PAD_M, midLat);

    try {
      const res = await fetch(`/api/cameras?south=${south}&west=${west}&north=${north}&east=${east}`);
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { cameras: allCameras } = await res.json();

      const WATCH_RADIUS_M = 50;
      const nearby = allCameras.filter(cam => isCameraNearPath(cam.lat, cam.lon, coords, WATCH_RADIUS_M));

      const existing = JSON.parse(localStorage.getItem('surveillance_cameras') || '[]');
      const byId = new globalThis.Map(existing.map(c => [c.id, c]));
      for (const c of nearby) byId.set(c.id, { ...c, queriedAt: new Date().toISOString() });
      localStorage.setItem('surveillance_cameras', JSON.stringify([...byId.values()]));

      const analysis = computeRouteAnalysis(coords, nearby);

      for (const cam of nearby) {
        const el = document.createElement('div');
        el.style.cssText = `width:22px;height:22px;background:#FFB703;border:2px solid #c47c00;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:13px;cursor:pointer;`;
        el.innerHTML = '📷';
        const popup = new mapboxgl.Popup({ offset: 14, closeButton: false })
          .setHTML(`<div style="font-size:12px;line-height:1.6;"><strong>Surveillance Camera</strong><br/>${cam.tags?.name ? `Name: ${cam.tags.name}<br/>` : ''}${cam.tags?.['surveillance:type'] ? `Type: ${cam.tags['surveillance:type']}<br/>` : ''}${cam.tags?.operator ? `Operator: ${cam.tags.operator}<br/>` : ''}<span style="color:#888;">${cam.lat.toFixed(6)}, ${cam.lon.toFixed(6)}</span></div>`);
        const marker = new mapboxgl.Marker({ element: el }).setLngLat([cam.lon, cam.lat]).setPopup(popup).addTo(map.current);
        cameraMarkersRef.current.push(marker);
      }

      setCameras(nearby);
      setAnalysisData(analysis);
      setAnalyzing(false);

      animateRouteDraw(coords, analysis.gradientStops, () => {
        setTimeout(() => setShowResults(true), 200);
      });

    } catch (err) {
      console.error('Route analysis failed:', err);
      setAnalyzing(false);
    }
  };

    const handleSearch = async (value) => {
    setSearch(value);
    if (showResults) setShowResults(false); // ← add this
    if (analysisData) setAnalysisData(null); // ← add this
    if (value.length < 2) { setSuggestions([]); return; }
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?types=place&country=us&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}`);
    const data = await res.json();
    setSuggestions(data.features || []);
    };

    const selectCity = (feature) => {
    setShowResults(false);
    setAnalysisData(null);
    const [lng, lat] = feature.center;
    map.current.flyTo({ center: [lng, lat], zoom: 13, duration: 1500 });
    setSearch(feature.place_name);
    setSuggestions([]);
    clearRoute();
    };  

  const scoreColor = !analysisData ? '#fff'
    : analysisData.score < 30 ? '#00C853'
    : analysisData.score < 60 ? '#FFD600'
    : '#E63946';

  const scoreLabel = !analysisData ? ''
    : analysisData.score < 30 ? 'Low Risk'
    : analysisData.score < 60 ? 'Moderate'
    : 'High Risk';

  const isLoading = analyzing || animating;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', fontFamily: 'system-ui, sans-serif' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Dark overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 8,
        pointerEvents: (animating || showResults) ? 'auto' : 'none',
        opacity: (animating || panelVisible) ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }} onClick={() => { if (!animating) setShowResults(false); }} />

      {/* Top header bar */}
      <div onClick={(e) => e.stopPropagation()} style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        background: 'white', padding: '12px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)', zIndex: 10, gap: 16,
        borderBottom: '1px solid #e0e0e0', color: '#111'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 10, height: 10, background: '#E63946', borderRadius: '50%' }} />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px', color: '#111' }}>SurveillanceTracker</span>
        </div>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <input type="text" placeholder="Search a city..." value={search}
            onChange={(e) => handleSearch(e.target.value)}
            style={{ width: '100%', padding: '8px 14px', borderRadius: 8, border: '1px solid #ccc', fontSize: 13, outline: 'none', boxSizing: 'border-box', color: '#111', background: '#f5f5f5' }}
          />
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: 'white', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', overflow: 'hidden', zIndex: 20 }}>
              {suggestions.map((s) => (
                <div key={s.id} onClick={() => selectCity(s)}
                  style={{ padding: '10px 14px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f0f0f0', color: '#111' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f9f9f9'}
                  onMouseLeave={e => e.currentTarget.style.background = 'white'}
                >{s.place_name}</div>
              ))}
            </div>
          )}
        </div>
        <span style={{ fontSize: 13, color: cameras.length > 0 ? '#c47c00' : activeEndpointId ? '#2196F3' : '#444', fontWeight: cameras.length > 0 || activeEndpointId ? 600 : 400, flexShrink: 0 }}>
          {analyzing ? 'Fetching cameras…'
            : animating ? 'Analyzing your route…'
            : cameras.length > 0 ? `📷 ${cameras.length} camera${cameras.length !== 1 ? 's' : ''} detected`
            : points.length === 0 ? 'Click map to add points'
            : activeEndpointId
              ? prependModeRef.current ? '⬆️ Adding before first point — click map' : '📍 Extending from selected point — click map'
              : `${points.length} point${points.length !== 1 ? 's' : ''} · click pin to select`}
        </span>
      </div>

      {/* Results — floating over map, no box */}
      {showResults && analysisData && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: panelVisible
            ? 'translate(-50%, -50%) scale(1)'
            : 'translate(-50%, -50%) scale(0.9)',
          opacity: panelVisible ? 1 : 0,
          transition: 'all 0.4s cubic-bezier(0.32, 0.72, 0, 1)',
          zIndex: 9,
          width: '90%',
          maxWidth: 420,
          textAlign: 'center',
        }}>
          {/* Close button */}
          <button onClick={() => setShowResults(false)} style={{
            position: 'absolute', top: -8, right: 0,
            width: 30, height: 30, borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.25)',
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            cursor: 'pointer', fontSize: 18,
            display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'white'
          }}>×</button>

          {/* Mini route preview */}
          <div style={{ marginBottom: 20 }}>
            <MiniRouteMap coords={pointsRef.current} analysisData={analysisData} />
          </div>

          {/* Big score */}
          <div style={{ fontSize: 88, fontWeight: 900, lineHeight: 1, color: scoreColor, letterSpacing: '-4px', textShadow: '0 2px 24px rgba(0,0,0,0.6)' }}>
            {analysisData.score}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: scoreColor, textTransform: 'uppercase', letterSpacing: 3, marginBottom: 28, textShadow: '0 1px 8px rgba(0,0,0,0.5)' }}>
            {scoreLabel}
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 36, marginBottom: 24 }}>
            {[
              { value: analysisData.totalCameras, label: 'Cameras' },
              { value: `${analysisData.routeMiles}`, label: 'Miles' },
              { value: analysisData.worstCount, label: 'Worst Block', color: '#E63946' },
            ].map(({ value, label, color }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 30, fontWeight: 900, color: color || 'white', letterSpacing: '-1px', textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>{value}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Exposure graph */}
          <ResponsiveContainer width="100%" height={70}>
            <AreaChart data={analysisData.graphData} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="exposureGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#E63946" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#E63946" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="distanceMi" tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.4)' }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.8)', color: '#fff' }}
                formatter={(value) => [`${value} cameras`, 'Exposure']}
                labelFormatter={(label) => `${label} mi`}
              />
              <Area type="monotone" dataKey="cameras" stroke="#E63946" strokeWidth={2}
                fill="url(#exposureGradient)" isAnimationActive={true} animationDuration={1000} />
            </AreaChart>
          </ResponsiveContainer>

          {/* Legend */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 14 }}>
            {[['#00C853', 'Low'], ['#FFD600', 'Medium'], ['#FF6D00', 'High'], ['#E63946', 'Severe']].map(([color, label]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                <div style={{ width: 14, height: 3, background: color, borderRadius: 2 }} /> {label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom action bar */}
      {!showResults && !animating && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'absolute', bottom: 30, left: '50%',
          transform: 'translateX(-50%)', display: 'flex', gap: 10, zIndex: 10
        }}>
          <button onClick={(e) => { e.stopPropagation(); clearRoute(); }} style={{
            background: 'white', border: '1px solid #e0e0e0', padding: '12px 20px',
            borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(0,0,0,0.12)', display: 'flex', alignItems: 'center', gap: 6, color: '#111'
          }}>🗑️ Clear</button>

          <button onClick={(e) => { e.stopPropagation(); analyzeRoute(); }}
            disabled={points.length < 2 || isLoading}
            style={{
              background: points.length < 2 || isLoading ? '#ccc' : '#E63946',
              color: 'white', border: 'none', padding: '12px 24px', borderRadius: 10,
              fontSize: 13, fontWeight: 700,
              cursor: points.length < 2 || isLoading ? 'not-allowed' : 'pointer',
              boxShadow: points.length >= 2 && !isLoading ? '0 2px 12px rgba(230,57,70,0.4)' : 'none',
              display: 'flex', alignItems: 'center', gap: 6
            }}>
            {analyzing ? 'Fetching…' : animating ? 'Analyzing…' : 'Analyze Route →'}
          </button>
        </div>
      )}
    </div>
  );
}