import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
];
const base = {
  entryPoints: ['server/src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  external,
  logLevel: 'warning',
};

await build({ ...base, format: 'cjs', outfile: 'dist/server/index.js' });
await build({
  ...base,
  format: 'esm',
  outfile: 'dist/server/index.mjs',
  banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
});

// Test helpers: `strapi-plugin-magic-messagegate/testing`.
const testing = { ...base, entryPoints: ['server/src/testing/index.js'] };
await build({ ...testing, format: 'cjs', outfile: 'dist/testing/index.js' });
await build({
  ...testing,
  format: 'esm',
  outfile: 'dist/testing/index.mjs',
  banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" },
});
