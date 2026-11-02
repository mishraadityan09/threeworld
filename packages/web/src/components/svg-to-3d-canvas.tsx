/**
 * =============================================================================
 * SVG-to-3D Canvas
 * =============================================================================
 *
 * Web editor wrapper around the 3dsvg engine's <SVG3D> component. Injects
 * web-only children: draggable light orb, background plane, and high-res
 * export capture.
 */

"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

import { SVG3D } from "3dsvg";
import type { AnimationType, GeometryMode, MaterialSettings, QualityProfile } from "3dsvg";

import { type TextureSettings } from "@/lib/types";

export type { AnimationType, MaterialSettings };

// ---------------------------------------------------------------------------
// Light controls — draggable orb with glow sprite (web-only)
// ---------------------------------------------------------------------------

function createGlowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  gradient.addColorStop(0, "rgba(255, 248, 200, 1)");
  gradient.addColorStop(0.1, "rgba(255, 220, 100, 0.8)");
  gradient.addColorStop(0.3, "rgba(255, 190, 50, 0.3)");
  gradient.addColorStop(0.6, "rgba(255, 170, 30, 0.08)");
  gradient.addColorStop(1, "rgba(255, 150, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

let _glowTexture: THREE.Texture | null = null;
function getGlowTexture() {
  if (!_glowTexture) _glowTexture = createGlowTexture();
  return _glowTexture;
}

// Soft white radial — used for tintable backdrop glow sprites
function createSoftGlow(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0,    "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,255,255,0.75)");
  g.addColorStop(0.35, "rgba(255,255,255,0.25)");
  g.addColorStop(0.65, "rgba(255,255,255,0.06)");
  g.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.needsUpdate = true;
  return t;
}

let _softGlow: THREE.Texture | null = null;
function getSoftGlow() {
  if (!_softGlow) _softGlow = createSoftGlow();
  return _softGlow;
}

function GlowSprite({ intensity }: { intensity: number }) {
  const scale = 1.5 + intensity * 0.8;
  return (
    <sprite scale={[scale, scale, 1]} renderOrder={-1}>
      <spriteMaterial
        map={getGlowTexture()}
        transparent
        opacity={Math.min(1, intensity * 0.4)}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  );
}

// ---------------------------------------------------------------------------
// SpaceLighting — backdrop glow sprites + matching point lights
// Sprites provide the visual; point lights cast that color onto the model.
// Both render independently of model load state.
// ---------------------------------------------------------------------------

function SpaceLighting() {
  const map = getSoftGlow();
  return (
    <>
      {/* ── Point lights — illuminate the 3D model ── */}
      <pointLight position={[7, 5, 5]}   intensity={3.5} color="#ef6423" distance={40} decay={1.8} />
      <pointLight position={[-8, 1, -4]} intensity={2.2} color="#2040c8" distance={35} decay={1.8} />
      <pointLight position={[0, -6, 3]}  intensity={0.7} color="#6020a0" distance={20} decay={2} />

      {/* ── Backdrop glow sprites — always visible, behind the model ── */}
      {/* Orange "sun" — top-right, far behind */}
      <sprite position={[5, 3.5, -5]} scale={[18, 18, 1]} renderOrder={-5}>
        <spriteMaterial map={map} color="#ef6423" transparent opacity={0.55}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      {/* Tighter bright core of the sun */}
      <sprite position={[5.2, 3.6, -4.5]} scale={[7, 7, 1]} renderOrder={-4}>
        <spriteMaterial map={map} color="#ffcc66" transparent opacity={0.7}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* Blue nebula — left, far behind */}
      <sprite position={[-7, 0.5, -5]} scale={[16, 16, 1]} renderOrder={-5}>
        <spriteMaterial map={map} color="#2050d0" transparent opacity={0.4}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* Violet underglow — bottom */}
      <sprite position={[0, -5, -4]} scale={[14, 14, 1]} renderOrder={-5}>
        <spriteMaterial map={map} color="#6018a0" transparent opacity={0.25}
          depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </>
  );
}

// ---------------------------------------------------------------------------
// DownloadCapture — high-res PNG export with content cropping (web-only)
// ---------------------------------------------------------------------------

