/**
 * Career Copilot — thin proxy server
 * ------------------------------------------------------------------
 * The ONLY job of this server is to hold the AI API key server-side
 * and forward two kinds of requests to it. It does not have a database,
 * auth, or user accounts on purpose — everything else in the app stays
 * client-side (see the HTML file / public/index.html).
 *
 * Routes:
 *   POST /api/extract-skills   { resumeText }        -> { skills, projectsCount, certsCount }
 *   POST /api/score-interview  { question, answer }  -> { technical, clarity, completeness, overall, feedback }
 *
 * If the AI call fails for any reason (bad key, rate limit, network),
 * both routes fall back to the same local heuristic logic that the
 * pure-HTML version used, so the demo never fully breaks on stage.
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const AI_PROVIDER = 'google_gemini';
// Accept either GEMINI_API_KEY (the name Google's docs use) or the
// existing AI_API_KEY var, so nobody has to touch their .env file.
const AI_API_KEY = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'gemini-2.5-flash';
const PORT = process.env.PORT || 3001;

if (!AI_API_KEY) {
  console.warn(
    '\n⚠️  GEMINI_API_KEY (or AI_API_KEY) is not set. Copy .env.example to .env and add your key.\n' +
    '    The server will still run, but every request will fall back to\n' +
    '    the local heuristic logic instead of calling a real AI model.\n'
  );
}

// The SDK reads GEMINI_API_KEY from the environment automatically, but we
// pass it explicitly here so AI_API_KEY (the older var name) still works.
const ai = AI_API_KEY ? new GoogleGenAI({ apiKey: AI_API_KEY }) : null;

/* ------------------------------------------------------------------
 * Generic call to Gemini via the Interactions API (@google/genai).
 * We ask for structured JSON output matching `schema` so the rest of
 * the route code can keep treating the result as a plain object.
 * ------------------------------------------------------------------ */
async function callAI(systemPrompt, userPrompt, schema) {
  if (!ai) throw new Error('No GEMINI_API_KEY configured');

  const interaction = await ai.interactions.create({
    model: AI_MODEL,
    input: `${systemPrompt}\n\n${userPrompt}`,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema,
    },
  });

  const raw = interaction.output_text;
  if (!raw) throw new Error('AI response had no content');
  return JSON.parse(raw); // guaranteed valid JSON matching `schema` per response_format above
}

/* ------------------------------------------------------------------
 * JSON schemas for the two routes' structured output.
 * ------------------------------------------------------------------ */
const EXTRACT_SKILLS_SCHEMA = {
  type: 'object',
  properties: {
    skills: {
      type: 'object',
      description: 'Map of skill name -> level (1, 2, or 3)',
      additionalProperties: { type: 'integer', enum: [1, 2, 3] },
    },
    projectsCount: { type: 'integer' },
    certsCount: { type: 'integer' },
  },
  required: ['skills', 'projectsCount', 'certsCount'],
};

const SCORE_INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    technical: { type: 'number' },
    clarity: { type: 'number' },
    completeness: { type: 'number' },
    overall: { type: 'number' },
    feedback: { type: 'string' },
  },
  required: ['technical', 'clarity', 'completeness', 'overall', 'feedback'],
};

const CAREER_MATCHES_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'One short sentence on why this fit score, referencing specific skills, projects, or certs.' },
        },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['matches'],
};

const SKILL_GAP_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          note: { type: 'string', description: 'One short (1 sentence) actionable note: why this skill matters for the role and what to do about the gap (or, if already met, a quick affirmation).' },
        },
        required: ['name', 'note'],
      },
    },
  },
  required: ['notes'],
};

const ROADMAP_SCHEMA = {
  type: 'object',
  properties: {
    roadmap: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          month: { type: 'integer' },
          focus: { type: 'string', description: 'Short title for this month, e.g. "Foundations" or "SQL + Statistics"' },
          skills: { type: 'array', items: { type: 'string' } },
          resources: { type: 'array', items: { type: 'string' }, description: '1-3 concrete, well-known learning resources or resource *types* (course, doc, project idea) for these skills.' },
          milestone: { type: 'string', description: 'A concrete, checkable outcome for the end of this month.' },
        },
        required: ['month', 'focus', 'skills', 'resources', 'milestone'],
      },
    },
  },
  required: ['roadmap'],
};

