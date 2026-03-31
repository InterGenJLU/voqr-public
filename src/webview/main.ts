interface VsCodeApi {
    postMessage(msg: { type: string; payload?: unknown }): void;
}

interface ModelInfo {
    id: string;
    name: string;
    vendor: string;
    family: string;
    maxTokens: number;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vsCodeApi = acquireVsCodeApi();

const mainBtn = document.getElementById('main-btn') as HTMLButtonElement;
const mainBtnIcon = document.getElementById('main-btn-icon') as HTMLSpanElement;
const mainLabel = document.getElementById('main-label') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const chatEl = document.getElementById('chat') as HTMLDivElement;
const modelBtn = document.getElementById('model-btn') as HTMLButtonElement;
const modelNameEl = document.getElementById('model-name') as HTMLSpanElement;
const modelDotEl = document.getElementById('model-dot') as HTMLSpanElement;
const modelDropdown = document.getElementById('model-dropdown') as HTMLDivElement;
const modeToggle = document.getElementById('mode-toggle') as HTMLButtonElement;
const modeToggleArea = document.getElementById('mode-toggle-area') as HTMLDivElement;
const modeKnob = document.getElementById('mode-knob') as HTMLSpanElement;
const modeLabelHF = document.getElementById('mode-label-hf') as HTMLLabelElement;
const modeLabelPTT = document.getElementById('mode-label-ptt') as HTMLLabelElement;

let active = false;
let started = false;
let hasModel = false;
let currentAssistantEl: HTMLDivElement | null = null;
let currentModelName = 'AI';
let currentVendor = '';
let dropdownOpen = false;
let currentInputMode = 'pushToTalk';

// ── Known LM provider extensions ─────────────────────────────────────
// ── Provider definitions + setup wizard steps ────────────────────────

interface WizardChoice {
    label: string;
    description: string;
    goToStep: number;
}

interface WizardModel {
    name: string;
    provider: string;
    checked?: boolean;
}

interface SetupStep {
    type: 'install' | 'info' | 'action' | 'wait' | 'done' | 'choice' | 'select';
    title: string;
    description?: string;
    linkUrl?: string;
    linkText?: string;
    choices?: WizardChoice[];
    models?: WizardModel[];
    afterSelect?: number; // step to jump to after model selection
}

interface LMProvider {
    name: string;
    extId: string;
    vendor: string;
    hint: string;
    tier: 'free' | 'paid';
    steps: SetupStep[];
}

// Only extensions that register as VS Code Language Model API providers.
// Excludes walled gardens (Gemini, Continue, Cody) and CLI tools (Claude Code).
const LM_PROVIDERS: LMProvider[] = [
    // ── Free tier available ──
    {
        name: 'GitHub Copilot',
        extId: 'GitHub.copilot-chat',
        vendor: 'copilot',
        hint: 'Sign in with GitHub — 50 free chats/mo',
        tier: 'free',
        steps: [
            { type: 'install', title: 'Installing GitHub Copilot...' },
            { type: 'info', title: 'Sign in to GitHub', description: 'Click "Use AI Features" in the VS Code status bar, then sign in with your GitHub account. The free tier includes 50 chat messages per month.' },
            { type: 'wait', title: 'Waiting for models...' },
            { type: 'done', title: 'You\'re all set!' },
        ],
    },
    {
        name: 'Hugging Face',
        extId: 'HuggingFace.huggingface-vscode-chat',
        vendor: 'huggingface',
        hint: 'Qwen, DeepSeek, open LLMs — free HF account',
        tier: 'free',
        steps: [
            { type: 'install', title: 'Installing Hugging Face provider...' },
            { type: 'action', title: 'Sign in or create an account', description: 'Already have a Hugging Face account? Click Next. Need one? Create a free account below, then click Next.', linkUrl: 'https://huggingface.co/join', linkText: 'Create a free account at huggingface.co' },
            { type: 'action', title: 'Create an access token', description: 'Go to your Hugging Face Settings → Access Tokens → Create new token. Enable the "Inference: Make calls to Inference Providers" permission.', linkUrl: 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained', linkText: 'Create token at huggingface.co' },
            { type: 'info', title: 'Add your token to VS Code', description: 'Open Command Palette (Ctrl+Shift+P) → Type "Manage Hugging Face Provider" → Paste your token in the text box → Press Enter. Then click Next below.' },
            { type: 'wait', title: 'Waiting for models...' },
            { type: 'done', title: 'You\'re all set!' },
        ],
    },
    // ── Cerebras: disabled — extension installs but never activates on Linux (no commands register).
    // Test on Windows before re-enabling. Users can still access Cerebras via OpenAI Compatible.
    // {
    //     name: 'Cerebras',
    //     extId: 'cerebras.cerebras-chat',
    //     vendor: 'cerebras',
    //     hint: 'Blazing fast inference — free API key',
    //     tier: 'free',
    //     steps: [
    //         { type: 'install', title: 'Installing Cerebras provider...' },
    //         { type: 'action', title: 'Sign in or create an account', description: 'Already have a Cerebras Cloud account? Click Next. Need one? Create a free account and grab your API key below, then click Next.', linkUrl: 'https://cloud.cerebras.ai/', linkText: 'Sign up at cloud.cerebras.ai' },
    //         { type: 'info', title: 'Add your API key to VS Code', description: 'Open Command Palette (Ctrl+Shift+P) → Type "Cerebras: Manage API Key" → Paste your API key → Press Enter. Then click Next below.' },
    //         { type: 'wait', title: 'Waiting for models...' },
    //         { type: 'done', title: 'You\'re all set!' },
    //     ],
    // },
    // ── May require paid access ──
    {
        name: 'AI Toolkit',
        extId: 'ms-windows-ai-studio.windows-ai-studio',
        vendor: 'microsoft',
        hint: 'GitHub Models, Foundry, Ollama — 130+ models added automatically',
        tier: 'free',
        steps: [
            { type: 'install', title: 'Installing AI Toolkit...' },
            { type: 'info', title: 'What to expect', description: 'AI Toolkit will register approximately 45 GitHub Models and 87 Foundry Models with VS Code. These include models from OpenAI, Anthropic, Google, Meta, DeepSeek, and others. GitHub Models are free with a GitHub account. Foundry Models may require an Azure account.' },
            { type: 'wait', title: 'Waiting for models...' },
            { type: 'done', title: 'You\'re all set!' },
        ],
    },
    // ── OAI Compatible: disabled — extension has hostile UX (broken auto-install,
    // nightmare config panel, requires user to know endpoint URL + API key + exact model ID).
    // Research needed: can we build our own OpenAI-compatible provider registration
    // that actually serves users? See VOQR session 11 notes.
    // {
    //     name: 'OpenAI Compatible',
    //     extId: 'johnny-zhao.oai-compatible-copilot',
    //     vendor: 'openai',
    //     hint: 'Any OpenAI-compatible endpoint — Ollama, LM Studio, etc.',
    //     tier: 'paid',
    //     steps: [
    //         { type: 'install', title: 'Installing OpenAI Compatible provider...' },
    //         { type: 'info', title: 'Open the configuration UI', description: 'Open Command Palette (Ctrl+Shift+P) → Search "OAICopilot: Open Configuration UI".' },
    //         { type: 'info', title: 'Add a provider and model', description: 'Click "Add Provider" — enter your endpoint URL and API key. Then click "Add Model" — enter the model ID.' },
    //         { type: 'wait', title: 'Waiting for models...' },
    //         { type: 'done', title: 'You\'re all set!' },
    //     ],
    // },
];

// ── Vendor color mapping (inspired-by, not exact brand colors) ───────
const VENDOR_COLORS: Record<string, string> = {
    'copilot': '#9B6DFF',     // soft purple (Copilot-inspired)
    'github': '#9B6DFF',
    'anthropic': '#E08A6D',   // warm coral (Claude-inspired)
    'google': '#5BA3E6',      // soft blue (Gemini-inspired)
    'openai': '#7EBB9B',      // sage green (GPT-inspired)
    'deepseek': '#6B8AFF',    // blue (DeepSeek-inspired)
    'meta': '#7EE8C8',        // mint (Llama-inspired)
    'mistral': '#FF9B45',     // orange (Mistral-inspired)
    'xai': '#888888',         // neutral gray (Grok)
    'cohere': '#FF8B73',      // coral (Cohere-inspired)
};
const DEFAULT_VENDOR_COLOR = '#00BFA5'; // Signal Teal (VOQR brand)

// Well-known models sorted by recognition/popularity — lower = higher priority
const MODEL_PRIORITY: string[] = [
    'deepseek-ai/deepseek-v3',
    'deepseek-ai/deepseek-r1',
    'qwen/qwen3',
    'qwen/qwq',
    'meta-llama/llama-3.3',
    'meta-llama/llama-3.1',
    'meta-llama/llama-4',
    'google/gemma',
    'openai/gpt-oss',
    'qwen/qwen2.5-coder',
    'qwen/qwen2.5',
    'mistral',
    'cohere',
];

/** Extract the model family from a name for dedup in initial view.
 *  "deepseek-ai/DeepSeek-V3.2" → "deepseek"
 *  "Qwen/Qwen3-Coder-30B" → "qwen3"
 *  "meta-llama/Llama-3.3-70B" → "llama"
 *  "GPT-4o mini" → "gpt"
 */
function getModelFamily(name: string): string {
    const lower = name.toLowerCase();
    // Match known family prefixes
    if (lower.includes('deepseek')) { return 'deepseek'; }
    if (lower.includes('qwen') || lower.includes('qwq')) { return 'qwen'; }
    if (lower.includes('llama')) { return 'llama'; }
    if (lower.includes('gemma')) { return 'gemma'; }
    if (lower.includes('glm')) { return 'glm'; }
    if (lower.startsWith('auto')) { return 'auto'; }
    if (lower.includes('gpt')) { return 'gpt'; }
    if (lower.includes('minimax')) { return 'minimax'; }
    if (lower.includes('kimi')) { return 'kimi'; }
    if (lower.includes('cohere') || lower.includes('command')) { return 'cohere'; }
    if (lower.includes('mimo')) { return 'mimo'; }
    // Fallback: use the org/first part of the name
    const slash = lower.indexOf('/');
    if (slash > 0) { return lower.substring(0, slash); }
    return lower.split(/[-_\s]/)[0];
}

function getModelPriority(name: string): number {
    const lower = name.toLowerCase();
    for (let i = 0; i < MODEL_PRIORITY.length; i++) {
        if (lower.includes(MODEL_PRIORITY[i])) {
            return i;
        }
    }
    return MODEL_PRIORITY.length; // Unknown models sort last
}

function getVendorColor(vendor: string): string {
    const key = vendor.toLowerCase();
    for (const [prefix, color] of Object.entries(VENDOR_COLORS)) {
        if (key.includes(prefix)) {
            return color;
        }
    }
    return DEFAULT_VENDOR_COLOR;
}

// ── Main button (Start / Mic / Stop) ─────────────────────────────────

mainBtn.addEventListener('click', () => {
    // Create/resume AudioContext on user gesture — required by autoplay policy
    if (!audioContext) {
        audioContext = new AudioContext();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    if (!started) {
        // First click: start the system
        started = true;
        hideModePrompt();
        // Label stays from now on
        mainLabel.classList.add('active-indicator');
        mainLabel.textContent = currentInputMode === 'voiceActivity'
            ? 'Hands-free enabled' : 'Push to talk enabled';
        // Replace watermark with prompt
        showReadyPrompt();
    }

    vsCodeApi.postMessage({ type: 'toggleCapture' });
});

// ── Toolbar controls (TTS speed, mute, settings) ────────────────────

const ttsMuteBtn = document.getElementById('tts-mute') as HTMLButtonElement;
const ttsMuteIcon = document.getElementById('tts-mute-icon') as HTMLSpanElement;
const ttsSpeedValue = document.getElementById('tts-speed-value') as HTMLSpanElement;
const ttsSpeedDown = document.getElementById('tts-speed-down') as HTMLButtonElement;
const ttsSpeedUp = document.getElementById('tts-speed-up') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

let ttsMuted = false;
let ttsSpeed = 1.0;
let platformId = 'linux'; // updated from syncSettings

/** Return the correct Command Palette shortcut for the current platform. */
function cmdPaletteShortcut(): string {
    return platformId === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';
}

ttsMuteBtn.addEventListener('click', () => {
    ttsMuted = !ttsMuted;
    ttsMuteIcon.textContent = ttsMuted ? '\u{1F507}' : '\u{1F50A}';
    ttsMuteBtn.classList.toggle('muted', ttsMuted);
    vsCodeApi.postMessage({ type: 'setTtsMute', payload: ttsMuted });
});

ttsSpeedDown.addEventListener('click', () => {
    ttsSpeed = Math.max(0.5, Math.round((ttsSpeed - 0.1) * 10) / 10);
    ttsSpeedValue.textContent = `${ttsSpeed.toFixed(1)}x`;
    vsCodeApi.postMessage({ type: 'setTtsSpeed', payload: ttsSpeed });
});

ttsSpeedUp.addEventListener('click', () => {
    ttsSpeed = Math.min(2.0, Math.round((ttsSpeed + 0.1) * 10) / 10);
    ttsSpeedValue.textContent = `${ttsSpeed.toFixed(1)}x`;
    vsCodeApi.postMessage({ type: 'setTtsSpeed', payload: ttsSpeed });
});

settingsBtn.addEventListener('click', () => {
    vsCodeApi.postMessage({ type: 'openSettings' });
});

// ── Input mode toggle ────────────────────────────────────────────────

modeToggle.addEventListener('click', () => {
    vsCodeApi.postMessage({ type: 'toggleInputMode' });
});

function updateModeUI(mode: string): void {
    currentInputMode = mode;

    if (mode === 'voiceActivity') {
        modeKnob.classList.add('on');
        modeLabelHF.classList.add('active');
        modeLabelPTT.classList.remove('active');
    } else {
        modeKnob.classList.remove('on');
        modeLabelHF.classList.remove('active');
        modeLabelPTT.classList.add('active');
    }

    // Update label and button text for current mode
    if (started) {
        mainLabel.textContent = mode === 'voiceActivity' ? 'Hands-free enabled' : 'Push to talk enabled';
        if (!active) {
            mainBtnIcon.textContent = mode === 'voiceActivity' ? 'GO' : 'PTT';
        }
    }
}

function showModePrompt(): void {
    if (document.getElementById('mode-prompt')) {
        return;
    }
    const prompt = document.createElement('div');
    prompt.id = 'mode-prompt';
    prompt.innerHTML = `
        <span class="mode-prompt-arrow">&#x2B05;</span>
        <span class="mode-prompt-text">Select your mode<br>then click GO</span>
    `;
    const header = document.getElementById('header');
    const controlsArea = document.getElementById('controls-area');
    if (header && controlsArea) {
        header.insertBefore(prompt, controlsArea.nextSibling);
    }
}

function hideModePrompt(): void {
    const existing = document.getElementById('mode-prompt');
    if (existing) {
        existing.remove();
    }
}

// ── Model selector dropdown ──────────────────────────────────────────

modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // If dropdown is empty, request a refresh from extension
    if (modelDropdown.children.length === 0) {
        vsCodeApi.postMessage({ type: 'refreshModels' });
    }
    dropdownOpen = !dropdownOpen;
    modelDropdown.classList.toggle('hidden', !dropdownOpen);
});

// Close dropdown when clicking elsewhere
document.addEventListener('click', () => {
    if (dropdownOpen) {
        dropdownOpen = false;
        modelDropdown.classList.add('hidden');
    }
});

let allModelsList: ModelInfo[] = [];
let currentActiveId: string | null = null;

function renderModelList(models: ModelInfo[], activeId: string | null): void {
    allModelsList = models;
    currentActiveId = activeId;
    modelDropdown.innerHTML = '';

    if (models.length === 0) {
        modelNameEl.textContent = 'No model selected';
        modelDotEl.style.backgroundColor = '#888';
        showOnboarding();
        showModelPrompt();
        return;
    }

    hideOnboarding();
    hideModelPrompt();

    if (!activeId) {
        showModelPrompt();
    }

    // Search box
    const searchBox = document.createElement('input');
    searchBox.className = 'model-search';
    searchBox.type = 'text';
    searchBox.placeholder = 'Search models...';
    searchBox.addEventListener('input', () => {
        renderFilteredModels(searchBox.value, models, activeId);
    });
    searchBox.addEventListener('click', (e) => e.stopPropagation());
    modelDropdown.appendChild(searchBox);

    // Render grouped models
    renderFilteredModels('', models, activeId);
}

function renderFilteredModels(query: string, models: ModelInfo[], activeId: string | null): void {
    // Remove everything AFTER the search box
    const searchBox = modelDropdown.querySelector('.model-search');
    while (searchBox && searchBox.nextSibling) {
        searchBox.nextSibling.remove();
    }

    const lowerQuery = query.toLowerCase();
    const filtered = query
        ? models.filter(m => m.name.toLowerCase().includes(lowerQuery) || m.vendor.toLowerCase().includes(lowerQuery))
        : models;

    // Group by vendor
    const grouped = new Map<string, ModelInfo[]>();
    for (const model of filtered) {
        const vendor = model.vendor;
        if (!grouped.has(vendor)) {
            grouped.set(vendor, []);
        }
        grouped.get(vendor)!.push(model);
    }

    const INITIAL_SHOW = 5;

    for (const [vendor, vendorModels] of grouped) {
        // Vendor header — colored per vendor
        const vendorColor = getVendorColor(vendor);
        const header = document.createElement('div');
        header.className = 'dropdown-vendor-header';
        header.dataset.vendor = vendor;
        header.style.color = vendorColor;
        const dot = document.createElement('span');
        dot.className = 'model-dot';
        dot.style.backgroundColor = vendorColor;
        const vendorName = document.createElement('span');
        vendorName.textContent = `${vendor} (${vendorModels.length})`;
        header.appendChild(dot);
        header.appendChild(vendorName);
        modelDropdown.appendChild(header);

        // Sort: active model first, then by popularity, then by maxTokens
        vendorModels.sort((a, b) => {
            if (a.id === activeId) { return -1; }
            if (b.id === activeId) { return 1; }
            const priDiff = getModelPriority(a.name) - getModelPriority(b.name);
            if (priDiff !== 0) { return priDiff; }
            return b.maxTokens - a.maxTokens;
        });

        // For initial view: one model per family, up to INITIAL_SHOW
        const showAll = query.length > 0;
        let initialModels: ModelInfo[];
        if (showAll) {
            initialModels = vendorModels;
        } else {
            const seenFamilies = new Set<string>();
            initialModels = [];
            for (const m of vendorModels) {
                const family = getModelFamily(m.name);
                if (!seenFamilies.has(family)) {
                    seenFamilies.add(family);
                    initialModels.push(m);
                }
                if (initialModels.length >= INITIAL_SHOW) { break; }
            }
        }
        const limit = initialModels.length;

        for (let i = 0; i < limit; i++) {
            modelDropdown.appendChild(createModelOption(initialModels[i], activeId));
        }

        // "Show more" button
        if (!showAll && vendorModels.length > INITIAL_SHOW) {
            const showMore = document.createElement('button');
            showMore.className = 'model-option show-more';
            showMore.textContent = `Show ${vendorModels.length - INITIAL_SHOW} more...`;
            showMore.addEventListener('click', (e) => {
                e.stopPropagation();
                showMore.remove();

                // Find the insertion point: walk forward from this vendor's header
                // to find the next vendor header or divider
                const thisHeader = modelDropdown.querySelector(
                    `.dropdown-vendor-header[data-vendor="${vendor}"]`,
                );
                let insertPoint: Element | null = null;
                if (thisHeader) {
                    let sibling = thisHeader.nextElementSibling;
                    while (sibling) {
                        if (sibling.classList.contains('dropdown-vendor-header') ||
                            sibling.classList.contains('dropdown-divider-thick')) {
                            insertPoint = sibling;
                            break;
                        }
                        sibling = sibling.nextElementSibling;
                    }
                }

                let firstNew: HTMLElement | null = null;
                for (let i = INITIAL_SHOW; i < vendorModels.length; i++) {
                    const opt = createModelOption(vendorModels[i], activeId);
                    if (!firstNew) { firstNew = opt; }
                    if (insertPoint) {
                        modelDropdown.insertBefore(opt, insertPoint);
                    } else {
                        modelDropdown.appendChild(opt);
                    }
                }
                // Scroll so the first new model is visible
                if (firstNew) {
                    firstNew.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            });
            modelDropdown.appendChild(showMore);
        }
    }

    // Add-a-model sections
    const freeProviders = LM_PROVIDERS.filter(p => p.tier === 'free');
    const paidProviders = LM_PROVIDERS.filter(p => p.tier === 'paid');

    const divider = document.createElement('div');
    divider.className = 'dropdown-divider-thick';
    modelDropdown.appendChild(divider);

    const freeHeader = document.createElement('div');
    freeHeader.className = 'dropdown-section-header';
    freeHeader.textContent = '+ Add a model (free)';
    modelDropdown.appendChild(freeHeader);

    let addedAnyFree = false;
    for (const provider of freeProviders) {
        const alreadyInstalled = models.some(m =>
            m.vendor.toLowerCase().includes(provider.vendor)
        );
        if (alreadyInstalled) {
            continue;
        }
        addedAnyFree = true;
        appendProviderOption(provider, modelDropdown);
    }

    if (!addedAnyFree) {
        const allDone = document.createElement('div');
        allDone.className = 'dropdown-section-note';
        allDone.textContent = 'All free providers installed';
        modelDropdown.appendChild(allDone);
    }

    // Paid providers section
    const divider2 = document.createElement('div');
    divider2.className = 'dropdown-divider-thick';
    modelDropdown.appendChild(divider2);

    const paidHeader = document.createElement('div');
    paidHeader.className = 'dropdown-section-header paid';
    paidHeader.textContent = '+ Add a model (may require paid access)';
    modelDropdown.appendChild(paidHeader);

    let addedAnyPaid = false;
    for (const provider of paidProviders) {
        const alreadyInstalled = models.some(m =>
            m.vendor.toLowerCase().includes(provider.vendor)
        );
        if (alreadyInstalled) {
            continue;
        }
        addedAnyPaid = true;
        appendProviderOption(provider, modelDropdown);
    }

    if (!addedAnyPaid) {
        const allDone = document.createElement('div');
        allDone.className = 'dropdown-section-note';
        allDone.textContent = 'All providers installed';
        modelDropdown.appendChild(allDone);
    }
}

function createModelOption(model: ModelInfo, activeId: string | null): HTMLButtonElement {
    const item = document.createElement('button');
    item.className = 'model-option' + (model.id === activeId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'model-dot';
    dot.style.backgroundColor = getVendorColor(model.vendor);

    const textCol = document.createElement('div');
    textCol.className = 'model-option-text';

    const name = document.createElement('span');
    name.className = 'model-option-name';
    name.textContent = getFriendlyModelName(model.name);

    const detail = document.createElement('span');
    detail.className = 'model-option-detail';
    const tokensK = Math.round(model.maxTokens / 1000);
    detail.textContent = `${tokensK}K tokens`;

    textCol.appendChild(name);
    textCol.appendChild(detail);
    item.title = model.name; // raw name on hover
    item.appendChild(dot);
    item.appendChild(textCol);

    item.addEventListener('click', (e) => {
        e.stopPropagation();
        vsCodeApi.postMessage({ type: 'selectModel', payload: model.id });
        dropdownOpen = false;
        modelDropdown.classList.add('hidden');
    });

    return item;
}

function appendProviderOption(provider: LMProvider, container: HTMLElement): void {
    const item = document.createElement('button');
    item.className = 'model-option add-model-option';

    const dot = document.createElement('span');
    dot.className = 'model-dot';
    dot.style.backgroundColor = getVendorColor(provider.vendor);

    const textCol = document.createElement('div');
    textCol.className = 'model-option-text';

    const name = document.createElement('span');
    name.className = 'model-option-name';
    name.textContent = provider.name;

    const detail = document.createElement('span');
    detail.className = 'model-option-detail';
    detail.textContent = provider.hint;

    textCol.appendChild(name);
    textCol.appendChild(detail);

    item.appendChild(dot);
    item.appendChild(textCol);

    item.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownOpen = false;
        modelDropdown.classList.add('hidden');
        startWizard(provider);
    });

    container.appendChild(item);
}

function showWatermark(): void {
    if (chatEl.querySelector('.watermark')) {
        return;
    }
    const wm = document.createElement('div');
    wm.className = 'watermark';
    wm.innerHTML = `
        <div class="wm-waveform">
            <div class="wm-bar wm-h1"></div>
            <div class="wm-bar wm-h2"></div>
            <div class="wm-bar wm-h3"></div>
            <div class="wm-bar wm-h4"></div>
            <div class="wm-bar wm-h5"></div>
            <div class="wm-bar wm-h6"></div>
            <div class="wm-bar wm-h7"></div>
            <div class="wm-bar wm-h8"></div>
            <div class="wm-bar wm-h9"></div>
            <div class="wm-bar wm-h10"></div>
            <div class="wm-bar wm-h11"></div>
            <div class="wm-bar wm-h12"></div>
        </div>
        <div class="wm-logo">VOQR</div>
        <div class="wm-tagline">Voice for AI Chat</div>
    `;
    chatEl.appendChild(wm);
}

function hideWatermark(): void {
    const existing = chatEl.querySelector('.watermark');
    if (existing) {
        existing.remove();
    }
}

function getFriendlyModelName(name: string): string {
    // Strip org prefix: "deepseek-ai/DeepSeek-V3.2" → "DeepSeek-V3.2"
    let friendly = name.includes('/') ? name.split('/').pop()! : name;
    // Strip routing suffixes: "(cheapest)", "(fastest)", "via groq"
    friendly = friendly.replace(/\s*\((?:cheapest|fastest)\)\s*$/i, '');
    friendly = friendly.replace(/\s+via\s+[\w-]+\s*$/i, '');
    // Strip technical suffixes that mean nothing to users
    friendly = friendly.replace(/[-_](?:Instruct|Chat|Base|PT|FP8|IT|BF16)(?:\b|$)/gi, '');
    // Clean up trailing hyphens/underscores/spaces
    friendly = friendly.replace(/[-_\s]+$/, '');
    return friendly || name;
}

function showReadyPrompt(): void {
    hideWatermark();
    hideReadyPrompt();
    const friendlyName = getFriendlyModelName(currentModelName);
    const prompt = document.createElement('div');
    prompt.className = 'ready-prompt';
    prompt.innerHTML = `
        <div class="ready-prompt-text">Go ahead,</div>
        <div class="ready-prompt-text">say <span class="ready-prompt-hi">"hi"</span> to <span class="ready-prompt-model">${friendlyName}</span>...</div>
    `;
    chatEl.appendChild(prompt);
}

function hideReadyPrompt(): void {
    const existing = chatEl.querySelector('.ready-prompt');
    if (existing) {
        existing.remove();
    }
}

// ── Setup Wizard ─────────────────────────────────────────────────────

let activeWizard: { provider: LMProvider; currentStep: number } | null = null;

function startWizard(provider: LMProvider): void {
    activeWizard = { provider, currentStep: 0 };
    hideWatermark();
    hideReadyPrompt();
    hideOnboarding();
    renderWizardStep();
}

function renderWizardStep(): void {
    if (!activeWizard) {
        return;
    }

    const { provider, currentStep } = activeWizard;
    const step = provider.steps[currentStep];

    // Clear previous wizard content
    const existing = chatEl.querySelector('.setup-wizard');
    if (existing) {
        existing.remove();
    }

    const wizard = document.createElement('div');
    wizard.className = 'setup-wizard';

    // Header
    const header = document.createElement('div');
    header.className = 'wizard-header';

    const title = document.createElement('div');
    title.className = 'wizard-title';
    title.textContent = `Setting up ${provider.name}`;

    const progress = document.createElement('div');
    progress.className = 'wizard-progress';
    progress.textContent = `Step ${currentStep + 1} of ${provider.steps.length}`;

    header.appendChild(title);
    header.appendChild(progress);
    wizard.appendChild(header);

    // Progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'wizard-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'wizard-progress-fill';
    progressFill.style.width = `${((currentStep + 1) / provider.steps.length) * 100}%`;
    progressBar.appendChild(progressFill);
    wizard.appendChild(progressBar);

    // Step content
    const content = document.createElement('div');
    content.className = 'wizard-step';

    const stepTitle = document.createElement('div');
    stepTitle.className = 'wizard-step-title';

    // Step type indicator
    const icon = document.createElement('span');
    icon.className = 'wizard-step-icon';
    if (step.type === 'install') {
        icon.textContent = '\u{2B07}'; // download
        stepTitle.classList.add('installing');
    } else if (step.type === 'wait') {
        icon.textContent = '\u{23F3}'; // hourglass
        stepTitle.classList.add('waiting');
    } else if (step.type === 'done') {
        icon.textContent = '\u{2705}'; // checkmark
        stepTitle.classList.add('done');
    } else if (step.type === 'action') {
        icon.textContent = '\u{1F517}'; // link
    } else if (step.type === 'choice') {
        icon.textContent = '\u{1F500}'; // shuffle/branch
    } else if (step.type === 'select') {
        icon.textContent = '\u{2611}'; // checkbox
    } else {
        icon.textContent = '\u{2139}'; // info
    }

    const stepText = document.createElement('span');
    stepText.textContent = step.title;

    stepTitle.appendChild(icon);
    stepTitle.appendChild(stepText);
    content.appendChild(stepTitle);

    if (step.description) {
        const desc = document.createElement('div');
        desc.className = 'wizard-step-desc';
        desc.textContent = step.description.replace(/Ctrl\+Shift\+P/g, cmdPaletteShortcut());
        content.appendChild(desc);
    }

    if (step.linkUrl) {
        const link = document.createElement('button');
        link.className = 'wizard-link';
        link.textContent = step.linkText ?? step.linkUrl;
        link.addEventListener('click', () => {
            vsCodeApi.postMessage({ type: 'openExternal', payload: step.linkUrl });
        });
        content.appendChild(link);
    }

    wizard.appendChild(content);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'wizard-actions';

    if (step.type === 'install') {
        // Auto-trigger install
        vsCodeApi.postMessage({ type: 'wizardInstall', payload: provider.extId });
        // Show spinner state
        const installing = document.createElement('div');
        installing.className = 'wizard-installing';
        installing.textContent = 'Installing...';
        actions.appendChild(installing);
    } else if (step.type === 'wait') {
        const waiting = document.createElement('div');
        waiting.className = 'wizard-waiting';
        waiting.textContent = 'Listening for new models...';
        actions.appendChild(waiting);

        // After 5 seconds, show reload guidance if models haven't appeared
        setTimeout(() => {
            if (!activeWizard || activeWizard.provider.steps[activeWizard.currentStep]?.type !== 'wait') {
                return; // wizard moved on or was cancelled
            }
            waiting.textContent = 'Models not detected yet.';
            const hint = document.createElement('div');
            hint.className = 'wizard-step-desc';
            hint.textContent = 'Some providers need a window reload to register their models.';
            hint.style.marginTop = '8px';
            actions.appendChild(hint);

            const reloadBtn = document.createElement('button');
            reloadBtn.className = 'wizard-btn wizard-btn-primary';
            reloadBtn.textContent = 'Reload Window';
            reloadBtn.style.marginTop = '8px';
            reloadBtn.addEventListener('click', () => {
                const wizardState = activeWizard ? {
                    providerName: activeWizard.provider.name,
                    step: activeWizard.currentStep,
                } : undefined;
                vsCodeApi.postMessage({ type: 'reloadWindow', payload: wizardState });
            });
            actions.appendChild(reloadBtn);
        }, 5000);
    } else if (step.type === 'done') {
        const doneBtn = document.createElement('button');
        doneBtn.className = 'wizard-btn wizard-btn-primary';
        doneBtn.textContent = 'Done — start using VOQR';
        doneBtn.addEventListener('click', () => {
            cancelWizard();
            vsCodeApi.postMessage({ type: 'refreshModels' });
        });
        actions.appendChild(doneBtn);
    } else if (step.type === 'choice' && step.choices) {
        // Render choice cards — clicking one jumps to the target step
        const choiceContainer = document.createElement('div');
        choiceContainer.className = 'wizard-choices';
        for (const choice of step.choices) {
            const card = document.createElement('button');
            card.className = 'wizard-choice-card';
            const cardLabel = document.createElement('div');
            cardLabel.className = 'wizard-choice-label';
            cardLabel.textContent = choice.label;
            const cardDesc = document.createElement('div');
            cardDesc.className = 'wizard-choice-desc';
            cardDesc.textContent = choice.description;
            card.appendChild(cardLabel);
            card.appendChild(cardDesc);
            card.addEventListener('click', () => {
                if (activeWizard) {
                    activeWizard.currentStep = choice.goToStep;
                    renderWizardStep();
                }
            });
            choiceContainer.appendChild(card);
        }
        actions.appendChild(choiceContainer);
    } else if (step.type === 'select' && step.models) {
        // Render model checkboxes with an "Add selected" button
        const selectContainer = document.createElement('div');
        selectContainer.className = 'wizard-model-select';
        const checkboxes: { name: string; provider: string; el: HTMLInputElement }[] = [];
        for (const model of step.models) {
            const row = document.createElement('label');
            row.className = 'wizard-model-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = model.checked ?? false;
            const label = document.createElement('span');
            label.textContent = model.name;
            row.appendChild(cb);
            row.appendChild(label);
            selectContainer.appendChild(row);
            checkboxes.push({ name: model.name, provider: model.provider, el: cb });
        }
        actions.appendChild(selectContainer);

        const addBtn = document.createElement('button');
        addBtn.className = 'wizard-btn wizard-btn-primary';
        addBtn.textContent = 'Add selected models';
        addBtn.addEventListener('click', () => {
            const selected = checkboxes
                .filter(c => c.el.checked)
                .map(c => ({ name: c.name, provider: c.provider }));
            if (selected.length === 0) {
                return; // nothing selected
            }
            vsCodeApi.postMessage({ type: 'wizardWriteAitkModels', payload: selected });
            // Jump to the afterSelect step or just advance
            if (activeWizard && step.afterSelect !== undefined) {
                activeWizard.currentStep = step.afterSelect;
                renderWizardStep();
            } else {
                advanceWizard();
            }
        });
        actions.appendChild(addBtn);
    } else {
        // Info or action step — show Next button
        const nextBtn = document.createElement('button');
        nextBtn.className = 'wizard-btn wizard-btn-primary';
        nextBtn.textContent = 'Next';
        nextBtn.addEventListener('click', () => {
            advanceWizard();
        });
        actions.appendChild(nextBtn);
    }

    // Cancel always available except on done
    if (step.type !== 'done') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'wizard-btn wizard-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            cancelWizard();
        });
        actions.appendChild(cancelBtn);
    }

    wizard.appendChild(actions);
    chatEl.appendChild(wizard);
    scrollToBottom();
}

