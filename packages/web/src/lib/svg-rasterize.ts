/**
 * =============================================================================
 * SVG Rasterizer
 * =============================================================================
 *
 * Renders any SVG string to a canvas, reads the pixels, and produces
 * a filled SVG made of rectangles — works reliably with stroke-based
 * SVGs like Lucide icons.
 */
export function rasterizeSvgToFilledSvg(
  svgMarkup: string,
  gridSize: number = 64
): Promise<string> {
  return new Promise((resolve) => {
    // Fix currentColor → black
    const cleanSvg = svgMarkup
      .replace(/currentColor/g, "black")
      .replace(/stroke="[^"]*"/g, 'stroke="black"');

    const blob = new Blob([cleanSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = gridSize;
      canvas.height = gridSize;
      const ctx = canvas.getContext("2d")!;

      // White background
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, gridSize, gridSize);

      // Draw SVG centered and scaled to fit
      const scale = Math.min(gridSize / img.width, gridSize / img.height) * 0.85;
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (gridSize - w) / 2;
      const y = (gridSize - h) / 2;
      ctx.drawImage(img, x, y, w, h);

      // Read pixels and threshold
      const imageData = ctx.getImageData(0, 0, gridSize, gridSize);
      const cellSize = Math.floor(200 / gridSize);
      const totalSize = cellSize * gridSize;
      let pathData = "";

      for (let py = 0; py < gridSize; py++) {
        for (let px = 0; px < gridSize; px++) {
          const i = (py * gridSize + px) * 4;
          const r = imageData.data[i];
          const g = imageData.data[i + 1];
          const b = imageData.data[i + 2];
          // Brightness threshold
          const brightness = (r + g + b) / 3;
          if (brightness < 128) {
            const sx = px * cellSize;
            const sy = py * cellSize;
            pathData += `M${sx},${sy}h${cellSize}v${cellSize}h${-cellSize}Z `;
          }
        }
      }

      URL.revokeObjectURL(url);

      if (!pathData) {
        resolve("");
        return;
      }

      resolve(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}"><path d="${pathData.trim()}" fill="black"/></svg>`
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("");
    };

    img.src = url;
  });
}
