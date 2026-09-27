const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_PROMPT = `You are a QA test-case generator. Given a user story and its acceptance criteria, generate comprehensive test cases.

Rules:
- Generate 8 to 12 test cases, with at least 2 of each type
- Cover happy path, negative cases, and edge cases (boundaries, empty/invalid input, limits, timing)
- "type" must be exactly one of: "Happy Path", "Negative", "Edge Case"
- Every acceptance criterion must map to at least one test case
- Test Case ID format: TC-[StoryID]-[two-digit number]
- "steps" must be an array of strings
- "coverage" lists every acceptance criterion from the story, verbatim, with the IDs of the test cases that verify it
- Do not read, create or edit any files; answer directly
- Return ONLY valid JSON, no other text, no markdown

Output JSON format:
{
  "testCases": [
    {
      "testCaseId": "TC-001-01",
      "scenario": "short description",
      "type": "Happy Path",
      "preconditions": "...",
      "steps": ["step 1", "step 2"],
      "testData": "...",
      "expectedResult": "...",
      "storyId": "001"
    }
  ],
  "coverage": [
    { "criterion": "valid credentials grant access", "testCaseIds": ["TC-001-01"] }
  ]
}`;

const BOB_TIMEOUT_MS = 120_000;

// Treat unset values and the "your_..." placeholders from .env.example as missing.
function env(name) {
  const value = (process.env[name] || '').trim();
  return value && !value.startsWith('your_') ? value : undefined;
}

function bobConfigured() {
  return Boolean(env('BOB_API_KEY'));
}

function watsonxConfigured() {
  return Boolean(env('WATSONX_API_KEY') && env('WATSONX_PROJECT_ID'));
}

// Bob runs in an empty scratch folder so it has no project files to read or modify.
const BOB_WORKSPACE = path.join(os.tmpdir(), 'test-case-generator-bob');
fs.mkdirSync(BOB_WORKSPACE, { recursive: true });

// Bob Shell's JSON output puts the answer in `last_message`; accept a string or a message object.
function extractBobText(stdout) {
  const output = parseJson(stdout);
  if (output.status && output.status !== 'success' && output.status !== 'completed') {
    throw new Error(`Bob Shell finished with status "${output.status}"`);
  }
  const message = output.last_message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    if (typeof message.content === 'string') return message.content;
    if (typeof message.text === 'string') return message.text;
    if (Array.isArray(message.content)) {
      return message.content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
    }
  }
  throw new Error('Bob Shell output had no last_message');
}