function advanceWizard(): void {
    if (!activeWizard) {
        return;
    }
    activeWizard.currentStep++;
    if (activeWizard.currentStep >= activeWizard.provider.steps.length) {
        cancelWizard();
        return;
    }
    renderWizardStep();
}

function cancelWizard(): void {
    activeWizard = null;
    const existing = chatEl.querySelector('.setup-wizard');
    if (existing) {
        existing.remove();
    }
    // Show watermark if no messages
    if (!chatEl.querySelector('.chat-message')) {
        showWatermark();
    }
}

function onWizardError(message: string): void {
    if (!activeWizard) {
        return;
    }
    // Show error in the wizard step area
    const stepEl = document.querySelector('.wizard-step-title');
    if (stepEl) {
        stepEl.classList.remove('installing', 'waiting');
        stepEl.classList.add('done'); // reuse red-ish styling below
        stepEl.innerHTML = `<span class="wizard-step-icon">\u{274C}</span><span style="color: var(--error, #d32f2f)">${message}</span>`;
    }
    // Replace actions with cancel-only
    const actions = document.querySelector('.wizard-actions');
    if (actions) {
        actions.innerHTML = '';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'wizard-btn wizard-btn-cancel';
        cancelBtn.textContent = 'Close';
        cancelBtn.addEventListener('click', () => cancelWizard());
        actions.appendChild(cancelBtn);
    }
}

