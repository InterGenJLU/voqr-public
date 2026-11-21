// Test-only extension used by scripts/test/activation-sandbox.ps1; it is never shipped.
// After start-up it asks VS Code to activate VOQR and records: whether VOQR is installed,
// whether activation succeeded (and the exact error if not), which voqr.* commands are
// registered, whether VOQR's packaged voice-activity model runs one second of silence, what
// happens when voqr.pushToTalk and voqr.toggleVoicePanel are run as a user runs them, and
// which webview tabs are open afterwards (VOQR's panel is one when those commands work).
// It writes the record to the file named by VOQR_PROBE_OUT, then closes the window.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

async function vadCheck(extensionPath) {
    const avr = require(path.join(extensionPath, 'node_modules', 'avr-vad'));
    let frames = 0;
    let lastIsSpeech = null;
    const vad = await avr.RealTimeVAD.new({
        sampleRate: 16000,
        onFrameProcessed: (p) => { frames += 1; lastIsSpeech = p.isSpeech; },
        onVADMisfire: () => {},
        onSpeechStart: () => {},
        onSpeechRealStart: () => {},
        onSpeechEnd: () => {},
    });
    vad.start();
    await vad.processAudio(new Float32Array(16000));
    vad.destroy();
    return { framesProcessed: frames, lastIsSpeech };
}

exports.activate = async function activate() {
    const out = process.env.VOQR_PROBE_OUT;
    const result = {
        probeStarted: new Date().toISOString(),
        vscodeVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
    };
    try {
        const ext = vscode.extensions.getExtension('intergen.voqr');
        result.installed = Boolean(ext);
        if (ext) {
            result.version = ext.packageJSON.version;
            try {
                await ext.activate();
                result.activated = true;
            } catch (err) {
                result.activated = false;
                result.activationError = String((err && err.message) || err);
            }
            result.isActive = ext.isActive;
            try {
                result.vad = await vadCheck(ext.extensionPath);
            } catch (err) {
                result.vadError = String((err && err.message) || err);
            }
        }
        const commands = await vscode.commands.getCommands(true);
        result.voqrCommands = commands.filter((c) => c.startsWith('voqr.')).sort();
        result.commandsRun = [];
        for (const id of ['voqr.pushToTalk', 'voqr.toggleVoicePanel']) {
            const run = { command: id };
            try {
                await vscode.commands.executeCommand(id);
                run.ran = true;
            } catch (err) {
                run.ran = false;
                run.error = String((err && err.message) || err);
            }
            result.commandsRun.push(run);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result.webviewTabs = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .filter((tab) => tab.input instanceof vscode.TabInputWebview)
            .map((tab) => ({ label: tab.label, viewType: tab.input.viewType }));
    } catch (err) {
        result.probeError = String((err && err.stack) || err);
    }
    result.probeFinished = new Date().toISOString();
    if (out) {
        fs.writeFileSync(out, JSON.stringify(result, null, 2));
    }
    setTimeout(() => { vscode.commands.executeCommand('workbench.action.quit'); }, 3000);
};

exports.deactivate = function deactivate() {};
