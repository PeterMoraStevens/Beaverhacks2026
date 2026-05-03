import { lineString, point } from "@turf/helpers";
import length from "@turf/length";
import along from "@turf/along";
import type { Feature, LineString, Point } from "geojson";
import type { Camera } from "../app/api/cameras/route.ts"

export type Coord = [number, number];

export function samplePoints(
  coords: Coord[],
  spacing: number = 20 // meters
) { if (coords.length < 2) return coords;

  const line: Feature<LineString> = lineString(coords);
  const totalLength = length(line, { units: "meters" });

  const sampled: Coord[] = [];

  for (let dist = 0; dist <= totalLength; dist += spacing) {
    const pt: Feature<Point> = along(line, dist, { units: "meters" });
    sampled.push(pt.geometry.coordinates as Coord);
  }

  // ensure final endpoint is included
  const last = coords[coords.length - 1];
  const lastSample = sampled[sampled.length - 1];

  if (
    !lastSample ||
    lastSample[0] !== last[0] ||
    lastSample[1] !== last[1]
  ) {
    sampled.push(last);
  }

  return sampled;
}

export async function fetchCamerasNearPoint(
  lon: number,
  lat: number,
  radius: number = 50
) {
  const res = await fetch(
    `/api/cameras?lat=${lat}&lon=${lon}&radius=${radius}`
  );

  if (!res.ok) throw new Error("Failed to fetch cameras");

  const data = await res.json();
  return data.cameras as Camera[];
}


