    import { openaiConfig } from "https://cdn.jsdelivr.net/npm/bootstrap-llm-provider@1.2";
    import { WebContainer } from "https://cdn.jsdelivr.net/npm/@webcontainer/api@1.5.3/+esm";
    let providerConfig = null;
    let models = [];
    let configContent = null;
    let webcontainerInstance;
    let isContainerInitialized = false;
    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);
    const clone = id => document.getElementById(id).content.cloneNode(true);

    document.querySelectorAll('input[name="mode"]').forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.value === 'create') {
                $('createSection').style.display = 'block';
                $('uploadSection').style.display = 'none';
            } else {
                $('createSection').style.display = 'none';
                $('uploadSection').style.display = 'block';
            }
        });
    });

    $('configureProvider').onclick = handleProvider;
    $('addProvider').onclick = () => addItem('provider');
    $('addPrompt').onclick = () => addItem('prompt');
    $('addTestCase').onclick = () => addItem('testCase');
    $('createYaml').onclick = createYaml;
    $('configFile').addEventListener('change', handleFileUpload);
    $('runEval').addEventListener('click', runEvaluation);
    $('clearOutput').addEventListener('click', clearOutput);
    $('resetContainer').addEventListener('click', resetContainer);

    async function handleProvider(showConfig = false) {
        try {
            const config = await openaiConfig({
                defaultBaseUrls: ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://localhost:11434/v1"],
                show: showConfig
            });
            if (!config?.models?.length) throw new Error('No models found');
            providerConfig = config;
            models = config.models;
            $('providerStatus').innerHTML = `<div class="alert alert-success">${showConfig ? 'Configured' : 'Auto-loaded'}: ${config.baseUrl} (${config.models.length} models)</div>`;
            $('providersSection').style.display = 'block';
            if (showConfig) $('providersContainer').innerHTML = '';
            addItem('provider');
            log(`✅ Provider ${showConfig ? 'configured' : 'auto-loaded'}: ${config.baseUrl}`);
        } catch (error) {
            $('providerStatus').innerHTML = `<div class="alert alert-${showConfig ? 'danger' : 'info'}">${
                showConfig ? `Failed: ${error.message}` : 'No saved configuration found. Click "Configure LLM Provider" to set up.'
            }</div>`;
        }
    }

    function addItem(type) {
        const container = $(`${type}sContainer`);
        const element = clone(`${type}Template`);
        if (type === 'provider') {
            const select = element.querySelector('.provider-model');
            select.innerHTML = '<option value="">Select model...</option>' +
                models.map(m => `<option value="${getModelId(m)}">${m}</option>`).join('');
        }
        if (type === 'testCase') {
            element.querySelector('.add-assertion').onclick = function() {
                addAssertion(this.parentNode.querySelector('.assertions-container'));
            };
            addAssertion(element.querySelector('.assertions-container'));
        }
        element.querySelector('.remove-btn').onclick = function() {
            this.closest('.item-container, .mb-3').remove();
        };
        container.appendChild(element);
    }

    function addAssertion(container) {
        const element = clone('assertionTemplate');
        element.querySelector('.remove-btn').onclick = function() {
            this.closest('.item-container').remove();
        };
        container.appendChild(element);
    }

    function getModelId(model) {
        const baseUrl = providerConfig.baseUrl;
        if (baseUrl.includes('openrouter')) return `openrouter:${model}`;
        if (baseUrl.includes('localhost')) return `ollama:${model}`;
        return `openai:${model}`;
    }

    function createYaml() {
        const prompts = Array.from($$('.prompt-input')).map(i => i.value.trim()).filter(p => p);
        const providers = Array.from($$('.provider-item, .item-container')).map(p => {
            const model = p.querySelector('.provider-model')?.value;
            const maxTokens = p.querySelector('.provider-max-tokens')?.value;
            return model ? { id: model, config: { apiKey: providerConfig?.apiKey, max_tokens: parseInt(maxTokens) } } : null;
        }).filter(p => p);
        let yaml = 'prompts:\n' + prompts.map(p => `  - |\n    ${p.replace(/\n/g, '\n    ')}`).join('\n') + '\n\n';
        
        yaml += 'providers:\n' + providers.map(p =>
            `  - id: "${p.id}"\n    config:\n${p.config.apiKey ? `      apiKey: "${p.config.apiKey}"\n` : ''}      max_tokens: ${p.config.max_tokens}`
        ).join('\n') + '\n\n';
        yaml += 'tests:\n' + Array.from($$('.item-container')).filter(tc => tc.querySelector('.test-vars')).map(tc => {
            const vars = tc.querySelector('.test-vars').value.trim().split('\n').filter(l => l.includes('='));
            const assertions = Array.from(tc.querySelectorAll('.assertion-type')).map(a => {
                const parent = a.closest('.item-container');
                return {
                    type: a.value,
                    value: parent.querySelector('.assertion-value').value,
                    weight: parent.querySelector('.assertion-weight').value,
                    metric: parent.querySelector('.assertion-metric').value
                };
            });
            let testYaml = '  - vars:\n';
            vars.forEach(v => {
                const [key, ...val] = v.split('=');
                testYaml += `      ${key.trim()}: ${val.join('=').trim()}\n`;
            });
            testYaml += '    assert:\n';
            assertions.forEach(a => {
                testYaml += `      - type: ${a.type}\n`;
                if (a.value) testYaml += `        value: "${a.value}"\n`;
                if (a.weight && a.weight !== '1') testYaml += `        weight: ${a.weight}\n`;
                if (a.metric) testYaml += `        metric: ${a.metric}\n`;
            });
            return testYaml;
        }).join('');
        configContent = yaml;
        $('yamlOutput').textContent = yaml;
        $('yamlCard').style.display = 'block';
        $('executionSection').style.display = 'block';
        $('runEval').disabled = false;
    }

    async function handleFileUpload(event) {
        const file = event.target.files[0];
        if (file) {
            configContent = await file.text();
            $('executionSection').style.display = 'block';
            $('runEval').disabled = false;
            log(`✅ Config file loaded: ${file.name}`);
        }
    }

    function log(message) {
        const timestamp = new Date().toLocaleTimeString();
        $('logs').innerHTML += `[${timestamp}] ${message}\n`;
        $('logs').scrollTop = $('logs').scrollHeight;
    }

    function enableDownloadButton(jsonContent, fileName = 'results.json') {
        $('downloadResults').disabled = false;
        $('downloadResults').onclick = () => {
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
            await Promise.race([ readOutput(),
                process.exit.then(() => { return new Promise(resolve => setTimeout(resolve, 1000)); })
            ]);
        } catch (e) { log(`⚠️ Output reading error: ${e.message}`);
        } finally { try { reader.releaseLock(); } catch (e) {}  }
        return capturedOutput;
    }

    async function initWebContainer() {
        if (isContainerInitialized && webcontainerInstance) { return webcontainerInstance; }
        const wc = await WebContainer.boot();
        log('✅ WebContainer booted');
        const envConfig = `PROMPTFOO_DISABLE_TELEMETRY=1
                            DO_NOT_TRACK=1
                            CI=true
                            PROMPTFOO_DISABLE_UPDATE=1`;
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
        $('resetContainer').disabled = false;
        return wc;
    }

    function parseEvaluationResults(capturedOutput) {
        log('🔍 Parsing evaluation results...');
        const results = {
            version: "promptfoo-webcontainer",
            timestamp: new Date().toISOString(),
            results: []
        };
        const lines = capturedOutput.split('\n');
        const apiCalls = [];
        let evalCounter = 1;
        for (const line of lines) {
            if (line.includes('Calling OpenAI API:')) {
                try {
                    const apiCall = JSON.parse(line.split('Calling OpenAI API: ')[1]);
                    const evalName = `Eval #${evalCounter}`;
                    apiCalls.push({
                        evalId: evalName,
                        prompt: apiCall.messages?.[0]?.content || apiCall.prompt || '',
                        provider: 'openai',
                        model: apiCall.model,
                        request: apiCall
                    });
                    log(`📤 ${evalName}: ${apiCall.messages?.[0]?.content?.substring(0, 50)}...`);
                    evalCounter++;
                } catch (e) {
                    log(`⚠️ Could not parse API call: ${e.message}`);
                }
            }
        }
        
        let currentResponse = null;
        let responseBuffer = '';
        let isCapturingResponse = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('OpenAI chat completions API response:')) {
                try {
                    const responseJson = line.split('OpenAI chat completions API response: ')[1];
                    currentResponse = JSON.parse(responseJson);
                    isCapturingResponse = true;
                    log(`📥 Found API response: ${currentResponse.id}`);
                } catch (e) {
                    log(`⚠️ Could not parse API response: ${e.message}`);
                    isCapturingResponse = false;
                }
            }
            if (line.includes('complete (') && line.includes('of') && currentResponse && isCapturingResponse) {
                const evalMatch = line.match(/Eval #(\d+) complete/);
                if (evalMatch) {
                    const evalNumber = parseInt(evalMatch[1]);
                    const evalId = `Eval #${evalNumber}`;
                    const matchingCall = apiCalls.find(call => call.evalId === evalId);              
                    if (matchingCall) {
                        const test = {
                            evalId: evalId,
                            ...matchingCall,
                            response: currentResponse,
                            output: currentResponse.choices?.[0]?.message?.content ||
                                   currentResponse.choices?.[0]?.text || 'No output found',
                            usage: currentResponse.usage || {}
                        };                        
                        results.results.push(test);
                        log(`✅ Matched ${evalId} with response ${currentResponse.id}`);
                        log(`   Prompt: ${test.prompt.substring(0, 60)}...`);
                        log(`   Response: ${test.output.substring(0, 60)}...`);
                    } else {
                        log(`⚠️ Could not find API call for ${evalId}`);
                    }
                    currentResponse = null;
                    isCapturingResponse = false;
                }
            }
        }
        results.results.sort((a, b) => {
            const aNum = parseInt(a.evalId.split('#')[1]);
            const bNum = parseInt(b.evalId.split('#')[1]);
            return aNum - bNum;
        });
        results.stats = {
            totalTests: results.results.length,
            totalTokens: results.results.reduce((sum, r) => sum + (r.usage?.total_tokens || 0), 0)
        };
        log(`🎯 Successfully parsed ${results.results.length} test results using completion markers`);
        return results;
    }

    async function runPromptfooEvaluation(wc, configContent) {
        log('📝 Writing config file...');
        await wc.fs.writeFile('promptfooconfig.yaml', configContent);
        log('⚡ Running promptfoo eval...');
        const evalProcess = await wc.spawn('npx', ['promptfoo', 'eval', '--verbose', '--no-cache', '--no-write'], {
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
        const actualSuccess = hasResults;
        let exportResults = '';
        if (actualSuccess) {
            log('⚠️ Generating results from output...');
            const generatedResults = parseEvaluationResults(capturedOutput);
            const generatedJson = JSON.stringify(generatedResults, null, 2);
            enableDownloadButton(generatedJson, 'result-generated.json');
            exportResults = `\n\n=== GENERATED RESULTS ===\n${generatedJson}`;
        }
        const status = actualSuccess ? 'SUCCESS' : 'FAILED';
        return `PROMPTFOO EVALUATION RESULTS
====================================
Status: ${status}
Exit Code: ${exitCode}
Timestamp: ${new Date().toISOString()}
Console Output:
${capturedOutput || 'No output captured'}${exportResults}
====================================`;
    }
    async function runEvaluation() {
        if (!configContent) {    log('❌ No config content available'); return;  }
        try {
            $('runEval').disabled = true;
            $('runEval').textContent = 'Running...';
            $('output').textContent = 'Initializing...';
            if (!isContainerInitialized) {
                webcontainerInstance = await initWebContainer();
            } else {
                log('🔄 Using existing WebContainer instance');
            }
            const result = await runPromptfooEvaluation(webcontainerInstance, configContent);
            $('output').textContent = result;
            log('🎉 Evaluation completed!');
        } catch (error) {
            log(`❌ Error: ${error.message}`);
            $('output').textContent = `Error: ${error.message}\n\nCheck logs for details.`;
            console.error('Full error:', error);
        } finally {
            $('runEval').disabled = false;
            $('runEval').textContent = 'Run Evaluation';
        }
    }

    function clearOutput() {
        $('logs').innerHTML = '';
        $('output').textContent = '';
        $('downloadResults').disabled = true;
        log('🧹 Output cleared');
    }

    async function resetContainer() {
        try {
            $('resetContainer').disabled = true;
            $('resetContainer').textContent = 'Resetting...';
            log('🔄 Resetting WebContainer...');
            webcontainerInstance = null;
            isContainerInitialized = false;
            log('✅ Container reset');
        } catch (error) {
            log(`❌ Reset error: ${error.message}`);
        } finally {
            $('resetContainer').textContent = 'Reset Container';
            $('resetContainer').disabled = true;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        addItem('testCase');
        handleProvider(); 
        if (!crossOriginIsolated) { log('❌ WebContainer requires Cross-Origin Isolation headers'); }
        else { log('✅ WebContainer environment ready');}
    });