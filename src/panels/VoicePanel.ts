import * as vscode from 'vscode';
import { panel as panelLog } from '../log';

export class VoicePanel {
    private static instance: VoicePanel | undefined;
    private static readonly viewType = 'voqr.voicePanel';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.onDispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.onMessage(msg),
            null,
            this.disposables,
        );
    }

    static createOrShow(context: vscode.ExtensionContext): void {
        if (VoicePanel.instance) {
            panelLog.debug('Panel already exists, revealing');
            VoicePanel.instance.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        panelLog.info('Creating new voice panel');
        const panel = vscode.window.createWebviewPanel(
            VoicePanel.viewType,
            'VOQR',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
                ],
            },
        );

        VoicePanel.instance = new VoicePanel(panel, context.extensionUri);
        panelLog.info('Voice panel created');
    }

    static sendMessage(msg: { type: string; payload?: unknown }): void {
        panelLog.messageSent(msg.type, msg.payload);
        VoicePanel.instance?.panel.webview.postMessage(msg);
    }

    static dispose(): void {
        panelLog.info('Disposing voice panel');
        VoicePanel.instance?.panel.dispose();
    }

    private onDispose(): void {
        panelLog.info('Voice panel disposed');
        VoicePanel.instance = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    private onMessage(msg: { type: string; payload?: unknown }): void {
        panelLog.messageReceived(msg.type);
        switch (msg.type) {
            case 'toggleCapture':
                vscode.commands.executeCommand('voqr.pushToTalk');
                break;
            case 'log':
                panelLog.info(`[webview] ${msg.payload as string}`);
                break;
            case 'audioPlaybackFailed':
                panelLog.info(`[webview] Audio playback FAILED: ${msg.payload as string}`);
                VoicePanel.sendMessage({ type: 'aiError', payload: `Audio playback failed: ${msg.payload as string}` });
                break;
            case 'audioDiag': {
                const diag = msg.payload as Record<string, unknown>;
                panelLog.info(`[webview] AudioDiag: contextRate=${diag.contextRate} bufferRate=${diag.bufferRate} resampled=${diag.resampled} samples=${diag.totalSamples} onset=${(diag.onsetRms as number)?.toFixed(6)} offset=${(diag.offsetRms as number)?.toFixed(6)}`);
                // Save diagnostic snapshots to debug_data if debug mode is on
                const debugOn = vscode.workspace.getConfiguration('voqr').get<boolean>('debug', false);
                if (debugOn && diag.first50ms) {
                    const fs = require('fs');
                    const path = require('path');
                    const diagDir = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'debug_data', 'webview_audio');
                    fs.mkdirSync(diagDir, { recursive: true });
                    const ts = Date.now();
                    fs.writeFileSync(path.join(diagDir, `diag_${ts}.json`), JSON.stringify(diag, null, 2));
                }
                break;
            }
            case 'selectModel':
                panelLog.info(`[webview] Model selected: ${msg.payload as string}`);
                vscode.commands.executeCommand('voqr.selectModel', msg.payload);
                break;
            case 'refreshModels':
                panelLog.info('[webview] Requesting model list refresh');
                vscode.commands.executeCommand('voqr.refreshModels');
                break;
            case 'toggleInputMode':
                panelLog.info('[webview] Toggling input mode');
                vscode.commands.executeCommand('voqr.toggleInputMode');
                break;
            case 'openSettings':
                panelLog.info('[webview] Opening VOQR settings');
                vscode.commands.executeCommand('workbench.action.openSettings', 'voqr');
                break;
            case 'setTtsSpeed': {
                const speed = msg.payload as number;
                panelLog.info(`[webview] TTS speed → ${speed}`);
                vscode.workspace.getConfiguration('voqr').update('ttsSpeed', speed, true);
                break;
            }
            case 'setTtsMute': {
                const muted = msg.payload as boolean;
                panelLog.info(`[webview] TTS autoPlay → ${!muted}`);
                vscode.workspace.getConfiguration('voqr').update('ttsAutoPlay', !muted, true);
                if (muted) {
                    // Stop current playback and clear queue
                    VoicePanel.sendMessage({ type: 'stopAudio' });
                    vscode.commands.executeCommand('voqr.clearTtsQueue');
                }
                break;
            }
            case 'installExtension':
                panelLog.info(`[webview] Opening extension: ${msg.payload as string}`);
                vscode.commands.executeCommand('workbench.extensions.search', `@id:${msg.payload as string}`);
                break;
            case 'wizardInstall':
                panelLog.info(`[webview] Wizard: installing extension ${msg.payload as string}`);
                vscode.commands.executeCommand('workbench.extensions.installExtension', msg.payload as string).then(() => {
                    panelLog.info(`[webview] Wizard: extension installed`);
                    VoicePanel.sendMessage({ type: 'extensionInstalled' });
                }, (err) => {
                    panelLog.info(`[webview] Wizard: install failed — ${err}`);
                    VoicePanel.sendMessage({ type: 'wizardError', payload: `Extension install failed: ${err}` });
                });
                break;
            case 'openExternal':
                panelLog.info(`[webview] Opening URL: ${msg.payload as string}`);
                vscode.env.openExternal(vscode.Uri.parse(msg.payload as string));
                break;
            case 'reloadWindow': {
                const wizardState = msg.payload as { providerName: string; step: number } | undefined;
                panelLog.info(`[webview] Reloading window (wizard: ${wizardState?.providerName ?? 'none'}, step: ${wizardState?.step ?? '?'})`);
                vscode.commands.executeCommand('voqr.wizardReload', wizardState);
                break;
            }
            case 'wizardWriteAitkModels': {
                const models = msg.payload as { name: string; provider: string }[];
                panelLog.info(`[webview] Wizard: writing ${models.length} models to AI Toolkit config`);
                this.writeAitkModels(models);
                break;
            }
        }
    }

    private async writeAitkModels(models: { name: string; provider: string }[]): Promise<void> {
        const os = await import('os');
        const fs = await import('fs');
        const path = await import('path');

        const configDir = path.join(os.homedir(), '.aitk', 'models');
        const configPath = path.join(configDir, 'my-models.yml');
        const backupPath = configPath + '.bak';

        try {
            // Ensure directory exists
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // Back up existing file
            if (fs.existsSync(configPath)) {
                fs.copyFileSync(configPath, backupPath);
                panelLog.info(`[wizard] Backed up ${configPath} → ${backupPath}`);
            }

            // Parse existing YAML (simple format — no library needed)
            const providers = new Map<string, Set<string>>();
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                let currentProvider = '';
                for (const line of content.split('\n')) {
                    const providerMatch = line.match(/^\s{2}- name:\s*(.+)/);
                    const modelMatch = line.match(/^\s{6}- name:\s*(.+)/);
                    if (providerMatch) {
                        currentProvider = providerMatch[1].trim();
                        if (!providers.has(currentProvider)) {
                            providers.set(currentProvider, new Set());
                        }
                    } else if (modelMatch && currentProvider) {
                        providers.get(currentProvider)?.add(modelMatch[1].trim());
                    }
                }
            }

            // Merge new models
            for (const model of models) {
                if (!providers.has(model.provider)) {
                    providers.set(model.provider, new Set());
                }
                providers.get(model.provider)?.add(model.name);
            }

            // Write updated YAML
            let yaml = '# yaml-language-server: $schema=\n\nversion: v0.1\nproviders:\n';
            for (const [providerName, modelNames] of providers) {
                yaml += `  - name: ${providerName}\n`;
                yaml += `    models:\n`;
                for (const modelName of modelNames) {
                    yaml += `      - name: ${modelName}\n`;
                }
            }

            fs.writeFileSync(configPath, yaml, 'utf-8');
            panelLog.info(`[wizard] Wrote ${models.length} models to ${configPath}`);

            // Verify the file is valid by re-reading it
            const verify = fs.readFileSync(configPath, 'utf-8');
            if (!verify.includes('version: v0.1') || !verify.includes('providers:')) {
                throw new Error('Written YAML failed verification');
            }

        } catch (err) {
            panelLog.info(`[wizard] Failed to write AI Toolkit config: ${err}`);

            // Restore backup
            const fs2 = await import('fs');
            if (fs2.existsSync(backupPath)) {
                fs2.copyFileSync(backupPath, configPath);
                panelLog.info(`[wizard] Restored backup from ${backupPath}`);
            }

            VoicePanel.sendMessage({
                type: 'wizardError',
                payload: `Failed to configure AI Toolkit models: ${err}`,
            });
        }
    }

    private getHtml(): string {
        const webview = this.panel.webview;
        const webviewUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'style.css'),
        );
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'nonce-${nonce}';
                   script-src 'nonce-${nonce}';
                   media-src data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <title>VOQR</title>
