/**
 * =============================================================================
 * 3D Scene
 * =============================================================================
 *
 * Core rendering pipeline. Parses SVG paths via SVGLoader, extrudes them into
 * buffered 3D geometry, and renders the result inside a React Three Fiber
 * <Canvas> with environment lighting, contact shadows, and smooth controls.
 *
 * @packageDocumentation
 */

// Suppress THREE.Clock deprecation warning from R3F internals (fixed when R3F updates to THREE.Timer)
const _origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("THREE.Clock")) return;
  _origWarn.apply(console, args);
};

import { useRef, useMemo, useEffect, useState, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment } from "@react-three/drei";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type MaterialSettings, materialPresets } from "./materials";
import { type GeometryMode, type QualityProfile } from "./types";
import {
  SmoothControls,
  IntroAnimation,
  LoopAnimation,
  introComplete,
  type AnimationType,
} from "./controls";

export type GeometryBuildProfile = "preview" | "export";
type MaterialBuildProfile = "preview" | "export";

// ---------------------------------------------------------------------------
// ExtrudedSVG
// ---------------------------------------------------------------------------

export interface ExtrudedSVGProps {
  svgString: string;
  mode: GeometryMode;
  depth: number;
  smoothness: number;
  volumeInflate: number;
  volumeFrontRoundness: number;
  volumeBackRoundness: number;
  volumeEdgeSoftness: number;
  volumeDetailStrength: number;
  qualityProfile: QualityProfile;
  antiFlicker: boolean;
  color: string;
  preserveSvgColors: boolean;
  materialSettings: MaterialSettings;
  rotationX: number;
  rotationY: number;
  groupRef: React.RefObject<THREE.Group | null>;
  texture?: string;
  textureRepeat?: number;
  textureRotation?: number;
  textureOffset?: [number, number];
  onLoadingChange?: (loading: boolean, progress: number) => void;
  onGroupReady?: (group: THREE.Group | null) => void;
}

// ---------------------------------------------------------------------------
function recomputeTriplanarUVs(geo: THREE.BufferGeometry, bb: THREE.Box3) {
  const bbSize = new THREE.Vector3();
  bb.getSize(bbSize);
  const uvAttr = geo.attributes.uv;
  const posAttr = geo.attributes.position;
  const normalAttr = geo.attributes.normal;
  const maxDimUv = Math.max(bbSize.x, bbSize.y, bbSize.z) || 1;

  for (let j = 0; j < uvAttr.count; j++) {
    const px = posAttr.getX(j);
    const py = posAttr.getY(j);
    const pz = posAttr.getZ(j);
    const nx = Math.abs(normalAttr.getX(j));
    const ny = Math.abs(normalAttr.getY(j));
    const nz = Math.abs(normalAttr.getZ(j));

    let u: number, v: number;
    if (nz >= nx && nz >= ny) {
      u = (px - bb.min.x) / maxDimUv;
      v = 1 - (py - bb.min.y) / maxDimUv;
    } else if (nx >= ny) {
      u = (pz - bb.min.z) / maxDimUv;
      v = 1 - (py - bb.min.y) / maxDimUv;
    } else {
      u = (px - bb.min.x) / maxDimUv;
      v = (pz - bb.min.z) / maxDimUv;
    }
    uvAttr.setXY(j, u, v);
  }
  uvAttr.needsUpdate = true;
}

// useExtrudedGeometry — async geometry computation hook
// Processes shapes in batches to avoid freezing the browser.
// ---------------------------------------------------------------------------

export interface ExtrudedGeometryResult {
  parts: {
    geometry: THREE.BufferGeometry;
    color: string | null;
  }[];
  center: THREE.Vector3;
  baseScale: number;
  boundsRadius: number;
}

function createEmptyResult(): ExtrudedGeometryResult {
  return {
    parts: [],
    center: new THREE.Vector3(),
    baseScale: 1,
    boundsRadius: 0,
  };
}

const EMPTY_RESULT = createEmptyResult();

// How many shapes to extrude per frame before yielding
const BATCH_SIZE = 20;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isViewBoxRect(shape: THREE.Shape, vbW: number, vbH: number): boolean {
  const pts = shape.getPoints(4);
  if (pts.length !== 4 && pts.length !== 5) return false;
  const bb = new THREE.Box2();
  for (const p of pts) bb.expandByPoint(p);
  const size = new THREE.Vector2();
  bb.getSize(size);
  const tolerance = 0.01;
  return Math.abs(size.x - vbW) / vbW < tolerance && Math.abs(size.y - vbH) / vbH < tolerance;
}

interface ParsedSVGPart {
  shapes: THREE.Shape[];
  color: string | null;
}

type VolumeRegionRole = "body" | "raised_feature" | "ignored_detail";

interface VolumeRegion {
  id: string;
  shape: THREE.Shape;
  color: string | null;
  paintOrder: number;
  bbox: THREE.Box2;
  area: number;
  centroid: THREE.Vector2;
  parentId: string | null;
  containmentDepth: number;
  touchesOuterSilhouette: boolean;
  role: VolumeRegionRole;
}

function resolveStyleOpacity(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = parseFloat(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 1;
}

function resolveSvgColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  if (!color) return null;

  const lower = color.toLowerCase();
  if (
    lower === "none" ||
    lower === "transparent" ||
    lower === "currentcolor" ||
    lower === "inherit"
  ) {
    return null;
  }

  try {
    return `#${new THREE.Color(color).getHexString()}`;
  } catch {
    return null;
  }
}

