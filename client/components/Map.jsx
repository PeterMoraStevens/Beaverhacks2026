/* eslint-disable react-hooks/exhaustive-deps */
'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { clearCamerasFromStorage } from '@/lib/cameras';
import { samplePoints, fetchCamerasNearPoint } from '@/lib/geoanalysis';


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

function camerasToGeoJSON(cameras) {
  return {
    type: 'FeatureCollection',
    features: cameras.map(cam => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [cam.lon, cam.lat] },
      properties: { ...cam.tags, _id: cam.id, _lat: cam.lat, _lon: cam.lon }
    }))
  };
}

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const pointsRef = useRef([]);
  const markerClickedRef = useRef(false);
  const activeEndpointRef = useRef(null);
  const prependModeRef = useRef(false);
  const addPointRef = useRef(null);
  const insertPointRef = useRef(null);
  const analysisActiveRef = useRef(false);
  const [points, setPoints] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [search, setSearch] = useState('');
  const [currentLocation, setCurrentLocation] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [activeEndpointId, setActiveEndpointId] = useState(null);


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

    geolocate.on('geolocate', (e) => {
      setCurrentLocation([e.coords.longitude, e.coords.latitude]);
    });
    
    map.current.addControl(geolocate, 'bottom-left');

    map.current.doubleClickZoom.disable();

    map.current.on('load', () => {
      geolocate.trigger();

      // ── Route ──────────────────────────────────────────────────────────────
      map.current.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
      });
      map.current.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#E63946', 'line-width': 4, 'line-opacity': 0.9 }
      });

      // ── Camera cluster source ───────────────────────────────────────────────
      map.current.addSource('cameras', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 50
      });

      // Cluster bubbles — color + size scale with point_count
      map.current.addLayer({
        id: 'camera-clusters',
        type: 'circle',
        source: 'cameras',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step', ['get', 'point_count'],
            '#FFB703',  // yellow   < 10
            10, '#FB8500', // orange  10–49
            50, '#E63946'  // red    ≥ 50
          ],
          'circle-radius': [
            'step', ['get', 'point_count'],
            18,      // < 10
            10, 24,  // 10–49
            50, 32   // ≥ 50
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.92
        }
      });

      // Count labels inside cluster bubbles
      map.current.addLayer({
        id: 'camera-cluster-count',
        type: 'symbol',
        source: 'cameras',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 13
        },
        paint: { 'text-color': '#fff' }
      });

      // Individual camera dots (unclustered)
      map.current.addLayer({
        id: 'camera-unclustered',
        type: 'circle',
        source: 'cameras',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#FFB703',
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#c47c00',
          'circle-opacity': 0.95
        }
      });

      // Click cluster → zoom into it
      map.current.on('click', 'camera-clusters', (e) => {
        markerClickedRef.current = true;
        const features = map.current.queryRenderedFeatures(e.point, { layers: ['camera-clusters'] });
        const clusterId = features[0].properties.cluster_id;
        map.current.getSource('cameras').getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err) return;
          map.current.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1, duration: 400 });
        });
      });

      // Click individual camera → popup with details
      map.current.on('click', 'camera-unclustered', (e) => {
        markerClickedRef.current = true;
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        new mapboxgl.Popup({ offset: 10 })
          .setLngLat(coords)
          .setHTML(`
            <div style="font-size:12px;line-height:1.7;min-width:160px;">
              <strong style="font-size:13px;">Surveillance Camera</strong><br/>
              ${props.name ? `<span style="color:#555;">Name:</span> ${props.name}<br/>` : ''}
              ${props['surveillance:type'] ? `<span style="color:#555;">Type:</span> ${props['surveillance:type']}<br/>` : ''}
              ${props.operator ? `<span style="color:#555;">Operator:</span> ${props.operator}<br/>` : ''}
              <span style="color:#aaa;font-size:11px;">${parseFloat(props._lat).toFixed(5)}, ${parseFloat(props._lon).toFixed(5)}</span>
            </div>
          `)
          .addTo(map.current);
      });

      map.current.on('mouseenter', 'camera-clusters', () => { map.current.getCanvas().style.cursor = 'pointer'; });
      map.current.on('mouseleave', 'camera-clusters', () => { map.current.getCanvas().style.cursor = ''; });
      map.current.on('mouseenter', 'camera-unclustered', () => { map.current.getCanvas().style.cursor = 'pointer'; });
      map.current.on('mouseleave', 'camera-unclustered', () => { map.current.getCanvas().style.cursor = ''; });

      // Load cameras for the visible viewport on load and after every pan/zoom
      const loadViewportCameras = async () => {
        if (analysisActiveRef.current) return; // analysis results take priority
        const zoom = map.current.getZoom();
        if (zoom < 11) return; // skip at city-level zoom — clusters would be meaningless
        const bounds = map.current.getBounds();
        const url = `/api/cameras?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const { cameras: fetched } = await res.json();
          if (map.current.getSource('cameras')) {
            map.current.getSource('cameras').setData(camerasToGeoJSON(fetched));
          }
        } catch { /* silently ignore viewport fetch errors */ }
      };

      map.current.on('moveend', loadViewportCameras);
      loadViewportCameras();

      // ── Route interactions ─────────────────────────────────────────────────
      map.current.on('click', 'route-line', (e) => {
        e.preventDefault();
        markerClickedRef.current = true;
        const coord = [e.lngLat.lng, e.lngLat.lat];
        const coords = pointsRef.current;
        let closestSegment = 0;
        let closestDist = Infinity;
        for (let i = 0; i < coords.length - 1; i++) {
          const [x1, y1] = coords[i];
          const [x2, y2] = coords[i + 1];
          const [cx, cy] = coord;
          const dx = x2 - x1, dy = y2 - y1;
          const lenSq = dx * dx + dy * dy;
          const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / lenSq));
          const dist = Math.sqrt((cx - x1 - t * dx) ** 2 + (cy - y1 - t * dy) ** 2);
          if (dist < closestDist) { closestDist = dist; closestSegment = i; }
        }
        insertPointRef.current?.(coord, closestSegment + 1);
      });

      map.current.on('mouseenter', 'route-line', () => { map.current.getCanvas().style.cursor = 'crosshair'; });
      map.current.on('mouseleave', 'route-line', () => { map.current.getCanvas().style.cursor = ''; });

      map.current.on('click', (e) => {
        if (markerClickedRef.current) { markerClickedRef.current = false; return; }
        addPointRef.current?.([e.lngLat.lng, e.lngLat.lat]);
      });
    });

  // // Add CSS to ensure geolocate button is visible
  // const style = document.createElement('style');
  // style.textContent = `
  //   .mapboxgl-ctrl-group {
  //     z-index: 20 !important;
  //   }
  //   .mapboxgl-ctrl-geolocate {
  //     z-index: 20 !important;
  //   }
  // `;
  // document.head.appendChild(style);
  
  // return () => style.remove();

  
  }, []);

  const updateRoute = (coords) => {
    if (!map.current?.getSource('route')) return;
    map.current.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords }
    });
  };

  const updateCameraLayer = (cams) => {
    if (!map.current?.getSource('cameras')) return;
    map.current.getSource('cameras').setData(camerasToGeoJSON(cams));
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

  const setPrependMode = (id) => {
    prependModeRef.current = true;
    setActiveEndpoint(id);
  };

  const deletePoint = (id) => {
    const index = markersRef.current.findIndex(m => m._id === id);
    if (index === -1) return;
    markersRef.current[index].remove();
    markersRef.current.splice(index, 1);
    pointsRef.current.splice(index, 1);

    if (activeEndpointRef.current === id) {
      const lastId = markersRef.current.length > 0
        ? markersRef.current[markersRef.current.length - 1]._id
        : null;
      setActiveEndpoint(lastId);
    }

    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };

  const createMarkerElement = () => {
    const el = document.createElement('div');
    el.style.cssText = `
      width: 16px; height: 16px; background: #E63946;
      border: 2.5px solid white; border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3); cursor: grab;
    `;
    return el;
  };

  const createPopupContent = (onDelete, onSetEndpoint, onPrepend) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; flex-direction: column; gap: 6px; padding: 2px;';

    if (onPrepend) {
      const prependBtn = document.createElement('button');
      prependBtn.innerText = '⬆️ Add point before this';
      prependBtn.style.cssText = `
        background: #9C27B0; color: white; border: none;
        padding: 6px 12px; border-radius: 6px; cursor: pointer;
        font-size: 12px; font-weight: 600; width: 100%;
      `;
      prependBtn.addEventListener('click', (e) => { e.stopPropagation(); onPrepend(); });
      wrapper.appendChild(prependBtn);
    }

    const extendBtn = document.createElement('button');
    extendBtn.innerText = '📍 Extend from here';
    extendBtn.style.cssText = `
      background: #2196F3; color: white; border: none;
      padding: 6px 12px; border-radius: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; width: 100%;
    `;
    extendBtn.addEventListener('click', (e) => { e.stopPropagation(); onSetEndpoint(); });

    const deleteBtn = document.createElement('button');
    deleteBtn.innerText = 'Remove point';
    deleteBtn.style.cssText = `
      background: #E63946; color: white; border: none;
      padding: 6px 12px; border-radius: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; width: 100%;
    `;
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
      .setLngLat(coord)
      .setPopup(popup)
      .addTo(map.current);

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

  function insertPoint(coord, insertIndex) {
    const { marker, id } = createMarker(coord);
    markersRef.current.splice(insertIndex, 0, marker);
    pointsRef.current.splice(insertIndex, 0, coord);
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };
  }

  function addPoint(coord) {
    const { marker, id } = createMarker(coord);

    // Prepend mode — insert before index 0
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

    // Extend from selected non-last point
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

    // Default — append to end
    markersRef.current.push(marker);
    pointsRef.current = [...pointsRef.current, coord];
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach(m => m._refreshPopup?.());
  };
  }

  const clearRoute = () => {
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    pointsRef.current = [];
    prependModeRef.current = false;
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    clearCamerasFromStorage();
    updateRoute([]);
    analysisActiveRef.current = false;
    // Reload viewport cameras now that analysis is cleared
    if (map.current) {
      const bounds = map.current.getBounds();
      const zoom = map.current.getZoom();
      if (zoom >= 14) {
        fetch(`/api/cameras?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`)
          .then(r => r.json())
          .then(({ cameras: fetched }) => updateCameraLayer(fetched))
          .catch(() => {});
      } else {
        updateCameraLayer([]);
      }
    }
  };

  const renderCameraMarkers = (camerasMap) => {
  // Remove existing markers first
  cameraMarkersRef.current.forEach(m => m.remove());
  cameraMarkersRef.current = [];

  // Render new markers
  for (const [id, cameraData] of camerasMap) {
    const el = document.createElement('div');
    el.style.cssText = `
      width: 22px; height: 22px; background: #FFB703;
      border: 2px solid #c47c00; border-radius: 5px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; cursor: pointer;
    `;
    el.innerHTML = '📷';

    const popup = new mapboxgl.Popup({ offset: 14, closeButton: false })
      .setHTML(`
        <div style="font-size:12px;line-height:1.6;">
          <strong>Surveillance Camera</strong><br/>
          ${cameraData.tags?.name ? `Name: ${cameraData.tags.name}<br/>` : ''}
          ${cameraData.tags?.['surveillance:type'] ? `Type: ${cameraData.tags['surveillance:type']}<br/>` : ''}
          ${cameraData.tags?.operator ? `Operator: ${cameraData.tags.operator}<br/>` : ''}
          <span style="color:#888;">${cameraData.lat.toFixed(6)}, ${cameraData.lon.toFixed(6)}</span>
        </div>
      `);

    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat([cameraData.lon, cameraData.lat])
      .setPopup(popup)
      .addTo(map.current);

    cameraMarkersRef.current.push(marker);
  }
};

  const analyzeLocation = async () => {
    if (analyzing || currentLocation == null) return;
    setAnalyzing(true);
    const allCameras = new globalThis.Map();

    try {
      const cameras = await fetchCamerasNearPoint(currentLocation[0], currentLocation[1]); //Cameras[]
      for (const cam of cameras) allCameras.set(cam.id, { ...cam, queriedAt: new Date().toISOString() });
      renderCameraMarkers(allCameras);
      setCameras(allCameras);
    } catch (err) {
      console.error('Location analysis failed:', err);
    } finally {
      setAnalyzing(false);
    }
  };
  const analyzeRoute = async () => {
    if (pointsRef.current.length < 2 || analyzing) return;
    setAnalyzing(true);
    cameraMarkersRef.current.forEach(m => m.remove());
    cameraMarkersRef.current = [];
    

    const coords = samplePoints(pointsRef.current); // [[lon, lat], ...]
    const allCameras = new globalThis.Map();

    try {
      for (const c of coords) {
        const cameras = await fetchCamerasNearPoint(c[0], c[1]); //Cameras[]
        for (const cam of cameras) allCameras.set(cam.id, { ...cam, queriedAt: new Date().toISOString() });
      }

      // Render camera markers
      // for (const [id, cameraData] of allCameras) {
      //   const el = document.createElement('div');
      //   el.style.cssText = `
      //     width: 22px; height: 22px; background: #FFB703;
      //     border: 2px solid #c47c00; border-radius: 5px;
      //     box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      //     display: flex; align-items: center; justify-content: center;
      //     font-size: 13px; cursor: pointer;
      //   `;
      //   el.innerHTML = '📷';

      //   const popup = new mapboxgl.Popup({ offset: 14, closeButton: false })
      //     .setHTML(`
      //       <div style="font-size:12px;line-height:1.6;">
      //         <strong>Surveillance Camera</strong><br/>
      //         ${cameraData.tags?.name ? `Name: ${cameraData.tags.name}<br/>` : ''}
      //         ${cameraData.tags?.['surveillance:type'] ? `Type: ${cameraData.tags['surveillance:type']}<br/>` : ''}
      //         ${cameraData.tags?.operator ? `Operator: ${cameraData.tags.operator}<br/>` : ''}
      //         <span style="color:#888;">${cameraData.lat.toFixed(6)}, ${cameraData.lon.toFixed(6)}</span>
      //       </div>
      //     `);

      //   const marker = new mapboxgl.Marker({ element: el })
      //     .setLngLat([cameraData.lon, cameraData.lat])
      //     .setPopup(popup)
      //     .addTo(map.current);

      //   cameraMarkersRef.current.push(marker);
      // }
      renderCameraMarkers(allCameras);
      setCameras(allCameras);
      const WATCH_RADIUS_M = 50;
      const nearby = allCameras.filter(cam =>
        isCameraNearPath(cam.lat, cam.lon, coords, WATCH_RADIUS_M)
      );

      // Persist to localStorage (merge by ID)
      const existing = JSON.parse(localStorage.getItem('surveillance_cameras') || '[]');
      const byId = new globalThis.Map(existing.map(c => [c.id, c]));
      for (const c of nearby) byId.set(c.id, { ...c, queriedAt: new Date().toISOString() });
      localStorage.setItem('surveillance_cameras', JSON.stringify([...byId.values()]));

      analysisActiveRef.current = true;
      updateCameraLayer(nearby);
      setCameras(nearby);
    } catch (err) {
      console.error('Route analysis failed:', err);
    } finally {
      setAnalyzing(false);
    }
  };

  // Sync refs after every render so the map's one-time event listeners
  // always call the current function instance.
  useLayoutEffect(() => {
    addPointRef.current = addPoint;
    insertPointRef.current = insertPoint;
  });

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
          position: 'absolute', top: 0, left: 0, right: 0,
          background: 'white', padding: '12px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)', zIndex: 10,
          gap: 16, borderBottom: '1px solid #e0e0e0', color: '#111'
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
              width: '100%', padding: '8px 14px', borderRadius: 8,
              border: '1px solid #ccc', fontSize: 13, outline: 'none',
              boxSizing: 'border-box', color: '#111', background: '#f5f5f5'
            }}
          />

          
        
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '110%', left: 0, right: 0,
              background: 'white', borderRadius: 8,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)', overflow: 'hidden', zIndex: 20
            }}>
              {suggestions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => selectCity(s)}
                  style={{ padding: '10px 14px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f0f0f0', color: '#111' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f9f9f9'}
                  onMouseLeave={e => e.currentTarget.style.background = 'white'}
                >
                  {s.place_name}
                </div>
              ))}
            </div>
          )}
        </div>

        <span style={{
          fontSize: 13,
          color: cameras.length > 0 ? '#c47c00' : activeEndpointId ? '#2196F3' : '#444',
          fontWeight: cameras.length > 0 || activeEndpointId ? 600 : 400,
          flexShrink: 0
        }}>
          {cameras.length > 0
            ? `📷 ${cameras.length} camera${cameras.length !== 1 ? 's' : ''} watching your route`
            : analyzing
            ? 'Analyzing…'
            : points.length === 0
            ? 'Click map to add points'
            : activeEndpointId
            ? prependModeRef.current
              ? '⬆️ Adding before first point — click map'
              : '📍 Extending from selected point — click map'
            : `${points.length} point${points.length !== 1 ? 's' : ''} · click pin to select`}
        </span>
      </div>

      {/* Bottom action bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: 30, left: '50%',
          transform: 'translateX(-50%)', display: 'flex', gap: 10, zIndex: 10
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); clearRoute(); }}
          style={{
            background: 'white', border: '1px solid #e0e0e0', padding: '12px 20px',
            borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(0,0,0,0.12)', display: 'flex', alignItems: 'center', gap: 6, color: '#111'
          }}>
          🗑️ Clear
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); analyzeRoute(); }}
          disabled={points.length < 2 || analyzing}
          style={{
            background: points.length < 2 || analyzing ? '#ccc' : '#E63946',
            color: 'white', border: 'none', padding: '12px 24px', borderRadius: 10,
            fontSize: 13, fontWeight: 700,
            cursor: points.length < 2 || analyzing ? 'not-allowed' : 'pointer',
            boxShadow: points.length >= 2 && !analyzing ? '0 2px 12px rgba(230,57,70,0.4)' : 'none',
            display: 'flex', alignItems: 'center', gap: 6
          }}>
          {analyzing ? 'Analyzing…' : 'Analyze Route →'}
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); analyzeLocation(); }}
          disabled={ analyzing }
          style={{
            background: currentLocation == null || analyzing ? '#ccc' : '#E63946',
            color: 'white', border: 'none', padding: '12px 24px', borderRadius: 10,
            fontSize: 13, fontWeight: 700,
            cursor: currentLocation == null || analyzing ? 'not-allowed' : 'pointer',
            boxShadow: currentLocation != null && !analyzing ? '0 2px 12px rgba(230,57,70,0.4)' : 'none',
            display: 'flex', alignItems: 'center', gap: 6
          }}>
          {analyzing ? 'Analyzing…' : 'Analyze Current Location →'}
        </button>
      </div>
    </div>
  );
}