/* ------------------------------------------------------------------
 * Skill-name normalization
 * ------------------------------------------------------------------
 * The career-matching math (computeCareerMatchesLocal / computeGapLocal)
 * looks skills up by exact, case-sensitive key against CAREERS[].skills,
 * which only uses the fixed lowercase vocabulary in SKILL_KEYWORDS
 * (e.g. 'node.js', 'apis', 'machine learning'). The AI extractor is
 * free-text and will happily return "Python", "Node.js", "REST APIs",
 * "Machine Learning", etc. Those don't match the lowercase keys, so
 * every lookup silently misses and every career scores 0%.
 *
 * normalizeSkillsMap() fixes this: it lowercases/trims every AI-returned
 * skill name, maps common synonyms/aliases onto the canonical keyword,
 * and drops anything that still isn't part of the recognized vocabulary
 * (so unrecognized skills never crash the scoring, they're just not
 * scored against a career that doesn't ask for them).
 * ------------------------------------------------------------------ */
const SKILL_ALIASES = {
  'js': 'javascript',
  'nodejs': 'node.js',
  'node js': 'node.js',
  'node.js/express': 'node.js',
  'reactjs': 'react',
  'react.js': 'react',
  'rest api': 'apis',
  'rest apis': 'apis',
  'restapi': 'apis',
  'restful apis': 'apis',
  'api': 'apis',
  'ml': 'machine learning',
  'machine learning fundamentals': 'machine learning',
  'dl': 'deep learning',
  'ui/ux design': 'ui/ux',
  'ux/ui': 'ui/ux',
  'ux': 'ui/ux',
  'c plus plus': 'c++',
  'cpp': 'c++',
  'aws fundamentals': 'aws',
  'aws cloud': 'aws',
  'basic statistics': 'statistics',
  'data visualization (matplotlib)': 'data visualization',
  'matplotlib': 'data visualization',
  'version control': 'git',
  'github': 'git',
  'oop': 'system design',
};

function normalizeSkillName(name) {
  const cleaned = String(name).toLowerCase().trim().replace(/\s+/g, ' ');
  return SKILL_ALIASES[cleaned] || cleaned;
}

// Keep only names that are part of the recognized vocabulary so they can
// actually be matched against CAREERS[].skills. Collisions (two AI names
// normalizing to the same keyword) keep the higher level.
function normalizeSkillsMap(skills) {
  const out = {};
  Object.entries(skills || {}).forEach(([name, level]) => {
    const norm = normalizeSkillName(name);
    if (SKILL_KEYWORDS.includes(norm)) {
      const numLevel = Math.max(1, Math.min(3, Math.round(Number(level)) || 1));
      out[norm] = Math.max(out[norm] || 0, numLevel);
    }
  });
  return out;
}

/* ------------------------------------------------------------------
 * Deterministic scoring/gap helpers — ported from the client-side
 * versions in public/index.html. These numbers stay identical whether
 * or not the AI call succeeds; the AI layer only adds narrative
 * (reasons, notes, resources, milestones) on top of them, so a bad
 * or missing API key never changes what score someone gets.
 * ------------------------------------------------------------------ */
function computeCareerMatchesLocal(careers, userSkills) {
  return careers.map((c) => {
    const req = Object.keys(c.skills);
    let earned = 0, total = 0;
    req.forEach((s) => {
      const reqLevel = c.skills[s];
      total += reqLevel;
      const have = userSkills[s] || 0;
      earned += Math.min(have, reqLevel);
    });
    const pct = total > 0 ? Math.round((earned / total) * 100) : 0;
    return { id: c.id, pct };
  }).sort((a, b) => b.pct - a.pct);
}

function computeGapLocal(career, userSkills) {
  return Object.keys(career.skills).map((name) => {
    const required = career.skills[name];
    const current = userSkills[name] || 0;
    let status = 'gap';
    if (current >= required) status = 'ok';
    else if (current >= required - 1) status = 'mid';
    return { name, required, current, status };
  });
}

function buildRoadmapLocal(gapList) {
  const missing = gapList.filter((g) => g.status !== 'ok').map((g) => g.name);
  const months = [];
  for (let i = 0; i < missing.length; i += 2) {
    const slice = missing.slice(i, i + 2);
    months.push({ month: months.length + 1, focus: slice.join(' & '), skills: slice, resources: [], milestone: '' });
  }
  return months;
}

/* ------------------------------------------------------------------
 * Local fallback logic (same approach as the pure-HTML version)
 * ------------------------------------------------------------------ */