// Run `bob run --format json` with the prompt on stdin and return Bob's final answer.
function callBob(userStory) {
  const command = env('BOB_COMMAND') || 'bob';
  const args = ['run', '--format', 'json', '--mode', env('BOB_MODE') || 'ask', '--disable-mcp',
    '--disable-subagents', '--log-level', 'silent', '--trust', '--workspace', `"${BOB_WORKSPACE}"`];
  if (env('BOB_MAX_COST')) args.push('--max-cost', env('BOB_MAX_COST'));
  // Headless runs can't answer the license prompt; the operator opts in explicitly.
  if (env('BOB_ACCEPT_LICENSE') === 'true') args.push('--accept-license');

  return new Promise((resolve, reject) => {
    // Run through the shell so Windows can resolve bob.cmd / bob.ps1 shims. Every part of the
    // command line is a fixed string or config value; the user story only goes in via stdin.
    const commandLine = [command.includes(' ') ? `"${command}"` : command, ...args].join(' ');
    const child = spawn(commandLine, { shell: true, env: { ...process.env, NODE_NO_WARNINGS: '1' }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Bob Shell timed out after ${BOB_TIMEOUT_MS / 1000}s`));
    }, BOB_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Could not start Bob Shell (${command}): ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Bob Shell exited with code ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      }
      try {
        resolve(extractBobText(stdout));
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.end(`${SYSTEM_PROMPT}\n\nUser story:\n${userStory}\n`);
  });
}

// ---------- IBM watsonx.ai (first backup when Bob fails, e.g. out of bobcoins) ----------

const WATSONX_TIMEOUT_MS = 90_000;

let iamToken = null;
let iamTokenExpiresAt = 0;

// Exchange the IBM Cloud API key for a short-lived IAM bearer token, cached until near expiry.
async function getIamToken() {
  if (iamToken && Date.now() < iamTokenExpiresAt - 60_000) return iamToken;
  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: env('WATSONX_API_KEY')
    }),
    signal: AbortSignal.timeout(WATSONX_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`IBM IAM token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  iamToken = data.access_token;
  iamTokenExpiresAt = data.expiration * 1000;
  return iamToken;
}

async function callWatsonx(userStory) {
  const baseUrl = env('WATSONX_URL') || 'https://us-south.ml.cloud.ibm.com';
  const res = await fetch(`${baseUrl}/ml/v1/text/chat?version=2024-05-31`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getIamToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model_id: watsonxModel(),
      project_id: env('WATSONX_PROJECT_ID'),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userStory }
      ],
      temperature: 0.3,
      max_tokens: 4000
    }),
    signal: AbortSignal.timeout(WATSONX_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`watsonx.ai request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function watsonxModel() {
  return env('WATSONX_MODEL_ID') || 'ibm/granite-4-h-small';
}

// ---------- Groq (backup) ----------

const HTTP_TIMEOUT_MS = 90_000;

function groqModel() {
  return env('GROQ_MODEL') || 'openai/gpt-oss-120b';
}

async function callGroq(userStory) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('GROQ_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: groqModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userStory }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Groq request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ---------- Google Gemini (backup) ----------

// GEMINI_MODEL may list several models; later ones are tried when Google reports the earlier ones as overloaded.
function geminiModels() {
  return (env('GEMINI_MODEL') || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
}

async function callGemini(userStory) {
  let lastError;
  for (const model of geminiModels()) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userStory }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return { content: parts.map(p => p.text ?? '').join(''), model };
    }
    lastError = new Error(`Gemini ${model} request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    // Only overload / rate-limit errors are worth retrying on another model.
    if (![429, 500, 503].includes(res.status)) break;
    console.error(`[gemini] ${model} unavailable (${res.status}), trying next model`);
  }
  throw lastError;
}

// ---------- Parsing and normalizing model output ----------

// Models sometimes wrap JSON in ```fences``` or add prose around it.
function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Response contained no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function str(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeType(value) {
  const t = str(value).toLowerCase();
  if (t.includes('happy') || t.includes('positive')) return 'Happy Path';
  if (t.includes('neg')) return 'Negative';
  if (t.includes('edge') || t.includes('boundary')) return 'Edge Case';
  return 'Other';
}

function normalizeSteps(value) {
  const steps = Array.isArray(value) ? value.map(str) : str(value).split(/\r?\n|;\s*/);
  return steps.map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
}

// Coerce whatever the model returned into the exact shape the frontend expects.
function normalize(raw) {
  const list = Array.isArray(raw?.testCases) ? raw.testCases : [];
  const testCases = list
    .filter(tc => tc && typeof tc === 'object')
    .map((tc, i) => ({
      testCaseId: str(tc.testCaseId) || `TC-${String(i + 1).padStart(2, '0')}`,
      scenario: str(tc.scenario),
      type: normalizeType(tc.type),
      preconditions: str(tc.preconditions),
      steps: normalizeSteps(tc.steps),
      testData: str(tc.testData),
      expectedResult: str(tc.expectedResult),
      storyId: str(tc.storyId)
    }));

  const coverage = (Array.isArray(raw?.coverage) ? raw.coverage : [])
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      criterion: str(c.criterion),
      testCaseIds: (Array.isArray(c.testCaseIds) ? c.testCaseIds : []).map(str).filter(Boolean)
    }))
    .filter(c => c.criterion);

  return { testCases, coverage };
}

const PROVIDERS = {
  bob: { configured: bobConfigured, model: () => 'Bob Shell', call: callBob },
  watsonx: { configured: watsonxConfigured, model: watsonxModel, call: callWatsonx },
  groq: { configured: () => Boolean(env('GROQ_API_KEY')), model: groqModel, call: callGroq },
  gemini: { configured: () => Boolean(env('GEMINI_API_KEY')), model: () => geminiModels()[0], call: callGemini }
};

// Providers in priority order (AI_PROVIDERS overrides it); only those with credentials are tried.
function configuredProviders() {
  const order = (env('AI_PROVIDERS') || 'bob,watsonx,groq,gemini').split(',').map(s => s.trim().toLowerCase());
  return order
    .filter(name => PROVIDERS[name]?.configured())
    .map(name => ({ name, model: PROVIDERS[name].model(), call: PROVIDERS[name].call }));
}

// Try each provider in turn; the first usable answer wins. Throws if all fail.
async function tryProviders(providers, userStory) {
  if (providers.length === 0) throw new Error('No AI provider configured in backend/.env');
  let lastError;
  for (const provider of providers) {
    try {
      // A provider returns the answer text, or { content, model } when the model used can vary.
      const answer = await provider.call(userStory);
      const content = typeof answer === 'string' ? answer : answer.content;
      const result = normalize(parseJson(content));
      if (result.testCases.length === 0) throw new Error('returned no test cases');
      return { ...result, provider: provider.name, model: answer.model ?? provider.model };
    } catch (err) {
      console.error(`[${provider.name}] failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}

function generateTestCases(userStory) {
  return tryProviders(configuredProviders(), userStory);
}

module.exports = { generateTestCases, configuredProviders, tryProviders, normalize, parseJson, extractBobText };
