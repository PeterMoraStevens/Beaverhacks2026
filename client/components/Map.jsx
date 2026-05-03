/* eslint-disable react-hooks/purity */
/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable react-hooks/exhaustive-deps */
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { clearCamerasFromStorage } from "@/lib/cameras";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import * as turf from "@turf/turf";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// ── Math helpers ─────────────────────────────────────────────────────────────

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
    if (
      distanceToSegmentMeters(camLat, camLon, lat1, lon1, lat2, lon2) <=
      thresholdMeters
    )
      return true;
  }
  return false;
}

function metersToDegLat(m) {
  return m / 111000;
}
function metersToDegLon(m, lat) {
  return m / (111000 * Math.cos(lat * (Math.PI / 180)));
}

function segmentLengthMeters(p1, p2) {
  const dx = (p2[0] - p1[0]) * Math.cos((p1[1] * Math.PI) / 180) * 111000;
  const dy = (p2[1] - p1[1]) * 111000;
  return Math.sqrt(dx * dx + dy * dy);
}

function formatTime(s) {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatDistance(m) {
  if (!m) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function scoreRouteByCameras(routeCoords, cameras, radiusMeters) {
  return cameras.filter((c) =>
    isCameraNearPath(c.lat, c.lon, routeCoords, radiusMeters),
  ).length;
}

function formatRelativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function intensityToColor(n) {
  if (n < 0.25) return "#00C853";
  if (n < 0.5) return "#FFD600";
  if (n < 0.75) return "#FF6D00";
  return "#E63946";
}

function camerasToGeoJSON(cameras) {
  return {
    type: "FeatureCollection",
    features: cameras.map((cam) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [cam.lon, cam.lat] },
      properties: { ...cam.tags, _id: cam.id, _lat: cam.lat, _lon: cam.lon },
    })),
  };
}

// ── Valhalla routing helpers ──────────────────────────────────────────────────

