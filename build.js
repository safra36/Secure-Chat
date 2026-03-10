// build.js — minify + bundle + SEA binary
const esbuild = require('esbuild');
const { minify: htmlMinify } = require('html-minifier-terser');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');

const CLIENT_ASSETS = [
  'index.html', 'login.html',
  'auth.js', 'encryption.js', 'error-reporter.js',
  'content-cache-db.js', 'sticker-db.js', 'p2p-transfer-manager.js',
  'pako.min.js', 'sw.js', 'manifest.json'
];

async function minifyAssets() {
  const assets = {};
  for (const file of CLIENT_ASSETS) {
    const src = path.join(__dirname, file);
    if (!fs.existsSync(src)) { console.warn(`  skip (not found): ${file}`); continue; }
    let content = fs.readFileSync(src, 'utf8');
    if (file.endsWith('.html')) {
      content = await htmlMinify(content, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: { compress: true, mangle: true },
      });
    } else if (file.endsWith('.js') && !file.endsWith('.min.js')) {
      const r = await esbuild.transform(content, { minify: true, loader: 'js' });
      content = r.code;
    } else if (file.endsWith('.json')) {
      content = JSON.stringify(JSON.parse(content));
    }
    assets[file] = content;
    const kb = (content.length / 1024).toFixed(1);
    console.log(`  ${file}: ${kb} KB`);
  }
  return assets;
}

function inlineAssetsPlugin(assets) {
  const serialized = JSON.stringify(Object.entries(assets));
  return {
    name: 'inline-assets',
    setup(build) {
      build.onResolve({ filter: /asset-loader/ }, () => ({
        path: 'asset-loader',
        namespace: 'inline'
      }));
      build.onLoad({ filter: /^asset-loader$/, namespace: 'inline' }, () => ({
        contents: `
const _m = new Map(${serialized});
module.exports = {
  getAsset: n => _m.has(n) ? Buffer.from(_m.get(n)) : null,
  hasAsset: n => _m.has(n),
  getAssetList: () => [..._m.keys()],
  getTotalAssetSize: () => [..._m.values()].reduce((s, v) => s + v.length, 0),
  loadAssets: () => {}
};`,
        loader: 'js'
      }));
    }
  };
}

async function bundle(assets) {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  await esbuild.build({
    entryPoints: ['server.js'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: path.join(DIST, 'bundle.js'),
    minify: true,
    plugins: [inlineAssetsPlugin(assets)]
  });
  const kb = (fs.statSync(path.join(DIST, 'bundle.js')).size / 1024).toFixed(0);
  console.log(`  bundle.js: ${kb} KB`);
}

function createBinary(target) {
  const isWin = target === 'win';
  const outName = isWin ? 'chat.exe' : `chat-${target}`;
  const outPath = path.join(DIST, outName);
  const blobPath = path.join(DIST, 'sea-blob.bin');
  const configPath = path.join(DIST, 'sea-config.json');

  fs.writeFileSync(configPath, JSON.stringify({
    main: path.join(DIST, 'bundle.js'),
    output: blobPath,
    useCodeCache: true,
    disableExperimentalSEAWarning: true
  }));

  console.log('  Generating SEA blob...');
  const r = spawnSync(process.execPath, ['--experimental-sea-config', configPath], {
    encoding: 'utf8', stdio: 'inherit'
  });
  if (r.status !== 0) throw new Error('SEA blob generation failed');

  console.log('  Copying node executable...');
  fs.copyFileSync(process.execPath, outPath);

  if (isWin) {
    try { execSync(`signtool remove /s "${outPath}"`, { stdio: 'ignore' }); } catch (_) {}
  }

  console.log('  Injecting blob...');
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const machoFlag = process.platform === 'darwin' ? '--macho-segment-name __NODE_SEA' : '';
  execSync(
    `npx postject "${outPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${fuse} ${machoFlag}`,
    { stdio: 'inherit', cwd: __dirname }
  );

  fs.unlinkSync(blobPath);
  fs.unlinkSync(configPath);

  const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ${outName}: ${mb} MB`);
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.includes('--linux') ? 'linux'
    : args.includes('--macos') ? 'macos'
    : 'win';
  const noBinary = args.includes('--no-binary');

  console.log('Minifying client assets...');
  const assets = await minifyAssets();
  console.log(`  ${Object.keys(assets).length} assets ready`);

  console.log('Bundling server...');
  await bundle(assets);

  if (!noBinary) {
    console.log(`Creating binary (${target})...`);
    createBinary(target);
  }

  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