const SKILL_KEYWORDS = [
  'python','java','javascript','sql','c++','c#','html','css','react','node.js','node',
  'machine learning','deep learning','tensorflow','pytorch','statistics','data visualization',
  'excel','git','docker','kubernetes','aws','azure','gcp','linux','networking',
  'security fundamentals','risk analysis','communication','stakeholder management',
  'prioritization','system design','apis','ui/ux','r','scikit-learn','pandas','numpy'
];

function localExtractSkills(resumeText) {
  const lower = resumeText.toLowerCase();
  const skills = {};
  SKILL_KEYWORDS.forEach((kw) => {
    if (lower.includes(kw)) {
      let level = 2;
      const idx = lower.indexOf(kw);
      const window = lower.substring(Math.max(0, idx - 30), idx + 30);
      if (/advanced|expert|extensive/.test(window)) level = 3;
      else if (/basic|familiar|beginner|exposure/.test(window)) level = 1;
      skills[kw] = level;
    }
  });
  const projectsCount = (lower.match(/project/g) || []).length;
  const certsCount = (lower.match(/certificat|certified/g) || []).length;
  return { skills, projectsCount, certsCount, source: 'local-fallback' };
}

function localScoreInterview(question, answer) {
  const lower = answer.toLowerCase();
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  const completeness = Math.min(10, Math.round(wordCount / 15));
  const clarity = answer.length > 20 ? Math.min(10, Math.round(answer.split(/[.!?]/).length * 2)) : 3;
  const technical = Math.min(10, Math.round(wordCount / 20)); // no keyword list available generically here
  const overall = Math.round(((technical + clarity + completeness) / 3) * 10) / 10;
  return {
    technical, clarity, completeness, overall,
    feedback: 'Fallback scoring (no AI configured) — based on answer length and structure only.',
    source: 'local-fallback',
  };
}

/* ------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------ */
app.post('/api/extract-skills', async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText || typeof resumeText !== 'string') {
    return res.status(400).json({ error: 'resumeText (string) is required' });
  }

  try {
    const systemPrompt = `You are a resume analysis engine for a career-guidance app.
Extract technical and soft skills from the resume text, each with a level from 1-3
(1 = basic/mentioned once, 2 = solid/used in a project, 3 = advanced/expert).
Also count distinct projects mentioned and distinct certifications mentioned.

IMPORTANT: The "skills" object's keys MUST be chosen from this exact vocabulary
(lowercase, spelled exactly as shown) so scores can be matched downstream. Do not
invent new spellings, do not capitalize, and do not include a skill that is not
in this list even if it's mentioned in the resume:
${SKILL_KEYWORDS.join(', ')}`;

    const result = await callAI(systemPrompt, resumeText.slice(0, 6000), EXTRACT_SKILLS_SCHEMA);
    // Defensive normalization: even with the instruction above, models can
    // still drift on casing/spelling — this guarantees the returned keys
    // are always ones the scoring logic can actually match against.
    const normalizedSkills = normalizeSkillsMap(result.skills);
    return res.json({ ...result, skills: normalizedSkills, source: 'ai' });
  } catch (err) {
    console.error('extract-skills AI call failed, using fallback:', err.message);
    return res.json(localExtractSkills(resumeText));
  }
});

app.post('/api/score-interview', async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    return res.status(400).json({ error: 'question and answer (strings) are required' });
  }

  try {
    const systemPrompt = `You are an interview coach evaluating a candidate's spoken/written
answer to a technical interview question. Score technical accuracy, clarity, and completeness
each out of 10, and give one short (1-2 sentence) actionable improvement suggestion.`;

    const userPrompt = `Question: ${question}\n\nCandidate's answer: ${answer}`;
    const result = await callAI(systemPrompt, userPrompt, SCORE_INTERVIEW_SCHEMA);
    return res.json({ ...result, source: 'ai' });
  } catch (err) {
    console.error('score-interview AI call failed, using fallback:', err.message);
    return res.json(localScoreInterview(question, answer));
  }
});