function onExtensionInstalled(): void {
    // Extension installed — advance past install step
    if (activeWizard && activeWizard.provider.steps[activeWizard.currentStep]?.type === 'install') {
        advanceWizard();
    }
}

function onModelsDetected(): void {
    // Models appeared — advance past wait step to done
    if (activeWizard && activeWizard.provider.steps[activeWizard.currentStep]?.type === 'wait') {
        advanceWizard();
    }
}

function showOnboarding(): void {
    if (chatEl.querySelector('.onboarding')) {
        return;
    }
    const onboard = document.createElement('div');
    onboard.className = 'onboarding';

    const title = document.createElement('p');
    title.className = 'onboarding-title';
    title.textContent = 'VOQR needs an AI chat provider';

    const text = document.createElement('p');
    text.className = 'onboarding-text';
    text.textContent = 'Click one to install:';

    const list = document.createElement('div');
    list.className = 'onboarding-list';

    for (const provider of LM_PROVIDERS) {
        const item = document.createElement('button');
        item.className = 'onboarding-item';

        const dot = document.createElement('span');
        dot.className = 'model-dot';
        dot.style.backgroundColor = getVendorColor(provider.vendor);

        const textCol = document.createElement('div');
        textCol.className = 'onboarding-item-text';

        const name = document.createElement('span');
        name.className = 'onboarding-item-name';
        name.textContent = provider.name;

        const hint = document.createElement('span');
        hint.className = 'onboarding-item-hint';
        hint.textContent = provider.hint;

        textCol.appendChild(name);
        textCol.appendChild(hint);

        item.appendChild(dot);
        item.appendChild(textCol);

        item.addEventListener('click', () => {
            startWizard(provider);
        });

        list.appendChild(item);
    }

    onboard.appendChild(title);
    onboard.appendChild(text);
    onboard.appendChild(list);
    chatEl.appendChild(onboard);
}

