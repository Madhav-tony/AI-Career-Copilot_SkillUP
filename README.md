# Career Copilot — server + frontend

This is the thin-proxy version: everything from the pure-HTML build still runs
client-side (career matching, skill gap, roadmap, readiness score). The only
things that now go through a real server are:

- Resume skill extraction (`POST /api/extract-skills`)
- Mock interview scoring (`POST /api/score-interview`)

The server exists for one reason: **to keep your AI API key out of the
browser.** If either AI call fails (no key configured, rate limit, network
error), the server automatically falls back to the same offline heuristic
logic from the pure-HTML version, so the demo never fully breaks.

---

## Setup

```bash
cd career-copilot-server
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `AI_API_KEY` — your real API key
- `AI_MODEL` — the model name you have access to
- `AI_BASE_URL` — only change this if you're not using OpenAI directly
  (e.g. pointing at an OpenAI-compatible endpoint)

If your provider is **not** OpenAI-compatible (different request/response
shape), you only need to edit one function: `callAI()` in `server.js`.
Everything else (the two routes, the fallback logic, the frontend) stays
the same.

## Run

```bash
npm start
```

Then open **http://localhost:4000** in your browser. That's it — the
frontend is served by the same Express server, so there's no separate
frontend process to run.

## Verify it's working

Visit **http://localhost:4000/api/health** — it tells you whether an API
key is configured, and which provider/model it'll use.

When you upload a resume and click "Analyze my profile," look for the small
tag next to "Extracted profile":
- **● AI-analyzed** (green) — the real API call worked
- **● Local fallback** (grey) — no key configured, or the call failed;
  check your terminal for the logged error message

Same pattern applies to the mock interview scoring.

## What's intentionally NOT here

- No database — nothing persists between page refreshes (fine for a demo)
- No user accounts/auth — single-user flow only
- No deployment config — running `npm start` locally on the presenter's
  laptop during the demo is completely fine for a hackathon

## If you need to deploy it live

Any host that runs a Node process works (Render, Railway, Fly.io). Set the
same environment variables from `.env` in your host's dashboard — never
commit your real `.env` file.
