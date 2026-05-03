import fs from 'fs'
import path from 'path'
import type { NextRequest } from 'next/server'

export interface Camera {
  id: number
  lat: number
  lon: number
  tags: Record<string, string>
}

interface GeoJsonFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: Record<string, string>
}

// Loaded once per server instance
let cameraCache: Camera[] | null = null

function loadCameras(): Camera[] {
  if (cameraCache) return cameraCache

  const filePath = path.join(process.cwd(), 'public', 'cameras.geojson')
  const raw = fs.readFileSync(filePath, 'utf-8')
  const geojson = JSON.parse(raw)

  cameraCache = (geojson.features as GeoJsonFeature[]).map((f, i) => ({
    id: i,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    tags: f.properties ?? {},
  }))

  return cameraCache
}

function filterByBbox(
  cameras: Camera[],
  south: number,
  west: number,
  north: number,
  east: number
): Camera[] {
  return cameras.filter(
    c => c.lat >= south && c.lat <= north && c.lon >= west && c.lon <= east
  )
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function filterByRadius(
  cameras: Camera[],
  lat: number,
  lon: number,
  radiusMeters: number
): Camera[] {
  return cameras.filter(c => haversineMeters(lat, lon, c.lat, c.lon) <= radiusMeters)
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  const hasBbox = ['south', 'west', 'north', 'east'].every(k => searchParams.has(k))
  const hasPoint = searchParams.has('lat') && searchParams.has('lon')

  if (!hasBbox && !hasPoint) {
    return Response.json(
      { error: 'Provide either bbox params (south, west, north, east) or point params (lat, lon)' },
      { status: 400 }
    )
  }

  try {
    const all = loadCameras()
    let cameras: Camera[]

    if (hasBbox) {
      const south = parseFloat(searchParams.get('south')!)
      const west = parseFloat(searchParams.get('west')!)
      const north = parseFloat(searchParams.get('north')!)
      const east = parseFloat(searchParams.get('east')!)

      if ([south, west, north, east].some(isNaN)) {
        return Response.json({ error: 'bbox params must be valid numbers' }, { status: 400 })
      }

      cameras = filterByBbox(all, south, west, north, east)
    } else {
      const lat = parseFloat(searchParams.get('lat')!)
      const lon = parseFloat(searchParams.get('lon')!)
      const radius = parseInt(searchParams.get('radius') ?? '100', 10)

      if (isNaN(lat) || isNaN(lon) || isNaN(radius)) {
        return Response.json({ error: 'lat, lon, and radius must be valid numbers' }, { status: 400 })
      }

      cameras = filterByRadius(all, lat, lon, radius)
    }

    return Response.json({ cameras, count: cameras.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return Response.json({ error: message }, { status: 502 })
  }
}