function hideOnboarding(): void {
    const existing = chatEl.querySelector('.onboarding');
    if (existing) {
        existing.remove();
    }
}

function showModelPrompt(): void {
    // Disable main button until model is selected
    mainBtn.disabled = true;
    mainBtn.classList.add('disabled');
    modeToggleArea.classList.add('hidden');
    mainLabel.textContent = '';

    // Show prompt arrow pointing to the dropdown
    if (document.getElementById('model-prompt')) {
        return;
    }
    const prompt = document.createElement('div');
    prompt.id = 'model-prompt';
    prompt.innerHTML = `
        <span class="model-prompt-text">Select a model to get started</span>
        <span class="model-prompt-arrow">&#x27A1;</span>
    `;
    const header = document.getElementById('header');
    const modelSelector = document.getElementById('model-selector');
    if (header && modelSelector) {
        header.insertBefore(prompt, modelSelector);
    }
}

function hideModelPrompt(): void {
    const existing = document.getElementById('model-prompt');
    if (existing) {
        existing.remove();
    }
}

function enableMain(): void {
    mainBtn.disabled = false;
    mainBtn.classList.remove('disabled');
    mainBtnIcon.textContent = 'GO';
    mainLabel.textContent = '';

    // Show mode toggle and mode prompt
    modeToggleArea.classList.remove('hidden');
    showModePrompt();
}

