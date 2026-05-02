import type { NextRequest } from 'next/server'

export interface Camera {
  id: number
  lat: number
  lon: number
  tags: Record<string, string>
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  const lat = searchParams.get('lat')
  const lon = searchParams.get('lon')
  const radius = searchParams.get('radius') ?? '100'

  if (!lat || !lon) {
    return Response.json(
      { error: 'lat and lon query parameters are required' },
      { status: 400 }
    )
  }

  const latNum = parseFloat(lat)
  const lonNum = parseFloat(lon)
  const radiusNum = parseInt(radius, 10)

  if (isNaN(latNum) || isNaN(lonNum) || isNaN(radiusNum)) {
    return Response.json(
      { error: 'lat, lon, and radius must be valid numbers' },
      { status: 400 }
    )
  }

  const query = `
[out:json][timeout:25];
(
  node["man_made"="surveillance"](around:${radiusNum},${latNum},${lonNum});
  node["surveillance"="camera"](around:${radiusNum},${latNum},${lonNum});
);
out body;
  `.trim()

  const overpassRes = await fetch(OVERPASS_URL, {
    method: 'POST',
     headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://overpass.petermorastevens.rocks",
      "User-Agent": "beaverhacks2026/1.0",
    },
    body: `data=${encodeURIComponent(query)}`,
  })

  if (!overpassRes.ok) {
    return Response.json(
      { error: 'Overpass API request failed', status: overpassRes.status },
      { status: 502 }
    )
  }

  const data = await overpassRes.json()

  const cameras: Camera[] = (data.elements ?? []).map((el: Camera) => ({
    id: el.id,
    lat: el.lat,
    lon: el.lon,
    tags: el.tags ?? {},
  }))

  return Response.json({ cameras, count: cameras.length })
}
