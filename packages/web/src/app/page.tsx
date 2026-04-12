/**
 * =============================================================================
 * Editor Page
 * =============================================================================
 *
 * Main application page. Composes the 3D canvas, input panel, controls
 * panel, and export bar into the full editor experience.
 */

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { Settings2, Pencil, Type, Code, FileUp } from "lucide-react";
import type { Group } from "three";
import { defaultLightSettings, type LightSettings } from "@/components/svg-to-3d-canvas";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { InputPanel } from "@/components/input-panel";
import { ControlsPanel } from "@/components/controls-panel";
import { ExportModal } from "@/components/export-bar";
import {
  defaultTextureSettings,
  defaultMaterialSettings,
  type TextureSettings,
  type MaterialSettings,
} from "@/lib/types";

const SVGTo3DCanvas = dynamic(
  () =>
    import("@/components/svg-to-3d-canvas").then((mod) => mod.SVGTo3DCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full bg-muted rounded-lg animate-pulse" />
    ),
  }
);

export default function Home() {
  // --- Editor state ---
  const [customSvg, setCustomSvg] = useState("");
  const [fileSvg, setFileSvg] = useState("");
  const [pixelSvg, setPixelSvg] = useState("");
  const [textSvg, setTextSvg] = useState("");
  const [inputTab, setInputTab] = useState("draw");
  const [depth, setDepth] = useState(1);
  const [smoothness, setSmoothness] = useState(0.6);
  const [color, setColor] = useState("#4f46e5");
  const [bgColor, setBgColor] = useState("#000000");
  const [textureUrl, setTextureUrl] = useState<string | null>(null);
  const [textureSettings, setTextureSettings] =
    useState<TextureSettings>(defaultTextureSettings);
  const [materialSettings, setMaterialSettings] =
    useState<MaterialSettings>(defaultMaterialSettings);
  const captureFnRef = useRef<((resolution: number, withBackground: boolean, onCapture: (dataUrl: string) => void, aspectRatio?: number | null) => void) | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [topPanel, setTopPanel] = useState<"toolbar" | "settings">("toolbar");
  const [lightingOpen, setLightingOpen] = useState(false);
  const [cursorOrbit, setCursorOrbit] = useState(false);
  const [orbitStrength, setOrbitStrength] = useState(0.15);
  const [resetOnIdle, setResetOnIdle] = useState(false);
  const [resetDelay, setResetDelay] = useState(2);
  const [rotationX, setRotationX] = useState(0);
  const [rotationY, setRotationY] = useState(0);
  const [zoom, setZoom] = useState(8);
  const [resetKey, setResetKey] = useState(0);
  const [animate, setAnimate] = useState<"none" | "spin" | "float" | "pulse" | "wobble" | "spinFloat" | "swing">("float");
  const [animateSpeed, setAnimateSpeed] = useState(1);
  const [animateReverse, setAnimateReverse] = useState(false);
  const [lightSettings, setLightSettings] = useState<LightSettings>(defaultLightSettings);
  const [currentText, setCurrentText] = useState("3DSVG");
  const [currentFont, setCurrentFont] = useState("Rubik Mono One");
  const [inputPanelOpen, setInputPanelOpen] = useState(false);

  // --- Export bar ---
  const [exportOpen] = useState(true);
  const [exportPreviewOpen, setExportPreviewOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const meshGroupRef = useRef<Group | null>(null);
  const [hasExportMesh, setHasExportMesh] = useState(false);

  const registerCapture = useCallback((fn: (resolution: number, withBackground: boolean, onCapture: (dataUrl: string) => void, aspectRatio?: number | null) => void) => {
    captureFnRef.current = fn;
  }, []);

  const registerCanvas = useCallback((canvas: HTMLCanvasElement) => {
    canvasRef.current = canvas;
  }, []);

  const registerMeshGroup = useCallback((group: Group | null) => {
    meshGroupRef.current = group;
    setHasExportMesh(!!group);
  }, []);

  // --- Drag-and-drop SVG ---
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFile, setDroppedFile] = useState<{ name: string; content: string } | null>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current++;
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDragging(true);
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) setIsDragging(false);
    };
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file && (file.type === "image/svg+xml" || file.name.endsWith(".svg"))) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target?.result as string;
          if (text) {
            setFileSvg(text);
            setInputTab("file");
            setDroppedFile({ name: file.name, content: text });
          }
        };
        reader.readAsText(file);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  const handleTextureUpload = useCallback((url: string | null) => {
    setTextureUrl(url);
    if (!url) setTextureSettings(defaultTextureSettings);
  }, []);

  const handlePixelSvgChange = useCallback((svg: string) => {
    setPixelSvg(svg);
  }, []);

  const handleTextSvgChange = useCallback((svg: string) => {
    setTextSvg(svg);
  }, []);

  // Show SVG from the active tab. When switching to an empty tab,
  // keep showing the last non-empty SVG that was displayed.
  const svgByTab: Record<string, string> = {
    text: textSvg,
    draw: pixelSvg,
    code: customSvg.trim(),
    file: fileSvg,
  };
  const tabSvg = svgByTab[inputTab] ?? "";
  const [lastActiveSvg, setLastActiveSvg] = useState("");
  const [lastActiveInputTab, setLastActiveInputTab] = useState(inputTab);
  if (tabSvg && (tabSvg !== lastActiveSvg || inputTab !== lastActiveInputTab)) {
    setLastActiveSvg(tabSvg);
    setLastActiveInputTab(inputTab);
  }
  const activeSvg = tabSvg || lastActiveSvg;
  const activeSvgTab = tabSvg ? inputTab : lastActiveInputTab;
  const preserveSvgColors = activeSvgTab !== "text";

  return (
    <main className="relative w-screen overflow-hidden bg-background h-[100svh]">
      {/* Layer 0: 3D Canvas */}
      <div className="absolute inset-0 z-0">
        <SVGTo3DCanvas
          svg={activeSvg}
          depth={depth}
          smoothness={smoothness}
          color={color}
          preserveSvgColors={preserveSvgColors}
          bgColor={bgColor}
          textureUrl={textureUrl}
          textureSettings={textureSettings}
          materialSettings={materialSettings}
          rotationX={rotationX}
          rotationY={rotationY}
          zoom={zoom}
          resetKey={resetKey}
          cursorOrbit={cursorOrbit}
          orbitStrength={orbitStrength}
          resetOnIdle={exportPreviewOpen ? false : resetOnIdle}
          resetDelay={resetDelay}
          animate={exportPreviewOpen ? "none" : animate}
          animateSpeed={animateSpeed}
          animateReverse={animateReverse}
          lightSettings={lightSettings}
          showLightHelper={controlsOpen && lightingOpen}
          registerCapture={registerCapture}
          registerCanvas={registerCanvas}
          registerMeshGroup={registerMeshGroup}
        />
      </div>

      {/* Layer 1: Ambient overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse at center, oklch(0.13 0.01 275 / 0.15) 0%, transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 50%, oklch(0 0 0 / 0.3) 100%)",
        }}
      />

      {/* Layer 2: Edit panel — left side, vertically centered */}
      <div className={`pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 md:pl-6 ${topPanel === "toolbar" ? "z-20" : "z-[8]"}`}>
        <div className="w-[min(420px,calc(100vw-1.5rem))]">
        <InputPanel
          inputTab={inputTab}
          onInputTabChange={(tab) => { setInputTab(tab); setTopPanel("toolbar"); setControlsOpen(false); }}
          customSvg={customSvg}
          onCustomSvgChange={setCustomSvg}
          onFileSvgChange={setFileSvg}
          onPixelSvgChange={handlePixelSvgChange}
          onTextSvgChange={handleTextSvgChange}
          onTextChange={setCurrentText}
          onFontChange={setCurrentFont}
          initialText={currentText}
          initialFont={currentFont}
          droppedFile={droppedFile}
          hideToolbar
          open={inputPanelOpen}
          onOpenChange={setInputPanelOpen}
        />
        </div>
      </div>

      {/* Top Navigation Dock */}
      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className={`pointer-events-auto absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 p-1.5 rounded-full bg-black/40 backdrop-blur-3xl border border-white/10 shadow-[0_12px_40px_oklch(0_0_0/0.6)] ${topPanel === "settings" ? "z-20" : "z-[8]"}`}
      >
        {/* Input tab icons — Draw, Text, Code, File */}
        {([
          { value: "draw", icon: Pencil, label: "Draw" },
          { value: "text", icon: Type,   label: "Text" },
          { value: "code", icon: Code,   label: "SVG Code" },
          { value: "file", icon: FileUp, label: "Upload File" },
        ] as const).map(({ value, icon: Icon, label }) => {
          const isActive = inputTab === value && inputPanelOpen;
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (inputTab === value && inputPanelOpen) {
                      setInputPanelOpen(false);
                    } else {
                      setInputTab(value);
                      setInputPanelOpen(true);
                      setTopPanel("toolbar");
                      setControlsOpen(false);
                    }
                  }}
                  className={`rounded-full h-10 w-10 transition-all duration-300 relative overflow-hidden ${
                    isActive
                      ? "bg-primary text-primary-foreground shadow-[0_0_20px_oklch(0.72_0.22_38/0.5)] border border-primary/50"
                      : "text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent"
                  }`}
                >
                  {isActive && <div className="absolute inset-0 bg-white/20 blur-md pointer-events-none" />}
                  <Icon className="h-[18px] w-[18px] relative z-10" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={12} className="bg-black/80 backdrop-blur border-white/10 text-white rounded-lg px-3 py-1.5 text-xs shadow-xl">{label}</TooltipContent>
            </Tooltip>
          );
        })}

        <div className="w-[1px] h-6 bg-white/10 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { setControlsOpen((v) => !v); setTopPanel("settings"); }}
              className={`rounded-full h-10 w-10 transition-all duration-300 relative overflow-hidden ${
                controlsOpen
                  ? "bg-primary text-primary-foreground shadow-[0_0_20px_oklch(0.72_0.22_38/0.5)] border border-primary/50"
                  : "hover:bg-white/10 text-white border border-transparent"
              }`}
            >
              {controlsOpen && <div className="absolute inset-0 bg-white/20 blur-sm" />}
              <Settings2 className="h-[18px] w-[18px] relative z-10" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={12} className="bg-black/80 backdrop-blur border-white/10 text-white rounded-lg px-3 py-1.5 text-xs shadow-xl">Settings</TooltipContent>
        </Tooltip>
      </motion.div>

      {/* Mobile backdrop — tap to close settings */}
      {controlsOpen && (
        <div
          className="md:hidden fixed inset-0 z-[19] bg-black/30 backdrop-blur-sm"
          onClick={() => setControlsOpen(false)}
        />
      )}

      {/* Right-side settings panel */}
      <motion.div
        initial={{ opacity: 0, x: 20, pointerEvents: "none" as const, scale: 0.95 }}
        animate={controlsOpen
          ? { opacity: 1, x: 0, pointerEvents: "auto" as const, scale: 1 }
          : { opacity: 0, x: 20, pointerEvents: "none" as const, scale: 0.95 }
        }
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className={`absolute top-24 right-6 bottom-6 max-md:left-6 max-md:top-24 max-md:bottom-32 ${topPanel === "settings" ? "z-20" : "z-[8]"}`}
      >
            <ControlsPanel
              depth={depth}
              onDepthChange={setDepth}
              smoothness={smoothness}
              onSmoothnessChange={setSmoothness}
              color={color}
              onColorChange={setColor}
              bgColor={bgColor}
              onBgColorChange={setBgColor}
              textureUrl={textureUrl}
              onTextureUpload={handleTextureUpload}
              textureSettings={textureSettings}
              onTextureSettingsChange={setTextureSettings}
              materialSettings={materialSettings}
              onMaterialSettingsChange={setMaterialSettings}
              animate={animate}
              onAnimateChange={setAnimate}
              animateSpeed={animateSpeed}
              onAnimateSpeedChange={setAnimateSpeed}
              animateReverse={animateReverse}
              onAnimateReverseChange={setAnimateReverse}
              rotationX={rotationX}
              onRotationXChange={setRotationX}
              rotationY={rotationY}
              onRotationYChange={setRotationY}
              zoom={zoom}
              onZoomChange={setZoom}
              onReset={() => setResetKey((k) => k + 1)}
              lightSettings={lightSettings}
              onLightSettingsChange={setLightSettings}
              cursorOrbit={cursorOrbit}
              onCursorOrbitChange={setCursorOrbit}
              orbitStrength={orbitStrength}
              onOrbitStrengthChange={setOrbitStrength}
              resetOnIdle={resetOnIdle}
              onResetOnIdleChange={setResetOnIdle}
              resetDelay={resetDelay}
              onResetDelayChange={setResetDelay}
              onClose={() => setControlsOpen(false)}
              onLightingSectionChange={setLightingOpen}
            />
      </motion.div>

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[100] flex items-center justify-center"
        >
          <div className="absolute inset-2 rounded-2xl border-2 border-dashed border-white/20 bg-card/40 flex flex-col items-center justify-center gap-4">
            <svg className="h-16 w-16 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <span className="text-xl font-medium text-white/60">Drop SVG file</span>
          </div>
        </motion.div>
      )}


      {/* Export modal */}
      <ExportModal
        open={exportOpen}
        onClose={() => {}}
        canvasRef={canvasRef}
        meshGroupRef={meshGroupRef}
        modelSource={{
          svgString: activeSvg,
          depth,
          smoothness,
          color,
          preserveSvgColors,
          materialSettings,
          rotationX,
          rotationY,
        }}
        canExportModel={hasExportMesh}
        captureFn={captureFnRef}
        animate={animate}
        animateSpeed={animateSpeed}
        onPreviewOpen={setExportPreviewOpen}
      />
    </main>
  );
}