window.addEventListener('message', (event: MessageEvent<{ type: string; payload?: unknown }>) => {
    const msg = event.data;
    switch (msg.type) {
        case 'status':
            statusEl.textContent = (msg.payload as string) ?? '';
            break;
        case 'speechStart':
            mainBtn.classList.add('speaking');
            break;
        case 'speechEnd':
            mainBtn.classList.remove('speaking');
            break;
        case 'transcription':
            if (msg.payload) {
                appendUserMessage(msg.payload as string);
            }
            break;
        case 'aiChunk':
            if (msg.payload) {
                appendAiChunk(msg.payload as string);
            }
            break;
        case 'aiComplete':
            finalizeAiMessage();
            break;
        case 'aiError':
            appendErrorMessage((msg.payload as string) ?? 'Unknown error');
            break;
        case 'playAudio':
            if (msg.payload) {
                playAudio(msg.payload as string);
            }
            break;
        case 'stopAudio':
            stopAudio();
            break;
        case 'modelInfo': {
            const info = msg.payload as { name: string; vendor: string };
            if (info) {
                currentModelName = getFriendlyModelName(info.name);
                currentVendor = info.vendor;
                modelNameEl.textContent = currentModelName;
                modelBtn.title = info.name; // raw name on hover
                modelDotEl.style.backgroundColor = getVendorColor(info.vendor);
                hasModel = true;
                hideModelPrompt();
                enableMain();
            }
            break;
        }
        case 'modelList': {
            const data = msg.payload as { models: ModelInfo[]; activeId: string | null };
            if (data) {
                renderModelList(data.models, data.activeId);
                // If wizard is waiting for models and we got some, advance
                if (data.models.length > 0) {
                    onModelsDetected();
                }
            }
            break;
        }
        case 'syncSettings': {
            const settings = msg.payload as { speed: number; muted: boolean; platform?: string };
            if (settings) {
                ttsSpeed = settings.speed;
                ttsSpeedValue.textContent = `${ttsSpeed.toFixed(1)}x`;
                ttsMuted = settings.muted;
                ttsMuteIcon.textContent = ttsMuted ? '\u{1F507}' : '\u{1F50A}';
                ttsMuteBtn.classList.toggle('muted', ttsMuted);
                if (settings.platform) { platformId = settings.platform; }
            }
            break;
        }
        case 'extensionInstalled':
            onExtensionInstalled();
            break;
        case 'wizardError':
            onWizardError((msg.payload as string) ?? 'Unknown error');
            break;
        case 'resumeWizard': {
            const resume = msg.payload as { providerName: string; step: number };
            if (resume) {
                const provider = LM_PROVIDERS.find(p => p.name === resume.providerName);
                if (provider) {
                    activeWizard = { provider, currentStep: resume.step };
                    hideWatermark();
                    hideReadyPrompt();
                    hideOnboarding();
                    renderWizardStep();
                }
            }
            break;
        }
        case 'inputModeChanged':
            updateModeUI(msg.payload as string);
            break;
        case 'error':
            statusEl.textContent = (msg.payload as string) ?? 'Error';
            break;
        case 'captureStarted': {
            active = true;
            mainBtn.classList.add('active');
            mainBtn.classList.add('pulse-btn');
            mainLabel.classList.add('active-indicator');
            if (currentInputMode === 'voiceActivity') {
                mainBtnIcon.textContent = '\u{1F50A}'; // speaker
                mainLabel.textContent = 'Hands-free enabled';
            } else {
                mainBtnIcon.textContent = '\u{1F3A4}'; // mic
                mainLabel.textContent = 'Push to talk enabled';
            }
            break;
        }
        case 'captureStopped': {
            active = false;
            mainBtn.classList.remove('active', 'speaking');
            // Keep label visible — only replace, never remove
            if (currentInputMode === 'voiceActivity') {
                mainBtnIcon.textContent = 'GO';
                mainLabel.textContent = 'Hands-free enabled';
            } else {
                mainBtnIcon.textContent = 'PTT';
                mainLabel.textContent = 'Push to talk enabled';
            }
            break;
        }
    }
});