app.post('/api/career-matches', async (req, res) => {
  const { skills, projectsCount, certsCount, careers } = req.body;
  if (!skills || !Array.isArray(careers)) {
    return res.status(400).json({ error: 'skills (object) and careers (array) are required' });
  }

  // Defensive: normalize again here too, in case the skills object came
  // from a stale client-side cache captured before this fix, or from any
  // other caller that isn't the extract-skills route.
  const normalizedSkills = normalizeSkillsMap(skills);
  const localMatches = computeCareerMatchesLocal(careers, normalizedSkills);

  try {
    const systemPrompt = `You are a career-matching engine for a career-guidance app.
You will be given a candidate's skills (with levels 1-3), project mention count,
certification mention count, and a list of careers each already scored with a
percentage fit (0-100, already computed — do not change or restate the number).
For EVERY career id in the input, write one short, specific sentence explaining
that fit score: reference the candidate's actual strong or missing skills, and
project/cert count where relevant. Return one entry per input career id.`;

    const userPrompt = JSON.stringify({
      skills: normalizedSkills, projectsCount, certsCount,
      careers: localMatches.map((m) => ({ id: m.id, pct: m.pct, requiredSkills: careers.find((c) => c.id === m.id).skills })),
    });

    const result = await callAI(systemPrompt, userPrompt, CAREER_MATCHES_SCHEMA);
    const reasonById = Object.fromEntries(result.matches.map((m) => [m.id, m.reason]));
    const matches = localMatches.map((m) => ({ ...m, reason: reasonById[m.id] || '' }));
    return res.json({ matches, source: 'ai' });
  } catch (err) {
    console.error('career-matches AI call failed, using fallback:', err.message);
    return res.json({ matches: localMatches, source: 'local-fallback' });
  }
});

app.post('/api/skill-gap', async (req, res) => {
  const { career, skills } = req.body;
  if (!career || !career.skills || !skills) {
    return res.status(400).json({ error: 'career (with skills) and skills (object) are required' });
  }

  const normalizedSkills = normalizeSkillsMap(skills);
  const localGap = computeGapLocal(career, normalizedSkills);

  try {
    const systemPrompt = `You are a skill-gap analyst for a career-guidance app.
You will be given a target career and a list of that career's required skills, each
already evaluated against the candidate (required level, current level, and a
status of "ok"/"mid"/"gap" — already computed, do not change these). For EVERY
skill in the list, write one short (1 sentence) actionable note: if status is
"gap" or "mid", explain briefly why this skill matters for the role and what to
do next; if "ok", give a brief affirmation. Return one entry per skill name.`;

    const userPrompt = JSON.stringify({ career: career.name, gap: localGap });
    const result = await callAI(systemPrompt, userPrompt, SKILL_GAP_SCHEMA);
    const noteByName = Object.fromEntries(result.notes.map((n) => [n.name, n.note]));
    const gap = localGap.map((g) => ({ ...g, note: noteByName[g.name] || '' }));
    return res.json({ gap, source: 'ai' });
  } catch (err) {
    console.error('skill-gap AI call failed, using fallback:', err.message);
    return res.json({ gap: localGap, source: 'local-fallback' });
  }
});

app.post('/api/roadmap', async (req, res) => {
  const { career, gap } = req.body;
  if (!career || !Array.isArray(gap)) {
    return res.status(400).json({ error: 'career and gap (array) are required' });
  }

  const missing = gap.filter((g) => g.status !== 'ok');
  if (!missing.length) {
    return res.json({ roadmap: [], source: 'n/a' });
  }

  try {
    const systemPrompt = `You are a learning-path designer for a career-guidance app.
You will be given a target career and a list of that candidate's missing/weak
skills for it (with current and required level 1-3). Design a realistic
month-by-month roadmap (roughly 1-2 skills per month, fewer if a skill is dense)
to close these gaps, in a sensible order (foundational skills before skills that
build on them). For each month give: a short focus title, the skill names covered,
1-3 concrete well-known resources or resource types to use, and one concrete,
checkable milestone for the end of that month.`;

    const userPrompt = JSON.stringify({ career: career.name, missingSkills: missing });
    const result = await callAI(systemPrompt, userPrompt, ROADMAP_SCHEMA);
    return res.json({ roadmap: result.roadmap, source: 'ai' });
  } catch (err) {
    console.error('roadmap AI call failed, using fallback:', err.message);
    return res.json({ roadmap: buildRoadmapLocal(gap), source: 'local-fallback' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(AI_API_KEY), provider: AI_PROVIDER, model: AI_MODEL });
});

app.listen(PORT, () => {
  console.log(`Career Copilot server running at http://localhost:${PORT}`);
  console.log(`AI configured: ${Boolean(AI_API_KEY)} (provider: ${AI_PROVIDER}, model: ${AI_MODEL})`);
});
