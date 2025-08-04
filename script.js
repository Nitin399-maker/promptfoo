import { WebContainer } from "https://cdn.jsdelivr.net/npm/@webcontainer/api@1.5.3/+esm";
let webcontainerInstance;
let isContainerInitialized = false;
let configContent = null;
const elements = {
    configFile: document.getElementById('configFile'),
    runButton: document.getElementById('runEval'),
    clearButton: document.getElementById('clearOutput'),
    resetButton: document.getElementById('resetContainer'),
    logsDiv: document.getElementById('logs'),
    outputDiv: document.getElementById('output'),
    downloadButton: document.getElementById('downloadResults')
};

function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    elements.logsDiv.innerHTML += `[${timestamp}] ${message}\n`;
    elements.logsDiv.scrollTop = elements.logsDiv.scrollHeight;
}

function enableDownloadButton(jsonContent, fileName = 'results.json') {
    elements.downloadButton.disabled = false;
    elements.downloadButton.onclick = () => {
        const blob = new Blob([jsonContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
    };
}

async function readProcessOutput(process, logPrefix = '') {
    let capturedOutput = '';
    if (!process.output) { return capturedOutput; }
    const reader = process.output.getReader();
    const readOutput = async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                let text = '';
                try {
                    if (typeof value === 'string') {
                        text = value;
                    } else if (value instanceof Uint8Array) {
                        text = new TextDecoder('utf-8', { fatal: false }).decode(value);
                    } else if (value && typeof value.toString === 'function') {
                        text = value.toString();
                    }
                    if (text) {
                        capturedOutput += text;
                        const lines = text.split('\n').filter(line => line.trim());
                        lines.forEach(line => {
                            if (line.trim() && logPrefix) {
                                log(`${logPrefix}: ${line.trim()}`);
                            }
                        });
                    }
                } catch (decodeError) {
                    log(`⚠️ Decode warning: ${decodeError.message}`);
                    if (value && value.length) {
                        try {
                            text = String.fromCharCode.apply(null, Array.from(value).filter(code => code < 128 && code > 31));
                            if (text.trim()) {
                                capturedOutput += text;
                                if (logPrefix) log(`${logPrefix}: ${text.trim()}`);
                            }
                        } catch (e) {
                        }
                    }
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {log(`⚠️ Stream read error: ${e.message}`);}
        }
    };
    
    try {
        await Promise.race([
            readOutput(),
            process.exit.then(() => {
                return new Promise(resolve => setTimeout(resolve, 1000));
            })
        ]);
    } catch (e) { log(`⚠️ Output reading error: ${e.message}`);
    } finally {
        try { reader.releaseLock(); } catch (e) {}
    }
    return capturedOutput;
}

async function initWebContainer() {
    if (isContainerInitialized && webcontainerInstance) { return webcontainerInstance; }
    const wc = await WebContainer.boot();
    log('✅ WebContainer booted');
    const envConfig = `NO_TELEMETRY=1
                        PROMPTFOO_DISABLE_TELEMETRY=1
                        PROMPTFOO_NO_TELEMETRY=true
                        DO_NOT_TRACK=1
                        CI=true
                        PROMPTFOO_DISABLE_UPDATE=1
                        PROMPTFOO_DISABLE_DATABASE=1`;
    await wc.fs.writeFile('.env', envConfig);
    log('✅ Environment configured');
    const packageJson = {
        name: 'promptfoo-runner', version: '1.0.0',
        private: true, dependencies: { 'promptfoo': '^0.67.0' }
    };
    await wc.fs.writeFile('package.json', JSON.stringify(packageJson, null, 2));
    log('✅ package.json created');
    log('📦 Installing promptfoo...');
    const installProcess = await wc.spawn('npm', ['install'], {
        env: { PROMPTFOO_DISABLE_TELEMETRY: '1', CI: 'true',PROMPTFOO_DISABLE_UPDATE:'1' }
    });
    const exitCode = await installProcess.exit;
    if (exitCode !== 0) { throw new Error(`npm install failed with exit code ${exitCode}`);}
    log('✅ promptfoo installed successfully');
    webcontainerInstance = wc;
    isContainerInitialized = true;
    elements.resetButton.disabled = false;
    return wc;
}

async function cleanupPreviousRun(wc) {
    log('🧹 Cleaning up previous files...');
    try {
        const files = await wc.fs.readdir('.');
        const filesToDelete = files.filter(f => 
            f.includes('result') || f.includes('output') || f.includes('eval') ||
            (f.endsWith('.json') && !f.includes('package'))
        );
        await Promise.all(filesToDelete.map(async file => {
            try {
                await wc.fs.unlink(file);
                log(`🗑️ Deleted: ${file}`);
            } catch (e) {}
        }));
        log('✅ Cleanup completed');
    } catch (e) {
        log(`⚠️ Cleanup warning: ${e.message}`);
    }
}

function parseEvaluationResults(capturedOutput) {
    log('🔍 Parsing evaluation results...');
    const results = {
        version: "promptfoo-webcontainer",
        timestamp: new Date().toISOString(),
        results: []
    };
    const lines = capturedOutput.split('\n');
    let currentTest = null;
    for (const line of lines) {
        if (line.includes('Calling OpenAI API:')) {
            try {
                const apiCall = JSON.parse(line.split('Calling OpenAI API: ')[1]);
                currentTest = {
                    prompt: apiCall.messages?.[0]?.content || apiCall.prompt || '',
                    provider: 'openai',
                    model: apiCall.model,
                    request: apiCall
                };
            } catch (e) {
                log(`⚠️ Could not parse API call: ${e.message}`);
            }
        }
        
        if (line.includes('API response:') && currentTest) {
            try {
                const response = JSON.parse(line.split('API response: ')[1]);
                currentTest.response = response;
                currentTest.output = response.choices?.[0]?.message?.content || 
                                    response.choices?.[0]?.text || 'No output found';
                currentTest.usage = response.usage || {};
                results.results.push(currentTest);
                log(`📝 Parsed test result`);
            } catch (e) {
                log(`⚠️ Could not parse API response: ${e.message}`);
            }
        }
    }
    
    results.stats = {
        totalTests: results.results.length,
        totalTokens: results.results.reduce((sum, r) => sum + (r.usage?.total_tokens || 0), 0)
    };
    log(`✅ Parsed ${results.results.length} test results`);
    return results;
}

async function runPromptfooEvaluation(wc, configContent) {
    await cleanupPreviousRun(wc);
    log('📝 Writing config file...');
    await wc.fs.writeFile('promptfooconfig.yaml', configContent);
    log('⚡ Running promptfoo eval...');
    const evalProcess = await wc.spawn('npx', ['promptfoo', 'eval', '--verbose', '--no-cache', '--no-write', '--output', 'result.json'], {
        env: {
            PROMPTFOO_DISABLE_TELEMETRY: '1',
            CI: 'true',
            PROMPTFOO_DISABLE_DATABASE: '1',
            PROMPTFOO_DISABLE_UPDATE: '1'
        }
    });
    const [capturedOutput, exitCode] = await Promise.all([
        readProcessOutput(evalProcess),
        evalProcess.exit
    ]);
    log(`📊 Evaluation finished with exit code: ${exitCode}`);
    const hasResults = capturedOutput.includes('API response:') || capturedOutput.includes('Eval #');
    const isDbError = capturedOutput.includes('better-sqlite3') || capturedOutput.includes('database migrations');
    const actualSuccess = hasResults;
    let exportResults = '';
    if (actualSuccess) {
        try {
            const resultContent = await wc.fs.readFile('result.json', { encoding: 'utf-8' });
            exportResults = `\n\n=== RESULTS ===\n${resultContent}`;
            enableDownloadButton(resultContent, 'result.json');
            log('✅ Successfully read result.json');
        } catch (e) {
            log('⚠️ Generating results from output...');
            const generatedResults = parseEvaluationResults(capturedOutput);
            const generatedJson = JSON.stringify(generatedResults, null, 2);
            try {
                await wc.fs.writeFile('result-generated.json', generatedJson);
                enableDownloadButton(generatedJson, 'result-generated.json');
            } catch (e) {}
            exportResults = `\n\n=== GENERATED RESULTS ===\n${generatedJson}`;
        }
    }
    
    let errorDetails = '';
    if (!hasResults && !configContent.includes('prompts:')) {
        errorDetails = `\n\n🔧 CONFIGURATION ERROR:
                            Your config is missing the "prompts:" section.
                            Required structure:
                            - providers: (your provider config)
                            - prompts: (your prompts)
                            - tests: (your test cases)`;
                        }
    const status = actualSuccess ? 'SUCCESS' : 'FAILED';
    const dbNote = isDbError && hasResults ? '\n⚠️ Note: Database save failed but evaluation completed successfully.\n' : '';
    return `PROMPTFOO EVALUATION RESULTS
====================================
Status: ${status}
Exit Code: ${exitCode}
Timestamp: ${new Date().toISOString()}${dbNote}
Console Output:
${capturedOutput || 'No output captured'}${errorDetails}${exportResults}
====================================`;
}

elements.configFile.addEventListener('change', async (event) => {
    const file = event.target.files[0];
        configContent = await file.text();
        elements.runButton.disabled = false;
        log(`✅ Config file loaded: ${file.name}`);
});

elements.runButton.addEventListener('click', async () => {
    if (!configContent) {
        log('❌ No config file loaded');
        return;
    }
    try {
        elements.runButton.disabled = true;
        elements.runButton.textContent = 'Running...';
        elements.outputDiv.textContent = 'Initializing...';
        if (!isContainerInitialized) { webcontainerInstance = await initWebContainer();}
        else { log('🔄 Using existing WebContainer instance');  }
        const result = await runPromptfooEvaluation(webcontainerInstance, configContent);
        elements.outputDiv.textContent = result;
        log('🎉 Evaluation completed!');
    } catch (error) {
        log(`❌ Error: ${error.message}`);
        elements.outputDiv.textContent = `Error: ${error.message}\n\nCheck logs for details.`;
        console.error('Full error:', error);
    } finally {
        elements.runButton.disabled = false;
        elements.runButton.textContent = 'Run Promptfoo Evaluation';
    }
});

elements.resetButton.addEventListener('click', async () => {
    try {
        elements.resetButton.disabled = true;
        elements.resetButton.textContent = 'Resetting...';
        log('🔄 Resetting WebContainer...');
        webcontainerInstance = null;
        isContainerInitialized = false;
        elements.resetButton.disabled = true;
        log('✅ Container reset');
    } catch (error) {
        log(`❌ Reset error: ${error.message}`);
    } finally {
        elements.resetButton.textContent = 'Reset Container';
    }
});

elements.clearButton.addEventListener('click', () => {
    elements.logsDiv.innerHTML = '';
    elements.outputDiv.textContent = '';
    elements.downloadButton.disabled = true;
    log('🧹 Output cleared');
});

elements.resetButton.disabled = true;
if (!crossOriginIsolated) { log('❌ WebContainer requires Cross-Origin Isolation headers'); }
else { log('✅ WebContainer environment ready'); }