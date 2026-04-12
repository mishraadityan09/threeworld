/**
 * FFmpeg WASM — WebM → MP4/WebM converter
 *
 * Uses FFmpeg compiled to WebAssembly for trim, crop, resize, and format conversion.
 * Single-threaded core to skip SharedArrayBuffer requirement.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

const BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<void> | null = null;

async function getFFmpeg(onStatus: (status: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance && loadPromise) {
    await loadPromise;
    return ffmpegInstance;
  }

  const ffmpeg = new FFmpeg();
  ffmpegInstance = ffmpeg;

  loadPromise = (async () => {
    onStatus("Downloading converter (~30 MB, first time only)...");

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${BASE_URL}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
    ]);

    await ffmpeg.load({ coreURL, wasmURL });
  })();

  await loadPromise;
  return ffmpeg;
}

export interface ConvertOptions {
  trimStart?: number;
  trimEnd?: number;
  filters?: string;
  bitrate?: string;
  format?: "mp4" | "webm";
  duration?: number; // total duration in seconds for progress estimation
}

export async function convertWebmToMp4(
  webmBlob: Blob,
  onStatus: (status: string) => void,
  options?: ConvertOptions
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onStatus);
  const format = options?.format ?? "mp4";
  const outputFile = `output.${format}`;

  const totalDuration = options?.duration ?? 0;

  const onProgress = ({ progress, time }: { progress: number; time: number }) => {
    let pct = 0;
    if (progress > 0 && progress <= 1) {
      pct = Math.round(progress * 100);
    } else if (time > 0 && totalDuration > 0) {
      pct = Math.round(Math.min(1, (time / 1_000_000) / totalDuration) * 100);
    }
    if (pct > 0) {
      onStatus(`${pct}%`);
    }
  };

  const onLog = ({ message }: { message: string }) => {
    // Silent — progress handler covers it
    if (message.includes("error")) {
      console.warn("[ffmpeg]", message);
    }
  };

  ffmpeg.on("progress", onProgress);
  ffmpeg.on("log", onLog);

  onStatus("Converting...");

  const inputData = await fetchFile(webmBlob);
  await ffmpeg.writeFile("input.webm", inputData);

  // Build FFmpeg command
  const args: string[] = [];

  // Trim: seek input before decoding (fast)
  if (options?.trimStart !== undefined) {
    args.push("-ss", String(options.trimStart));
  }

  args.push("-i", "input.webm");

  if (options?.trimEnd !== undefined) {
    const duration = (options.trimEnd) - (options?.trimStart ?? 0);
    args.push("-t", String(duration));
  }

  // Video filters (crop + scale)
  if (options?.filters) {
    args.push("-vf", options.filters);
  }

  if (format === "mp4") {
    // Try copy codec first for speed, fall back to mpeg4
    args.push("-c:v", "mpeg4");
    args.push("-q:v", options?.bitrate === "16M" ? "2" : options?.bitrate === "8M" ? "4" : "6");
  } else {
    args.push("-c:v", "libvpx-vp9");
    if (options?.bitrate) {
      args.push("-b:v", options.bitrate);
    }
  }

  args.push("-pix_fmt", "yuv420p");
  if (format === "mp4") {
    args.push("-movflags", "+faststart");
  }
  args.push("-an"); // no audio
  args.push(outputFile);

  const exitCode = await ffmpeg.exec(args);

  if (exitCode !== 0) {
    console.error("[ffmpeg] exec failed with exit code:", exitCode);
    await ffmpeg.deleteFile("input.webm");
    return webmBlob;
  }

  const outputData = await ffmpeg.readFile(outputFile);
  const outputBlob = new Blob([new Uint8Array(outputData as Uint8Array)], {
    type: format === "mp4" ? "video/mp4" : "video/webm",
  });

  await ffmpeg.deleteFile("input.webm");
  await ffmpeg.deleteFile(outputFile);

  ffmpeg.off("progress", onProgress);
  ffmpeg.off("log", onLog);

  return outputBlob;
}
