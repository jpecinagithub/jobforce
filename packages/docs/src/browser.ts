/**
 * HTML -> PDF / PNG con Playwright (chromium headless).
 * El binario se resuelve en este orden: PLAYWRIGHT_CHROMIUM_EXE,
 * ~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome,
 * o el headless shell equivalente bajo chromium_headless_shell-<build>/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

function resolveChromiumExe(): string {
  const env = process.env.PLAYWRIGHT_CHROMIUM_EXE;
  if (env && existsSync(env)) return env;
  const base = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(base)) {
    for (const dir of readdirSync(base).sort().reverse()) {
      const full = join(base, dir, "chrome-linux64", "chrome");
      if (existsSync(full)) return full;
      const shell = join(base, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(shell)) return shell;
    }
  }
  throw new Error(
    "No se encontró el binario de Chromium (ms-playwright). " +
      "Define PLAYWRIGHT_CHROMIUM_EXE o instala el navegador.",
  );
}

export interface RenderOptions {
  pdfPath: string;
  pngPath: string;
  /** Ancho de viewport para el PNG (el PDF siempre es A4). */
  pngWidth?: number;
}

/** Renderiza el HTML a PDF (A4) y PNG (captura de la página). */
export async function renderHtmlToPdfAndPng(html: string, opts: RenderOptions): Promise<void> {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumExe() });
  try {
    const page = await browser.newPage({ viewport: { width: opts.pngWidth ?? 900, height: 1200 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: opts.pdfPath, format: "A4", printBackground: true });
    await page.screenshot({ path: opts.pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

/** Extrae texto de un PDF usando pdftotext (poppler) si está disponible. */
export function extractPdfTextWithPdftotext(pdfPath: string): string {
  const out = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out;
}
