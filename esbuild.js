const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
};

/** @type {import('esbuild').BuildOptions} */
const testBuild = {
  entryPoints: [
    'src/test/suite/index.ts',
    'src/test/suite/extension.test.ts',
  ],
  bundle: true,
  outdir: 'out/test/suite',
  external: ['vscode', 'mocha', 'glob'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const testRunnerBuild = {
  entryPoints: ['src/test/runTest.ts'],
  bundle: true,
  outdir: 'out/test',
  external: ['@vscode/test-electron'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionBuild);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(extensionBuild);
    await esbuild.build(testBuild);
    await esbuild.build(testRunnerBuild);
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
