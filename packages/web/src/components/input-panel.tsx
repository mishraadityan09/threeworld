/**
 * =============================================================================
 * Input Panel
 * =============================================================================
 *
 * Vertical toolbar (top-left) + expandable content panel. Each tool produces
 * an SVG string fed to the 3D canvas.
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Pencil,
  Type,
  FileUp,
  Upload,
  Code,
  FileCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { PixelEditor } from "@/components/pixel-editor";
import { TextInput } from "@/components/text-input";

interface InputPanelProps {
  inputTab: string;
  onInputTabChange: (tab: string) => void;
  customSvg: string;
  onCustomSvgChange: (v: string) => void;
  onFileSvgChange: (svg: string) => void;
  onPixelSvgChange: (svg: string) => void;
  onTextSvgChange: (svg: string) => void;
  onTextChange?: (text: string) => void;
  onFontChange?: (font: string) => void;
  initialText?: string;
  initialFont?: string;
  droppedFile?: { name: string; content: string } | null;
  /** Hide the built-in toolbar dock (icons are shown in the top nav instead) */
  hideToolbar?: boolean;
  /** Controlled open state — when provided, overrides internal expanded state */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const tabs = [
  { value: "draw", icon: Pencil, label: "Draw" },
  { value: "text", icon: Type, label: "Text" },
  { value: "code", icon: Code, label: "SVG Code" },
  { value: "file", icon: FileUp, label: "Upload File" },
];

const contentVariants = {
  enter: { opacity: 0, x: -8 },
  active: { opacity: 1, x: 0, transition: { duration: 0.15 } },
  exit: { opacity: 0, x: -8, transition: { duration: 0.1 } },
};

const tabLabels: Record<string, string> = {
  draw: "Draw",
  text: "Text",
  code: "SVG Code",
  file: "Upload File",
};

