/**
 * Shared Types — Web editor only
 *
 * Material types come from the engine ("3dsvg").
 * Texture and light settings are web-editor-specific.
 */

// Re-export engine types so existing imports from "@/lib/types" still work
export type { MaterialSettings, MaterialPreset, GeometryMode, QualityProfile } from "3dsvg";
export { materialPresets } from "3dsvg";
import { materialPresets } from "3dsvg";
import type { GeometryMode, MaterialPreset, MaterialSettings } from "3dsvg";

export function createMaterialSettings(preset: MaterialPreset): MaterialSettings {
  const base = materialPresets[preset];
  return {
    preset,
    metalness: base.metalness,
    roughness: base.roughness,
    opacity: base.opacity,
    transparent: base.transparent,
    wireframe: false,
  };
}

export const defaultMaterialSettings = createMaterialSettings("default");

export const modeMaterialDefaults: Record<GeometryMode, MaterialSettings> = {
  extrude: defaultMaterialSettings,
  volume: createMaterialSettings("clay"),
};

export function materialSettingsMatch(a: MaterialSettings, b: MaterialSettings) {
  return (
    a.preset === b.preset &&
    a.metalness === b.metalness &&
    a.roughness === b.roughness &&
    a.opacity === b.opacity &&
    a.transparent === b.transparent &&
    a.wireframe === b.wireframe
  );
}

export interface TextureSettings {
  offsetX: number;
  offsetY: number;
  repeatX: number;
  repeatY: number;
  rotation: number;
}

export const defaultTextureSettings: TextureSettings = {
  offsetX: 0,
  offsetY: 0,
  repeatX: 1,
  repeatY: 1,
  rotation: 0,
};
