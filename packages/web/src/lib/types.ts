/**
 * Shared Types — Web editor only
 *
 * Material types come from the engine ("3dsvg").
 * Texture and light settings are web-editor-specific.
 */

// Re-export engine types so existing imports from "@/lib/types" still work
export type { MaterialSettings, MaterialPreset } from "3dsvg";
export { materialPresets } from "3dsvg";
import { materialPresets } from "3dsvg";

export const defaultMaterialSettings = {
  preset: "default" as const,
  metalness: materialPresets.default.metalness,
  roughness: materialPresets.default.roughness,
  opacity: materialPresets.default.opacity,
  transparent: materialPresets.default.transparent,
  wireframe: false,
};

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