function decodePolyline6(encoded) {
  const coords = [];
  let idx = 0,
    lat = 0,
    lng = 0;
  while (idx < encoded.length) {
    let b,
      shift = 0,
      result = 0;
    do {
      b = encoded.charCodeAt(idx++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(idx++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e6, lat / 1e6]); // [lon, lat] for Mapbox
  }
  return coords;
}

function generateExcludePolygons(cameras, radiusMeters) {
  const radiusKm = Math.max(radiusMeters, 10) / 1000;
  return cameras.slice(0, 50).map(
    (cam) =>
      turf.circle([cam.lon, cam.lat], radiusKm, {
        steps: 4,
        units: "kilometers",
      }).geometry.coordinates[0],
  );
}

async function fetchValhallaRoute(locations, costing, excludePolygons = []) {
  const body = { locations, costing };
  if (excludePolygons.length > 0) body.exclude_polygons = excludePolygons;
  const res = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Valhalla ${res.status}`);
  }
  return res.json();
}

function computeRouteAnalysis(coords, cameras) {
  const THRESHOLD = 50;
  const segLengths = coords
    .slice(0, -1)
    .map((p1, i) => segmentLengthMeters(p1, coords[i + 1]));
  const totalLength = segLengths.reduce((a, b) => a + b, 0);
  const segCameraCounts = coords.slice(0, -1).map((p1, i) => {
    const p2 = coords[i + 1];
    return cameras.filter(
      (cam) =>
        distanceToSegmentMeters(cam.lat, cam.lon, p1[1], p1[0], p2[1], p2[0]) <=
        THRESHOLD,
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
    cameras:
      i < segCameraCounts.length
        ? segCameraCounts[i]
        : segCameraCounts[segCameraCounts.length - 1],
  }));
  const routeMiles = totalLength / 1609.34;
  const score = Math.min(
    100,
    Math.round((cameras.length / Math.max(routeMiles, 0.05)) * 8),
  );
  const worstCount = Math.max(...segCameraCounts);
  const worstIdx = segCameraCounts.indexOf(worstCount);
  return {
    gradientStops,
    graphData,
    score,
    totalCameras: cameras.length,
    worstCount,
    worstIdx,
    routeMiles: routeMiles.toFixed(2),
    segCameraCounts,
    maxCount,
  };
}

// Mini route preview — colored by camera exposure
function MiniRouteMap({ coords, analysisData }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !coords || coords.length < 2) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const W = canvas.offsetWidth || 400;
    const H = canvas.offsetHeight || 120;
    canvas.width = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const minLng = Math.min(...lngs),
      maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats),
      maxLat = Math.max(...lats);
    const pad = 20;
    const toX = (lng) =>
      pad + ((lng - minLng) / (maxLng - minLng || 1)) * (W - pad * 2);
    const toY = (lat) =>
      H - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (H - pad * 2);
    const counts = analysisData.segCameraCounts;
    const maxCount = analysisData.maxCount || 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    for (let i = 0; i < coords.length - 1; i++) {
      ctx.strokeStyle = intensityToColor((counts[i] || 0) / maxCount);
      ctx.beginPath();
      ctx.moveTo(toX(coords[i][0]), toY(coords[i][1]));
      ctx.lineTo(toX(coords[i + 1][0]), toY(coords[i + 1][1]));
      ctx.stroke();
    }
    ctx.fillStyle = "white";
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(toX(coords[0][0]), toY(coords[0][1]), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#E63946";
    ctx.beginPath();
    ctx.arc(
      toX(coords[coords.length - 1][0]),
      toY(coords[coords.length - 1][1]),
      5,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [coords, analysisData]);
  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "120px",
        borderRadius: 12,
        background: "rgba(0,0,0,0.4)",
        display: "block",
      }}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const cameraMarkersRef = useRef([]);
  const pointsRef = useRef([]);
  const markerClickedRef = useRef(false);
  const activeEndpointRef = useRef(null);
  const prependModeRef = useRef(false);
  const [prependMode, setPrependModeState] = useState(false);
  const addPointRef = useRef(null);
  const insertPointRef = useRef(null);
  const analysisActiveRef = useRef(false);
  const allCamerasRef = useRef([]);
  const primaryRouteRef = useRef(null); // { coords, duration, distance }
  const allRoutesRef = useRef([]);

  const [points, setPoints] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [routeCoords, setRouteCoords] = useState(null);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [activeEndpointId, setActiveEndpointId] = useState(null);
  const [safeRadius, setSafeRadius] = useState(50);
  const [routeStats, setRouteStats] = useState(null);
  const [mode, setMode] = useState("draw"); // 'draw' | 'route'
  const [profile, setProfile] = useState("walking"); // 'walking' | 'driving'
  const [statsVisible, setStatsVisible] = useState(true);
  const [showCameras, setShowCameras] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tripHistory, setTripHistory] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("trip_history") || "[]");
    } catch {
      return [];
    }
  });

  // Animate panel in after showResults is set
  useEffect(() => {
    const t = setTimeout(
      () => setPanelVisible(showResults),
      showResults ? 30 : 0,
    );
    return () => clearTimeout(t);
  }, [showResults]);

  // Toggle camera heatmap layer visibility
  useEffect(() => {
    if (!map.current) return;
    const visibility = showCameras ? "visible" : "none";
    const layers = [
      "camera-clusters",
      "camera-cluster-count",
      "camera-unclustered",
    ];
    layers.forEach((id) => {
      if (map.current.getLayer(id))
        map.current.setLayoutProperty(id, "visibility", visibility);
    });
  }, [showCameras]);

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-95.7129, 37.0902],
      zoom: 4,
    });
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      fitBoundsOptions: { maxZoom: 15 },
    });
    map.current.addControl(geolocate, "bottom-left");
    map.current.doubleClickZoom.disable();

    map.current.on("load", () => {
      geolocate.trigger();

      // Route source + layer
      map.current.addSource("route", {
        type: "geojson",
        lineMetrics: true,
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [] },
        },
      });
      map.current.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            "#E63946",
            1,
            "#E63946",
          ],
          "line-width": 5,
          "line-opacity": 0.95,
        },
      });

      // Safe route (dashed blue)
      map.current.addSource("safe-route", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [] },
        },
      });
      map.current.addLayer({
        id: "safe-route-line",
        type: "line",
        source: "safe-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2196F3",
          "line-width": 4,
          "line-dasharray": [2, 2],
          "line-opacity": 0.9,
        },
      });

      // Camera cluster source
      map.current.addSource("cameras", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 50,
      });
      map.current.addLayer({
        id: "camera-clusters",
        type: "circle",
        source: "cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#FFB703",
            10,
            "#FB8500",
            50,
            "#E63946",
          ],
          "circle-radius": ["step", ["get", "point_count"], 24, 10, 32, 50, 42],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.92,
        },
      });
      map.current.addLayer({
        id: "camera-cluster-count",
        type: "symbol",
        source: "cameras",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
          "text-size": 13,
        },
        paint: { "text-color": "#fff" },
      });
      map.current.addLayer({
        id: "camera-unclustered",
        type: "circle",
        source: "cameras",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#FFB703",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#c47c00",
          "circle-opacity": 0.95,
        },
      });

      map.current.on("click", "camera-clusters", (e) => {
        markerClickedRef.current = true;
        const features = map.current.queryRenderedFeatures(e.point, {
          layers: ["camera-clusters"],
        });
        const clusterId = features[0].properties.cluster_id;
        map.current
          .getSource("cameras")
          .getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.current.easeTo({
              center: features[0].geometry.coordinates,
              zoom: zoom + 1,
              duration: 400,
            });
          });
      });

      map.current.on("click", "camera-unclustered", (e) => {
        markerClickedRef.current = true;
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        new mapboxgl.Popup({ offset: 10 })
          .setLngLat(coords)
          .setHTML(
            `<div style="font-size:12px;line-height:1.7;min-width:160px;">
              <strong style="font-size:13px;">Surveillance Camera</strong><br/>
              ${props.name ? `<span style="color:#555;">Name:</span> ${props.name}<br/>` : ""}
              ${props["surveillance:type"] ? `<span style="color:#555;">Type:</span> ${props["surveillance:type"]}<br/>` : ""}
              ${props.operator ? `<span style="color:#555;">Operator:</span> ${props.operator}<br/>` : ""}
              <span style="color:#aaa;font-size:11px;">${parseFloat(props._lat).toFixed(5)}, ${parseFloat(props._lon).toFixed(5)}</span>
            </div>`,
          )
          .addTo(map.current);
      });
      map.current.on("mouseenter", "camera-clusters", () => {
        map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", "camera-clusters", () => {
        map.current.getCanvas().style.cursor = "";
      });
      map.current.on("mouseenter", "camera-unclustered", () => {
        map.current.getCanvas().style.cursor = "pointer";
      });
      map.current.on("mouseleave", "camera-unclustered", () => {
        map.current.getCanvas().style.cursor = "";
      });

      // Viewport camera heatmap — always on
      const loadViewportCameras = async () => {
        const bounds = map.current.getBounds();
        const url = `/api/cameras?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const { cameras: fetched } = await res.json();
          if (map.current.getSource("cameras"))
            map.current.getSource("cameras").setData(camerasToGeoJSON(fetched));
        } catch {
          /* silently ignore */
        }
      };
      map.current.on("moveend", loadViewportCameras);
      loadViewportCameras();

      map.current.on("click", "route-line", (e) => {
        e.preventDefault();
        markerClickedRef.current = true;
        const coord = [e.lngLat.lng, e.lngLat.lat];
        const coords = pointsRef.current;
        let closestSegment = 0,
          closestDist = Infinity;
        for (let i = 0; i < coords.length - 1; i++) {
          const [x1, y1] = coords[i],
            [x2, y2] = coords[i + 1],
            [cx, cy] = coord;
          const dx = x2 - x1,
            dy = y2 - y1;
          const lenSq = dx * dx + dy * dy;
          const t = Math.max(
            0,
            Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / lenSq),
          );
          const dist = Math.sqrt(
            (cx - x1 - t * dx) ** 2 + (cy - y1 - t * dy) ** 2,
          );
          if (dist < closestDist) {
            closestDist = dist;
            closestSegment = i;
          }
        }
        insertPointRef.current?.(coord, closestSegment + 1);
      });
      map.current.on("mouseenter", "route-line", () => {
        map.current.getCanvas().style.cursor = "crosshair";
      });
      map.current.on("mouseleave", "route-line", () => {
        map.current.getCanvas().style.cursor = "";
      });
      map.current.on("click", (e) => {
        if (markerClickedRef.current) {
          markerClickedRef.current = false;
          return;
        }
        addPointRef.current?.([e.lngLat.lng, e.lngLat.lat]);
      });
    });
  }, []);

  // ── Route helpers ────────────────────────────────────────────────────────────

  const updateRoute = (coords) => {
    if (!map.current?.getSource("route")) return;
    map.current.getSource("route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
    });
  };

  const resetRouteColor = () => {
    if (!map.current?.getLayer("route-line")) return;
    map.current.setPaintProperty("route-line", "line-gradient", [
      "interpolate",
      ["linear"],
      ["line-progress"],
      0,
      "#E63946",
      1,
      "#E63946",
    ]);
  };

  const updateSafeRouteLayer = (coords) => {
    if (!map.current?.getSource("safe-route")) return;
    map.current.getSource("safe-route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
    });
  };

  const animateRouteDraw = (coords, gradientStops, onComplete) => {
    setAnimating(true);
    const line = turf.lineString(coords);
    const totalLengthKm = turf.length(line, { units: "kilometers" });
    const DURATION = 1800;
    const start = performance.now();
    map.current.getSource("route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [coords[0], coords[0]] },
    });
    map.current.setPaintProperty("route-line", "line-gradient", [
      "interpolate",
      ["linear"],
      ["line-progress"],
      0,
      "#E63946",
      1,
      "#E63946",
    ]);
    const frame = (now) => {
      const t = Math.min((now - start) / DURATION, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      try {
        const sliced = turf.lineSliceAlong(
          line,
          0,
          Math.max(eased * totalLengthKm, 0.0001),
          { units: "kilometers" },
        );
        map.current.getSource("route").setData(sliced);
      } catch {
        /* ignore */
      }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        map.current.getSource("route").setData({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
        });
        if (gradientStops.length >= 2) {
          map.current.setPaintProperty("route-line", "line-gradient", [
            "interpolate",
            ["linear"],
            ["line-progress"],
            ...gradientStops,
          ]);
        }
        setAnimating(false);
        onComplete();
      }
    };
    requestAnimationFrame(frame);
  };

  // ── Marker helpers ───────────────────────────────────────────────────────────

  const setActiveEndpoint = (id) => {
    if (activeEndpointRef.current) {
      const prev = markersRef.current.find(
        (m) => m._id === activeEndpointRef.current,
      );
      if (prev) prev._el.style.border = "2.5px solid white";
    }
    if (id) {
      const next = markersRef.current.find((m) => m._id === id);
      if (next) next._el.style.border = "3px solid #2196F3";
    }
    activeEndpointRef.current = id;
    setActiveEndpointId(id);
  };

  const setPrependMode = (id) => {
    prependModeRef.current = true;
    setPrependModeState(true);
    setActiveEndpoint(id);
  };

  const deletePoint = (id) => {
    const index = markersRef.current.findIndex((m) => m._id === id);
    if (index === -1) return;
    markersRef.current[index].remove();
    markersRef.current.splice(index, 1);
    pointsRef.current.splice(index, 1);
    if (activeEndpointRef.current === id) {
      const lastId =
        markersRef.current.length > 0
          ? markersRef.current[markersRef.current.length - 1]._id
          : null;
      setActiveEndpoint(lastId);
    }
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    markersRef.current.forEach((m) => m._refreshPopup?.());
  };

  const createMarkerElement = () => {
    const el = document.createElement("div");
    el.style.cssText = `width:16px;height:16px;background:#E63946;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:grab;`;
    return el;
  };

  const createEndpointMarker = (coord, label) => {
    const id = `marker-${Date.now()}-${Math.random()}`;
    const isStart = label === "A";
    const el = document.createElement("div");
    el.style.cssText = `
      width:28px;height:28px;background:${isStart ? "#388e3c" : "#7B1FA2"};
      border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.35);
      cursor:grab;display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:700;color:white;
    `;
    el.innerText = label;
    const marker = new mapboxgl.Marker({ element: el, draggable: true })
      .setLngLat(coord)
      .addTo(map.current);
    marker._id = id;
    marker._el = el;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      markerClickedRef.current = true;
    });
    marker.on("drag", () => {
      const idx = markersRef.current.findIndex((m) => m._id === id);
      if (idx === -1) return;
      const ll = marker.getLngLat();
      pointsRef.current[idx] = [ll.lng, ll.lat];
    });
    marker.on("dragend", () => {
      const idx = markersRef.current.findIndex((m) => m._id === id);
      if (idx === -1) return;
      const ll = marker.getLngLat();
      pointsRef.current[idx] = [ll.lng, ll.lat];
      setPoints([...pointsRef.current]);
    });
    return { marker, id };
  };

  const createPopupContent = (onDelete, onSetEndpoint, onPrepend) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "display:flex;flex-direction:column;gap:6px;padding:2px;";
    if (onPrepend) {
      const btn = document.createElement("button");
      btn.innerText = "Add point before this";
      btn.style.cssText =
        "background:#9C27B0;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onPrepend();
      });
      wrapper.appendChild(btn);
    }
    const extendBtn = document.createElement("button");
    extendBtn.innerText = "Extend from here";
    extendBtn.style.cssText =
      "background:#2196F3;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;";
    extendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onSetEndpoint();
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.innerText = "Remove point";
    deleteBtn.style.cssText =
      "background:#E63946;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;width:100%;";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });
    wrapper.appendChild(extendBtn);
    wrapper.appendChild(deleteBtn);
    return wrapper;
  };

  const attachDragListeners = (marker, id) => {
    marker.on("drag", () => {
      const idx = markersRef.current.findIndex((m) => m._id === id);
      if (idx === -1) return;
      const ll = marker.getLngLat();
      pointsRef.current[idx] = [ll.lng, ll.lat];
      updateRoute([...pointsRef.current]);
    });
    marker.on("dragend", () => {
      const idx = markersRef.current.findIndex((m) => m._id === id);
      if (idx === -1) return;
      const ll = marker.getLngLat();
      pointsRef.current[idx] = [ll.lng, ll.lat];
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
      popup.setDOMContent(
        createPopupContent(
          () => {
            popup.remove();
            deletePoint(id);
          },
          () => {
            popup.remove();
            setActiveEndpoint(id);
          },
          isFirst
            ? () => {
                popup.remove();
                setPrependMode(id);
              }
            : null,
        ),
      );
    };
    refreshPopup();
    marker._refreshPopup = refreshPopup;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      markerClickedRef.current = true;
      refreshPopup();
      marker.togglePopup();
    });
    attachDragListeners(marker, id);
    return { marker, id };
  };

  function insertPoint(coord, insertIndex) {
    if (mode === "route") return;
    const { marker, id } = createMarker(coord);
    markersRef.current.splice(insertIndex, 0, marker);
    pointsRef.current.splice(insertIndex, 0, coord);
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach((m) => m._refreshPopup?.());
  }

  function addPoint(coord) {
    if (mode === "route") {
      if (pointsRef.current.length >= 2) return;
      const label = pointsRef.current.length === 0 ? "A" : "B";
      const { marker, id } = createEndpointMarker(coord, label);
      markersRef.current.push(marker);
      pointsRef.current = [...pointsRef.current, coord];
      setPoints([...pointsRef.current]);
      setActiveEndpoint(id);
      return;
    }
    const { marker, id } = createMarker(coord);

    if (prependModeRef.current) {
      prependModeRef.current = false;
      setPrependModeState(false);
      markersRef.current.splice(0, 0, marker);
      pointsRef.current.splice(0, 0, coord);
      setPoints([...pointsRef.current]);
      updateRoute([...pointsRef.current]);
      setActiveEndpoint(id);
      markersRef.current.forEach((m) => m._refreshPopup?.());
      return;
    }

    if (activeEndpointRef.current && markersRef.current.length > 0) {
      const activeIndex = markersRef.current.findIndex(
        (m) => m._id === activeEndpointRef.current,
      );
      if (activeIndex !== -1 && activeIndex < markersRef.current.length - 1) {
        markersRef.current.splice(activeIndex + 1, 0, marker);
        pointsRef.current.splice(activeIndex + 1, 0, coord);
        setPoints([...pointsRef.current]);
        updateRoute([...pointsRef.current]);
        setActiveEndpoint(id);
        markersRef.current.forEach((m) => m._refreshPopup?.());
        return;
      }
    }

    markersRef.current.push(marker);
    pointsRef.current = [...pointsRef.current, coord];
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach((m) => m._refreshPopup?.());
  }

  // ── Route actions ─────────────────────────────────────────────────────────────

  // Calls /api/optimal_pathing with Valhalla exclude_polygons built from cameras,
  // then shows the camera-avoiding route in the safe-route layer if it's better.
  const applyAvoidanceRadius = async (routes, allCams, radius) => {
    if (!routes?.length || !pointsRef.current.length) {
      setRouteStats(null);
      return;
    }

    const primaryCoords = routes[0].geometry.coordinates;
    const primaryNearby = allCams.filter((c) =>
      isCameraNearPath(c.lat, c.lon, primaryCoords, radius),
    );
    const originalStats = {
      time: routes[0].duration,
      distance: routes[0].distance,
      cameras: primaryNearby.length,
    };

    if (primaryNearby.length === 0) {
      updateSafeRouteLayer([]);
      setRouteStats({ original: originalStats, safe: null });
      return;
    }

    const costing = profile === "walking" ? "pedestrian" : "auto";
    const waypoints = pointsRef.current.map((p) => ({ lon: p[0], lat: p[1] }));

    // Only exclude cameras that are ON the primary route.
    // Excluding off-route cameras blocks the alternative roads Valhalla needs for detours,
    // which causes it to find routes with MORE cameras, not fewer.
    try {
      const res = await fetch("/api/optimal_pathing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waypoints,
          costing,
          cameras: primaryNearby,
          radiusMeters: radius,
        }),
      });

      if (!res.ok) throw new Error(`Optimal pathing ${res.status}`);
      const data = await res.json();

      const safeCoords = decodePolyline6(data.trip.legs[0].shape);
      const safeDuration = data.trip.summary.time;
      const safeDistance = data.trip.summary.length * 1000;
      const safeNearby = allCams.filter((c) =>
        isCameraNearPath(c.lat, c.lon, safeCoords, radius),
      );
      const safeStats = {
        time: safeDuration,
        distance: safeDistance,
        cameras: safeNearby.length,
      };

      // Always display the Valhalla camera-avoiding route as the blue dashed line.
      updateSafeRouteLayer(safeCoords);
      setRouteStats({ original: originalStats, safe: safeStats });
    } catch {
      updateSafeRouteLayer([]);
      setRouteStats({ original: originalStats, safe: null });
    }
  };

  const clearRoute = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    cameraMarkersRef.current.forEach((m) => m.remove());
    cameraMarkersRef.current = [];
    pointsRef.current = [];
    prependModeRef.current = false;
    setPrependModeState(false);
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    setAnalysisData(null);
    setRouteCoords(null);
    setShowResults(false);
    setAnimating(false);
    clearCamerasFromStorage();
    updateRoute([]);
    updateSafeRouteLayer([]);
    setRouteStats(null);
    setStatsVisible(true);
    allRoutesRef.current = [];
    allCamerasRef.current = [];
    analysisActiveRef.current = false;
    resetRouteColor();
    const style = map.current?.getStyle();
    if (style) {
      style.layers
        .filter((l) => l.id.startsWith("route-graded-"))
        .forEach((l) => {
          map.current.removeLayer(l.id);
          map.current.removeSource(l.id);
        });
    }
    if (map.current?.getLayer("route-line")) {
      map.current.setLayoutProperty("route-line", "visibility", "visible");
    }
  };

  const analyzeRoute = async () => {
    const canAnalyze =
      mode === "route"
        ? pointsRef.current.length === 2
        : pointsRef.current.length >= 2;
    if (!canAnalyze || analyzing || animating) return;
    setAnalyzing(true);
    setRouteStats(null);
    setAnalysisData(null);
    setShowResults(false);
    updateSafeRouteLayer([]);
    cameraMarkersRef.current.forEach((m) => m.remove());
    cameraMarkersRef.current = [];
    const waypoints = pointsRef.current;
    try {
      const coordStr = waypoints.map((p) => p.join(",")).join(";");
      const dirRes = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordStr}?alternatives=true&geometries=geojson&overview=full&steps=false&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}`,
      );
      if (!dirRes.ok) throw new Error(`Directions API ${dirRes.status}`);
      const { routes } = await dirRes.json();
      if (!routes?.length) throw new Error("No route returned");
      allRoutesRef.current = routes;
      const primaryCoords = routes[0].geometry.coordinates;
      const allCoords = routes.flatMap((r) => r.geometry.coordinates);
      const lats = allCoords.map((p) => p[1]),
        lons = allCoords.map((p) => p[0]);
      const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
      const PAD_M = 150;
      const south = Math.min(...lats) - metersToDegLat(PAD_M);
      const north = Math.max(...lats) + metersToDegLat(PAD_M);
      const west = Math.min(...lons) - metersToDegLon(PAD_M, midLat);
      const east = Math.max(...lons) + metersToDegLon(PAD_M, midLat);
      const camRes = await fetch(
        `/api/cameras?south=${south}&west=${west}&north=${north}&east=${east}`,
      );
      if (!camRes.ok) throw new Error(`Camera API ${camRes.status}`);
      const { cameras: fetched } = await camRes.json();
      allCamerasRef.current = fetched;
      const nearby = fetched.filter((c) =>
        isCameraNearPath(c.lat, c.lon, primaryCoords, safeRadius),
      );
      applyAvoidanceRadius(routes, fetched, safeRadius);
      setTimeout(() => {
        applyColorGradedRoute(
          map.current,
          routes[0].geometry.coordinates,
          fetched,
        );
      }, 0);
      const analysis = computeRouteAnalysis(primaryCoords, nearby);
      setAnalysisData(analysis);
      // for (const cam of nearby) {
      //   // const el = document.createElement("div");
      //   // el.style.cssText =
      //   //   "width:22px;height:22px;background:#FFB703;border:2px solid #c47c00;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:13px;cursor:pointer;";
      //   // el.innerHTML = "📷";
      //   // const popup = new mapboxgl.Popup({
      //   //   offset: 14,
      //   //   closeButton: false,
      //   // }).setHTML(
      //   //   `<div style="font-size:12px;line-height:1.6;"><strong>Surveillance Camera</strong><br/>${cam.tags?.name ? `Name: ${cam.tags.name}<br/>` : ""}${cam.tags?.["surveillance:type"] ? `Type: ${cam.tags["surveillance:type"]}<br/>` : ""}${cam.tags?.operator ? `Operator: ${cam.tags.operator}<br/>` : ""}<span style="color:#888;">${cam.lat.toFixed(6)}, ${cam.lon.toFixed(6)}</span></div>`,
      //   // );
      //   const marker = new mapboxgl.Marker({ element: el })
      //     .setLngLat([cam.lon, cam.lat])
      //     .setPopup(popup)
      //     .addTo(map.current);
      //   cameraMarkersRef.current.push(marker);
      // }
      setCameras(nearby);
      setAnalyzing(false);
      const scoredTrip = routes.map((r) => ({
        duration: r.duration,
        distance: r.distance,
        cameraCount: scoreRouteByCameras(
          r.geometry.coordinates,
          fetched,
          safeRadius,
        ),
      }));
      let tripSafeIdx = 0;
      for (let i = 1; i < scoredTrip.length; i++) {
        if (scoredTrip[i].cameraCount < scoredTrip[tripSafeIdx].cameraCount)
          tripSafeIdx = i;
      }
      const tripNow = Date.now();
      saveTripToHistory({
        id: tripNow,
        timestamp: new Date(tripNow).toISOString(),
        mode,
        profile,
        waypoints: [...waypoints],
        original: scoredTrip[0],
        safe: tripSafeIdx !== 0 ? scoredTrip[tripSafeIdx] : null,
      });
      setRouteCoords(primaryCoords);
      animateRouteDraw(primaryCoords, analysis.gradientStops, () => {
        setTimeout(() => setShowResults(true), 200);
      });
    } catch (err) {
      console.error("Route analysis failed:", err);
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    if (allRoutesRef.current.length > 0)
      applyAvoidanceRadius(
        allRoutesRef.current,
        allCamerasRef.current,
        safeRadius,
      );
  }, [safeRadius]);

  useLayoutEffect(() => {
    addPointRef.current = addPoint;
    insertPointRef.current = insertPoint;
  });

  const saveTripToHistory = (entry) => {
    const prev = (() => {
      try {
        return JSON.parse(localStorage.getItem("trip_history") || "[]");
      } catch {
        return [];
      }
    })();
    const next = [entry, ...prev].slice(0, 30);
    localStorage.setItem("trip_history", JSON.stringify(next));
    setTripHistory(next);
  };

  const switchMode = (newMode) => {
    if (newMode === mode) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    cameraMarkersRef.current.forEach((m) => m.remove());
    cameraMarkersRef.current = [];
    pointsRef.current = [];
    prependModeRef.current = false;
    setPrependModeState(false);
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    setAnalysisData(null);
    setRouteCoords(null);
    setShowResults(false);
    setAnimating(false);
    updateRoute([]);
    updateSafeRouteLayer([]);
    setRouteStats(null);
    setStatsVisible(true);
    allRoutesRef.current = [];
    allCamerasRef.current = [];
    analysisActiveRef.current = false;
    resetRouteColor();
    setMode(newMode);
  };

  const handleSearch = async (value) => {
    setSearch(value);
    if (showResults) setShowResults(false);
    if (value.length < 2) {
      setSuggestions([]);
      return;
    }
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json?types=place&country=us&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}`,
    );
    const data = await res.json();
    setSuggestions(data.features || []);
  };

  const selectCity = (feature) => {
    const [lng, lat] = feature.center;
    map.current.flyTo({ center: [lng, lat], zoom: 13, duration: 1500 });
    setSearch(feature.place_name);
    setSuggestions([]);
    clearRoute();
  };

  const scoreColor = !analysisData
    ? "#fff"
    : analysisData.score < 30
      ? "#00C853"
      : analysisData.score < 60
        ? "#FFD600"
        : "#E63946";
  const isLoading = analyzing || animating;
  const canAnalyze =
    mode === "route" ? points.length === 2 : points.length >= 2;

  function densityColor(ratio) {
    const clamp = Math.max(0, Math.min(1, ratio));
    if (clamp <= 0.5) return lerpColor("#4CAF50", "#FFB703", clamp * 2);
    return lerpColor("#FFB703", "#E63946", (clamp - 0.5) * 2);
  }

  function lerpColor(a, b, t) {
    const ah = a.replace("#", ""),
      bh = b.replace("#", "");
    const ar = parseInt(ah.substring(0, 2), 16),
      ag = parseInt(ah.substring(2, 4), 16),
      ab = parseInt(ah.substring(4, 6), 16);
    const br = parseInt(bh.substring(0, 2), 16),
      bg = parseInt(bh.substring(2, 4), 16),
      bb = parseInt(bh.substring(4, 6), 16);
    return `#${Math.round(ar + (br - ar) * t)
      .toString(16)
      .padStart(2, "0")}${Math.round(ag + (bg - ag) * t)
      .toString(16)
      .padStart(2, "0")}${Math.round(ab + (bb - ab) * t)
      .toString(16)
      .padStart(2, "0")}`;
  }

  function interpolateRoute(coords, segmentMeters = 20) {
    const R = 6371000;
    const result = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i],
        [lon2, lat2] = coords[i + 1];
      const dLat = (lat2 - lat1) * (Math.PI / 180),
        dLon = (lon2 - lon1) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * (Math.PI / 180)) *
          Math.cos(lat2 * (Math.PI / 180)) *
          Math.sin(dLon / 2) ** 2;
      const dist = 2 * R * Math.asin(Math.sqrt(a));
      const steps = Math.max(1, Math.ceil(dist / segmentMeters));
      for (let s = 0; s < steps; s++) {
        result.push([
          lon1 + (lon2 - lon1) * (s / steps),
          lat1 + (lat2 - lat1) * (s / steps),
        ]);
      }
    }
    result.push(coords[coords.length - 1]);
    return result;
  }

  function applyColorGradedRoute(
    mapRef,
    pathCoords,
    cameras,
    thresholdMeters = 50,
    maxCams = 3,
  ) {
    const existingLayers = mapRef.getStyle().layers.map((l) => l.id);
    existingLayers
      .filter((id) => id.startsWith("route-graded-"))
      .forEach((id) => {
        mapRef.removeLayer(id);
        mapRef.removeSource(id);
      });
    if (pathCoords.length < 2) {
      if (mapRef.getLayer("route-line"))
        mapRef.setLayoutProperty("route-line", "visibility", "visible");
      return;
    }
    if (mapRef.getLayer("route-line"))
      mapRef.setLayoutProperty("route-line", "visibility", "none");
    const dense = interpolateRoute(pathCoords, 20);
    const segments = [];
    for (let i = 0; i < dense.length - 1; i++) {
      const count = cameras.filter((cam) =>
        isCameraNearPath(
          cam.lat,
          cam.lon,
          [dense[i], dense[i + 1]],
          thresholdMeters,
        ),
      ).length;
      segments.push({
        coords: [dense[i], dense[i + 1]],
        color: densityColor(Math.min(count / maxCams, 1)),
      });
    }
    const merged = [];
    let current = { coords: [segments[0].coords[0]], color: segments[0].color };
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].color === current.color) {
        current.coords.push(segments[i].coords[1]);
      } else {
        merged.push(current);
        current = {
          coords: [segments[i].coords[0], segments[i].coords[1]],
          color: segments[i].color,
        };
      }
    }
    merged.push(current);
    merged.forEach((run, idx) => {
      const id = `route-graded-${idx}`;
      mapRef.addSource(id, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: run.coords },
        },
      });
      mapRef.addLayer({
        id,
        type: "line",
        source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": run.color,
          "line-width": 5,
          "line-opacity": 0.95,
        },
      });
    });
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 8,
          pointerEvents: animating || showResults ? "auto" : "none",
          opacity: animating || panelVisible ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
        onClick={() => {
          if (!animating) setShowResults(false);
        }}
      />

      {/* Top header — logo centered */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          background: "white",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          zIndex: 10,
          gap: 16,
          borderBottom: "1px solid #e0e0e0",
          color: "#111",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
          <div
            style={{
              display: "flex",
              gap: 3,
              background: "#f0f0f0",
              borderRadius: 8,
              padding: 3,
            }}
          >
            {[
              ["draw", "Free Draw"],
              ["route", "A→B Route"],
            ].map(([m, label]) => (
              <button
                key={m}
                onClick={(e) => {
                  e.stopPropagation();
                  switchMode(m);
                }}
                style={{
                  background: mode === m ? "white" : "transparent",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: mode === m ? 700 : 500,
                  cursor: "pointer",
                  color: mode === m ? "#111" : "#666",
                  boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen((o) => !o);
            }}
            style={{
              background: historyOpen ? "#1976D2" : "white",
              border: "1px solid #e0e0e0",
              padding: "9px 18px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              color: historyOpen ? "white" : "#555",
              display: "flex",
              alignItems: "center",
              gap: 5,
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
            }}
          >
            History {tripHistory.length > 0 && `(${tripHistory.length})`}
          </button>
        </div>

        {/* Camera heatmap toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowCameras((v) => !v);
          }}
          style={{
            background: showCameras ? "#FFB703" : "white",
            border: "1px solid #e0e0e0",
            padding: "7px 14px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            color: showCameras ? "white" : "#555",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 5,
            boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          }}
        >
          {showCameras ? "Toggle off " : "Toggle on "} Heatmap
        </button>

        {/* Search */}
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <input
            type="text"
            placeholder="Search a city..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #ccc",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
              color: "#111",
              background: "#f5f5f5",
            }}
          />
          {suggestions.length > 0 && (
            <div
              style={{
                width: "100%",
                padding: "10px 16px",
                borderRadius: 9,
                border: "1px solid #ccc",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
                color: "#111",
                background: "#f5f5f5",
              }}
            >
              {suggestions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => selectCity(s)}
                  style={{
                    padding: "10px 14px",
                    fontSize: 13,
                    cursor: "pointer",
                    borderBottom: "1px solid #f0f0f0",
                    color: "#111",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#f9f9f9")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "white")
                  }
                >
                  {s.place_name}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Status text */}
        <span
          style={{
            fontSize: 13,
            color:
              cameras.length > 0
                ? "#c47c00"
                : activeEndpointId
                  ? "#2196F3"
                  : "#444",
            fontWeight: cameras.length > 0 || activeEndpointId ? 600 : 400,
            flexShrink: 0,
          }}
        >
          {cameras.length > 0
            ? `${cameras.length} camera${cameras.length !== 1 ? "s" : ""} on route`
            : isLoading
              ? animating
                ? "Analyzing your route…"
                : "Fetching cameras…"
              : mode === "route"
                ? points.length === 0
                  ? "Click map to place start (A)"
                  : points.length === 1
                    ? "Click map to place end (B)"
                    : "A→B set — click Analyze Route"
                : points.length === 0
                  ? "Click map to add points"
                  : activeEndpointId
                    ? prependMode
                      ? "Adding before first point, click map"
                      : "Extending from selected point, click map"
                    : `${points.length} point${points.length !== 1 ? "s" : ""} · click pin to select`}
        </span>
      </div>

      {/* Results overlay */}
      {showResults && analysisData && routeStats && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: panelVisible
              ? "translate(-50%, -50%) scale(1)"
              : "translate(-50%, -50%) scale(0.9)",
            opacity: panelVisible ? 1 : 0,
            transition: "all 0.4s cubic-bezier(0.32, 0.72, 0, 1)",
            zIndex: 9,
            width: "90%",
            maxWidth: 800,
            textAlign: "center",
          }}
        >
          <button
            onClick={() => setShowResults(false)}
            style={{
              position: "absolute",
              top: -8,
              right: 0,
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.25)",
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(4px)",
              cursor: "pointer",
              fontSize: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              zIndex: 10,
            }}
          >
            ×
          </button>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              maxHeight: "80vh",
              overflowY: "auto",
              padding: "4px",
            }}
          >
            <div
              style={{
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(12px)",
                borderRadius: 16,
                padding: "12px",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 8,
                  color: "rgba(255,255,255,0.7)",
                }}
              >
                Route Preview
              </div>
              <MiniRouteMap coords={routeCoords} analysisData={analysisData} />
            </div>

            <div
              style={{
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(12px)",
                borderRadius: 16,
                padding: "20px",
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: "24px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  background: "rgba(0,0,0,0.55)",
                  backdropFilter: "blur(8px)",
                  borderRadius: 20,
                  padding: "12px 24px",
                  flex: 1,
                  height: "100%",
                }}
              >
                <div
                  style={{
                    fontSize: 64,
                    fontWeight: 900,
                    lineHeight: 1,
                    color: scoreColor,
                    letterSpacing: "-4px",
                  }}
                >
                  {analysisData.score}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: scoreColor,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                    marginTop: 6,
                    alignItems: "center",
                  }}
                >
                  Safety Score
                </div>
              </div>
              <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(8px)",
                borderRadius: 20,
                padding: "12px 24px",
                flex: 1,
                height: "100%",
              }}
            >
              <div
                style={{
                  fontSize: 64,
                  fontWeight: 900,
                  lineHeight: 1,
                  color: scoreColor,
                  letterSpacing: "-4px",
                }}
              >
                {analysisData.totalCameras}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: scoreColor,
                  textTransform: "uppercase",
                  letterSpacing: 2,
                  marginTop: 6,
                  alignItems: "center",
                }}
              >
                Total Cameras
              </div>
            </div>
            </div>

             {/* Cell 3: Camera Stats & Graph (Bottom Left) */}
            <div
              style={{
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(12px)",
                borderRadius: 16,
                padding: "16px",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "rgba(255,255,255,0.7)" }}>
                Camera Exposure
              </div>
              
              {/* Stats Row */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-around",
                  marginBottom: 16,
                }}
              >
                {[
                  { value: `${analysisData.routeMiles}`, label: "Total Miles" },
                  { value: analysisData.worstCount, label: "Worst Block", color: "#E63946" },
                ].map(({ value, label, color }) => (
                  <div key={label} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 900,
                        color: color || "white",
                        letterSpacing: "-1px",
                      }}
                    >
                      {value}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: "rgba(255,255,255,0.6)",
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        marginTop: 4,
                      }}
                    >
                      {label}
                    </div>
                  </div>
                ))}
              </div>

              {/* Graph */}
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart
                  data={analysisData.graphData}
                  margin={{ top: 4, right: 0, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="exposureGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#E63946" stopOpacity={0.6} />
                      <stop offset="95%" stopColor="#E63946" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="distanceMi"
                    tick={{ fontSize: 8, fill: "rgba(255,255,255,0.5)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 8, fill: "rgba(255,255,255,0.5)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 8,
                      border: "1px solid rgba(255,255,255,0.15)",
                      background: "rgba(0,0,0,0.8)",
                      color: "#fff",
                    }}
                    formatter={(value) => [`${value} cameras`, "Exposure"]}
                    labelFormatter={(label) => `${label} mi`}
                  />
                  <Area
                    type="monotone"
                    dataKey="cameras"
                    stroke="#E63946"
                    strokeWidth={2}
                    fill="url(#exposureGradient)"
                    isAnimationActive={true}
                    animationDuration={1000}
                  />
                </AreaChart>
              </ResponsiveContainer>

              {/* Legend */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: 10,
                  marginTop: 12,
                  flexWrap: "wrap",
                }}
              >
                {[
                  ["#00C853", "Low"],
                  ["#FFD600", "Medium"],
                  ["#FF6D00", "High"],
                  ["#E63946", "Severe"],
                ].map(([color, label]) => (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 9,
                      color: "rgba(255,255,255,0.6)",
                    }}
                  >
                    <div style={{ width: 12, height: 3, background: color, borderRadius: 2 }} />{" "}
                    {label}
                  </div>
                ))}
              </div>
            </div>

            {/* Cell 4: Route Comparison (Bottom Right) */}
            <div
              style={{
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(12px)",
                borderRadius: 16,
                padding: "16px",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "rgba(255,255,255,0.7)" }}>
                Route Comparison
              </div>

              {/* Route Stats */}
              <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                <div
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "10px 8px",
                    borderRadius: 10,
                    background: "rgba(230, 57, 70, 0.2)",
                    border: "1px solid rgba(230, 57, 70, 0.3)",
                  }}
                >
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    Your Route
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#E63946" }}>
                    {formatTime(routeStats.original.time)}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
                    {formatDistance(routeStats.original.distance)}
                  </div>
                  <div style={{ fontSize: 11, color: "#FFB703", marginTop: 4, fontWeight: 600 }}>
                    📷 {routeStats.original.cameras} camera{routeStats.original.cameras !== 1 ? "s" : ""}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "10px 8px",
                    borderRadius: 10,
                    background: routeStats.safe
                      ? "rgba(33, 150, 243, 0.2)"
                      : "rgba(255,255,255,0.1)",
                    border: `1px solid ${routeStats.safe ? "rgba(33, 150, 243, 0.3)" : "rgba(255,255,255,0.1)"}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: "rgba(255,255,255,0.5)",
                      marginBottom: 4,
                      textTransform: "uppercase",
                    }}
                  >
                    Optimal Path
                  </div>
                  {routeStats.safe ? (
                    <>
                      <div
                        style={{
                          fontSize: 20,
                          fontWeight: 800,
                          color: "#2196F3",
                        }}
                      >
                        {formatTime(routeStats.safe.time)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "rgba(255,255,255,0.6)",
                          marginTop: 2,
                        }}
                      >
                        {formatDistance(routeStats.safe.distance)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color:
                            routeStats.safe.cameras <
                            routeStats.original.cameras
                              ? "#66bb6a"
                              : "#c47c00",
                          marginTop: 4,
                          fontWeight: 600,
                        }}
                      >
                        {routeStats.safe.cameras} camera
                        {routeStats.safe.cameras !== 1 ? "s" : ""}
                        {routeStats.safe.cameras <
                          routeStats.original.cameras && " ✓"}
                      </div>
                    </>
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.4)",
                        marginTop: 12,
                      }}
                    >
                      Calculating…
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
            
            {/* Bottom Right: Path comparison */}
            {/* <div
              style={{
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(12px)",
                borderRadius: 16,
                padding: "16px",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 12,
                  color: "rgba(255,255,255,0.7)",
                }}
              >
                Route Comparison
              </div>
              <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                <div
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "10px 8px",
                    borderRadius: 10,
                    background: "rgba(230, 57, 70, 0.2)",
                    border: "1px solid rgba(230, 57, 70, 0.3)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: "rgba(255,255,255,0.5)",
                      marginBottom: 4,
                      textTransform: "uppercase",
                    }}
                  >
                    Your Route
                  </div>
                  <div
                    style={{ fontSize: 20, fontWeight: 800, color: "#E63946" }}
                  >
                    {formatTime(routeStats.original.time)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "rgba(255,255,255,0.6)",
                      marginTop: 2,
                    }}
                  >
                    {formatDistance(routeStats.original.distance)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#c47c00",
                      marginTop: 4,
                      fontWeight: 600,
                    }}
                  >
                    {routeStats.original.cameras} camera
                    {routeStats.original.cameras !== 1 ? "s" : ""}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "10px 8px",
                    borderRadius: 10,
                    background: routeStats.safe
                      ? "rgba(33, 150, 243, 0.2)"
                      : "rgba(255,255,255,0.1)",
                    border: `1px solid ${routeStats.safe ? "rgba(33, 150, 243, 0.3)" : "rgba(255,255,255,0.1)"}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: "rgba(255,255,255,0.5)",
                      marginBottom: 4,
                      textTransform: "uppercase",
                    }}
                  >
                    Optimal Path
                  </div>
                  {routeStats.safe ? (
                    <>
                      <div
                        style={{
                          fontSize: 20,
                          fontWeight: 800,
                          color: "#2196F3",
                        }}
                      >
                        {formatTime(routeStats.safe.time)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "rgba(255,255,255,0.6)",
                          marginTop: 2,
                        }}
                      >
                        {formatDistance(routeStats.safe.distance)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color:
                            routeStats.safe.cameras <
                            routeStats.original.cameras
                              ? "#66bb6a"
                              : "#c47c00",
                          marginTop: 4,
                          fontWeight: 600,
                        }}
                      >
                        {routeStats.safe.cameras} camera
                        {routeStats.safe.cameras !== 1 ? "s" : ""}
                        {routeStats.safe.cameras <
                          routeStats.original.cameras && " ✓"}
                      </div>
                    </>
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.4)",
                        marginTop: 12,
                      }}
                    >
                      Calculating…
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )} */}

      {/* ── Route stats panel (safe route comparison) ───────────────────────── */}
      {routeStats && !statsVisible && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: 90,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => setStatsVisible(true)}
            style={{
              background: "white",
              border: "1px solid #e0e0e0",
              padding: "8px 18px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
              color: "#555",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            📊 Show Results — {routeStats.original.cameras} cam
            {routeStats.original.cameras !== 1 ? "s" : ""}
            {routeStats.safe &&
            routeStats.safe.cameras < routeStats.original.cameras
              ? ` → ${routeStats.safe.cameras} optimal`
              : ""}
          </button>
        </div>
      )}

      {/* Bottom action bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 30,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 10,
          zIndex: 10,
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 3,
            background: "white",
            borderRadius: 10,
            padding: 3,
            border: "1px solid #e0e0e0",
            boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
          }}
        >
          {[
            ["walking", "Walk"],
            ["driving", "Drive"],
          ].map(([p, label]) => (
            <button
              key={p}
              onClick={(e) => {
                e.stopPropagation();
                setProfile(p);
              }}
              style={{
                background: profile === p ? "#2196F3" : "transparent",
                border: "none",
                padding: "11px 18px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: profile === p ? 700 : 500,
                cursor: "pointer",
                color: profile === p ? "white" : "#666",
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            clearRoute();
          }}
          style={{
            background: "white",
            border: "1px solid #e0e0e0",
            padding: "14px 24px",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "#111",
          }}
        >
          Clear
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            analyzeRoute();
          }}
          disabled={!canAnalyze || isLoading}
          style={{
            background: !canAnalyze || isLoading ? "#ccc" : "#E63946",
            color: "white",
            border: "none",
            padding: "14px 28px",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            cursor: !canAnalyze || isLoading ? "not-allowed" : "pointer",
            boxShadow:
              canAnalyze && !isLoading
                ? "0 2px 12px rgba(230,57,70,0.4)"
                : "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {analyzing
            ? "Fetching…"
            : animating
              ? "Animating…"
              : "Analyze Route →"}
        </button>
      </div>

      {/* History panel */}
      {historyOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 61,
            right: 0,
            bottom: 0,
            width: 320,
            background: "white",
            boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
            zIndex: 15,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "14px 16px",
              borderBottom: "1px solid #eee",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 14, color: "#111" }}>
              Trip History
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {tripHistory.length > 0 && (
                <button
                  onClick={() => {
                    localStorage.removeItem("trip_history");
                    setTripHistory([]);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    fontSize: 11,
                    color: "#bbb",
                    cursor: "pointer",
                    padding: "2px 4px",
                  }}
                >
                  Clear all
                </button>
              )}
              <button
                onClick={() => setHistoryOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#999",
                  fontSize: 18,
                  padding: "0 2px",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
          </div>
          <div style={{ overflowY: "auto", flex: 1, padding: "8px 0" }}>
            {tripHistory.length === 0 ? (
              <div
                style={{
                  color: "#bbb",
                  fontSize: 13,
                  textAlign: "center",
                  marginTop: 48,
                  lineHeight: 1.7,
                }}
              >
                No trips yet.
                <br />
                Analyze a route to save it here.
              </div>
            ) : (
              tripHistory.map((trip) => (
                <div
                  key={trip.id}
                  style={{
                    margin: "0 12px 8px",
                    padding: "12px",
                    borderRadius: 10,
                    background: "#f9f9f9",
                    border: "1px solid #eee",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "#999" }}>
                      {formatRelativeTime(trip.timestamp)}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <span
                        style={{
                          fontSize: 10,
                          background: "#e8f5e9",
                          color: "#388e3c",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        {trip.profile}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          background: "#e3f2fd",
                          color: "#1565c0",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        {trip.mode === "route" ? "A→B" : "Free Draw"}
                      </span>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        background: "#fff5f5",
                        borderRadius: 7,
                        padding: "8px",
                        textAlign: "center",
                        border: "1px solid #fcc",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: "#999",
                          marginBottom: 2,
                          textTransform: "uppercase",
                        }}
                      >
                        Your Route
                      </div>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 15,
                          color: "#E63946",
                        }}
                      >
                        {formatTime(trip.original.duration)}
                      </div>
                      <div style={{ fontSize: 11, color: "#888" }}>
                        {formatDistance(trip.original.distance)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#c47c00",
                          fontWeight: 600,
                          marginTop: 2,
                        }}
                      >
                        {trip.original.cameraCount} Cameras
                      </div>
                    </div>
                    <div
                      style={{
                        background: trip.safe ? "#f0f7ff" : "#f9f9f9",
                        borderRadius: 7,
                        padding: "8px",
                        textAlign: "center",
                        border: `1px solid ${trip.safe ? "#90caf9" : "#eee"}`,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: "#999",
                          marginBottom: 2,
                          textTransform: "uppercase",
                        }}
                      >
                        Safe Route
                      </div>
                      {trip.safe ? (
                        <>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 15,
                              color: "#2196F3",
                            }}
                          >
                            {formatTime(trip.safe.duration)}
                          </div>
                          <div style={{ fontSize: 11, color: "#888" }}>
                            {formatDistance(trip.safe.distance)}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#388e3c",
                              fontWeight: 600,
                              marginTop: 2,
                            }}
                          >
                            {trip.safe.cameraCount} Cameras
                          </div>
                        </>
                      ) : (
                        <div
                          style={{ fontSize: 11, color: "#bbb", marginTop: 10 }}
                        >
                          No safer
                          <br />
                          alternative
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (trip.waypoints?.length > 0) {
                        const [lon, lat] = trip.waypoints[0];
                        map.current?.flyTo({
                          center: [lon, lat],
                          zoom: 14,
                          duration: 1200,
                        });
                      }
                    }}
                    style={{
                      marginTop: 8,
                      width: "100%",
                      background: "none",
                      border: "1px solid #e0e0e0",
                      borderRadius: 6,
                      padding: "5px",
                      fontSize: 11,
                      color: "#666",
                      cursor: "pointer",
                    }}
                  >
                    Fly to start
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