</head>
<body>
    <div id="voice-panel">
        <div id="header">
            <div id="controls-area">
                <button id="main-btn" aria-label="Start voice" disabled>
                    <span id="main-btn-icon">GO</span>
                </button>
                <div id="mode-toggle-area" class="hidden">
                    <label id="mode-label-hf" class="mode-label">Hands-free</label>
                    <button id="mode-toggle" aria-label="Toggle input mode">
                        <span id="mode-knob" class="mode-knob"></span>
                    </button>
                    <label id="mode-label-ptt" class="mode-label active">Push to Talk</label>
                </div>
            </div>
            <div id="header-text">
                <h2>VOQR</h2>
                <p id="status">Ready</p>
                <span id="main-label"></span>
            </div>
            <div id="model-selector">
                <span id="model-selector-label">Selected Model:</span>
                <button id="model-btn" aria-label="Select AI model">
                    <span id="model-dot" class="model-dot"></span>
                    <span id="model-name">No model selected</span>
                    <span class="dropdown-arrow">&#x25BE;</span>
                </button>
                <div id="model-dropdown" class="model-dropdown hidden"></div>
            </div>
        </div>
        <div id="toolbar">
            <div id="tts-controls">
                <button id="tts-mute" aria-label="Toggle voice output" title="Toggle voice output">
                    <span id="tts-mute-icon">&#x1F50A;</span>
                </button>
                <span id="tts-speed-label"><span class="tts-label-top">Text-to-Speech</span><span class="tts-label-bottom">Speed</span></span>
                <button id="tts-speed-down" aria-label="Slower" title="Slower">&#x2212;</button>
                <span id="tts-speed-value">1.0x</span>
                <button id="tts-speed-up" aria-label="Faster" title="Faster">&#x002B;</button>
            </div>
            <button id="settings-btn" aria-label="Settings" title="Open VOQR settings">
                <span>&#x2699;</span>
            </button>
        </div>
        <div id="chat"></div>
    </div>
    <script nonce="${nonce}" src="${webviewUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
