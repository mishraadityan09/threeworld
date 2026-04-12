/**
 * =============================================================================
 * Pixel Editor
 * =============================================================================
 *
 * 16x16 grid-based drawing tool. Draw/erase pixels, then contour-trace
 * the result into an SVG path for 3D extrusion.
 */

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Eraser, Paintbrush, RotateCcw } from "lucide-react";

interface PixelEditorProps {
  onSvgChange: (svg: string) => void;
}

// Traces outlines of filled pixel regions using edge detection.
// Produces clean merged shapes instead of individual rectangles,
// which is critical for transparent materials (no internal faces).
function pixelsToSvg(pixels: boolean[][], gridSize: number): string {
  const cellSize = Math.floor(200 / gridSize);
  const totalSize = cellSize * gridSize;

  const isFilled = (x: number, y: number) =>
    x >= 0 && x < gridSize && y >= 0 && y < gridSize && pixels[y][x];

  // Collect all horizontal and vertical edges between filled/empty cells
  type Edge = { x1: number; y1: number; x2: number; y2: number };
  const edges: Edge[] = [];

  for (let y = 0; y <= gridSize; y++) {
    for (let x = 0; x <= gridSize; x++) {
      const above = isFilled(x, y - 1);
      const below = isFilled(x, y);
      const left = isFilled(x - 1, y);
      const right = isFilled(x, y);

      // Horizontal edge (between rows y-1 and y)
      if (above !== below) {
        edges.push({
          x1: x * cellSize,
          y1: y * cellSize,
          x2: (x + 1) * cellSize,
          y2: y * cellSize,
        });
      }
      // Vertical edge (between cols x-1 and x)
      if (left !== right) {
        edges.push({
          x1: x * cellSize,
          y1: y * cellSize,
          x2: x * cellSize,
          y2: (y + 1) * cellSize,
        });
      }
    }
  }

  if (edges.length === 0) return "";

  // Build adjacency: for each point, which edges connect to it
  const pointKey = (x: number, y: number) => `${x},${y}`;
  const adj = new Map<string, Edge[]>();
  for (const e of edges) {
    const k1 = pointKey(e.x1, e.y1);
    const k2 = pointKey(e.x2, e.y2);
    if (!adj.has(k1)) adj.set(k1, []);
    if (!adj.has(k2)) adj.set(k2, []);
    adj.get(k1)!.push(e);
    adj.get(k2)!.push(e);
  }

  // Trace closed loops
  const used = new Set<Edge>();
  const loops: Array<Array<{ x: number; y: number }>> = [];

  for (const edge of edges) {
    if (used.has(edge)) continue;
    const loop: Array<{ x: number; y: number }> = [];
    let cur = edge;
    let px = cur.x1,
      py = cur.y1;
    loop.push({ x: px, y: py });

    while (true) {
      used.add(cur);
      // Move to the other end
      let nx: number, ny: number;
      if (cur.x1 === px && cur.y1 === py) {
        nx = cur.x2;
        ny = cur.y2;
      } else {
        nx = cur.x1;
        ny = cur.y1;
      }
      loop.push({ x: nx, y: ny });

      if (nx === edge.x1 && ny === edge.y1 && loop.length > 2) break;

      // Find next unused edge from this point
      const key = pointKey(nx, ny);
      const candidates = adj.get(key) ?? [];
      const next = candidates.find((e) => !used.has(e));
      if (!next) break;
      cur = next;
      px = nx;
      py = ny;
    }

    if (loop.length > 2) loops.push(loop);
  }

  // Convert loops to SVG path data
  let pathData = "";
  for (const loop of loops) {
    pathData += `M${loop[0].x},${loop[0].y}`;
    for (let i = 1; i < loop.length; i++) {
      pathData += `L${loop[i].x},${loop[i].y}`;
    }
    pathData += "Z ";
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}"><path d="${pathData.trim()}" fill="black" fill-rule="evenodd"/></svg>`;
}

function createEmptyGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array(size).fill(false));
}

function createDefaultGrid(): boolean[][] {
  // Classic Space Invader — symmetric, centered in 16x16
  // Using a bitmap approach: define rows as binary strings (1=filled)
  const rows = [
    "0000100000010000",  // row 3:  antennas
    "0000010000100000",  // row 4
    "0000111111110000",  // row 5:  head
    "0001101111011000",  // row 6:  head with eyes
    "0011111111111100",  // row 7:  wide body
    "0010111111110100",  // row 8:  body
    "0010100000010100",  // row 9:  legs top
    "0000011001100000",  // row 10: feet
  ];
  const grid = createEmptyGrid(16);
  const startY = 4; // vertically center (16 - 8 rows) / 2 = 4
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < 16; c++) {
      if (rows[r][c] === "1") {
        grid[startY + r][c] = true;
      }
    }
  }
  return grid;
}

export function PixelEditor({ onSvgChange }: PixelEditorProps) {
  const [gridSize, setGridSize] = useState(16);
  const [pixels, setPixels] = useState<boolean[][]>(() => createDefaultGrid());
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [isDrawing, setIsDrawing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState(0);

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerSize(Math.floor(width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Emit SVG when pixels change
  useEffect(() => {
    const svg = pixelsToSvg(pixels, gridSize);
    onSvgChange(svg);
  }, [pixels, gridSize, onSvgChange]);

  const togglePixel = useCallback(
    (x: number, y: number) => {
      setPixels((prev) => {
        const next = prev.map((row) => [...row]);
        next[y][x] = tool === "draw";
        return next;
      });
    },
    [tool]
  );

  const handlePointerDown = useCallback(
    (x: number, y: number) => {
      setIsDrawing(true);
      togglePixel(x, y);
    },
    [togglePixel]
  );

  const handlePointerEnter = useCallback(
    (x: number, y: number) => {
      if (isDrawing) togglePixel(x, y);
    },
    [isDrawing, togglePixel]
  );

  const handlePointerUp = useCallback(() => {
    setIsDrawing(false);
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", handlePointerUp);
    return () => window.removeEventListener("pointerup", handlePointerUp);
  }, [handlePointerUp]);

  const clearGrid = () => setPixels(createEmptyGrid(gridSize));

  const cellPx = containerSize > 0 ? Math.floor(containerSize / gridSize) : 0;
  const gridPx = cellPx * gridSize;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5">
        <Button
          variant={tool === "draw" ? "default" : "outline"}
          size="sm"
          onClick={() => setTool("draw")}
          className="h-7 w-7 p-0"
          title="Draw"
        >
          <Paintbrush className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={tool === "erase" ? "default" : "outline"}
          size="sm"
          onClick={() => setTool("erase")}
          className="h-7 w-7 p-0"
          title="Erase"
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={clearGrid}
          className="h-7 w-7 p-0"
          title="Clear"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Pixel grid */}
      <div
        ref={containerRef}
        className="w-full border rounded-md bg-white overflow-hidden select-none touch-none"
        style={{ aspectRatio: "1" }}
      >
        {cellPx > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${gridSize}, ${cellPx}px)`,
              gridTemplateRows: `repeat(${gridSize}, ${cellPx}px)`,
              width: gridPx,
              height: gridPx,
              margin: "0 auto",
            }}
          >
            {pixels.map((row, y) =>
              row.map((filled, x) => (
                <div
                  key={`${x}-${y}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    handlePointerDown(x, y);
                  }}
                  onPointerEnter={() => handlePointerEnter(x, y)}
                  style={{
                    width: cellPx,
                    height: cellPx,
                    backgroundColor: filled ? "#000" : "transparent",
                    boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.08)",
                  }}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