function DownloadCapture({
  registerCapture,
  shadowRef,
  lightOrbRef,
  bgPlaneRef,
}: {
  registerCapture?: (fn: (resolution: number, withBackground: boolean, onCapture: (dataUrl: string) => void, aspectRatio?: number | null) => void) => void;
  shadowRef: React.RefObject<THREE.Group | null>;
  lightOrbRef: React.RefObject<THREE.Group | null>;
  bgPlaneRef: React.RefObject<THREE.Mesh | null>;
}) {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    if (!registerCapture) return;
    registerCapture((resolution, withBackground, onCapture, aspectRatio) => {
      const prevBackground = scene.background;
      const shadowGroup = shadowRef.current;
      const lightOrbGroup = lightOrbRef.current;
      const bgPlane = bgPlaneRef.current;
      if (lightOrbGroup) lightOrbGroup.visible = false;
      if (!withBackground) {
        if (shadowGroup) shadowGroup.visible = false;
        if (bgPlane) bgPlane.visible = false;
        scene.background = null;
      }

      const canvas = gl.domElement;
      const prevWidth = canvas.width;
      const prevHeight = canvas.height;
      const prevStyle = canvas.style.cssText;

      const renderAspect = aspectRatio ?? (prevWidth / prevHeight);
      const w = resolution;
      const h = Math.round(resolution / renderAspect);

      canvas.style.position = "fixed";
      canvas.style.left = "-9999px";

      gl.setSize(w, h, false);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = renderAspect;
        camera.updateProjectionMatrix();
      }

      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.toneMappingExposure = 1.2;
      gl.setClearColor(0x000000, 0);
      gl.render(scene, camera);

      if (aspectRatio || withBackground) {
        const dataUrl = canvas.toDataURL("image/png");
        onCapture(dataUrl);
      } else {
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = w;
        tmpCanvas.height = h;
        const tmpCtx = tmpCanvas.getContext("2d")!;
        tmpCtx.drawImage(canvas, 0, 0);
        const imageData = tmpCtx.getImageData(0, 0, w, h);
        const data = imageData.data;

        let minX = w, minY = h, maxX = 0, maxY = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const alpha = data[(y * w + x) * 4 + 3];
            if (alpha > 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        const cropW = maxX - minX + 1;
        const cropH = maxY - minY + 1;
        const pad = Math.max(10, Math.round(Math.max(cropW, cropH) * 0.05));

        const x0 = Math.max(0, minX - pad);
        const y0 = Math.max(0, minY - pad);
        const x1 = Math.min(w, maxX + 1 + pad);
        const y1 = Math.min(h, maxY + 1 + pad);

        const croppedCanvas = document.createElement("canvas");
        croppedCanvas.width = x1 - x0;
        croppedCanvas.height = y1 - y0;
        const croppedCtx = croppedCanvas.getContext("2d")!;
        croppedCtx.drawImage(
          tmpCanvas,
          x0, y0, x1 - x0, y1 - y0,
          0, 0, x1 - x0, y1 - y0
        );

        const dataUrl = croppedCanvas.toDataURL("image/png");
        onCapture(dataUrl);
      }

      gl.setSize(prevWidth, prevHeight, false);
      canvas.style.cssText = prevStyle;
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = prevWidth / prevHeight;
        camera.updateProjectionMatrix();
      }
      scene.background = prevBackground;
      if (shadowGroup) shadowGroup.visible = true;
      if (lightOrbGroup) lightOrbGroup.visible = true;
      if (bgPlane) bgPlane.visible = true;
    });
  }, [gl, scene, camera, registerCapture, shadowRef, bgPlaneRef]);

  return null;
}

// ---------------------------------------------------------------------------
// SVGTo3DCanvas — main exported component
// ---------------------------------------------------------------------------

export interface LightSettings {
  keyX: number;
  keyY: number;
  keyZ: number;
  keyIntensity: number;
  ambientIntensity: number;
  shadowEnabled: boolean;
}

export const lightingPresets = {
  studio: {
    label: "Studio",
    settings: {
      keyX: 2,
      keyY: 2,
      keyZ: 4,
      keyIntensity: 3.0,
      ambientIntensity: 0.8,
      shadowEnabled: true,
    } satisfies LightSettings,
  },
  rim: {
    label: "Rim",
    settings: {
      keyX: -4,
      keyY: 1.5,
      keyZ: 5,
      keyIntensity: 2.6,
      ambientIntensity: 0.55,
      shadowEnabled: true,
    } satisfies LightSettings,
  },
  sunset: {
    label: "Sunset",
    settings: {
      keyX: 4.5,
      keyY: 3.5,
      keyZ: 2.5,
      keyIntensity: 3.4,
      ambientIntensity: 0.65,
      shadowEnabled: true,
    } satisfies LightSettings,
  },
} as const;

export const defaultLightSettings: LightSettings = {
  ...lightingPresets.studio.settings,
};

