import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(rootDir, 'dist');

const cssAsText = {
  name: 'css-as-text',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => ({
      contents: await fs.readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await fs.mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/vendor.js')],
  outfile: path.join(outDir, 'vendor.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'eof',
  sourcemap: false,
  minify: false,
});

await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/renderer/index.js')],
  outfile: path.join(outDir, 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'eof',
  sourcemap: false,
  minify: false,
  plugins: [cssAsText],
});
