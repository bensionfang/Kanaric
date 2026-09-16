import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const configuredOutDir = process.env.KANARIC_OUT_DIR;
const outDir = configuredOutDir ? path.resolve(configuredOutDir) : path.join(here, 'dist');

if (configuredOutDir) {
  if (fs.existsSync(outDir)) throw new Error(`KANARIC_OUT_DIR already exists: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
}

const bundles = [
  ['service-worker.js', 'service-worker.js'],
  ['youtube-content.js', 'youtube-content.js'],
  ['popup.js', 'popup.js'],
  ['offscreen.js', 'offscreen.js'],
];

for (const [input, output] of bundles) {
  await build({
    entryPoints: [path.join(srcDir, input)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(outDir, output),
  });
}

for (const name of ['manifest.json', 'popup.html', 'popup.css', 'offscreen.html']) {
  fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
}

const vendorDir = path.join(outDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });
await build({
  entryPoints: [path.join(here, 'node_modules/@soundtouchjs/audio-worklet/.dist/index.js')],
  bundle: true,
  format: 'iife',
  globalName: 'SoundTouchLib',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(vendorDir, 'soundtouch-node.js'),
});
fs.copyFileSync(
  path.join(here, 'node_modules/@soundtouchjs/audio-worklet/.dist/soundtouch-processor.js'),
  path.join(vendorDir, 'soundtouch-processor.js'),
);
fs.copyFileSync(
  path.join(here, 'node_modules/@soundtouchjs/audio-worklet/LICENSE'),
  path.join(vendorDir, 'SoundTouchJS-MPL-2.0.txt'),
);