let thinkingEl: HTMLDivElement | null = null;

function appendUserMessage(text: string): void {
    hideWatermark();
    hideReadyPrompt();
    const bubble = document.createElement('div');
    bubble.className = 'chat-message user';

    const label = document.createElement('span');
    label.className = 'chat-label';
    label.textContent = 'You:';

    const content = document.createElement('span');
    content.className = 'chat-text';
    content.textContent = text;

    bubble.appendChild(label);
    bubble.appendChild(content);
    chatEl.appendChild(bubble);

    // Show thinking indicator
    showThinking();
    scrollToBottom();
}

function showThinking(): void {
    removeThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'chat-thinking';

    const dot = document.createElement('span');
    dot.className = 'model-dot';
    dot.style.backgroundColor = getVendorColor(currentVendor);

    const text = document.createElement('span');
    text.textContent = `${currentModelName} is thinking...`;

    thinkingEl.appendChild(dot);
    thinkingEl.appendChild(text);
    chatEl.appendChild(thinkingEl);
}

function removeThinking(): void {
    if (thinkingEl) {
        thinkingEl.remove();
        thinkingEl = null;
    }
}

function appendAiChunk(text: string): void {
    if (!currentAssistantEl) {
        removeThinking();
        currentAssistantEl = document.createElement('div');
        currentAssistantEl.className = 'chat-message assistant';

        // Apply vendor-specific color
        const color = getVendorColor(currentVendor);
        currentAssistantEl.style.backgroundColor = hexToRgba(color, 0.25);
        currentAssistantEl.style.borderColor = hexToRgba(color, 0.45);

        const label = document.createElement('span');
        label.className = 'chat-label';
        label.textContent = `${currentModelName}:`;

        const content = document.createElement('span');
        content.className = 'chat-text';

        currentAssistantEl.appendChild(label);
        currentAssistantEl.appendChild(content);
        chatEl.appendChild(currentAssistantEl);
    }
    const contentEl = currentAssistantEl.querySelector('.chat-text');
    if (contentEl) {
        contentEl.textContent += text;
    }
    scrollToBottom();
}