function parseShapesFromSVG(svgString: string, preserveSvgColors: boolean): ParsedSVGPart[] {
  const loader = new SVGLoader();
  const svgData = loader.parse(svgString);
  const allParts: ParsedSVGPart[] = [];

  // Parse viewBox for background rect detection
  const vbMatch = svgString.match(/viewBox\s*=\s*["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
  const vbW = vbMatch ? parseFloat(vbMatch[3]) : null;
  const vbH = vbMatch ? parseFloat(vbMatch[4]) : null;

  svgData.paths.forEach((path) => {
    const style = path.userData?.style;
    const fillColor = resolveSvgColor(style?.fill);
    const strokeColor = resolveSvgColor(style?.stroke);
    const fillOpacity = resolveStyleOpacity(style?.fillOpacity, style?.opacity);
    const strokeOpacity = resolveStyleOpacity(style?.strokeOpacity, style?.opacity);

    const hasFill = fillColor && fillOpacity > 0;
    const hasStroke = strokeColor && strokeOpacity > 0;

    if (hasFill) {
      const shapes = SVGLoader.createShapes(path);
      for (const shape of shapes) {
        // Skip full-viewBox rectangles (background artifacts from export tools)
        if (vbW && vbH && isViewBoxRect(shape, vbW, vbH)) continue;
        allParts.push({
          shapes: [shape],
          color: preserveSvgColors ? fillColor : null,
        });
      }
    }

    if (hasStroke) {
      const strokeWidth = parseFloat(style?.strokeWidth ?? "2");
      const divisions = 12;
      path.subPaths.forEach((subPath) => {
        const points = subPath.getPoints(divisions);
        if (points.length < 2) return;

        const shape = new THREE.Shape();
        const halfWidth = strokeWidth / 2;
        const leftSide: THREE.Vector2[] = [];
        const rightSide: THREE.Vector2[] = [];

        for (let i = 0; i < points.length; i++) {
          const curr = points[i];
          const prev = points[Math.max(0, i - 1)];
          const next = points[Math.min(points.length - 1, i + 1)];
          const dx = next.x - prev.x;
          const dy = next.y - prev.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          leftSide.push(new THREE.Vector2(curr.x + nx * halfWidth, curr.y + ny * halfWidth));
          rightSide.push(new THREE.Vector2(curr.x - nx * halfWidth, curr.y - ny * halfWidth));
        }

        shape.moveTo(leftSide[0].x, leftSide[0].y);
        for (let i = 1; i < leftSide.length; i++) shape.lineTo(leftSide[i].x, leftSide[i].y);
        for (let i = rightSide.length - 1; i >= 0; i--) shape.lineTo(rightSide[i].x, rightSide[i].y);
        shape.closePath();
        allParts.push({
          shapes: [shape],
          color: preserveSvgColors ? strokeColor : null,
        });
      });
    }

    if (!hasFill && !hasStroke) {
      const shapes = SVGLoader.createShapes(path);
      if (shapes.length > 0) {
        allParts.push({ shapes, color: null });
      }
    }
  });

  return allParts;
}

function getBox2Size(box: THREE.Box2) {
  return new THREE.Vector2(box.max.x - box.min.x, box.max.y - box.min.y);
}

function computePolygonArea(points: THREE.Vector2[]) {
  if (points.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area * 0.5;
}

function pointInPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-6) + xi;

    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInShape(point: THREE.Vector2, shape: THREE.Shape) {
  const extracted = shape.extractPoints(40);
  if (!pointInPolygon(point, extracted.shape)) return false;
  return !extracted.holes.some((hole) => pointInPolygon(point, hole));
}

function measureShape(shape: THREE.Shape) {
  const extracted = shape.extractPoints(32);
  const bbox = new THREE.Box2();

  for (const point of extracted.shape) bbox.expandByPoint(point);
  for (const hole of extracted.holes) {
    for (const point of hole) bbox.expandByPoint(point);
  }

  const outerArea = Math.abs(computePolygonArea(extracted.shape));
  const holeArea = extracted.holes.reduce((sum, hole) => sum + Math.abs(computePolygonArea(hole)), 0);
  const area = Math.max(outerArea - holeArea, 1e-6);
  const centroid = bbox.getCenter(new THREE.Vector2());

  return { bbox, area, centroid };
}

function boxContainsBox(outer: THREE.Box2, inner: THREE.Box2, padding: number) {
  return (
    inner.min.x >= outer.min.x - padding &&
    inner.min.y >= outer.min.y - padding &&
    inner.max.x <= outer.max.x + padding &&
    inner.max.y <= outer.max.y + padding
  );
}

function parseVolumeRegionsFromSVG(svgString: string, preserveSvgColors: boolean) {
  const loader = new SVGLoader();
  const svgData = loader.parse(svgString);
  const regions: VolumeRegion[] = [];

  const vbMatch = svgString.match(/viewBox\s*=\s*["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
  const vbW = vbMatch ? parseFloat(vbMatch[3]) : null;
  const vbH = vbMatch ? parseFloat(vbMatch[4]) : null;

  let paintOrder = 0;
  svgData.paths.forEach((path) => {
    const style = path.userData?.style;
    const fillColor = resolveSvgColor(style?.fill);
    const fillOpacity = resolveStyleOpacity(style?.fillOpacity, style?.opacity);
    if (!fillColor || fillOpacity <= 0) return;

    const shapes = SVGLoader.createShapes(path);
    for (const shape of shapes) {
      if (vbW && vbH && isViewBoxRect(shape, vbW, vbH)) continue;
      const { bbox, area, centroid } = measureShape(shape);
      regions.push({
        id: `region-${paintOrder}`,
        shape,
        color: preserveSvgColors ? fillColor : null,
        paintOrder,
        bbox,
        area,
        centroid,
        parentId: null,
        containmentDepth: 0,
        touchesOuterSilhouette: false,
        role: "body",
      });
      paintOrder++;
    }
  });

  if (regions.length === 0) return regions;

  const globalBox = new THREE.Box2();
  for (const region of regions) {
    globalBox.expandByPoint(region.bbox.min);
    globalBox.expandByPoint(region.bbox.max);
  }

  const maxFlatDim = Math.max(...regions.map((region) => {
    const size = getBox2Size(region.bbox);
    return Math.max(size.x, size.y, 1);
  }));
  const containPadding = maxFlatDim * 0.003;
  const edgeTolerance = maxFlatDim * 0.02;

  const byArea = [...regions].sort((a, b) => a.area - b.area);
  for (const region of byArea) {
    let parent: VolumeRegion | null = null;
    for (const candidate of byArea) {
      if (candidate.area <= region.area || candidate.id === region.id) continue;
      if (!boxContainsBox(candidate.bbox, region.bbox, containPadding)) continue;
      if (!pointInShape(region.centroid, candidate.shape)) continue;
      if (!parent || candidate.area < parent.area) {
        parent = candidate;
      }
    }
    region.parentId = parent?.id ?? null;
  }

  const byId = new Map(regions.map((region) => [region.id, region]));
  for (const region of regions) {
    let depth = 0;
    let parent = region.parentId ? byId.get(region.parentId) ?? null : null;
    while (parent) {
      depth++;
      parent = parent.parentId ? byId.get(parent.parentId) ?? null : null;
    }
    region.containmentDepth = depth;
    region.touchesOuterSilhouette =
      Math.abs(region.bbox.min.x - globalBox.min.x) <= edgeTolerance ||
      Math.abs(region.bbox.min.y - globalBox.min.y) <= edgeTolerance ||
      Math.abs(region.bbox.max.x - globalBox.max.x) <= edgeTolerance ||
      Math.abs(region.bbox.max.y - globalBox.max.y) <= edgeTolerance;
  }

  return regions;
}

function classifyVolumeRegions(regions: VolumeRegion[], volumeDetailStrength: number) {
  if (regions.length === 0) return regions;

  const maxArea = Math.max(...regions.map((region) => region.area), 1e-6);
  const ignoreThreshold = THREE.MathUtils.lerp(0.0028, 0.00035, clamp(volumeDetailStrength, 0, 1));

  return regions.map((region) => {
    const areaRatio = region.area / maxArea;

    if (region.parentId === null) {
      return { ...region, role: areaRatio < ignoreThreshold * 0.45 && !region.touchesOuterSilhouette ? "ignored_detail" : "body" };
    }

    if (areaRatio < ignoreThreshold) {
      return { ...region, role: "ignored_detail" };
    }

    return { ...region, role: "raised_feature" };
  });
}

interface BuildExtrudedGeometryOptions {
  svgString: string;
  depth: number;
  smoothness: number;
  volumeInflate: number;
  volumeFrontRoundness: number;
  volumeBackRoundness: number;
  volumeEdgeSoftness: number;
  volumeDetailStrength: number;
  qualityProfile: QualityProfile;
  preserveSvgColors: boolean;
  profile?: GeometryBuildProfile;
  onProgress?: (progress: number) => void;
  shouldCancel?: () => boolean;
}

interface BuildGeometryOptions extends BuildExtrudedGeometryOptions {
  mode: GeometryMode;
}

function getQualityMultiplier(qualityProfile: QualityProfile) {
  switch (qualityProfile) {
    case "draft":
      return 0.72;
    case "high":
      return 1.18;
    default:
      return 1;
  }
}

function getExtrudeSettings(
  maxFlatDim: number,
  depth: number,
  smoothness: number,
  complexity: number,
  profile: GeometryBuildProfile,
  qualityProfile: QualityProfile
) {
  const scaledDepth = (depth / 10) * maxFlatDim;
  const bevelScale = Math.min(maxFlatDim * 0.02, 1);
  const qualityScale = getQualityMultiplier(qualityProfile);
  const complexityScale =
    complexity > 240 ? 0.38 :
    complexity > 140 ? 0.56 :
    complexity > 70 ? 0.78 :
    1;
  const thinGeometry = depth <= 1 || smoothness < 0.14;
  const denseGeometry = complexity > 150;
  const allowBevel = !thinGeometry && !(qualityProfile === "draft" && denseGeometry);

  if (profile === "export") {
    const curveSegments = clamp(
      Math.round((16 + smoothness * 18) * qualityScale * complexityScale),
      qualityProfile === "draft" ? 8 : 12,
      qualityProfile === "high" ? 34 : 28
    );
    const bevelSegments = allowBevel
      ? clamp(
          Math.round((1 + smoothness * 3.2) * qualityScale * Math.max(0.55, complexityScale)),
          1,
          qualityProfile === "high" ? 5 : 4
        )
      : 0;
    const bevelAmount = bevelScale * (0.1 + smoothness * 0.12) * Math.min(1.1, qualityScale);

    return {
      depth: scaledDepth,
      bevelEnabled: bevelSegments > 0,
      bevelThickness: bevelSegments > 0 ? bevelAmount : 0,
      bevelSize: bevelSegments > 0 ? bevelAmount : 0,
      bevelSegments,
      curveSegments,
      includeUvs: false,
    };
  }

  return {
    depth: scaledDepth,
    bevelEnabled: allowBevel,
    bevelThickness: allowBevel ? bevelScale * (0.11 + smoothness * 0.12) * Math.min(1.05, qualityScale) : 0,
    bevelSize: allowBevel ? bevelScale * (0.11 + smoothness * 0.12) * Math.min(1.05, qualityScale) : 0,
    bevelSegments: allowBevel
      ? clamp(
          Math.round((1 + smoothness * 5) * qualityScale * Math.max(0.55, complexityScale)),
          1,
          qualityProfile === "high" ? 5 : 3
        )
      : 0,
    curveSegments: clamp(
      Math.round((12 + smoothness * 22) * qualityScale * complexityScale),
      qualityProfile === "draft" ? 8 : 10,
      qualityProfile === "high" ? 30 : 24
    ),
    includeUvs: true,
  };
}

function getVolumeSettings(
  maxFlatDim: number,
  depth: number,
  smoothness: number,
  volumeInflate: number,
  volumeFrontRoundness: number,
  volumeBackRoundness: number,
  volumeEdgeSoftness: number,
  complexity: number,
  profile: GeometryBuildProfile,
  qualityProfile: QualityProfile
) {
  const scaledDepth = (depth / 10) * maxFlatDim;
  const bevelScale = Math.min(maxFlatDim * 0.02, 1);
  const qualityScale = getQualityMultiplier(qualityProfile);
  const inflate = clamp(volumeInflate, 0, 1);
  const frontRoundness = clamp(volumeFrontRoundness, 0, 1);
  const backRoundness = clamp(volumeBackRoundness, 0, 1);
  const edgeSoftness = clamp(volumeEdgeSoftness, 0, 1);
  const complexityScale =
    complexity > 220 ? 0.52 :
    complexity > 120 ? 0.72 :
    complexity > 60 ? 0.9 :
    1;
  const curveSegments = clamp(
    Math.round((14 + smoothness * 12 + edgeSoftness * 10) * qualityScale * complexityScale),
    qualityProfile === "draft" ? 10 : 12,
    qualityProfile === "high" ? 34 : 28
  );
  const bevelSegments = clamp(
    Math.round((3 + smoothness * 4 + edgeSoftness * 4) * qualityScale * Math.max(0.7, complexityScale)),
    qualityProfile === "draft" ? 3 : 4,
    qualityProfile === "high" ? 8 : 6
  );
  const bevelThickness = clamp(
    scaledDepth * (0.12 + edgeSoftness * 0.16 + Math.max(frontRoundness, backRoundness) * 0.06),
    scaledDepth * 0.1,
    scaledDepth * 0.38
  );
  const bevelSize = clamp(
    bevelScale * (0.18 + edgeSoftness * 0.22 + smoothness * 0.06) * Math.min(1.08, qualityScale) * Math.max(0.82, complexityScale),
    bevelScale * 0.16,
    bevelScale * 0.52
  );
  const bulgeStrength = clamp(
    (profile === "export" ? 0.045 : 0.04) + inflate * 0.14 + smoothness * 0.045 + (qualityProfile === "high" ? 0.015 : 0),
    0.04,
    0.24
  );
  const domeDepth = clamp(
    scaledDepth * (0.08 + Math.max(frontRoundness, backRoundness) * 0.18 + edgeSoftness * 0.04),
    scaledDepth * 0.06,
    scaledDepth * 0.32
  );
  const edgeExponent = THREE.MathUtils.lerp(2.4, 0.9, edgeSoftness);

  return {
    depth: scaledDepth,
    bevelEnabled: true,
    bevelThickness,
    bevelSize,
    bevelSegments,
    curveSegments,
    includeUvs: profile === "preview",
    bulgeStrength,
    frontRoundness,
    backRoundness,
    domeDepth,
    edgeExponent,
  };
}

function applyVolumeBulge(
  geo: THREE.BufferGeometry,
  {
    bulgeStrength,
    frontRoundness,
    backRoundness,
    domeDepth,
    edgeExponent,
  }: {
    bulgeStrength: number;
    frontRoundness: number;
    backRoundness: number;
    domeDepth: number;
    edgeExponent: number;
  },
  bounds?: {
    xy?: THREE.Box3;
    z?: THREE.Box3;
  }
) {
  geo.computeBoundingBox();
  if (!geo.boundingBox) return;
  const xyBounds = bounds?.xy ?? geo.boundingBox;
  const zBounds = bounds?.z ?? geo.boundingBox;

  const center = new THREE.Vector3();
  xyBounds.getCenter(center);
  const depth = Math.max(zBounds.max.z - zBounds.min.z, 1e-6);
  const halfX = Math.max((xyBounds.max.x - xyBounds.min.x) * 0.5, 1e-6);
  const halfY = Math.max((xyBounds.max.y - xyBounds.min.y) * 0.5, 1e-6);
  const posAttr = geo.attributes.position;

  for (let i = 0; i < posAttr.count; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const z = pz - zBounds.min.z;
    const t = clamp(z / depth, 0, 1);
    const midWeight = Math.pow(Math.sin(Math.PI * t), 1.15);
    const dx = px - center.x;
    const dy = py - center.y;
    const radial = clamp(Math.hypot(dx / halfX, dy / halfY), 0, 1.4);
    const coreWeight = Math.pow(Math.max(0, 1 - Math.min(radial, 1)), edgeExponent);
    const scaleWeight = 0.35 + coreWeight * 0.65;

    if (midWeight > 0.0001) {
      const scale = 1 + bulgeStrength * midWeight * scaleWeight;
      posAttr.setXY(i, center.x + dx * scale, center.y + dy * scale);
    }

    const frontCap = frontRoundness > 0
      ? Math.pow(t, THREE.MathUtils.lerp(1.45, 0.9, frontRoundness)) * coreWeight * frontRoundness
      : 0;
    const backCap = backRoundness > 0
      ? Math.pow(1 - t, THREE.MathUtils.lerp(1.45, 0.9, backRoundness)) * coreWeight * backRoundness
      : 0;
    posAttr.setZ(i, pz + (frontCap - backCap) * domeDepth);
  }

  posAttr.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

export async function buildExtrudedGeometryResult({
  svgString,
  depth,
  smoothness,
  volumeInflate: _volumeInflate,
  volumeFrontRoundness: _volumeFrontRoundness,
  volumeBackRoundness: _volumeBackRoundness,
  volumeEdgeSoftness: _volumeEdgeSoftness,
  volumeDetailStrength: _volumeDetailStrength,
  qualityProfile,
  preserveSvgColors,
  profile = "preview",
  onProgress,
  shouldCancel,
}: BuildExtrudedGeometryOptions): Promise<ExtrudedGeometryResult> {
  const isCancelled = () => shouldCancel?.() ?? false;
  const reportProgress = (progress: number) => onProgress?.(progress);

  const svgParts = parseShapesFromSVG(svgString, preserveSvgColors);
  const allShapes = svgParts.flatMap((part) => part.shapes);
  if (allShapes.length === 0 || isCancelled()) {
    return createEmptyResult();
  }

  const tempGeo = new THREE.ShapeGeometry(allShapes);
  tempGeo.computeBoundingBox();
  const flatSize = new THREE.Vector3();
  tempGeo.boundingBox!.getSize(flatSize);
  const maxFlatDim = Math.max(flatSize.x, flatSize.y, 1);
  tempGeo.dispose();

  const extrudeSettings = getExtrudeSettings(
    maxFlatDim,
    depth,
    smoothness,
    allShapes.length,
    profile,
    qualityProfile
  );

  const groupedGeometries = new Map<string, { color: string | null; geometries: THREE.ExtrudeGeometry[] }>();
  let processedShapes = 0;

  for (const part of svgParts) {
    for (const shape of part.shapes) {
      if (isCancelled()) {
        groupedGeometries.forEach((entry) => entry.geometries.forEach((g) => g.dispose()));
        return createEmptyResult();
      }

      const key = part.color ?? "__default__";
      const entry = groupedGeometries.get(key) ?? { color: part.color, geometries: [] };
      entry.geometries.push(new THREE.ExtrudeGeometry(shape, extrudeSettings));
      groupedGeometries.set(key, entry);

      processedShapes++;
      if (processedShapes % BATCH_SIZE === 0) {
        reportProgress(Math.round((processedShapes / allShapes.length) * 90));
        await yieldToMain();
      }
    }
  }

  if (isCancelled()) {
    groupedGeometries.forEach((entry) => entry.geometries.forEach((g) => g.dispose()));
    return createEmptyResult();
  }

  reportProgress(92);
  await yieldToMain();

  const mergedParts: ExtrudedGeometryResult["parts"] = [];
  const groupedEntries = [...groupedGeometries.entries()].sort(([leftKey], [rightKey]) => {
    const leftFeature = leftKey.startsWith("feature:");
    const rightFeature = rightKey.startsWith("feature:");
    return Number(leftFeature) - Number(rightFeature);
  });

  for (const [, entry] of groupedEntries) {
    const merged =
      entry.geometries.length === 1
        ? entry.geometries[0]
        : BufferGeometryUtils.mergeGeometries(entry.geometries, false);

    if (!merged) {
      entry.geometries.forEach((g) => g.dispose());
      mergedParts.forEach((part) => part.geometry.dispose());
      return createEmptyResult();
    }

    if (entry.geometries.length > 1) {
      entry.geometries.forEach((g) => g.dispose());
    }

    merged.computeBoundingBox();
    if (extrudeSettings.includeUvs) {
      recomputeTriplanarUVs(merged, merged.boundingBox!);
    } else {
      merged.deleteAttribute("uv");
    }

    const optimized =
      profile === "export"
        ? BufferGeometryUtils.mergeVertices(merged, qualityProfile === "draft" ? 1e-4 : 1e-5)
        : merged;

    if (optimized !== merged) {
      merged.dispose();
    }

    optimized.computeBoundingBox();
    optimized.computeVertexNormals();
    optimized.computeBoundingSphere();
    optimized.deleteAttribute("color");

    mergedParts.push({ geometry: optimized, color: entry.color });
  }

  if (mergedParts.length === 0 || isCancelled()) {
    mergedParts.forEach((part) => part.geometry.dispose());
    return createEmptyResult();
  }

  reportProgress(96);
  await yieldToMain();

  const bb = new THREE.Box3();
  for (const part of mergedParts) {
    if (part.geometry.boundingBox) {
      bb.union(part.geometry.boundingBox);
    }
  }
  const ctr = new THREE.Vector3();
  bb.getCenter(ctr);
  const size = new THREE.Vector3();
  bb.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const baseScale = maxDim > 0 ? 4 / maxDim : 1;
  const boundsRadius = size.length() * 0.5;

  if (isCancelled()) {
    mergedParts.forEach((part) => part.geometry.dispose());
    return createEmptyResult();
  }

  reportProgress(100);
  return { parts: mergedParts, center: ctr, baseScale, boundsRadius };
}

export async function buildVolumeGeometryResult({
  svgString,
  depth,
  smoothness,
  volumeInflate,
  volumeFrontRoundness,
  volumeBackRoundness,
  volumeEdgeSoftness,
  volumeDetailStrength,
  qualityProfile,
  preserveSvgColors,
  profile = "preview",
  onProgress,
  shouldCancel,
}: BuildExtrudedGeometryOptions): Promise<ExtrudedGeometryResult> {
  const isCancelled = () => shouldCancel?.() ?? false;
  const reportProgress = (progress: number) => onProgress?.(progress);

  const svgParts = parseShapesFromSVG(svgString, preserveSvgColors);
  const allShapes = svgParts.flatMap((part) => part.shapes);
  if (allShapes.length === 0 || isCancelled()) {
    return createEmptyResult();
  }

  const tempGeo = new THREE.ShapeGeometry(allShapes);
  tempGeo.computeBoundingBox();
  const flatBB = tempGeo.boundingBox!.clone();
  const flatSize = new THREE.Vector3();
  flatBB.getSize(flatSize);
  const maxFlatDim = Math.max(flatSize.x, flatSize.y, 1);
  tempGeo.dispose();

  const volumeSettings = getVolumeSettings(
    maxFlatDim,
    depth,
    smoothness,
    volumeInflate,
    volumeFrontRoundness,
    volumeBackRoundness,
    volumeEdgeSoftness,
    allShapes.length,
    profile,
    qualityProfile
  );

  // Keep XY weighting anchored to the full SVG, while allowing Z shaping to
  // normalize per merged part so shallow details still dome cleanly.
  const globalBulgeBox = new THREE.Box3(
    new THREE.Vector3(flatBB.min.x, flatBB.min.y, 0),
    new THREE.Vector3(flatBB.max.x, flatBB.max.y, volumeSettings.depth)
  );

  const classifiedRegions = classifyVolumeRegions(
    parseVolumeRegionsFromSVG(svgString, preserveSvgColors),
    volumeDetailStrength
  );
  const maxRegionArea = Math.max(...classifiedRegions.map((region) => region.area), 1e-6);
  const detailDepthBase = clamp(
    volumeSettings.depth * THREE.MathUtils.lerp(0.14, 0.4, clamp(volumeDetailStrength, 0, 1)),
    volumeSettings.depth * 0.1,
    volumeSettings.depth * 0.44
  );
  const ignoredAreaThreshold = THREE.MathUtils.lerp(0.0028, 0.00035, clamp(volumeDetailStrength, 0, 1));

  const featureSettingsBase = {
    ...volumeSettings,
    depth: detailDepthBase,
    bevelThickness: Math.min(volumeSettings.bevelThickness * 0.72, detailDepthBase * 0.45),
    bevelSize: Math.min(volumeSettings.bevelSize * 0.9, Math.max(volumeSettings.bevelSize * 0.45, 0.05)),
    bevelSegments: Math.max(2, volumeSettings.bevelSegments - 1),
  };

  const groupedGeometries = new Map<string, { color: string | null; geometries: THREE.ExtrudeGeometry[] }>();
  let processedShapes = 0;

  if (classifiedRegions.length > 0) {
    for (const region of classifiedRegions) {
      if (isCancelled()) {
        groupedGeometries.forEach((entry) => entry.geometries.forEach((g) => g.dispose()));
        return createEmptyResult();
      }

      const areaRatio = region.area / maxRegionArea;
      if (region.role === "ignored_detail" || areaRatio < ignoredAreaThreshold) {
        processedShapes++;
        continue;
      }

      const isFeature = region.role === "raised_feature";
      const reliefScale = isFeature
        ? THREE.MathUtils.lerp(0.58, 1, clamp(Math.sqrt(areaRatio / 0.08), 0, 1))
        : 1;
      const extrudeSettings = isFeature
        ? {
            ...featureSettingsBase,
            depth: featureSettingsBase.depth * reliefScale,
            bevelThickness: Math.min(featureSettingsBase.bevelThickness * reliefScale, featureSettingsBase.depth * reliefScale * 0.45),
            bevelSize: Math.min(featureSettingsBase.bevelSize, volumeSettings.bevelSize),
          }
        : volumeSettings;

      const geometry = new THREE.ExtrudeGeometry(region.shape, extrudeSettings);
      if (isFeature) {
        const embed = extrudeSettings.depth * THREE.MathUtils.lerp(0.42, 0.24, clamp(volumeDetailStrength, 0, 1));
        geometry.translate(0, 0, volumeSettings.depth - embed);
      }

      const key = `${isFeature ? "feature" : "body"}:${region.color ?? "__default__"}`;
      const entry = groupedGeometries.get(key) ?? { color: region.color, geometries: [] };
      entry.geometries.push(geometry);
      groupedGeometries.set(key, entry);

      processedShapes++;
      if (processedShapes % BATCH_SIZE === 0) {
        reportProgress(Math.round((processedShapes / classifiedRegions.length) * 90));
        await yieldToMain();
      }
    }
  } else {
    for (const part of svgParts) {
      for (const shape of part.shapes) {
        if (isCancelled()) {
          groupedGeometries.forEach((entry) => entry.geometries.forEach((g) => g.dispose()));
          return createEmptyResult();
        }

        const key = `body:${part.color ?? "__default__"}`;
        const entry = groupedGeometries.get(key) ?? { color: part.color, geometries: [] };
        entry.geometries.push(new THREE.ExtrudeGeometry(shape, volumeSettings));
        groupedGeometries.set(key, entry);

        processedShapes++;
        if (processedShapes % BATCH_SIZE === 0) {
          reportProgress(Math.round((processedShapes / allShapes.length) * 90));
          await yieldToMain();
        }
      }
    }
  }

  if (isCancelled()) {
    groupedGeometries.forEach((entry) => entry.geometries.forEach((g) => g.dispose()));
    return createEmptyResult();
  }

  if (groupedGeometries.size === 0) {
    for (const part of svgParts) {
      for (const shape of part.shapes) {
        const key = `body:${part.color ?? "__default__"}`;
        const entry = groupedGeometries.get(key) ?? { color: part.color, geometries: [] };
        entry.geometries.push(new THREE.ExtrudeGeometry(shape, volumeSettings));
        groupedGeometries.set(key, entry);
      }
    }
  }

  reportProgress(92);
  await yieldToMain();

  const mergedParts: ExtrudedGeometryResult["parts"] = [];
  for (const entry of groupedGeometries.values()) {
    const merged =
      entry.geometries.length === 1
        ? entry.geometries[0]
        : BufferGeometryUtils.mergeGeometries(entry.geometries, false);

    if (!merged) {
      entry.geometries.forEach((g) => g.dispose());
      mergedParts.forEach((part) => part.geometry.dispose());
      return createEmptyResult();
    }

    if (entry.geometries.length > 1) {
      entry.geometries.forEach((g) => g.dispose());
    }

    merged.computeBoundingBox();
    applyVolumeBulge(merged, volumeSettings, {
      xy: globalBulgeBox,
      z: merged.boundingBox ?? undefined,
    });

    merged.computeBoundingBox();
    if (volumeSettings.includeUvs) {
      recomputeTriplanarUVs(merged, merged.boundingBox!);
    } else {
      merged.deleteAttribute("uv");
    }

    const optimized =
      profile === "export"
        ? BufferGeometryUtils.mergeVertices(merged, qualityProfile === "draft" ? 1e-4 : 1e-5)
        : merged;

    if (optimized !== merged) {
      merged.dispose();
    }

    optimized.computeBoundingBox();
    optimized.computeVertexNormals();
    optimized.computeBoundingSphere();
    optimized.deleteAttribute("color");

    mergedParts.push({ geometry: optimized, color: entry.color });
  }

  if (mergedParts.length === 0 || isCancelled()) {
    mergedParts.forEach((part) => part.geometry.dispose());
    return createEmptyResult();
  }

  reportProgress(96);
  await yieldToMain();

  const bb = new THREE.Box3();
  for (const part of mergedParts) {
    if (part.geometry.boundingBox) {
      bb.union(part.geometry.boundingBox);
    }
  }

  const ctr = new THREE.Vector3();
  bb.getCenter(ctr);
  const size = new THREE.Vector3();
  bb.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const baseScale = maxDim > 0 ? 4 / maxDim : 1;
  const boundsRadius = size.length() * 0.5;

  if (isCancelled()) {
    mergedParts.forEach((part) => part.geometry.dispose());
    return createEmptyResult();
  }

  reportProgress(100);
  return { parts: mergedParts, center: ctr, baseScale, boundsRadius };
}

async function buildGeometryResult({
  mode,
  ...options
}: BuildGeometryOptions): Promise<ExtrudedGeometryResult> {
  return mode === "volume"
    ? buildVolumeGeometryResult(options)
    : buildExtrudedGeometryResult(options);
}

interface MeshMaterialOptions {
  color: string;
  materialSettings: MaterialSettings;
  texture?: THREE.Texture | null;
  profile?: MaterialBuildProfile;
  depthBias?: { factor: number; units: number } | null;
}

function isShimmerPronePreset(materialSettings: MaterialSettings) {
  return (
    materialSettings.transparent ||
    materialSettings.opacity < 1 ||
    materialSettings.metalness > 0.75 ||
    materialSettings.preset === "glass" ||
    materialSettings.preset === "holographic" ||
    materialSettings.preset === "chrome"
  );
}

function getStackWorldEpsilon(
  layerCount: number,
  materialSettings: MaterialSettings,
  antiFlicker: boolean
) {
  const densityBoost = clamp(1 + layerCount / 90, 1, 2.4);
  const materialBoost = isShimmerPronePreset(materialSettings) ? 1.6 : 1;
  const base = antiFlicker ? 0.00135 : 0.001;
  return clamp(base * densityBoost * materialBoost, 0.001, 0.006);
}

function getDepthBias(
  layerIndex: number,
  layerCount: number,
  materialSettings: MaterialSettings,
  antiFlicker: boolean
) {
  if (!antiFlicker || layerCount <= 1) return null;

  const reflective = isShimmerPronePreset(materialSettings);
  const progress = layerCount <= 1 ? 0 : layerIndex / (layerCount - 1);
  return {
    factor: reflective ? -1.25 : -0.65,
    units: (reflective ? -1.5 : -0.75) - progress * (reflective ? 2.4 : 1.2),
  };
}

function createMeshMaterial({
  color,
  materialSettings,
  texture,
  profile = "preview",
  depthBias,
}: MeshMaterialOptions) {
  const preset = materialPresets[materialSettings.preset];
  const isEmissive = materialSettings.preset === "emissive";
  const wantsTransparency = materialSettings.transparent || materialSettings.opacity < 1;

  if (profile === "export") {
    const exportRoughness = wantsTransparency
      ? Math.max(
          materialSettings.preset === "glass" ? 0.22 : 0.18,
          materialSettings.roughness
        )
      : materialSettings.roughness;

    return new THREE.MeshPhysicalMaterial({
      color,
      metalness: materialSettings.metalness,
      roughness: exportRoughness,
      transmission: 0,
      thickness: 0,
      ior: 1.45,
      opacity: 1,
      transparent: false,
      wireframe: materialSettings.wireframe,
      emissive: isEmissive ? color : "#000000",
      emissiveIntensity: preset.emissiveIntensity ?? 0,
      clearcoat: wantsTransparency ? Math.min(0.35, preset.clearcoat ?? 0.2) : (preset.clearcoat ?? 0),
      clearcoatRoughness: wantsTransparency ? 0.18 : 0.05,
      side: THREE.FrontSide,
      envMapIntensity: wantsTransparency ? 0.85 : 1,
      depthWrite: true,
      depthTest: true,
    });
  }

  const transmissionAmount = wantsTransparency ? (1 - materialSettings.opacity) : 0;

  return new THREE.MeshPhysicalMaterial({
    color,
    map: texture ?? undefined,
    metalness: materialSettings.metalness,
    roughness: wantsTransparency
      ? Math.max(
          materialSettings.preset === "glass" ? 0.08 : materialSettings.preset === "holographic" ? 0.12 : 0.05,
          materialSettings.roughness * 0.45
        )
      : materialSettings.roughness,
    transmission: transmissionAmount,
    thickness: wantsTransparency ? 2.5 : 0,
    ior: wantsTransparency ? 1.5 : 1.45,
    opacity: 1,
    transparent: false,
    wireframe: materialSettings.wireframe,
    emissive: isEmissive ? color : "#000000",
    emissiveIntensity: preset.emissiveIntensity ?? 0,
    clearcoat: wantsTransparency ? (materialSettings.preset === "holographic" ? 0.7 : 0.5) : (preset.clearcoat ?? 0),
    clearcoatRoughness: wantsTransparency ? 0.14 : 0.05,
    side: THREE.FrontSide,
    envMapIntensity: wantsTransparency ? 0.82 : materialSettings.preset === "chrome" ? 0.95 : 1,
    polygonOffset: !!depthBias,
    polygonOffsetFactor: depthBias?.factor ?? 0,
    polygonOffsetUnits: depthBias?.units ?? 0,
  });
}

interface MeshGroupOptions {
  result: ExtrudedGeometryResult;
  color: string;
  materialSettings: MaterialSettings;
  rotationX: number;
  rotationY: number;
  texture?: THREE.Texture | null;
  materialProfile?: MaterialBuildProfile;
  antiFlicker?: boolean;
}

function createMeshGroup({
  result,
  color,
  materialSettings,
  rotationX,
  rotationY,
  texture,
  materialProfile = "preview",
  antiFlicker = true,
}: MeshGroupOptions) {
  const group = new THREE.Group();
  group.rotation.set(rotationX, rotationY, 0);
  group.scale.set(result.baseScale, -result.baseScale, result.baseScale);

  // Tiny Z offset per SVG stacking layer: later paths in the SVG document sit
  // slightly in front of earlier ones, matching the SVG painter's algorithm and
  // preventing Z-fighting between overlapping extruded shapes (e.g. a white
  // detail icon inside a filled circle).
  const STACK_Z_WORLD = getStackWorldEpsilon(result.parts.length, materialSettings, antiFlicker);
  const stackEpsilon = result.baseScale > 0 ? STACK_Z_WORLD / result.baseScale : 0;

  const fallbackColor = materialSettings.preset === "gold" ? "#d4a017" : color;
  for (const [index, part] of result.parts.entries()) {
    const meshColor = part.color ?? (texture ? "#ffffff" : fallbackColor);
    const mesh = new THREE.Mesh(part.geometry, createMeshMaterial({
      color: meshColor,
      materialSettings,
      texture,
      profile: materialProfile,
      depthBias: materialProfile === "preview"
        ? getDepthBias(index, result.parts.length, materialSettings, antiFlicker)
        : null,
    }));
    mesh.position.set(-result.center.x, -result.center.y, -result.center.z + index * stackEpsilon);
    group.add(mesh);
  }

  return group;
}

export interface OptimizedExportMeshOptions {
  svgString: string;
  mode?: GeometryMode;
  depth: number;
  smoothness: number;
  volumeInflate?: number;
  volumeFrontRoundness?: number;
  volumeBackRoundness?: number;
  volumeEdgeSoftness?: number;
  volumeDetailStrength?: number;
  qualityProfile?: QualityProfile;
  antiFlicker?: boolean;
  color: string;
  preserveSvgColors: boolean;
  materialSettings: MaterialSettings;
  rotationX: number;
  rotationY: number;
  onProgress?: (progress: number) => void;
}

export async function buildOptimizedExportMeshGroup(options: OptimizedExportMeshOptions) {
  const result = await buildGeometryResult({
    mode: options.mode ?? "extrude",
    svgString: options.svgString,
    depth: options.depth,
    smoothness: options.smoothness,
    volumeInflate: options.volumeInflate ?? 0.55,
    volumeFrontRoundness: options.volumeFrontRoundness ?? 0.65,
    volumeBackRoundness: options.volumeBackRoundness ?? 0.45,
    volumeEdgeSoftness: options.volumeEdgeSoftness ?? 0.6,
    volumeDetailStrength: options.volumeDetailStrength ?? 0.5,
    qualityProfile: options.qualityProfile ?? "standard",
    preserveSvgColors: options.preserveSvgColors,
    profile: "export",
    onProgress: options.onProgress,
  });

  return createMeshGroup({
    result,
    color: options.color,
    materialSettings: options.materialSettings,
    rotationX: options.rotationX,
    rotationY: options.rotationY,
    materialProfile: "export",
    antiFlicker: options.antiFlicker ?? true,
  });
}

export function useExtrudedGeometry(
  mode: GeometryMode,
  svgString: string,
  depth: number,
  smoothness: number,
  volumeInflate: number,
  volumeFrontRoundness: number,
  volumeBackRoundness: number,
  volumeEdgeSoftness: number,
  volumeDetailStrength: number,
  qualityProfile: QualityProfile,
  preserveSvgColors: boolean
): ExtrudedGeometryResult & { loading: boolean; progress: number; cancel: () => void } {
  const [result, setResult] = useState<ExtrudedGeometryResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const versionRef = useRef(0);
  const prevGeosRef = useRef<THREE.BufferGeometry[]>([]);

  // Dispose old geometries when result changes
  useEffect(() => {
    const oldGeos = prevGeosRef.current;
    prevGeosRef.current = result.parts.map((part) => part.geometry);
    return () => { oldGeos.forEach((g) => g.dispose()); };
  }, [result]);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);

  useEffect(() => {
    if (!svgString) {
      setResult(createEmptyResult());
      setLoading(false);
      setProgress(0);
      return;
    }

    const version = ++versionRef.current;
    cancelRef.current = false;
    setLoading(true);
    setProgress(0);

    (async () => {
      const nextResult = await buildGeometryResult({
        mode,
        svgString,
        depth,
        smoothness,
        volumeInflate,
        volumeFrontRoundness,
        volumeBackRoundness,
        volumeEdgeSoftness,
        volumeDetailStrength,
        qualityProfile,
        preserveSvgColors,
        profile: "preview",
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current || version !== versionRef.current,
      });

      if (cancelRef.current || version !== versionRef.current) {
        nextResult.parts.forEach((part) => part.geometry.dispose());
        setLoading(false);
        return;
      }

      setResult(nextResult);
      setLoading(false);
    })();

    return () => { cancelRef.current = true; };
  }, [
    mode,
    svgString,
    depth,
    smoothness,
    volumeInflate,
    volumeFrontRoundness,
    volumeBackRoundness,
    volumeEdgeSoftness,
    volumeDetailStrength,
    qualityProfile,
    preserveSvgColors,
  ]);

  return { ...result, loading, progress, cancel };
}

export function ExtrudedSVG({
  svgString,
  mode,
  depth,
  smoothness,
  volumeInflate,
  volumeFrontRoundness,
  volumeBackRoundness,
  volumeEdgeSoftness,
  volumeDetailStrength,
  qualityProfile,
  antiFlicker,
  color,
  preserveSvgColors,
  materialSettings,
  rotationX,
  rotationY,
  groupRef,
  texture: textureUrl,
  textureRepeat = 1,
  textureRotation = 0,
  textureOffset = [0, 0],
  onLoadingChange,
  onGroupReady,
}: ExtrudedSVGProps) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!textureUrl) {
      setTexture((prev) => {
        prev?.dispose();
        return null;
      });
      return;
    }
    let disposed = false;
    const loader = new THREE.TextureLoader();
    loader.load(textureUrl, (tex) => {
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      setTexture((prev) => {
        if (prev && prev !== tex) prev.dispose();
        return tex;
      });
    });
    return () => {
      disposed = true;
    };
  }, [textureUrl]);

  useEffect(() => {
    return () => {
      if (texture) texture.dispose();
    };
  }, [texture]);

  useEffect(() => {
    if (!texture) return;
    texture.offset.set(textureOffset[0], textureOffset[1]);
    texture.repeat.set(textureRepeat, textureRepeat);
    texture.rotation = textureRotation;
    texture.center.set(0.5, 0.5);
    texture.needsUpdate = true;
  }, [texture, textureRepeat, textureRotation, textureOffset]);

  const { parts, center, baseScale, loading, progress } = useExtrudedGeometry(
    mode,
    svgString,
    depth,
    smoothness,
    volumeInflate,
    volumeFrontRoundness,
    volumeBackRoundness,
    volumeEdgeSoftness,
    volumeDetailStrength,
    qualityProfile,
    preserveSvgColors
  );

  // Match SVG painter's algorithm: later paths sit slightly in front of earlier ones.
  // Prevents Z-fighting when overlapping shapes (e.g. detail icon inside a circle)
  // are extruded to the same depth.
  const STACK_Z_WORLD = getStackWorldEpsilon(parts.length, materialSettings, antiFlicker);
  const stackEpsilon = baseScale > 0 ? STACK_Z_WORLD / baseScale : 0;

  const onLoadingChangeRef = useRef(onLoadingChange);
  onLoadingChangeRef.current = onLoadingChange;
  useEffect(() => {
    onLoadingChangeRef.current?.(loading, progress);
  }, [loading, progress]);

  useEffect(() => {
    onGroupReady?.(groupRef.current);
    return () => onGroupReady?.(null);
  }, [groupRef, onGroupReady]);

  return (
    <group
      ref={groupRef}
      rotation={[rotationX, rotationY, 0]}
      scale={[baseScale, -baseScale, baseScale]}
    >
      {parts.map((part, i) => {
        const preset = materialPresets[materialSettings.preset];
        const isGold = materialSettings.preset === "gold";
        const isEmissive = materialSettings.preset === "emissive";
        const wantsTransparency = materialSettings.transparent || materialSettings.opacity < 1;
        const fallbackColor = isGold ? "#d4a017" : color;
        const baseColor = part.color ?? (texture ? "#ffffff" : fallbackColor);
        const emissiveColor = isEmissive ? (part.color ?? color) : "#000000";
        const emissiveIntensity = preset.emissiveIntensity ?? 0;
        const transmissionAmount = wantsTransparency ? (1 - materialSettings.opacity) : 0;

        return (
          <mesh
            key={`${i}-${part.color ?? "default"}-${texture ? "tex" : "notex"}-${materialSettings.preset}-${wantsTransparency}`}
            geometry={part.geometry}
            position={[-center.x, -center.y, -center.z + i * stackEpsilon]}
            renderOrder={i}
          >
            <meshPhysicalMaterial
              color={baseColor}
              map={texture ?? undefined}
              metalness={materialSettings.metalness}
              roughness={wantsTransparency
                ? Math.max(
                    materialSettings.preset === "glass" ? 0.08 : materialSettings.preset === "holographic" ? 0.12 : 0.05,
                    materialSettings.roughness * 0.45
                  )
                : materialSettings.roughness}
              transmission={transmissionAmount}
              thickness={wantsTransparency ? 2.5 : 0}
              ior={wantsTransparency ? 1.5 : 1.45}
              opacity={1}
              transparent={false}
              wireframe={materialSettings.wireframe}
              emissive={emissiveColor}
              emissiveIntensity={emissiveIntensity}
              clearcoat={wantsTransparency ? (materialSettings.preset === "holographic" ? 0.7 : 0.5) : (preset.clearcoat ?? 0)}
              clearcoatRoughness={wantsTransparency ? 0.14 : 0.05}
              side={THREE.FrontSide}
              envMapIntensity={wantsTransparency ? 0.82 : materialSettings.preset === "chrome" ? 0.95 : 1}
              polygonOffset={antiFlicker && parts.length > 1}
              polygonOffsetFactor={antiFlicker && parts.length > 1 ? getDepthBias(i, parts.length, materialSettings, antiFlicker)?.factor ?? 0 : 0}
              polygonOffsetUnits={antiFlicker && parts.length > 1 ? getDepthBias(i, parts.length, materialSettings, antiFlicker)?.units ?? 0 : 0}
            />
          </mesh>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// ReadyNotifier
// ---------------------------------------------------------------------------

function ReadyNotifier({ onReady }: { onReady?: () => void }) {
  const readyFired = useRef(false);
  const { gl } = useThree();

  // Reveal canvas after first frame is drawn
  useFrame(() => {
    if (!readyFired.current) {
      readyFired.current = true;
      const wrapper = gl.domElement.parentElement;
      if (wrapper) wrapper.style.visibility = "visible";
      onReady?.();
    }
  });

  return null;
}

function AutoCameraClipping({ targetRef }: { targetRef: React.RefObject<THREE.Object3D | null> }) {
  const { camera } = useThree();
  const scratchBox = useRef(new THREE.Box3());
  const scratchSphere = useRef(new THREE.Sphere());

  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || !targetRef.current) return;

    scratchBox.current.setFromObject(targetRef.current);
    if (scratchBox.current.isEmpty()) return;

    scratchBox.current.getBoundingSphere(scratchSphere.current);
    const distance = camera.position.distanceTo(scratchSphere.current.center);
    const radius = Math.max(0.5, scratchSphere.current.radius);
    const nextNear = Math.max(0.05, distance - radius * 2.5);
    const nextFar = Math.max(nextNear + 10, distance + radius * 3.5);

    if (Math.abs(camera.near - nextNear) > 0.01 || Math.abs(camera.far - nextFar) > 0.5) {
      camera.near = nextNear;
      camera.far = nextFar;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// SVG3DScene
// ---------------------------------------------------------------------------

export interface SVG3DSceneProps {
  svgString: string;
  mode: GeometryMode;
  depth: number;
  smoothness: number;
  volumeInflate: number;
  volumeFrontRoundness: number;
  volumeBackRoundness: number;
  volumeEdgeSoftness: number;
  volumeDetailStrength: number;
  qualityProfile: QualityProfile;
  antiFlicker: boolean;
  color: string;
  preserveSvgColors: boolean;
  materialSettings: MaterialSettings;
  rotationX: number;
  rotationY: number;
  zoom: number;
  fov: number;
  texture?: string;
  textureRepeat?: number;
  textureRotation?: number;
  textureOffset?: [number, number];
  lightPosition: [number, number, number];
  lightIntensity: number;
  ambientIntensity: number;
  shadow: boolean;
  cursorOrbit: boolean;
  orbitStrength: number;
  draggable: boolean;
  scrollZoom: boolean;
  animate: AnimationType;
  animateSpeed: number;
  animateReverse: boolean;
  intro: "zoom" | "fade" | "none";
  introDuration: number;
  introFrom: { zoom?: number; opacity?: number };
  introTo: { zoom?: number; opacity?: number };
  resetOnIdle: boolean;
  resetDelay: number;
  background: string;
  onReady?: () => void;
  onAnimationComplete?: () => void;
  onLoadingChange?: (loading: boolean, progress: number) => void;
  resetKey?: number;
  registerCanvas?: (canvas: HTMLCanvasElement) => void;
  registerMeshGroup?: (group: THREE.Group | null) => void;
  children?: React.ReactNode;
}

export function SVG3DScene({
  svgString,
  mode,
  depth,
  smoothness,
  volumeInflate,
  volumeFrontRoundness,
  volumeBackRoundness,
  volumeEdgeSoftness,
  volumeDetailStrength,
  qualityProfile,
  antiFlicker,
  color,
  preserveSvgColors,
  materialSettings,
  rotationX,
  rotationY,
  zoom,
  fov,
  texture,
  textureRepeat,
  textureRotation,
  textureOffset,
  lightPosition,
  lightIntensity,
  ambientIntensity,
  shadow,
  cursorOrbit,
  orbitStrength,
  draggable,
  scrollZoom,
  animate,
  animateSpeed,
  animateReverse,
  resetOnIdle,
  resetDelay,
  intro,
  introDuration,
  introFrom,
  introTo,
  background,
  onReady,
  onAnimationComplete,
  onLoadingChange,
  resetKey,
  registerCanvas,
  registerMeshGroup,
  children,
}: SVG3DSceneProps) {
  const meshGroupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    introComplete.current = false;
  }, []);

  return (
    <Canvas
      camera={{ position: [0, 0, zoom], fov, near: 0.05, far: 100 }}
      style={{ background, visibility: "hidden" }}
      gl={{
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
        powerPreference: "default",
        failIfMajorPerformanceCaveat: false,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      onCreated={({ gl, scene }) => {
        if (background && background !== "transparent") {
          scene.background = new THREE.Color(background);
        }
        const canvas = gl.domElement;
        registerCanvas?.(canvas);
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          const wrapper = canvas.parentElement;
          if (wrapper) wrapper.style.visibility = "hidden";
        });
        canvas.addEventListener("webglcontextrestored", () => {
          const wrapper = canvas.parentElement;
          if (wrapper) wrapper.style.visibility = "visible";
        });
      }}
    >
      <ReadyNotifier onReady={onReady} />
      <AutoCameraClipping targetRef={animGroupRef} />

      <IntroAnimation
        type={intro}
        duration={introDuration}
        from={introFrom}
        to={introTo}
        onComplete={onAnimationComplete}
      />

      <SmoothControls
        rotationX={rotationX}
        rotationY={rotationY}
        meshRef={meshGroupRef}
        cursorOrbit={cursorOrbit}
        orbitStrength={orbitStrength}
        draggable={draggable}
        scrollZoom={scrollZoom}
        zoom={zoom}
        resetOnIdle={resetOnIdle}
        resetDelay={resetDelay}
        resetKey={resetKey}
      />
      <LoopAnimation type={animate} speed={animateSpeed} reverse={animateReverse} meshRef={animGroupRef} />

      <ambientLight intensity={ambientIntensity} />
      <directionalLight position={lightPosition} intensity={lightIntensity} castShadow />
      <directionalLight position={[-5, 3, -3]} intensity={0.4} />
      <directionalLight position={[0, -4, 6]} intensity={0.2} />
      <pointLight position={[0, 5, 0]} intensity={0.3} />

      <group ref={animGroupRef}>
        <ExtrudedSVG
          svgString={svgString}
          mode={mode}
          depth={depth}
          smoothness={smoothness}
          volumeInflate={volumeInflate}
          volumeFrontRoundness={volumeFrontRoundness}
          volumeBackRoundness={volumeBackRoundness}
          volumeEdgeSoftness={volumeEdgeSoftness}
          volumeDetailStrength={volumeDetailStrength}
          qualityProfile={qualityProfile}
          antiFlicker={antiFlicker}
          color={color}
          preserveSvgColors={preserveSvgColors}
          materialSettings={materialSettings}
          rotationX={rotationX}
          rotationY={rotationY}
          groupRef={meshGroupRef}
          texture={texture}
          textureRepeat={textureRepeat}
          textureRotation={textureRotation}
          textureOffset={textureOffset}
          onLoadingChange={onLoadingChange}
          onGroupReady={registerMeshGroup}
        />
      </group>

      {shadow && (
        <ContactShadows
          position={[0, -3, 0]}
          opacity={0.4}
          scale={10}
          blur={2}
          far={4}
        />
      )}

      <hemisphereLight args={["#b1e1ff", "#b97a20", 0.5]} />

      <Environment background={false} environmentIntensity={1.5} frames={1}>
        <mesh scale={50}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial color="#0a0a12" side={THREE.BackSide} />
        </mesh>
        <mesh position={[0, 25, 0]}>
          <sphereGeometry args={[20, 32, 32]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <mesh position={[0, 0, 30]}>
          <sphereGeometry args={[15, 32, 32]} />
          <meshBasicMaterial color="#444444" />
        </mesh>
        <mesh position={[-20, 5, 10]}>
          <sphereGeometry args={[10, 32, 32]} />
          <meshBasicMaterial color="#333333" />
        </mesh>
      </Environment>

      {children}
    </Canvas>
  );
}

export default SVG3DScene;