interface SVGTo3DCanvasProps {
  svg: string;
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
  bgColor: string;
  textureUrl: string | null;
  textureSettings: TextureSettings;
  materialSettings: MaterialSettings;
  cursorOrbit: boolean;
  orbitStrength: number;
  resetOnIdle: boolean;
  resetDelay: number;
  animate: AnimationType;
  animateSpeed: number;
  animateReverse: boolean;
  rotationX: number;
  rotationY: number;
  zoom: number;
  resetKey: number;
  lightSettings: LightSettings;
  showLightHelper: boolean;
  registerCapture?: (fn: (resolution: number, withBackground: boolean, onCapture: (dataUrl: string) => void, aspectRatio?: number | null) => void) => void;
  registerCanvas?: (canvas: HTMLCanvasElement) => void;
  registerMeshGroup?: (group: THREE.Group | null) => void;
}

export function SVGTo3DCanvas({
  svg,
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
  bgColor,
  textureUrl,
  textureSettings,
  materialSettings,
  cursorOrbit,
  orbitStrength,
  resetOnIdle,
  resetDelay,
  animate,
  animateSpeed,
  animateReverse,
  rotationX,
  rotationY,
  zoom,
  resetKey,
  lightSettings,
  showLightHelper,
  registerCapture,
  registerCanvas,
  registerMeshGroup,
}: SVGTo3DCanvasProps) {
  const shadowRef = useRef<THREE.Group>(null);
  const lightOrbRef = useRef<THREE.Group>(null);
  const bgPlaneRef = useRef<THREE.Mesh>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [loadingProgress, setLoadingProgress] = useState(0);
  const [showLoader, setShowLoader] = useState(false);
  const loaderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLoadingChange = useCallback((loading: boolean, progress: number) => {
    setIsLoading(loading);
    setLoadingProgress(progress);
    if (loading) {
      if (!loaderTimerRef.current) {
        loaderTimerRef.current = setTimeout(() => setShowLoader(true), 800);
      }
    } else {
      if (loaderTimerRef.current) { clearTimeout(loaderTimerRef.current); loaderTimerRef.current = null; }
      setShowLoader(false);
    }
  }, []);

  return (
    <>
      <div
        className={`absolute inset-0 z-20 flex items-center justify-center pointer-events-none transition-opacity duration-300 ${showLoader ? "opacity-100" : "opacity-0"}`}
      >
        <div className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-xl px-4 py-2">
          <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          <span className="text-xs text-white/70">{loadingProgress > 0 && loadingProgress < 100 ? `${loadingProgress}%` : "Loading..."}</span>
        </div>
      </div>
    <SVG3D
      svg={svg}
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
      material={materialSettings.preset}
      metalness={materialSettings.metalness}
      roughness={materialSettings.roughness}
      opacity={materialSettings.opacity}
      wireframe={materialSettings.wireframe}
      texture={textureUrl ?? undefined}
      textureRepeat={textureSettings.repeatX}
      textureRotation={textureSettings.rotation}
      textureOffset={[textureSettings.offsetX, textureSettings.offsetY]}
      lightPosition={[lightSettings.keyX, lightSettings.keyY, lightSettings.keyZ]}
      lightIntensity={lightSettings.keyIntensity}
      ambientIntensity={lightSettings.ambientIntensity}
      shadow={lightSettings.shadowEnabled}
      rotationX={rotationX}
      rotationY={rotationY}
      zoom={zoom}
      resetKey={resetKey}
      cursorOrbit={cursorOrbit}
      orbitStrength={orbitStrength}
      resetOnIdle={resetOnIdle}
      resetDelay={resetDelay}
      animate={animate}
      animateSpeed={animateSpeed}
      animateReverse={animateReverse}
      scrollZoom
      background="#05060f"
      width="100%"
      height="100%"
      intro="zoom"
      onReady={() => setIsLoading(false)}
      onLoadingChange={handleLoadingChange}
      registerCanvas={registerCanvas}
      registerMeshGroup={registerMeshGroup}
    >
      {/* Export capture — needs GL access */}
      <DownloadCapture
        registerCapture={registerCapture}
        shadowRef={shadowRef}
        lightOrbRef={lightOrbRef}
        bgPlaneRef={bgPlaneRef}
      />

      {/* Space lighting — matches the CSS background glow regions */}
      <SpaceLighting />

      {/* Light position indicator */}
      <group ref={lightOrbRef}>
        {showLightHelper && (
          <mesh position={[lightSettings.keyX, lightSettings.keyY, lightSettings.keyZ]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshBasicMaterial color="#ffffff" />
            <GlowSprite intensity={lightSettings.keyIntensity} />
          </mesh>
        )}
      </group>

      {/* Background plane — gives glass/transmission materials something to refract through */}
      <mesh ref={bgPlaneRef} position={[0, 0, -3]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color={bgColor} roughness={0.8} metalness={0} />
      </mesh>
    </SVG3D>
    </>
  );
}
