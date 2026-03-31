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
    external: [
        'vscode',
        '@analyticsinmotion/micstream',
        'node-record-lpcm16',
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
