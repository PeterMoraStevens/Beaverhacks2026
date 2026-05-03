import type { NextRequest } from 'next/server'
import * as turf from '@turf/turf'

interface Waypoint {
  lat: number
  lon: number
}

interface Camera {
  lat: number
  lon: number
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}


const VALHALLA_URL = process.env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de'
const MAX_POLYGONS = parseInt(process.env.VALHALLA_MAX_POLYGONS ?? '50', 10)
// Use rounder circles locally; keep 4 steps for the public server.
const POLYGON_STEPS = MAX_POLYGONS > 50 ? 8 : 4

// Valhalla rejects requests whose total polygon perimeter exceeds this.
// Default is 10,000 m; self-hosted can raise it via loki.service_defaults.max_exclude_polygons_length.
const VALHALLA_MAX_CIRCUMFERENCE_M = parseFloat(
  process.env.VALHALLA_MAX_CIRCUMFERENCE_M ?? '10000'
)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { waypoints, costing, cameras = [], radiusMeters = 50 } = body

    if (!waypoints || (waypoints as Waypoint[]).length < 2) {
      return Response.json({ error: 'At least 2 waypoints required' }, { status: 400 })
    }

    if (!costing) {
      return Response.json({ error: 'costing is required (pedestrian or auto)' }, { status: 400 })
    }

    const locations = (waypoints as Waypoint[]).map((wp, i, arr) => ({
      lon: wp.lon,
      lat: wp.lat,
      type: i === 0 || i === arr.length - 1 ? 'break' : 'through',
    }))

    const radiusKm = Math.max(radiusMeters as number, 10) / 1000

    // Perimeter of a regular POLYGON_STEPS-gon inscribed in a circle of radiusKm.
    const perimeterPerPolyM = 2 * POLYGON_STEPS * radiusKm * 1000 * Math.sin(Math.PI / POLYGON_STEPS)

    // How many polygons fit in 95% of Valhalla's circumference budget.
    const maxByCircumference = Math.floor((VALHALLA_MAX_CIRCUMFERENCE_M * 0.95) / perimeterPerPolyM)
    const effectiveMax = Math.min(MAX_POLYGONS, maxByCircumference)

    // Build exclusion zones. Skip cameras whose polygon would engulf a waypoint
    // (that causes Valhalla error 110 — location inside excluded area).
    const wps = waypoints as Waypoint[]
    const excludePolygons = (cameras as Camera[])
      .slice(0, effectiveMax)
      .filter((cam) =>
        !wps.some((wp) => haversineKm(cam.lat, cam.lon, wp.lat, wp.lon) < radiusKm)
      )
      .map((cam) =>
        turf.circle([cam.lon, cam.lat], radiusKm, { steps: POLYGON_STEPS, units: 'kilometers' })
          .geometry.coordinates[0]
      )

    const valhallaBody: Record<string, unknown> = { locations, costing }
    if (excludePolygons.length > 0) valhallaBody.exclude_polygons = excludePolygons

    const res = await fetch(`${VALHALLA_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valhallaBody),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return Response.json(
        { error: (err as { error?: string }).error ?? `Valhalla ${res.status}` },
        { status: res.status }
      )
    }

    const data = await res.json()
    return Response.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}