function finalizeAiMessage(): void {
    currentAssistantEl = null;
}

function appendErrorMessage(text: string): void {
    removeThinking();
    currentAssistantEl = null;
    const bubble = document.createElement('div');
    bubble.className = 'chat-message error';
    bubble.textContent = text;
    chatEl.appendChild(bubble);
    scrollToBottom();
}

let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let nextStartTime = 0; // Web Audio scheduled time for next buffer

async function playAudio(dataUri: string): Promise<void> {
    vsCodeApi.postMessage({ type: 'log', payload: `playAudio called, dataUri length: ${dataUri.length}` });

    try {
        if (!audioContext) {
            audioContext = new AudioContext();
            nextStartTime = 0;
            vsCodeApi.postMessage({ type: 'log', payload: `AudioContext created, state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate}` });
        }

        // Resume context if suspended (autoplay policy)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
            nextStartTime = 0;
            vsCodeApi.postMessage({ type: 'log', payload: `AudioContext resumed, state: ${audioContext.state}` });
        }

        // Decode base64 data URI to ArrayBuffer
        const base64 = dataUri.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        vsCodeApi.postMessage({ type: 'log', payload: `Decoded ${bytes.length} bytes of audio` });

        const audioBuffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
        vsCodeApi.postMessage({ type: 'log', payload: `AudioBuffer: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch` });

        // Diagnostic logging
        const samples = audioBuffer.getChannelData(0);
        const contextRate = audioContext.sampleRate;
        const bufferRate = audioBuffer.sampleRate;
        const resampled = contextRate !== bufferRate;
        vsCodeApi.postMessage({ type: 'log', payload: `AudioDiag: contextRate=${contextRate} bufferRate=${bufferRate} resampled=${resampled} samples=${samples.length}` });

        // Schedule playback precisely — no gap between sentences
        const now = audioContext.currentTime;
        const startAt = Math.max(now, nextStartTime);
        nextStartTime = startAt + audioBuffer.duration;

        currentSource = audioContext.createBufferSource();
        currentSource.buffer = audioBuffer;
        currentSource.connect(audioContext.destination);
        currentSource.start(startAt);
        currentSource.onended = () => {
            currentSource = null;
            vsCodeApi.postMessage({ type: 'log', payload: 'Audio playback ended' });
        };
        vsCodeApi.postMessage({ type: 'log', payload: `Audio scheduled: startAt=${startAt.toFixed(3)} duration=${audioBuffer.duration.toFixed(3)} nextStart=${nextStartTime.toFixed(3)}` });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vsCodeApi.postMessage({ type: 'audioPlaybackFailed', payload: msg });
    }
}

function stopAudio(): void {
    if (currentSource) {
        try { currentSource.stop(); } catch { /* already stopped */ }
        currentSource = null;
    }
    nextStartTime = 0;
}

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function scrollToBottom(): void {
    chatEl.scrollTop = chatEl.scrollHeight;
}

// ── Initialize ───────────────────────────────────────────────────────
showWatermark();
