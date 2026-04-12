# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

3dsvg is an npm workspaces monorepo with two packages:

- **`packages/engine`** — `<SVG3D>` React component published to npm as `3dsvg`
- **`packages/web`** — Next.js visual editor at 3dsvg.design

The web editor renders the engine's `<SVG3D>` component directly — what you see in the editor is exactly what you get with the embed.

## Commands

```bash
npm install              # install all dependencies (run from repo root)
npm run build:engine     # build the engine with tsup (required before dev:web)
npm run dev:web          # start the web editor at localhost:3000 (Turbopack)
npm run dev              # run both engine watch + web dev in parallel
npm run build            # build engine then web (full production build)
npm --workspace=packages/web run lint   # lint the web package
```

**Critical workflow**: Changes to engine source require `npm run build:engine` to be picked up by the web editor. The web imports the built `dist/` output, not the raw source.

## Architecture

### Engine (`packages/engine`)

Bundled with tsup as a pure ESM library. Entry point: `src/index.tsx`.

**Rendering pipeline:**
1. `SVG3D` (index.tsx) — public-facing component. Resolves the `svg` prop (raw markup or URL fetch), converts `text` prop via Google Fonts using `opentype.js`, merges material presets with user overrides via `resolveMaterial()`, then lazy-loads `SVG3DScene`.
2. `SVG3DScene` (scene.tsx) — wraps a React Three Fiber `<Canvas>`. Composes `ExtrudedSVG`, `SmoothControls`, `IntroAnimation`, `LoopAnimation`, lighting, `ContactShadows`, and a custom `Environment` probe.
3. `ExtrudedSVG` (scene.tsx) — parses SVG paths with Three.js `SVGLoader`, extrudes them into `THREE.ExtrudeGeometry` in async batches (`BATCH_SIZE = 20`) via `useExtrudedGeometry`, applies triplanar UVs, and renders `meshPhysicalMaterial` meshes.
4. `buildExtrudedGeometryResult` — async function (also exported) that does the geometry work. Supports `"preview"` and `"export"` build profiles (export profile uses lower bevel/curve segments and drops UVs for cleaner PNG/video output).
5. `buildOptimizedExportMeshGroup` — async function used by the web editor for high-quality PNG/video captures.

**Key engine exports** (from `src/index.tsx`):
- `SVG3D`, `SVG3DProps`, `MaterialPreset`, `defaultProps`
- `SVG3DScene`, `SVG3DSceneProps`, `ExtrudedSVG`, `useExtrudedGeometry`, `ExtrudedGeometryResult`
- `IntroAnimation`, `LoopAnimation`, `SmoothControls`, `introComplete`
- `materialPresets`, `resolveMaterial`, `MaterialSettings`
- `useFont`, `textToSvg`

**Sub-path exports**: `3dsvg/scene`, `3dsvg/controls`, `3dsvg/materials`, `3dsvg/types`, `3dsvg/use-font`

### Web editor (`packages/web`)

Next.js 16 app (App Router) with React 19, Tailwind CSS v4, shadcn/ui.

**Component tree:**
- `app/page.tsx` — owns all editor state (svg, depth, color, material, animation, lighting, etc.) and composes the four main sections
- `components/svg-to-3d-canvas.tsx` — wraps `<SVG3D>` for the editor; adds draggable light controls, a background plane, and exposes a `captureFn` ref for export
- `components/input-panel.tsx` — tabs for SVG input modes: draw (freehand SVG), file upload, pixel editor, text
- `components/controls-panel.tsx` — all visual knobs (material, depth, animation, camera, lighting)
- `components/export-bar.tsx` — PNG export (up to 4K) and video export (MP4/WebM via FFmpeg WASM)
- `components/embed-dialog.tsx` — generates copy-paste embed code
- `lib/ffmpeg.ts` — FFmpeg WASM wrapper for video encoding
- `lib/procedural-textures.ts` — programmatic texture generation
- `lib/types.ts` — web-only types (`MaterialSettings`, `TextureSettings`, `LightSettings`)

**`SVGTo3DCanvas`** must be loaded with `dynamic(..., { ssr: false })` because it creates a WebGL context.

## Conventions

- All engine source files have `/** === TITLE === */` block headers with `@packageDocumentation`
- Web components use the same header style but without `@packageDocumentation`
- TypeScript strict mode throughout
- Tailwind CSS for all styling (no CSS modules)
- shadcn/ui components live in `packages/web/src/components/ui/`
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`

## Key files

- `packages/engine/src/types.ts` — all `SVG3DProps` and `defaultProps`
- `packages/engine/src/index.tsx` — public API entry point and `SVG3D` component
- `packages/engine/src/scene.tsx` — Three.js rendering pipeline, geometry extrusion, `SVG3DScene`
- `packages/engine/src/controls.tsx` — `SmoothControls`, `IntroAnimation`, `LoopAnimation`
- `packages/engine/src/materials.ts` — 10 PBR material presets and `resolveMaterial()`
- `packages/engine/src/use-font.ts` — Google Font loading and `textToSvg()` via opentype.js
- `packages/web/src/app/page.tsx` — main editor page; owns all state
- `packages/web/src/components/svg-to-3d-canvas.tsx` — editor canvas wrapper

## Important notes

- `svg` prop accepts raw SVG markup or URLs (`http://`, `https://`, `/`, `./`) — URLs are auto-fetched. `svgString` is deprecated in favour of `svg`.
- SVG paths **must** have a non-transparent fill or stroke — paths with `fill="none"` are skipped.
- Default color is `#ffffff` (white). Default `scrollZoom` is `false` (embeds don't hijack page scroll).
- `preserveSvgColors` (default `false`) — when `true`, each SVG path retains its original fill/stroke color instead of using the `color` prop.
- Browsers cap WebGL contexts at ~8–16 per page; keep to 3–4 `<SVG3D>` instances max.
- Use `dynamic(() => import("3dsvg"), { ssr: false })` in Next.js to avoid SSR errors.
- `buildOptimizedExportMeshGroup` is exported from the engine for advanced export use cases (lower bevel/curve segments, no transmission, no UVs).

## LLM context files

- `llms.txt` — root-level project overview
- `packages/engine/llms.txt` — full `<SVG3D>` API reference (included in the npm package)
