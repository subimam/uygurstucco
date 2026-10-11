/**
 * generate-images.mjs
 * ------------------------------------------------------------------
 * Build-time image pipeline for the stucco portfolio site.
 *
 * Takes a folder of full-resolution source photos and produces, for each one:
 *   - resized variants at several widths (so phones don't download desktop files)
 *   - AVIF + WebP + JPEG copies of each width (modern formats, JPEG fallback)
 *   - a tiny blurred placeholder as an inline base64 data URI (the "blur-up")
 *
 * Everything is written to /public/images, and a manifest.json is produced
 * that the site reads to build <img srcset> and set blur placeholders +
 * fixed dimensions (which is what kills layout shift).
 *
 * Run once, by hand, whenever you add or change photos:
 *     node generate-images.mjs
 *
 * Setup (one time):
 *     npm install sharp
 *
 * Source folder layout (folder per project; file names are up to you):
 *     photos-raw/
 *       hero.jpg
 *       harbourview-hotel/
 *         cover.jpg
 *         01-facade.jpg
 *         02-detail.jpg
 *       carlton-residences/
 *         cover.jpg
 *         ...
 * ------------------------------------------------------------------
 */

import sharp from "sharp";
import { readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, dirname, extname, sep } from "node:path";

// ---------------------------------------------------------------- config
const SRC_DIR = "photos-raw";              // where your originals live
const OUT_DIR = "public/images";           // where optimized files are written
const MANIFEST = "public/images/manifest.json";

const WIDTHS = [400, 800, 1200, 2000];     // responsive sizes; small → large
const FORMATS = {                          // quality per format (lower = smaller)
  avif: { quality: 52 },
  webp: { quality: 76 },
  jpg:  { quality: 80, mozjpeg: true },
};
const PLACEHOLDER_WIDTH = 24;              // blur-up thumbnail width in px
const SOURCE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);

// ---------------------------------------------------------------- helpers

// Walk a directory tree and return every image file path.
async function findImages(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findImages(full)));
    } else if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// "photos-raw/harbourview-hotel/01-facade.jpg" -> "harbourview-hotel/01-facade"
function keyFor(srcPath) {
  const rel = relative(SRC_DIR, srcPath);
  return rel.slice(0, rel.length - extname(rel).length).split(sep).join("/");
}

// Make a tiny blurred base64 data URI to show instantly before the photo loads.
async function makePlaceholder(input) {
  const buf = await sharp(input)
    .resize(PLACEHOLDER_WIDTH)        // shrink hard
    .blur()                           // soften
    .webp({ quality: 40 })
    .toBuffer();
  return `data:image/webp;base64,${buf.toString("base64")}`;
}

// ---------------------------------------------------------------- main

async function run() {
  // Confirm the source folder exists before doing anything.
  try {
    await stat(SRC_DIR);
  } catch {
    console.error(`✗ Source folder "${SRC_DIR}" not found. Create it and add photos.`);
    process.exit(1);
  }

  const images = await findImages(SRC_DIR);
  if (images.length === 0) {
    console.error(`✗ No images found in "${SRC_DIR}".`);
    process.exit(1);
  }
  console.log(`Found ${images.length} source image(s). Processing…\n`);

  const manifest = {};
  let totalIn = 0;
  let totalOut = 0;

  for (const src of images) {
    const key = keyFor(src);
    const meta = await sharp(src).metadata();
    const srcBytes = (await stat(src)).size;
    totalIn += srcBytes;

    // Mirror the project folder structure inside OUT_DIR.
    const outSubdir = join(OUT_DIR, dirname(key));
    await mkdir(outSubdir, { recursive: true });

    const entry = {
      width: meta.width,
      height: meta.height,
      aspectRatio: +(meta.width / meta.height).toFixed(4),
      blurDataURL: await makePlaceholder(src),
      variants: { avif: [], webp: [], jpg: [] },
    };

    // For each width, emit one file per format. Never upscale past the original.
    for (const w of WIDTHS) {
      if (w > meta.width) continue; // skip widths larger than the source
      for (const [fmt, opts] of Object.entries(FORMATS)) {
        const fileName = `${key.split("/").pop()}-${w}.${fmt}`;
        const outPath = join(outSubdir, fileName);
        const pipeline = sharp(src).resize({ width: w, withoutEnlargement: true });
        const fmtKey = fmt === "jpg" ? "jpeg" : fmt;
        await pipeline[fmtKey](opts).toFile(outPath);

        totalOut += (await stat(outPath)).size;
        // Public URL the browser will request (POSIX slashes).
        const url = "/" + relative("public", outPath).split(sep).join("/");
        entry.variants[fmt].push({ w, src: url });
      }
    }

    // Always include the full-width original at the largest available size as a
    // convenience "src" (largest webp) for non-srcset uses like the lightbox.
    const largestWebp = entry.variants.webp.at(-1);
    entry.src = largestWebp ? largestWebp.src : null;

    manifest[key] = entry;
    console.log(`  ✓ ${key}  (${meta.width}×${meta.height})`);
  }

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(`\nDone. ${Object.keys(manifest).length} image(s) processed.`);
  console.log(`Source total: ${mb(totalIn)} MB  →  Output total: ${mb(totalOut)} MB`);
  console.log(`Manifest written to ${MANIFEST}`);
}

run().catch((err) => {
  console.error("\n✗ Image generation failed:");
  console.error(err);
  process.exit(1);
});
