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
import { type MaterialPreset } from "./types";
import {
  SmoothControls,
  IntroAnimation,
  LoopAnimation,
  introComplete,
  type SmoothControlsProps,
  type IntroAnimationProps,
  type AnimationType,
} from "./controls";

export type GeometryBuildProfile = "preview" | "export";
type MaterialBuildProfile = "preview" | "export";

// ---------------------------------------------------------------------------
// ExtrudedSVG
// ---------------------------------------------------------------------------

export interface ExtrudedSVGProps {
  svgString: string;
  depth: number;
  smoothness: number;
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
}

function createEmptyResult(): ExtrudedGeometryResult {
  return {
    parts: [],
    center: new THREE.Vector3(),
    baseScale: 1,
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

interface BuildExtrudedGeometryOptions {
  svgString: string;
  depth: number;
  smoothness: number;
  preserveSvgColors: boolean;
  profile?: GeometryBuildProfile;
  onProgress?: (progress: number) => void;
  shouldCancel?: () => boolean;
}

function getExtrudeSettings(
  maxFlatDim: number,
  depth: number,
  smoothness: number,
  complexity: number,
  profile: GeometryBuildProfile
) {
  const scaledDepth = (depth / 10) * maxFlatDim;
  const bevelScale = Math.min(maxFlatDim * 0.02, 1);

  if (profile === "export") {
    const qualityScale = complexity > 200 ? 0.65 : complexity > 50 ? 0.85 : 1;
    const bevelSegments = clamp(Math.round((2 + smoothness * 4) * qualityScale), 2, 5);
    const curveSegments = clamp(Math.round((18 + smoothness * 18) * qualityScale), 18, 36);
    const bevelAmount = bevelScale * (0.12 + smoothness * 0.14);

    return {
      depth: scaledDepth,
      bevelEnabled: true,
      bevelThickness: bevelAmount,
      bevelSize: bevelAmount,
      bevelSegments,
      curveSegments,
      includeUvs: false,
    };
  }

  const qualityScale = complexity > 200 ? 0.3 : complexity > 50 ? 0.6 : 1;
  return {
    depth: scaledDepth,
    bevelEnabled: true,
    bevelThickness: bevelScale * (0.15 + smoothness * 0.2),
    bevelSize: bevelScale * (0.15 + smoothness * 0.2),
    bevelSegments: Math.round((3 + smoothness * 20) * qualityScale),
    curveSegments: Math.round((24 + smoothness * 176) * qualityScale),
    includeUvs: true,
  };
}

export async function buildExtrudedGeometryResult({
  svgString,
  depth,
  smoothness,
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

  const extrudeSettings = getExtrudeSettings(maxFlatDim, depth, smoothness, allShapes.length, profile);

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
    merged.computeVertexNormals();
    if (extrudeSettings.includeUvs) {
      recomputeTriplanarUVs(merged, merged.boundingBox!);
    } else {
      merged.deleteAttribute("uv");
    }

    mergedParts.push({ geometry: merged, color: entry.color });
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

  if (isCancelled()) {
    mergedParts.forEach((part) => part.geometry.dispose());
    return createEmptyResult();
  }

  reportProgress(100);
  return { parts: mergedParts, center: ctr, baseScale };
}

interface MeshMaterialOptions {
  color: string;
  materialSettings: MaterialSettings;
  texture?: THREE.Texture | null;
  profile?: MaterialBuildProfile;
}

function createMeshMaterial({
  color,
  materialSettings,
  texture,
  profile = "preview",
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
    roughness: wantsTransparency ? Math.max(0.02, materialSettings.roughness * 0.3) : materialSettings.roughness,
    transmission: transmissionAmount,
    thickness: wantsTransparency ? 2.5 : 0,
    ior: wantsTransparency ? 1.5 : 1.45,
    opacity: 1,
    transparent: false,
    wireframe: materialSettings.wireframe,
    emissive: isEmissive ? color : "#000000",
    emissiveIntensity: preset.emissiveIntensity ?? 0,
    clearcoat: wantsTransparency ? 1 : (preset.clearcoat ?? 0),
    clearcoatRoughness: 0.05,
    side: THREE.FrontSide,
    envMapIntensity: 1,
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
}

function createMeshGroup({
  result,
  color,
  materialSettings,
  rotationX,
  rotationY,
  texture,
  materialProfile = "preview",
}: MeshGroupOptions) {
  const group = new THREE.Group();
  group.rotation.set(rotationX, rotationY, 0);
  group.scale.set(result.baseScale, -result.baseScale, result.baseScale);

  // Tiny Z offset per SVG stacking layer: later paths in the SVG document sit
  // slightly in front of earlier ones, matching the SVG painter's algorithm and
  // preventing Z-fighting between overlapping extruded shapes (e.g. a white
  // detail icon inside a filled circle).
  const STACK_Z_WORLD = 0.002;
  const stackEpsilon = result.baseScale > 0 ? STACK_Z_WORLD / result.baseScale : 0;

  const fallbackColor = materialSettings.preset === "gold" ? "#d4a017" : color;
  for (const [index, part] of result.parts.entries()) {
    const meshColor = part.color ?? (texture ? "#ffffff" : fallbackColor);
    const mesh = new THREE.Mesh(part.geometry, createMeshMaterial({
      color: meshColor,
      materialSettings,
      texture,
      profile: materialProfile,
    }));
    mesh.position.set(-result.center.x, -result.center.y, -result.center.z + index * stackEpsilon);
    group.add(mesh);
  }

  return group;
}

export interface OptimizedExportMeshOptions {
  svgString: string;
  depth: number;
  smoothness: number;
  color: string;
  preserveSvgColors: boolean;
  materialSettings: MaterialSettings;
  rotationX: number;
  rotationY: number;
  onProgress?: (progress: number) => void;
}

export async function buildOptimizedExportMeshGroup(options: OptimizedExportMeshOptions) {
  const result = await buildExtrudedGeometryResult({
    svgString: options.svgString,
    depth: options.depth,
    smoothness: options.smoothness,
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
  });
}

export function useExtrudedGeometry(
  svgString: string,
  depth: number,
  smoothness: number,
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
      const nextResult = await buildExtrudedGeometryResult({
        svgString,
        depth,
        smoothness,
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
  }, [svgString, depth, smoothness, preserveSvgColors]);

  return { ...result, loading, progress, cancel };
}

export function ExtrudedSVG({
  svgString,
  depth,
  smoothness,
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
      setTexture(null);
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.load(textureUrl, (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      setTexture(tex);
    });
  }, [textureUrl]);

  useEffect(() => {
    if (!texture) return;
    texture.offset.set(textureOffset[0], textureOffset[1]);
    texture.repeat.set(textureRepeat, textureRepeat);
    texture.rotation = textureRotation;
    texture.center.set(0.5, 0.5);
    texture.needsUpdate = true;
  }, [texture, textureRepeat, textureRotation, textureOffset]);

  const { parts, center, baseScale, loading, progress } = useExtrudedGeometry(
    svgString,
    depth,
    smoothness,
    preserveSvgColors
  );

  // Match SVG painter's algorithm: later paths sit slightly in front of earlier ones.
  // Prevents Z-fighting when overlapping shapes (e.g. detail icon inside a circle)
  // are extruded to the same depth.
  const STACK_Z_WORLD = 0.002;
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
              roughness={wantsTransparency ? Math.max(0.02, materialSettings.roughness * 0.3) : materialSettings.roughness}
              transmission={transmissionAmount}
              thickness={wantsTransparency ? 2.5 : 0}
              ior={wantsTransparency ? 1.5 : 1.45}
              opacity={1}
              transparent={false}
              wireframe={materialSettings.wireframe}
              emissive={emissiveColor}
              emissiveIntensity={emissiveIntensity}
              clearcoat={wantsTransparency ? 1 : (preset.clearcoat ?? 0)}
              clearcoatRoughness={0.05}
              side={THREE.FrontSide}
              envMapIntensity={1}
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

// ---------------------------------------------------------------------------
// SVG3DScene
// ---------------------------------------------------------------------------

export interface SVG3DSceneProps {
  svgString: string;
  depth: number;
  smoothness: number;
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
  depth,
  smoothness,
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
      camera={{ position: [0, 0, zoom], fov }}
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
          depth={depth}
          smoothness={smoothness}
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
