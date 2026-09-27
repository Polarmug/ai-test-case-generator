# AI Test-Case Generator

Paste a user story with acceptance criteria → **IBM Bob** (with **IBM watsonx.ai** as backup) generates test cases (Happy Path / Negative / Edge Case) → shown in a table with an acceptance-criteria coverage check → exported to CSV.

## How Bob is used

The backend runs Bob Shell (Bob's command-line interface) in non-interactive mode for every request:

```
bob run --format json --mode ask --disable-mcp --workspace <empty temp folder>
```

The prompt (instructions + user story) goes in on stdin. Bob's JSON answer (`last_message`) is parsed and cleaned up before it reaches the frontend. Bob runs in an empty scratch folder, so it can't read or change project files.

## AI providers

Each request tries, in order:

1. **IBM Bob Shell**: primary
2. **IBM watsonx.ai** (Granite, default `ibm/granite-4-h-small`): backup when Bob fails, e.g. out of bobcoins, error or timeout
3. **Saved example** (`fallback.json`): last resort so the demo never shows an error

Providers without credentials in `.env` are skipped. The page's "Powered by" badge shows which one answered, and the backend logs why a provider failed.

## Structure

```
test-case-generator/
├── backend/               Node + Express, port 3001
│   ├── server.js          Routes: POST /api/generate, GET /api/health
│   ├── llm.js             Prompt, Bob Shell + watsonx.ai calls, provider chain, JSON normalization
│   ├── fallback.json      Saved example result, served if Bob fails
│   ├── llm.test.js        Tests (npm test)
│   └── .env               API keys (never commit; template in .env.example)
└── frontend/              Vite + React + TypeScript, port 5173
    └── src/App.tsx        UI: input, summary/filter, coverage, table, CSV export
```

## Setup

1. Install Bob Shell (needs Node 24+). In PowerShell:
   ```
   powershell -c "irm -Uri https://bob.ibm.com/download/bobshell.ps1 | iex"
   ```
   Check it works: `bob --version`
2. Create an API key in the Bob web portal (bob.ibm.com) with **Scope = Inference**, and put it in `backend/.env`:
   ```
   BOB_API_KEY=...
   ```
3. Run:
   ```
   cd backend   && npm install && npm start
   cd frontend  && npm install && npm run dev
   ```
   Optionally add the watsonx.ai backup (see `.env.example`): `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL`.
   The backend prints the active chain, e.g. `AI providers: bob -> watsonx -> saved example`.
4. Open http://localhost:5173 and click **Load example**.

## Deploy to Railway

The repo deploys as a single Railway service: the `Dockerfile` installs Bob Shell, builds the frontend, and runs the backend, which serves both the page and `/api/*` from one URL. `railway.json` sets the health check to `/api/health`.

```
npm install -g @railway/cli
railway login
railway init            # create a new project
railway up              # upload and build this folder
```

Then in the Railway dashboard, open the service:
- **Variables:** add `BOB_API_KEY` and `BOB_ACCEPT_LICENSE=true`, plus the `WATSONX_*` variables for the backup (optionally `BOB_MAX_COST`, `RATE_LIMIT`, `MAX_CONCURRENT_BOB_RUNS`)
- **Settings → Networking → Generate Domain** to get the public URL

`.env` is excluded from the upload by `.dockerignore`; the key only lives in Railway's variables.

Public-use limits (each Bob run costs bobcoins): 10 generations per visitor per 15 minutes (`RATE_LIMIT`) and at most 2 Bob runs at once (`MAX_CONCURRENT_BOB_RUNS`).

## How it stays demo-safe

- Bob's output is parsed leniently (markdown fences stripped) and normalized: missing fields become empty strings, `steps` is always an array, `type` is mapped to Happy Path / Negative / Edge Case.
- If Bob fails or times out (120 s), watsonx.ai answers instead. If both fail, the backend returns `fallback.json` with a visible notice instead of an error.

## Ideas for later

- Batch CSV upload of several stories
- Edit/delete individual test cases before export
- Excel or TestRail/Jira import formats
