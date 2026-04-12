import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "threeworld — Turn SVGs into interactive 3D",
  description: "Turn any SVG, text, or pixel art into an interactive 3D object. Animate and export as 4K image, video, or 3D model.",
  openGraph: {
    title: "threeworld — Turn SVGs into interactive 3D",
    description: "Turn any SVG, text, or pixel art into an interactive 3D object. Animate and export as 4K image, video, or 3D model.",
    siteName: "threeworld",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "threeworld — Turn SVGs into interactive 3D",
    description: "Turn any SVG, text, or pixel art into an interactive 3D object. Animate and export as 4K image, video, or 3D model.",
  },
  keywords: ["3d", "svg", "react", "three.js", "embed", "webgl", "pixel art", "text to 3d", "svg to 3d", "threeworld"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <TooltipProvider delayDuration={700}>{children}</TooltipProvider>
        <Analytics />
      </body>
    </html>
  );
}
