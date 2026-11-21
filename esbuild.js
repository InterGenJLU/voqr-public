const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

function copyStaticAssets() {
    const distWebview = path.join(__dirname, 'dist', 'webview');
    fs.mkdirSync(distWebview, { recursive: true });

    // CSS
    fs.copyFileSync(
        path.join(__dirname, 'src', 'webview', 'style.css'),
        path.join(distWebview, 'style.css'),
    );
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    // Left out of the bundle because they load native code or data files relative to their
    // own folder; scripts/package/voqr-package.json ships each of them under node_modules.
    // Everything else, node-record-lpcm16 included, is bundled into dist/extension.js.
    external: [
        'vscode',
        '@analyticsinmotion/micstream',
        'onnxruntime-node',
        'avr-vad',
    ],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
};

async function build() {
    if (watch) {
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        await Promise.all([extCtx.watch(), webCtx.watch()]);
        console.log('Watching for changes...');
    } else {
        await Promise.all([
            esbuild.build(extensionConfig),
            esbuild.build(webviewConfig),
        ]);
        copyStaticAssets();
        console.log('Build complete.');
    }
}

build().catch(() => process.exit(1));
