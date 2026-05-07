import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let outputChannel: vscode.OutputChannel;
let lastVideoPath: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Algo Viz');

    context.subscriptions.push(
        vscode.commands.registerCommand('algo-viz.animateFile', animateFile),
        vscode.commands.registerCommand('algo-viz.animateSelection', animateSelection),
        vscode.commands.registerCommand('algo-viz.configureApiKey', configureApiKey),
        vscode.commands.registerCommand('algo-viz.openLastVideo', openLastVideo),
    );

    outputChannel.appendLine('[Algo Viz] Extension activated');
}

// ── Animate entire MD file ─────────────────────────

async function animateFile(uri?: vscode.Uri) {
    let filePath: string;

    if (uri) {
        filePath = uri.fsPath;
    } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No file open');
            return;
        }
        filePath = editor.document.uri.fsPath;
    }

    if (!filePath.endsWith('.md')) {
        vscode.window.showWarningMessage('Only Markdown files are supported');
        return;
    }

    await runGeneration(filePath);
}

// ── Animate selected text ──────────────────────────

async function animateSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.selection || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('No text selected');
        return;
    }

    const selectedText = editor.document.getText(editor.selection);
    if (selectedText.trim().length < 20) {
        vscode.window.showWarningMessage('Selection too short (min 20 chars)');
        return;
    }

    // Write selection to a temp MD file
    const docDir = path.dirname(editor.document.uri.fsPath);
    const tmpFile = path.join(docDir, '_algo_viz_selection.md');
    fs.writeFileSync(tmpFile, selectedText, 'utf-8');

    try {
        await runGeneration(tmpFile);
    } finally {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch {}
    }
}

// ── Configure API key ──────────────────────────────