export function InputPanel({
  inputTab,
  onInputTabChange,
  customSvg,
  onCustomSvgChange,
  onFileSvgChange,
  onPixelSvgChange,
  onTextSvgChange,
  onTextChange,
  onFontChange,
  initialText,
  initialFont,
  droppedFile,
  hideToolbar = false,
  open,
  onOpenChange,
}: InputPanelProps) {
  const isControlled = open !== undefined;
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = isControlled ? open : internalExpanded;
  const setExpanded = (v: boolean) => {
    if (isControlled) onOpenChange?.(v);
    else setInternalExpanded(v);
  };

  // Collapse on mobile after mount (uncontrolled mode only)
  useEffect(() => {
    if (!isControlled && window.innerWidth < 768) setInternalExpanded(false);
  }, [isControlled]);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedSvgContent, setUploadedSvgContent] = useState<string | null>(null);
  const svgFileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync dropped file from parent (drag-and-drop)
  useEffect(() => {
    if (droppedFile) {
      setUploadedFileName(droppedFile.name);
      setUploadedSvgContent(droppedFile.content);
      setExpanded(true);
    }
  }, [droppedFile]);

  // Close panel when clicking outside
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent | PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, [expanded]);

  const handleTabClick = (value: string) => {
    if (inputTab === value && expanded) {
      setExpanded(false);
    } else {
      onInputTabChange(value);
      setExpanded(true);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (text) {
        setUploadedSvgContent(text);
        onFileSvgChange(text);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div ref={panelRef} className={`flex gap-4 pointer-events-none items-start ${hideToolbar ? "flex-col" : "flex-col max-md:flex-row max-md:items-center"}`}>
      {/* Expandable content panel */}
      <motion.div
        initial={false}
        animate={expanded
          ? { opacity: 1, scale: 1, pointerEvents: "auto" as const }
          : { opacity: 0, scale: 0.95, pointerEvents: "none" as const }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={`w-full rounded-[2rem] bg-black/40 backdrop-blur-3xl border border-white/10 shadow-[0_12px_44px_oklch(0_0_0/0.5)] p-5 relative overflow-hidden scrollbar-none ${hideToolbar ? "max-h-[75vh] overflow-y-auto" : "max-w-[340px] max-md:max-w-[260px] max-md:max-h-[70vh] max-md:overflow-y-auto order-1 max-md:order-2"}`}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-white/[0.03] to-transparent pointer-events-none" />
        <div className="relative z-10">
            {/* Panel header — only when hideToolbar */}
            {hideToolbar && (
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-semibold text-white/90 tracking-tight">
                  {tabLabels[inputTab] ?? "Edit"}
                </span>
                <button
                  onClick={() => setExpanded(false)}
                  className="p-1.5 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className={inputTab === "draw" ? "" : "hidden"}>
              <PixelEditor onSvgChange={onPixelSvgChange} />
            </div>
            <div className={inputTab === "text" ? "" : "hidden"}>
              <TextInput onSvgChange={onTextSvgChange} onTextChange={onTextChange} onFontChange={onFontChange} initialText={initialText} initialFont={initialFont} active={inputTab === "text" && expanded} />
            </div>
            <div className={inputTab === "code" ? "" : "hidden"}>
              <div className="space-y-3">
                <textarea
                  className="w-full rounded-2xl border border-white/10 bg-black/50 px-4 py-3 text-xs font-mono h-48 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow placeholder:text-white/20 text-white/90 shadow-inner"
                  placeholder={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <path d="..." fill="black"/>\n</svg>`}
                  value={customSvg}
                  onChange={(e) => onCustomSvgChange(e.target.value)}
                />
                {!customSvg && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs w-full bg-white/5 border-white/10 hover:bg-white/10 rounded-xl py-5 transition-all text-white/80 hover:text-white"
                    onClick={() => onCustomSvgChange('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="black"/></svg>')}
                  >
                    Load example (star)
                  </Button>
                )}
              </div>
            </div>
            <div className={inputTab === "file" ? "" : "hidden"}>
              {uploadedFileName ? (
                <div className="space-y-4">
                  {uploadedSvgContent && (
                    <div
                      className="rounded-2xl border border-white/10 bg-white/5 p-6 flex items-center justify-center aspect-square overflow-hidden shadow-inner"
                      dangerouslySetInnerHTML={{ __html: uploadedSvgContent.replace(/<svg/, '<svg style="width:100%;height:100%;object-fit:contain;display:block;max-width:100%;max-height:100%"') }}
                    />
                  )}
                  <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/40 backdrop-blur-md p-3 shadow-sm">
                    <FileCheck className="h-5 w-5 text-primary shrink-0" />
                    <span className="text-xs text-white/90 truncate flex-1 font-medium">{uploadedFileName}</span>
                    <button
                      onClick={() => {
                        setUploadedFileName(null);
                        setUploadedSvgContent(null);
                        onFileSvgChange("");
                        if (svgFileInputRef.current) svgFileInputRef.current.value = "";
                      }}
                      className="shrink-0 p-1.5 rounded-full hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/10 bg-black/20 p-12 transition-colors hover:border-white/20 hover:bg-white/[0.02]">
                    <div className="p-3 bg-white/5 rounded-full mb-1">
                      <Upload className="h-6 w-6 text-white/60" />
                    </div>
                    <p className="text-xs text-white/50 font-medium">
                      Upload an SVG file
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 bg-white/5 border-white/10 hover:bg-white/10 rounded-xl px-5 text-white/90"
                      onClick={() => svgFileInputRef.current?.click()}
                    >
                      Choose File
                    </Button>
                  </div>
                )}
                <input
                  ref={svgFileInputRef}
                  type="file"
                  accept=".svg"
                  className="hidden"
                  onChange={handleFileUpload}
                />
            </div>
        </div>
      </motion.div>

      {/* Toolbar dock — hidden when icons are in the top nav */}
      <div className={`flex items-center gap-1.5 rounded-full bg-black/40 backdrop-blur-3xl border border-white/10 shadow-[0_12px_40px_oklch(0_0_0/0.6)] p-2 pointer-events-auto order-2 max-md:order-1 max-md:flex-col ${hideToolbar ? "hidden" : ""}`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isSelected = inputTab === tab.value;
          const isOpen = isSelected && expanded;
          return (
            <Tooltip key={tab.value}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-11 w-11 rounded-full transition-all duration-300 relative overflow-hidden ${
                    isOpen
                      ? "bg-primary text-primary-foreground shadow-[0_0_20px_oklch(0.72_0.22_38/0.5)] border border-primary/50"
                      : isSelected
                        ? "bg-white/10 text-white border border-transparent"
                        : "text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent"
                  }`}
                  onClick={() => handleTabClick(tab.value)}
                >
                  {isOpen && <div className="absolute inset-0 bg-white/20 blur-md pointer-events-none" />}
                  <Icon className="h-5 w-5 relative z-10" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={12} className="bg-black/80 backdrop-blur border-white/10 text-white rounded-lg px-3 py-1.5 text-xs shadow-xl max-md:block hidden">{tab.label}</TooltipContent>
              <TooltipContent side="top" sideOffset={12} className="bg-black/80 backdrop-blur border-white/10 text-white rounded-lg px-3 py-1.5 text-xs shadow-xl md:block hidden">{tab.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
