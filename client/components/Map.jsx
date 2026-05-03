/* eslint-disable react-hooks/purity */
/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable react-hooks/exhaustive-deps */
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { clearCamerasFromStorage } from "@/lib/cameras";

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
    if (
      distanceToSegmentMeters(camLat, camLon, lat1, lon1, lat2, lon2) <=
      thresholdMeters
    )
      return true;
  }
  return false;
}

function metersToDegLat(meters) {
  return meters / 111000;
}
function metersToDegLon(meters, latDeg) {
  return meters / (111000 * Math.cos(latDeg * (Math.PI / 180)));
}

function formatTime(seconds) {
  if (!seconds) return "—";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDistance(meters) {
  if (!meters) return "—";
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1)} km`;
}

function scoreRouteByCameras(routeCoords, cameras, radiusMeters) {
  return cameras.filter((cam) =>
    isCameraNearPath(cam.lat, cam.lon, routeCoords, radiusMeters),
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

export default function MapView() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const pointsRef = useRef([]);
  const markerClickedRef = useRef(false);
  const activeEndpointRef = useRef(null);
  const prependModeRef = useRef(false);
  const [prependMode, setPrependModeState] = useState(false);
  const addPointRef = useRef(null);
  const insertPointRef = useRef(null);
  const analysisActiveRef = useRef(false);
  const allRoutesRef = useRef([]);
  const allCamerasRef = useRef([]);
  const [points, setPoints] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [activeEndpointId, setActiveEndpointId] = useState(null);
  const [safeRadius, setSafeRadius] = useState(50);
  const [routeStats, setRouteStats] = useState(null);
  const [mode, setMode] = useState("draw"); // 'draw' | 'route'
  const [profile, setProfile] = useState("walking"); // 'walking' | 'driving'
  const [statsVisible, setStatsVisible] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tripHistory, setTripHistory] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("trip_history") || "[]");
    } catch {
      return [];
    }
  });

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

      // ── Route ──────────────────────────────────────────────────────────────
      map.current.addSource("route", {
        type: "geojson",
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
          "line-color": "#E63946",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });

      // ── Safe route (dashed blue) ───────────────────────────────────────────
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

      // ── Camera cluster source ───────────────────────────────────────────────
      map.current.addSource("cameras", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 50,
      });

      // Cluster bubbles — color + size scale with point_count
      map.current.addLayer({
        id: "camera-clusters",
        type: "circle",
        source: "cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#FFB703", // yellow   < 10
            10,
            "#FB8500", // orange  10–49
            50,
            "#E63946", // red    ≥ 50
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            18, // < 10
            10,
            24, // 10–49
            50,
            32, // ≥ 50
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.92,
        },
      });

      // Count labels inside cluster bubbles
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

      // Individual camera dots (unclustered)
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

      // Click cluster → zoom into it
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

      // Click individual camera → popup with details
      map.current.on("click", "camera-unclustered", (e) => {
        markerClickedRef.current = true;
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        new mapboxgl.Popup({ offset: 10 })
          .setLngLat(coords)
          .setHTML(
            `
            <div style="font-size:12px;line-height:1.7;min-width:160px;">
              <strong style="font-size:13px;">Surveillance Camera</strong><br/>
              ${props.name ? `<span style="color:#555;">Name:</span> ${props.name}<br/>` : ""}
              ${props["surveillance:type"] ? `<span style="color:#555;">Type:</span> ${props["surveillance:type"]}<br/>` : ""}
              ${props.operator ? `<span style="color:#555;">Operator:</span> ${props.operator}<br/>` : ""}
              <span style="color:#aaa;font-size:11px;">${parseFloat(props._lat).toFixed(5)}, ${parseFloat(props._lon).toFixed(5)}</span>
            </div>
          `,
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

      // Load cameras for the visible viewport on load and after every pan/zoom
      const loadViewportCameras = async () => {
        const bounds = map.current.getBounds();
        const url = `/api/cameras?south=${bounds.getSouth()}&west=${bounds.getWest()}&north=${bounds.getNorth()}&east=${bounds.getEast()}`;
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const { cameras: fetched } = await res.json();
          if (map.current.getSource("cameras")) {
            map.current.getSource("cameras").setData(camerasToGeoJSON(fetched));
          }
        } catch {
          /* silently ignore viewport fetch errors */
        }
      };

      map.current.on("moveend", loadViewportCameras);
      loadViewportCameras();

      // ── Route interactions ─────────────────────────────────────────────────
      map.current.on("click", "route-line", (e) => {
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
    if (!map.current?.getSource("route")) return;
    map.current.getSource("route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
    });
  };

  const updateSafeRouteLayer = (coords) => {
    if (!map.current?.getSource("safe-route")) return;
    map.current.getSource("safe-route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
    });
  };

  const applyAvoidanceRadius = (routes, cameras, radius) => {
    const scored = routes.map((route) => ({
      ...route,
      cameraCount: scoreRouteByCameras(
        route.geometry.coordinates,
        cameras,
        radius,
      ),
    }));

    let safestIdx = 0;
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].cameraCount < scored[safestIdx].cameraCount) safestIdx = i;
    }

    const original = scored[0];
    const safest = scored[safestIdx];

    // Count cameras near primary route for header — heatmap stays untouched
    const primaryCameras = cameras.filter((cam) =>
      isCameraNearPath(cam.lat, cam.lon, original.geometry.coordinates, radius),
    );
    setCameras(primaryCameras);

    // Show safe route dashed line only if it's different from the original
    if (safestIdx !== 0) {
      updateSafeRouteLayer(safest.geometry.coordinates);
    } else {
      updateSafeRouteLayer([]);
    }

    setRouteStats({
      original: {
        time: original.duration,
        distance: original.distance,
        cameras: original.cameraCount,
      },
      safe:
        safestIdx !== 0
          ? {
              time: safest.duration,
              distance: safest.distance,
              cameras: safest.cameraCount,
            }
          : null,
    });
  };

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
    el.style.cssText = `
      width: 16px; height: 16px; background: #E63946;
      border: 2.5px solid white; border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3); cursor: grab;
    `;
    return el;
  };

  const createEndpointMarker = (coord, label) => {
    const id = `marker-${Date.now()}-${Math.random()}`;
    const isStart = label === "A";
    const el = document.createElement("div");
    el.style.cssText = `
      width: 28px; height: 28px;
      background: ${isStart ? "#388e3c" : "#7B1FA2"};
      border: 2.5px solid white; border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: grab;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: white;
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
      const index = markersRef.current.findIndex((m) => m._id === id);
      if (index === -1) return;
      const lngLat = marker.getLngLat();
      pointsRef.current[index] = [lngLat.lng, lngLat.lat];
    });
    marker.on("dragend", () => {
      const index = markersRef.current.findIndex((m) => m._id === id);
      if (index === -1) return;
      const lngLat = marker.getLngLat();
      pointsRef.current[index] = [lngLat.lng, lngLat.lat];
      setPoints([...pointsRef.current]);
    });

    return { marker, id };
  };

  const createPopupContent = (onDelete, onSetEndpoint, onPrepend) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "display: flex; flex-direction: column; gap: 6px; padding: 2px;";

    if (onPrepend) {
      const prependBtn = document.createElement("button");
      prependBtn.innerText = "⬆️ Add point before this";
      prependBtn.style.cssText = `
        background: #9C27B0; color: white; border: none;
        padding: 6px 12px; border-radius: 6px; cursor: pointer;
        font-size: 12px; font-weight: 600; width: 100%;
      `;
      prependBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onPrepend();
      });
      wrapper.appendChild(prependBtn);
    }

    const extendBtn = document.createElement("button");
    extendBtn.innerText = "📍 Extend from here";
    extendBtn.style.cssText = `
      background: #2196F3; color: white; border: none;
      padding: 6px 12px; border-radius: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; width: 100%;
    `;
    extendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onSetEndpoint();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.innerText = "Remove point";
    deleteBtn.style.cssText = `
      background: #E63946; color: white; border: none;
      padding: 6px 12px; border-radius: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; width: 100%;
    `;
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
      const index = markersRef.current.findIndex((m) => m._id === id);
      if (index === -1) return;
      const lngLat = marker.getLngLat();
      pointsRef.current[index] = [lngLat.lng, lngLat.lat];
      updateRoute([...pointsRef.current]);
    });
    marker.on("dragend", () => {
      const index = markersRef.current.findIndex((m) => m._id === id);
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
    // Route mode: only allow A and B endpoint markers
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

    // Prepend mode — insert before index 0
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

    // Extend from selected non-last point
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

    // Default — append to end
    markersRef.current.push(marker);
    pointsRef.current = [...pointsRef.current, coord];
    setPoints([...pointsRef.current]);
    updateRoute([...pointsRef.current]);
    setActiveEndpoint(id);
    markersRef.current.forEach((m) => m._refreshPopup?.());
  }

  const clearRoute = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    pointsRef.current = [];
    prependModeRef.current = false;
    setPrependModeState(false);
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    clearCamerasFromStorage();
    updateRoute([]);
    updateSafeRouteLayer([]);
    setRouteStats(null);
    allRoutesRef.current = [];
    allCamerasRef.current = [];
    analysisActiveRef.current = false;
    setStatsVisible(true);
  };

  const analyzeRoute = async () => {
    if (pointsRef.current.length < 2 || analyzing) return;
    setAnalyzing(true);
    setRouteStats(null);
    updateSafeRouteLayer([]);

    const waypoints = pointsRef.current; // [[lon, lat], ...]

    try {
      // 1. Get walking directions (+ up to 2 alternatives) from Mapbox
      const coordStr = waypoints.map((p) => p.join(",")).join(";");
      const dirRes = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordStr}` +
          `?alternatives=true&geometries=geojson&overview=full&steps=false` +
          `&access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}`,
      );
      if (!dirRes.ok) throw new Error(`Directions API ${dirRes.status}`);
      const { routes } = await dirRes.json();
      if (!routes?.length) throw new Error("No route returned");

      allRoutesRef.current = routes;

      // Replace hand-drawn line with the actual road-following geometry
      updateRoute(routes[0].geometry.coordinates);

      // 2. Fetch cameras covering the bbox of ALL route alternatives
      const allCoords = routes.flatMap((r) => r.geometry.coordinates);
      const lats = allCoords.map((p) => p[1]);
      const lons = allCoords.map((p) => p[0]);
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

      // 3. Score each alternative and display results
      applyAvoidanceRadius(routes, fetched, safeRadius);

      // 4. Save trip to history
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
    } catch (err) {
      console.error("Route analysis failed:", err);
    } finally {
      setAnalyzing(false);
    }
  };

  // Re-score routes when the avoidance slider changes
  useEffect(() => {
    if (allRoutesRef.current.length > 0) {
      applyAvoidanceRadius(
        allRoutesRef.current,
        allCamerasRef.current,
        safeRadius,
      );
    }
  }, [safeRadius]);

  // Sync refs after every render so the map's one-time event listeners
  // always call the current function instance.
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
    pointsRef.current = [];
    prependModeRef.current = false;
    setPrependModeState(false);
    setPoints([]);
    setCameras([]);
    setActiveEndpoint(null);
    updateRoute([]);
    updateSafeRouteLayer([]);
    setRouteStats(null);
    allRoutesRef.current = [];
    allCamerasRef.current = [];
    analysisActiveRef.current = false;
    setStatsVisible(true);
    setMode(newMode);
  };

  const handleSearch = async (value) => {
    setSearch(value);
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
  };

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

      {/* Top header bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          background: "white",
          padding: "12px 20px",
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              background: "#E63946",
              borderRadius: "50%",
            }}
          />
          <span
            style={{
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: "-0.3px",
              color: "#111",
            }}
          >
            SurveillanceTracker
          </span>
        </div>

        {/* Mode toggle */}
        <div
          style={{
            display: "flex",
            gap: 3,
            background: "#f0f0f0",
            borderRadius: 8,
            padding: 3,
            flexShrink: 0,
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
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 12,
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

        {/* History toggle button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setHistoryOpen((o) => !o);
          }}
          style={{
            background: historyOpen ? "#1976D2" : "white",
            border: "1px solid #e0e0e0",
            padding: "7px 14px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            color: historyOpen ? "white" : "#555",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 5,
            boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          }}
        >
          History {tripHistory.length > 0 && `(${tripHistory.length})`}
        </button>

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
                position: "absolute",
                top: "110%",
                left: 0,
                right: 0,
                background: "white",
                borderRadius: 8,
                boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                overflow: "hidden",
                zIndex: 20,
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
            ? `${cameras.length} camera${cameras.length !== 1 ? "s" : ""} watching your route`
            : analyzing
              ? "Analyzing…"
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

      {/* Route stats panel — collapsed pill when hidden */}
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
            Show Results: {routeStats.original.cameras} camera
            {routeStats.original.cameras !== 1 ? "s" : ""} on route
          </button>
        </div>
      )}

      {routeStats && statsVisible && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: 90,
            left: "50%",
            transform: "translateX(-50%)",
            background: "white",
            borderRadius: 14,
            padding: "16px 20px",
            boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
            zIndex: 10,
            minWidth: 360,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* Title bar with close */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: -4,
            }}
          >
            <span
              style={{
                fontWeight: 700,
                fontSize: 13,
                color: "#333",
                letterSpacing: "-0.2px",
              }}
            >
              Route Analysis
            </span>
            <button
              onClick={() => setStatsVisible(false)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#999",
                fontSize: 16,
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
          {/* Two-column route comparison */}
          <div style={{ display: "flex", gap: 12 }}>
            {/* Original route */}
            <div
              style={{
                flex: 1,
                textAlign: "center",
                padding: "10px 8px",
                borderRadius: 10,
                background: "#fff5f5",
                border: "1px solid #fcc",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#999",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Your Route
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#E63946" }}>
                {formatTime(routeStats.original.time)}
              </div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                {formatDistance(routeStats.original.distance)}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#c47c00",
                  marginTop: 4,
                  fontWeight: 600,
                }}
              >
                {routeStats.original.cameras} camera
                {routeStats.original.cameras !== 1 ? "s" : ""}
              </div>
            </div>

            {/* Safe route */}
            <div
              style={{
                flex: 1,
                textAlign: "center",
                padding: "10px 8px",
                borderRadius: 10,
                background: routeStats.safe ? "#f0f7ff" : "#f9f9f9",
                border: `1px solid ${routeStats.safe ? "#90caf9" : "#eee"}`,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#999",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                Safe Route
              </div>
              {routeStats.safe ? (
                <>
                  <div
                    style={{ fontSize: 22, fontWeight: 800, color: "#2196F3" }}
                  >
                    {formatTime(routeStats.safe.time)}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                    {formatDistance(routeStats.safe.distance)}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#388e3c",
                      marginTop: 4,
                      fontWeight: 600,
                    }}
                  >
                    {routeStats.safe.cameras} camera
                    {routeStats.safe.cameras !== 1 ? "s" : ""}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: "#999", marginTop: 12 }}>
                  No safer
                  <br />
                  alternative found
                </div>
              )}
            </div>
          </div>

          {/* Avoidance radius slider */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: "#666",
                marginBottom: 6,
              }}
            >
              <span>Camera avoidance radius</span>
              <span style={{ fontWeight: 600, color: "#2196F3" }}>
                {safeRadius} m ({Math.round(safeRadius * 3.281)} ft)
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={200}
              step={5}
              value={safeRadius}
              onChange={(e) => setSafeRadius(parseInt(e.target.value))}
              style={{ width: "100%", accentColor: "#2196F3" }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "#bbb",
                marginTop: 2,
              }}
            >
              <span>10 m</span>
              <span>200 m</span>
            </div>
          </div>
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
        {/* Profile selector */}
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
                padding: "9px 14px",
                borderRadius: 7,
                fontSize: 12,
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
            padding: "12px 20px",
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

        {(() => {
          const canAnalyze =
            mode === "route" ? points.length === 2 : points.length >= 2;
          const disabled = !canAnalyze || analyzing;
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                analyzeRoute();
              }}
              disabled={disabled}
              style={{
                background: disabled ? "#ccc" : "#E63946",
                color: "white",
                border: "none",
                padding: "12px 24px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                cursor: disabled ? "not-allowed" : "pointer",
                boxShadow: !disabled
                  ? "0 2px 12px rgba(230,57,70,0.4)"
                  : "none",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {analyzing ? "Analyzing…" : "Analyze Route →"}
            </button>
          );
        })()}
      </div>

      {/* History side panel */}
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
          {/* Panel header */}
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

          {/* Trip list */}
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
                  {/* Trip header */}
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
                        {trip.profile === "driving" ? "" : ""}{" "}
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

                  {/* Stats grid */}
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

                  {/* Fly to button */}
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