async function configureApiKey() {
    const config = vscode.workspace.getConfiguration('algoViz');
    const currentPlatform = config.get<string>('platform', 'openrouter');

    const platform = await vscode.window.showQuickPick(
        ['openrouter', 'mindcraft', 'ablai'],
        { placeHolder: `Select API platform (current: ${currentPlatform})` }
    );
    if (!platform) { return; }

    const key = await vscode.window.showInputBox({
        prompt: `Enter API key for ${platform}`,
        password: true,
        placeHolder: 'sk-...',
    });
    if (!key) { return; }

    await config.update('platform', platform, vscode.ConfigurationTarget.Global);
    await config.update('apiKey', key, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Algo Viz: ${platform} API key saved`);
}

// ── Open last video ────────────────────────────────

async function openLastVideo() {
    if (!lastVideoPath || !fs.existsSync(lastVideoPath)) {
        vscode.window.showWarningMessage('No video available. Generate one first.');
        return;
    }
    showVideoPreview(lastVideoPath);
}

// ── Core: run api_generate.py ──────────────────────

async function runGeneration(mdFilePath: string) {
    const config = vscode.workspace.getConfiguration('algoViz');
    const pythonPath = config.get<string>('pythonPath', 'python');
    const scriptPath = config.get<string>('apiGeneratePath', '');
    const platform = config.get<string>('platform', 'openrouter');
    const model = config.get<string>('model', 'qwen/qwen3-235b-a22b');
    const quality = config.get<string>('quality', 'm');
    const apiKey = config.get<string>('apiKey', '');

    if (!scriptPath || !fs.existsSync(scriptPath)) {
        vscode.window.showErrorMessage(
            `api_generate.py not found at: ${scriptPath}\n` +
            'Configure in Settings > Algo Viz > Api Generate Path'
        );
        return;
    }

    if (!apiKey) {
        const action = await vscode.window.showWarningMessage(
            'No API key configured. Set one first?',
            'Configure', 'Cancel'
        );
        if (action === 'Configure') {
            await configureApiKey();
        }
        return;
    }

    const fileName = path.basename(mdFilePath, '.md');
    outputChannel.show(true);
    outputChannel.appendLine(`\n${'='.repeat(60)}`);
    outputChannel.appendLine(`[Algo Viz] Generating animation for: ${fileName}`);
    outputChannel.appendLine(`[Algo Viz] Platform: ${platform} | Model: ${model} | Quality: ${quality}`);
    outputChannel.appendLine(`${'='.repeat(60)}\n`);

    // Build env with API key
    const env = { ...process.env };
    if (platform === 'openrouter') { env['OPENROUTER_API_KEY'] = apiKey; }
    else if (platform === 'mindcraft') { env['MINDCRAFT_API_KEY'] = apiKey; }
    else if (platform === 'ablai') { env['API_KEY_POOL'] = apiKey; }

    const args = [
        scriptPath,
        mdFilePath,
        '-q', quality,
        '--model', model,
        '--platform', platform,
    ];

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Algo Viz: Generating "${fileName}"...`,
        cancellable: true,
    }, async (progress, token) => {

        return new Promise<void>((resolve, reject) => {
            const proc = cp.spawn(pythonPath, args, {
                env,
                cwd: path.dirname(scriptPath),
            });

            let stdout = '';
            let foundVideo = '';

            proc.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                outputChannel.append(text);

                // Parse progress from output
                if (text.includes('Calling')) {
                    progress.report({ message: 'Calling LLM API...' });
                } else if (text.includes('Generated:')) {
                    progress.report({ message: 'Code generated, rendering...' });
                } else if (text.includes('Rendering:')) {
                    progress.report({ message: 'Rendering Manim scenes...' });
                } else if (text.includes('Extracting')) {
                    progress.report({ message: 'Extracting preview frames...' });
                } else if (text.includes('Done!')) {
                    progress.report({ message: 'Done!' });
                }

                // Capture video path
                const videoMatch = text.match(/Final video:\s*(.+\.mp4)/);
                if (videoMatch) {
                    foundVideo = videoMatch[1].trim();
                }
                const videoMatch2 = text.match(/Done! Video:\s*(.+\.mp4)/);
                if (videoMatch2) {
                    foundVideo = videoMatch2[1].trim();
                }
            });

            proc.stderr?.on('data', (data: Buffer) => {
                outputChannel.append(data.toString());
            });

            token.onCancellationRequested(() => {
                proc.kill();
                outputChannel.appendLine('\n[Algo Viz] Cancelled by user');
                resolve();
            });

            proc.on('close', (code) => {
                if (code === 0 && foundVideo && fs.existsSync(foundVideo)) {
                    lastVideoPath = foundVideo;
                    outputChannel.appendLine(`\n[Algo Viz] Success! Video: ${foundVideo}`);

                    vscode.window.showInformationMessage(
                        `Animation ready: ${path.basename(foundVideo)}`,
                        'Preview', 'Open Folder', 'Open External'
                    ).then(action => {
                        if (action === 'Preview') {
                            showVideoPreview(foundVideo);
                        } else if (action === 'Open Folder') {
                            vscode.commands.executeCommand(
                                'revealFileInOS',
                                vscode.Uri.file(foundVideo)
                            );
                        } else if (action === 'Open External') {
                            vscode.env.openExternal(vscode.Uri.file(foundVideo));
                        }
                    });
                } else if (code !== 0) {
                    outputChannel.appendLine(`\n[Algo Viz] Failed with code ${code}`);
                    vscode.window.showErrorMessage(
                        `Animation generation failed. Check Output > Algo Viz for details.`
                    );
                }
                resolve();
            });

            proc.on('error', (err) => {
                outputChannel.appendLine(`\n[Algo Viz] Error: ${err.message}`);
                vscode.window.showErrorMessage(`Failed to start: ${err.message}`);
                resolve();
            });
        });
    });
}

// ── Video preview in Webview ───────────────────────

function showVideoPreview(videoPath: string) {
    const panel = vscode.window.createWebviewPanel(
        'algoVizPreview',
        `Preview: ${path.basename(videoPath)}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.dirname(videoPath))],
        }
    );

    const videoUri = panel.webview.asWebviewUri(vscode.Uri.file(videoPath));

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0; padding: 20px;
            background: #1e1e1e;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            height: 100vh; box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            color: #ccc;
        }
        video {
            max-width: 100%; max-height: 80vh;
            border-radius: 8px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        }
        .info {
            margin-top: 12px; font-size: 13px; color: #888;
        }
        .controls {
            margin-top: 8px; display: flex; gap: 8px;
        }
        button {
            background: #333; color: #ccc; border: 1px solid #555;
            padding: 4px 12px; border-radius: 4px; cursor: pointer;
            font-size: 12px;
        }
        button:hover { background: #444; }
    </style>
</head>
<body>
    <video id="video" controls autoplay>
        <source src="${videoUri}" type="video/mp4">
        Your browser does not support video playback.
    </video>
    <div class="info">${path.basename(videoPath)}</div>
    <div class="controls">
        <button onclick="document.getElementById('video').playbackRate = 0.5">0.5x</button>
        <button onclick="document.getElementById('video').playbackRate = 1">1x</button>
        <button onclick="document.getElementById('video').playbackRate = 1.5">1.5x</button>
        <button onclick="document.getElementById('video').playbackRate = 2">2x</button>
    </div>
</body>
</html>`;
}

export function deactivate() {
    outputChannel?.dispose();
}
