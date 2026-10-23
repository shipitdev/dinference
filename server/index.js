import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { jsonrepair } from "jsonrepair";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");
const dataPath = path.resolve(__dirname, "../data");
const dbPath = path.join(dataPath, "reports.sqlite");
const mastraDbPath = path.join(dataPath, "mastra.sqlite");
const CACHE_VERSION = "user-shark-room-v3";
const LLM_CALL_TIMEOUT_MS = Number(process.env.NEBIUS_CALL_TIMEOUT_MS || 90_000);

fs.mkdirSync(dataPath, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    cache_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    title TEXT NOT NULL,
    winner TEXT NOT NULL,
    prompt TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_chunks (
    cache_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    step TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drill_attempts (
    id TEXT PRIMARY KEY,
    report_id TEXT,
    created_at TEXT NOT NULL,
    drill_name TEXT NOT NULL,
    drill_prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    score INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    data TEXT NOT NULL
  )
`);

const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map((column) => column.name);
if (!reportColumns.includes("cache_key")) {
  db.exec("ALTER TABLE reports ADD COLUMN cache_key TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_cache_key ON reports(cache_key)");

const app = express();
const port = Number(process.env.PORT || 8790);
const defaultBaseUrl =
  process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1/";

const modelConfig = {
  nemotron: {
    label: "MiniMax Shark",
    model: process.env.NEBIUS_NEMOTRON_MODEL || "MiniMaxAI/MiniMax-M3",
    baseUrl: process.env.NEBIUS_NEMOTRON_BASE_URL || defaultBaseUrl,
  },
  deepseek: {
    label: "DeepSeek Flash Shark",
    model: process.env.NEBIUS_DEEPSEEK_MODEL || "deepseek-ai/DeepSeek-V4-Flash",
    baseUrl: process.env.NEBIUS_DEEPSEEK_BASE_URL || defaultBaseUrl,
  },
  judge: {
    label: "Nemotron Lightning Shark",
    model: process.env.NEBIUS_JUDGE_MODEL || "nvidia/Nemotron-3_5-Lightning",
    baseUrl: process.env.NEBIUS_JUDGE_BASE_URL || defaultBaseUrl,
  },
};

function nebiusModel(role) {
  return {
    providerId: "nebius",
    modelId: role.model,
    url: role.baseUrl,
    apiKey: process.env.NEBIUS_API_KEY || "",
  };
}

const miniMaxFounderAgent = new Agent({
  id: "minimax-shark-agent",
  name: "MiniMax Shark",
  model: () => nebiusModel(modelConfig.nemotron),
  instructions:
    "You are the operator/execution shark in an AI Shark Tank practice room. You evaluate founders through operating rigor, concrete numbers, hiring plans, delivery capacity, margin control, automation, retention, and measurable scaling milestones.",
});

const deepSeekFounderAgent = new Agent({
  id: "deepseek-flash-shark-agent",
  name: "DeepSeek Flash Shark",
  model: () => nebiusModel(modelConfig.deepseek),
  instructions:
    "You are the growth/category shark in an AI Shark Tank practice room. You evaluate founders through market positioning, partnerships, distribution loops, product/data leverage, category expansion, and defensibility.",
});

const investorJudgeAgent = new Agent({
  id: "nemotron-lightning-shark-agent",
  name: "Nemotron Lightning Shark",
  model: () => nebiusModel(modelConfig.judge),
  instructions:
    "You are the lead deal-maker and financial skeptic in an AI Shark Tank practice room. Extract business facts, ask hard questions, score founder answers, negotiate realistic terms, and write practical practice notes without inventing facts.",
});

const fallbackQuestions = [
  "Give me the 30-second pitch. What exactly do you sell, who buys it first, and why now?",
  "What proof do you have that the sharpest first customer segment urgently wants this and will keep paying?",
  "Walk me through the business model, pricing, margins, and the next revenue milestone.",
  "How will you acquire customers repeatedly without founder-led hustle every time?",
  "What is your creative scaling plan from the current revenue and traction?",
  "What role should technology, automation, data, or AI play in scaling this company?",
  "Who are the closest competitors or substitutes, and what makes this company hard to copy?",
  "What is the biggest operational or market risk, and how will you reduce it?",
  "What exactly would you do with the investment, and what milestones should it unlock?",
  "What deal terms would make this investable, and why should I believe this can become big?",
];

const practiceStages = {
  idea: {
    label: "Idea",
    prompt:
      "The founder may be pre-revenue. Test problem clarity, target customer, validation plan, prototype, founder insight, and the first proof needed before fundraising.",
  },
  early: {
    label: "Early Traction",
    prompt:
      "The founder has first customers, pilots, revenue, or usage. Test repeatability, retention, margin, customer acquisition, use of funds, and next milestone.",
  },
  scaling: {
    label: "Scaling",
    prompt:
      "The founder is already operating with meaningful traction. Test operating leverage, hiring, unit economics, market expansion, defensibility, and execution risk.",
  },
  fundraising: {
    label: "Fundraising",
    prompt:
      "The founder wants investor readiness. Test deal terms, milestone framing, investor objections, upside, risk, and proof needed to close capital.",
  },
};

const practiceObjectives = {
  clarity: {
    label: "Pitch Clarity",
    prompt:
      "Optimize feedback for simple pitch narrative, customer pain, why now, and one memorable investor hook.",
  },
  growth: {
    label: "Growth Plan",
    prompt:
      "Optimize feedback for acquisition loops, channel strategy, partnerships, expansion, and creative scaling.",
  },
  economics: {
    label: "Unit Economics",
    prompt:
      "Optimize feedback for pricing, margin, payback, retention, operating capacity, and financial proof.",
  },
  deal: {
    label: "Investor Deal",
    prompt:
      "Optimize feedback for funding ask, valuation logic, milestone use of capital, risk reduction, and final terms.",
  },
};

const skillCategories = [
  { key: "clarity", label: "Clarity" },
  { key: "proof", label: "Proof" },
  { key: "economics", label: "Economics" },
  { key: "scale", label: "Scale" },
  { key: "moat", label: "Moat" },
  { key: "deal", label: "Deal" },
];

const practiceLengths = {
  quick: { label: "Quick Room", roundCount: 3, questionsPerShark: 1 },
  full: { label: "Full Room", roundCount: 6, questionsPerShark: 2 },
};

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function flattenMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content || "");
}

function splitAgentMessages(messages) {
  const system = [];
  const prompt = [];

  for (const message of messages || []) {
    const content = flattenMessageContent(message.content);
    if (!content) {
      continue;
    }

    if (message.role === "system") {
      system.push(content);
      continue;
    }

    prompt.push(`${String(message.role || "user").toUpperCase()}:\n${content}`);
  }

  return {
    instructions: system.join("\n\n"),
    prompt: prompt.join("\n\n"),
  };
}

function getAgentForRole(role) {
  if (role === modelConfig.nemotron) {
    return miniMaxFounderAgent;
  }
  if (role === modelConfig.deepseek) {
    return deepSeekFounderAgent;
  }
  return investorJudgeAgent;
}

async function withTimeout(promise, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(LLM_CALL_TIMEOUT_MS / 1000)}s.`));
        }, LLM_CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeInput(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 5000);
}

function toScore(value, fallback = 65) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const scaled = numeric > 0 && numeric <= 10 ? numeric * 10 : numeric;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function isWeakPitchText(value) {
  const text = sanitizeInput(value).toLowerCase();
  return (
    text.length < 40 ||
    text === "..." ||
    text.includes("clearest customer pain, the current proof, and the next measurable milestone") ||
    text.includes("this business already has concrete traction, and the next pitch should tie") ||
    text.includes("validate the next growth step with a measurable experiment") ||
    text.includes("validate willingness to pay with a small, specific customer segment")
  );
}

function isPlaceholderText(value) {
  const text = sanitizeInput(value).toLowerCase();
  const labeledOnlyPattern =
    /^(reaction|score|interest|pressure|deal signal|deal_signal|investor note|investor_note|decision|amount|equity|conditions|rationale|improvement|confidence|message|final advice|final_advice|revised amount|revised_amount|revised equity|revised_equity):?$/i;
  return (
    !text ||
    labeledOnlyPattern.test(text) ||
    text === "..." ||
    text === "short title" ||
    text === "one sentence business summary" ||
    text === "fact from user prompt" ||
    text.includes("the answer needs clearer proof before this shark can move closer to a deal") ||
    text.includes("what proof can you show that this answer is repeatable") ||
    text.includes("tighten the answer with customer proof, economics, and a milestone") ||
    text.includes("the shark needs clearer logic before changing terms") ||
    text.includes("make the counter specific, rational, and tied to milestones") ||
    text.includes("specific investor language tied to the counter-offer") ||
    text.includes("specific investor language tied to counter-offer") ||
    text.includes("i need to fill") ||
    text.includes("let's think like") ||
    text.includes("let's draft") ||
    text.includes("round 1 focus") ||
    text.includes("operator angle") ||
    text.includes("growth angle") ||
    text.includes("deal-maker angle") ||
    text.includes("missing fact investors will ask for") ||
    text.includes("best proof already stated") ||
    text.includes("concise investor reaction to the user's answer") ||
    text.includes("one optional follow-up pressure point") ||
    text.includes("how this affects your willingness to invest") ||
    text.includes("one note to help the founder improve") ||
    text.includes("why you made this decision") ||
    text.includes("what founder should improve") ||
    text.includes("response to founder") ||
    text.includes("what founder should learn")
  );
}

function isPlaceholderReaction(reaction = {}) {
  const reactionText = sanitizeInput(reaction.reaction);
  return (
    isPlaceholderText(reaction.reaction) ||
    isPlaceholderText(reaction.pressure) ||
    isPlaceholderText(reaction.dealSignal) ||
    isPlaceholderText(reaction.investorNote) ||
    reactionText.length < 40
  );
}

function extractLabeledValue(text, labels, fallback = "") {
  const source = String(text || "");
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const nextLabelPattern =
    "REACTION|SCORE|INTEREST|PRESSURE|DEAL SIGNAL|DEAL_SIGNAL|INVESTOR NOTE|INVESTOR_NOTE|DECISION|AMOUNT|EQUITY|CONDITIONS|RATIONALE|IMPROVEMENT|CONFIDENCE|MESSAGE|FINAL ADVICE|FINAL_ADVICE|REVISED AMOUNT|REVISED_AMOUNT|REVISED EQUITY|REVISED_EQUITY|FOCUS\\s+\\d+|QUESTION\\s+\\d+|ANGLE\\s+\\d+";
  const labeledOnly = new RegExp(`^(?:${nextLabelPattern})\\s*:?$`, "i");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${nextLabelPattern})\\s*:|$)`, "gi");
  const values = Array.from(source.matchAll(pattern))
    .map((match) => sanitizeInput(match?.[1]))
    .map((value) => value.replace(/^["']|["']$/g, "").trim())
    .filter((value) => value && !labeledOnly.test(value));
  const value = values.at(-1) || sanitizeInput(fallback);
  if (labeledOnly.test(value)) {
    return sanitizeInput(fallback);
  }
  return value;
}

function parseListValue(value) {
  return sanitizeInput(value)
    .split(/\n|;|\|/)
    .map((item) => sanitizeInput(item.replace(/^[-*]\s*/, "")))
    .filter(Boolean)
    .slice(0, 5);
}

function parseModelJson(text) {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .replace(/"\s*\+\s*"/g, "")
    .replace(/"\s*\+\s*\n\s*"/g, "")
    .replace(/\n\s*\+\s*"/g, "\n\"")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model did not return JSON.");
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return JSON.parse(jsonrepair(match[0]));
    }
  }
}

async function callText({ role, messages, temperature = 0.55, maxTokens = 2600 }) {
  if (!process.env.NEBIUS_API_KEY) {
    throw new Error("Missing NEBIUS_API_KEY. Add it to ai-shark-tank/.env and restart the server.");
  }

  const agent = getAgentForRole(role);
  const { instructions, prompt } = splitAgentMessages(messages);
  const result = await withTimeout(
    agent.generate(prompt || "Continue.", {
      instructions: instructions || undefined,
      maxSteps: 1,
      modelSettings: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
    role.label,
  );

  return String(result.text || (result.object ? JSON.stringify(result.object) : ""));
}

async function callJson({ role, messages, temperature = 0.5, maxTokens = 2800 }) {
  const text = await callText({ role, messages, temperature, maxTokens });
  try {
    return parseModelJson(text);
  } catch {
    const repaired = await callText({
      role,
      temperature: 0,
      maxTokens,
      messages: [
        {
          role: "system",
          content:
            "Repair malformed JSON. Return only valid JSON with double-quoted property names, no string concatenation, and no markdown.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Repair this into valid JSON while preserving meaning. Remove JavaScript-style + string concatenation if present.\n\n${text}`,
            },
          ],
        },
      ],
    });

    try {
      return parseModelJson(repaired);
    } catch {
      const repairRole = role?.label === modelConfig.deepseek.label ? modelConfig.nemotron : modelConfig.deepseek;
      const secondRepair = await callText({
        role: repairRole,
        temperature: 0,
        maxTokens,
        messages: [
          {
            role: "system",
            content:
              "Convert malformed model output into strict JSON. Return only one valid JSON object with double-quoted property names. No prose, markdown, analysis, or placeholders.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `The previous JSON repair failed. Repair this output into valid JSON while preserving the intended fields and meaning.\n\n${text}\n\nFirst failed repair:\n${repaired}`,
              },
            ],
          },
        ],
      });
      return parseModelJson(secondRepair);
    }
  }
}

function buildPromptFromBody(body) {
  const prompt = sanitizeInput(body.prompt);
  if (prompt) {
    return prompt;
  }

  const parts = [
    sanitizeInput(body.idea) && `Business idea: ${sanitizeInput(body.idea)}`,
    sanitizeInput(body.customer) && `Target customer: ${sanitizeInput(body.customer)}`,
    sanitizeInput(body.traction) && `Traction/proof: ${sanitizeInput(body.traction)}`,
    sanitizeInput(body.ask) && `Investment ask: ${sanitizeInput(body.ask)}`,
    sanitizeInput(body.intensity) && `Room intensity: ${sanitizeInput(body.intensity)}`,
  ].filter(Boolean);

  return parts.join("\n").slice(0, 5000);
}

function normalizePracticeContext(body = {}) {
  const stageKey = Object.hasOwn(practiceStages, body.stage) ? body.stage : "early";
  const objectiveKey = Object.hasOwn(practiceObjectives, body.objective) ? body.objective : "growth";
  const lengthKey = Object.hasOwn(practiceLengths, body.length) ? body.length : "full";

  return {
    stage: stageKey,
    stageLabel: practiceStages[stageKey].label,
    stagePrompt: practiceStages[stageKey].prompt,
    objective: objectiveKey,
    objectiveLabel: practiceObjectives[objectiveKey].label,
    objectivePrompt: practiceObjectives[objectiveKey].prompt,
    length: lengthKey,
    lengthLabel: practiceLengths[lengthKey].label,
    roundCount: practiceLengths[lengthKey].roundCount,
    questionsPerShark: practiceLengths[lengthKey].questionsPerShark,
  };
}

function practiceContextPrompt(practiceContext) {
  return [
    `Founder stage: ${practiceContext.stageLabel}`,
    practiceContext.stagePrompt,
    `Practice objective: ${practiceContext.objectiveLabel}`,
    practiceContext.objectivePrompt,
    `Room length: ${practiceContext.lengthLabel} (${practiceContext.roundCount} investor questions, ${practiceContext.questionsPerShark || 1} per shark)`,
  ].join("\n");
}

function normalizePromptDiagnostics(raw = {}) {
  return {
    stageFit: sanitizeInput(raw.stageFit, "The prompt gives enough context to start investor practice.").slice(0, 220),
    missingFacts: Array.isArray(raw.missingFacts)
      ? raw.missingFacts.slice(0, 5).map((item) => sanitizeInput(item).slice(0, 150))
      : [],
    strongestSignal: sanitizeInput(raw.strongestSignal, "The clearest signal is the founder's stated traction or customer insight.").slice(0, 180),
    firstPracticeMove: sanitizeInput(raw.firstPracticeMove, "Practice explaining the customer pain, proof, and next milestone in one tight answer.").slice(0, 180),
  };
}

function normalizeSkillScores(raw = {}) {
  return skillCategories.map((category) => {
    const source = raw[category.key] || {};
    return {
      key: category.key,
      label: category.label,
      score: toScore(source.score, 65),
      note: sanitizeInput(source.note, `${category.label} needs sharper investor-grade proof.`).slice(0, 160),
    };
  });
}

function normalizePracticeDrills(raw = []) {
  const drills = Array.isArray(raw) ? raw : [];
  return drills.slice(0, 3).map((drill, index) => ({
    name: sanitizeInput(drill.name, `Drill ${index + 1}`).slice(0, 80),
    goal: sanitizeInput(drill.goal, "Sharpen one investor-critical part of the pitch.").slice(0, 180),
    prompt: sanitizeInput(drill.prompt, "Answer this investor question in 45 seconds with one metric, one risk, and one next milestone.").slice(0, 320),
  }));
}

const sharkKeys = ["nemotron", "deepseek", "judge"];

function sharkProfiles() {
  return {
    nemotron: {
      key: "nemotron",
      label: modelConfig.nemotron.label,
      model: modelConfig.nemotron.model,
      thesis: "Operator and execution investor. Cares about delivery systems, hiring, margin, retention, and what the founder can actually operate next.",
    },
    deepseek: {
      key: "deepseek",
      label: modelConfig.deepseek.label,
      model: modelConfig.deepseek.model,
      thesis: "Growth and category investor. Cares about wedge, distribution, partnerships, market expansion, and defensibility.",
    },
    judge: {
      key: "judge",
      label: modelConfig.judge.label,
      model: modelConfig.judge.model,
      thesis: "Lead deal-maker and financial skeptic. Cares about valuation logic, risk, terms, proof quality, and whether a real offer can be made.",
    },
  };
}

function sharkLabel(key) {
  return sharkProfiles()[key]?.label || "Shark";
}

const fallbackSharkQuestions = {
  nemotron: [
    {
      focus: "Operating proof",
      question: "Walk me through how you deliver this repeatedly without quality dropping, and what operating metric proves it is working.",
      angle: "Pressure delivery systems, margin, capacity, retention, and hiring risk.",
    },
    {
      focus: "Execution plan",
      question: "What exactly changes in the next 90 days if you get capital, and how will you measure whether the execution plan is working?",
      angle: "Pressure use of funds, operational milestones, staffing, and throughput.",
    },
  ],
  deepseek: [
    {
      focus: "Growth wedge",
      question: "Who is the sharpest first customer segment, why do they buy now, and what channel can repeatedly reach them?",
      angle: "Pressure positioning, distribution, market pull, and category expansion.",
    },
    {
      focus: "Scale loop",
      question: "What growth loop or partnership can make this scale beyond founder-led selling?",
      angle: "Pressure acquisition loops, partnerships, data leverage, and defensibility.",
    },
  ],
  judge: [
    {
      focus: "Deal logic",
      question: "Why is this ask the right amount, what milestone does it unlock, and what makes the terms fair for investors?",
      angle: "Pressure valuation, risk, capital use, and investability.",
    },
    {
      focus: "Risk and return",
      question: "What is the biggest reason I should pass today, and what proof would change that decision?",
      angle: "Pressure downside risk, missing proof, and realistic deal conditions.",
    },
  ],
};

function normalizeRoomRounds(raw = {}, practiceContext) {
  const rounds = Array.isArray(raw.rounds) ? raw.rounds : [];
  return fallbackQuestions.slice(0, practiceContext.roundCount).map((fallback, index) => {
    const round = rounds[index] || {};
    return {
      id: `round-${index + 1}`,
      focus: sanitizeInput(round.focus, `Investor round ${index + 1}`).slice(0, 100),
      panelQuestion: sanitizeInput(round.panelQuestion || round.question, fallback).slice(0, 520),
      sharkAngles: {
        nemotron: sanitizeInput(round.sharkAngles?.nemotron, "Pressure the operating plan and capacity.").slice(0, 180),
        deepseek: sanitizeInput(round.sharkAngles?.deepseek, "Pressure the market and growth logic.").slice(0, 180),
        judge: sanitizeInput(round.sharkAngles?.judge, "Pressure the deal, risk, and valuation.").slice(0, 180),
      },
      userAnswer: "",
      sharkReactions: {},
      scores: {},
      interest: {},
      status: "awaiting-answer",
    };
  });
}

function normalizeSharkQuestionSet(rawQuestions = [], sharkKey, count) {
  const source = Array.isArray(rawQuestions) ? rawQuestions : [];
  const fallback = fallbackSharkQuestions[sharkKey] || fallbackSharkQuestions.judge;

  return Array.from({ length: count }, (_, index) => {
    const item = source[index] || {};
    const fallbackItem = fallback[index % fallback.length];
    return {
      askingShark: sharkKey,
      askingSharkLabel: sharkLabel(sharkKey),
      focus: sanitizeInput(item.focus, fallbackItem.focus).slice(0, 100),
      question: sanitizeInput(item.question || item.panelQuestion, fallbackItem.question).slice(0, 520),
      angle: sanitizeInput(item.angle, fallbackItem.angle).slice(0, 180),
    };
  });
}

function normalizeRoomRoundsFromSharkQuestions(questionSets = {}, practiceContext) {
  const perShark = practiceContext.questionsPerShark || 1;
  const ordered = [];
  for (let questionIndex = 0; questionIndex < perShark; questionIndex += 1) {
    for (const sharkKey of sharkKeys) {
      const question = questionSets[sharkKey]?.[questionIndex];
      if (question) {
        ordered.push(question);
      }
    }
  }

  return ordered.slice(0, practiceContext.roundCount).map((question, index) => ({
    id: `round-${index + 1}`,
    askingShark: question.askingShark,
    askingSharkLabel: question.askingSharkLabel,
    focus: question.focus,
    panelQuestion: question.question,
    sharkAngles: {
      nemotron:
        question.askingShark === "nemotron"
          ? question.angle
          : "React to the founder answer through operating rigor, capacity, margin, and execution risk.",
      deepseek:
        question.askingShark === "deepseek"
          ? question.angle
          : "React to the founder answer through growth, market wedge, distribution, and defensibility.",
      judge:
        question.askingShark === "judge"
          ? question.angle
          : "React to the founder answer through deal logic, risk, valuation, and investor terms.",
    },
    userAnswer: "",
    sharkReactions: {},
    scores: {},
    interest: {},
    status: "awaiting-answer",
  }));
}

function normalizeSharkReaction(raw = {}, sharkKey) {
  return {
    shark: sharkKey,
    label: sharkLabel(sharkKey),
    reaction: sanitizeInput(raw.reaction, "The answer needs clearer proof before this shark can move closer to a deal.").slice(0, 520),
    score: toScore(raw.score, 60),
    interest: toScore(raw.interest, 50),
    pressure: sanitizeInput(raw.pressure, "What proof can you show that this answer is repeatable?").slice(0, 260),
    dealSignal: sanitizeInput(raw.dealSignal, "Still evaluating.").slice(0, 220),
    investorNote: sanitizeInput(raw.investorNote, "Tighten the answer with customer proof, economics, and a milestone.").slice(0, 240),
  };
}

function normalizeOffer(raw = {}, sharkKey) {
  const decision = ["offer", "pass", "join"].includes(String(raw.decision || "").toLowerCase())
    ? String(raw.decision).toLowerCase()
    : "pass";
  return {
    shark: sharkKey,
    label: sharkLabel(sharkKey),
    decision,
    amount: decision === "pass" ? "" : sanitizeInput(raw.amount, "Conditional check pending diligence.").slice(0, 120),
    equity: decision === "pass" ? "" : sanitizeInput(raw.equity, "Negotiable").slice(0, 80),
    conditions: Array.isArray(raw.conditions)
      ? raw.conditions.slice(0, 5).map((item) => sanitizeInput(item).slice(0, 180))
      : [],
    rationale: sanitizeInput(raw.rationale, "The founder must show stronger proof before this shark commits.").slice(0, 520),
    improvementNote: sanitizeInput(raw.improvementNote, "Answer with sharper metrics, proof, risk control, and use of funds.").slice(0, 260),
    confidence: toScore(raw.confidence, decision === "pass" ? 35 : 68),
  };
}

function normalizeCounterResponse(raw = {}, sharkKey) {
  const decision = ["accept", "revise", "walk"].includes(String(raw.decision || "").toLowerCase())
    ? String(raw.decision).toLowerCase()
    : "revise";
  return {
    shark: sharkKey,
    label: sharkLabel(sharkKey),
    decision,
    revisedAmount: sanitizeInput(raw.revisedAmount, "").slice(0, 120),
    revisedEquity: sanitizeInput(raw.revisedEquity, "").slice(0, 80),
    conditions: Array.isArray(raw.conditions)
      ? raw.conditions.slice(0, 5).map((item) => sanitizeInput(item).slice(0, 180))
      : [],
    message: sanitizeInput(raw.message, "The shark needs clearer logic before changing terms.").slice(0, 520),
    finalAdvice: sanitizeInput(raw.finalAdvice, "Make the counter specific, rational, and tied to milestones.").slice(0, 260),
  };
}

async function repairCounterOfferResponse({ sharkKey, prompt, practiceContext, room, counter, rawOutput }) {
  const repairRole = sharkKey === "deepseek" ? modelConfig.nemotron : modelConfig.deepseek;
  const repairedText = await callText({
    role: repairRole,
    temperature: 0.16,
    maxTokens: 1400,
    messages: [
      {
        role: "system",
        content:
          "Write a final Shark Tank counter-offer response using only the requested labels. Do not copy placeholders, schema text, instructions, draft notes, markdown, or analysis.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Respond using exactly these labels:",
              "DECISION:",
              "REVISED AMOUNT:",
              "REVISED EQUITY:",
              "CONDITIONS:",
              "MESSAGE:",
              "FINAL ADVICE:",
              "",
              `Write as ${sharkLabel(sharkKey)}.`,
              sharkProfiles()[sharkKey].thesis,
              "decision must be accept, revise, or walk.",
              "If the founder materially solved your objections, revise into a conditional offer. If not, walk.",
              "",
              `Practice context:\n${practiceContextPrompt(practiceContext)}`,
              "",
              `Business prompt:\n${prompt}`,
              "",
              `Final deal before counter:\n${JSON.stringify(room.finalDeal)}`,
              "",
              `Founder counter-offer:\n${counter}`,
              "",
              `Malformed previous output:\n${rawOutput}`,
            ].join("\n"),
          },
        ],
      },
    ],
  });

  return normalizeCounterResponse(
    {
      decision: extractLabeledValue(repairedText, ["DECISION"]),
      revisedAmount: extractLabeledValue(repairedText, ["REVISED AMOUNT", "REVISED_AMOUNT"]),
      revisedEquity: extractLabeledValue(repairedText, ["REVISED EQUITY", "REVISED_EQUITY"]),
      conditions: parseListValue(extractLabeledValue(repairedText, ["CONDITIONS"])),
      message: extractLabeledValue(repairedText, ["MESSAGE"]),
      finalAdvice: extractLabeledValue(repairedText, ["FINAL ADVICE", "FINAL_ADVICE"]),
    },
    sharkKey,
  );
}

function isPlaceholderCounterResponse(response = {}) {
  const message = sanitizeInput(response.message);
  return (
    isPlaceholderText(response.message) ||
    isPlaceholderText(response.finalAdvice) ||
    message.length < 40
  );
}

function roomTotals(room) {
  const totals = {};
  const counts = {};
  for (const round of room.rounds || []) {
    for (const key of sharkKeys) {
      const score = Number(round.scores?.[key]);
      if (Number.isFinite(score)) {
        totals[key] = (totals[key] || 0) + score;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }

  return Object.fromEntries(
    sharkKeys.map((key) => [key, counts[key] ? Math.round(totals[key] / counts[key]) : null]),
  );
}

function dealOutcomeKey(outcome) {
  const normalized = sanitizeInput(outcome).toLowerCase();
  if (normalized.includes("no")) return "no_deal";
  if (normalized.includes("conditional")) return "conditional_deal";
  return "deal";
}

function isReportableDealOutcome(outcome) {
  return ["Deal", "Conditional deal", "No deal"].includes(sanitizeInput(outcome));
}

function saveRoom(room) {
  const now = new Date().toISOString();
  const createdAt = room.createdAt || now;
  const updatedRoom = { ...room, createdAt, updatedAt: now };
  db.prepare(
    "INSERT OR REPLACE INTO rooms (id, created_at, updated_at, status, prompt, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(updatedRoom.id, createdAt, now, updatedRoom.status, updatedRoom.prompt, JSON.stringify(updatedRoom));
  return updatedRoom;
}

function getRoom(id) {
  const row = db.prepare("SELECT data FROM rooms WHERE id = ?").get(id);
  if (!row) return null;
  return JSON.parse(row.data);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function winnerName(winner) {
  if (winner === "deal") return "Deal";
  if (winner === "conditional_deal") return "Conditional deal";
  if (winner === "no_deal") return "No deal";
  if (winner === "nemotron") return modelConfig.nemotron.label;
  if (winner === "deepseek") return modelConfig.deepseek.label;
  return "Tie";
}

function getCacheKey(prompt, practiceContext = normalizePracticeContext()) {
  const normalizedPrompt = sanitizeInput(prompt)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const modelSignature = JSON.stringify({
    nemotron: modelConfig.nemotron.model,
    nemotronBase: modelConfig.nemotron.baseUrl,
    deepseek: modelConfig.deepseek.model,
    deepseekBase: modelConfig.deepseek.baseUrl,
    judge: modelConfig.judge.model,
    judgeBase: modelConfig.judge.baseUrl,
  });

  return createHash("sha256")
    .update(`${CACHE_VERSION}\n${normalizedPrompt}\n${JSON.stringify(practiceContext)}\n${modelSignature}`)
    .digest("hex");
}

function getStepCacheKey({ prompt, step, extra = "", practiceContext = normalizePracticeContext() }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: CACHE_VERSION,
        prompt: sanitizeInput(prompt).toLowerCase().replace(/\s+/g, " ").trim(),
        practiceContext,
        step,
        extra,
        models: modelConfig,
      }),
    )
    .digest("hex");
}

async function withChunkCache({ prompt, practiceContext, step, extra, producer }) {
  const cacheKey = getStepCacheKey({ prompt, practiceContext, step, extra });
  const row = db.prepare("SELECT data FROM llm_chunks WHERE cache_key = ?").get(cacheKey);
  if (row) {
    return JSON.parse(row.data);
  }

  const data = await producer();
  db.prepare(
    "INSERT OR REPLACE INTO llm_chunks (cache_key, created_at, step, data) VALUES (?, ?, ?, ?)",
  ).run(cacheKey, new Date().toISOString(), step, JSON.stringify(data));
  return data;
}

async function withChunkCacheMeta({ prompt, practiceContext, step, extra, producer }) {
  const cacheKey = getStepCacheKey({ prompt, practiceContext, step, extra });
  const row = db.prepare("SELECT data FROM llm_chunks WHERE cache_key = ?").get(cacheKey);
  if (row) {
    return { cached: true, data: JSON.parse(row.data) };
  }

  const data = await producer();
  db.prepare(
    "INSERT OR REPLACE INTO llm_chunks (cache_key, created_at, step, data) VALUES (?, ?, ?, ?)",
  ).run(cacheKey, new Date().toISOString(), step, JSON.stringify(data));
  return { cached: false, data };
}

function saveReport(data, cacheKey) {
  if (cacheKey) {
    const existing = db.prepare("SELECT id, created_at FROM reports WHERE cache_key = ?").get(cacheKey);
    if (existing) {
      return { id: existing.id, createdAt: existing.created_at };
    }
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      "INSERT INTO reports (id, cache_key, created_at, title, winner, prompt, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      cacheKey || null,
      createdAt,
      data.businessTitle || "AI Shark Tank Report",
      data.winner || "tie",
      data.prompt || "",
      JSON.stringify({ ...data, reportId: id, reportUrl: `/reports/${id}`, generatedAt: data.generatedAt || createdAt }),
    );
  } catch (error) {
    const existing = cacheKey
      ? db.prepare("SELECT id, created_at FROM reports WHERE cache_key = ?").get(cacheKey)
      : null;
    if (existing) {
      return { id: existing.id, createdAt: existing.created_at };
    }

    throw error;
  }

  return { id, createdAt };
}

function updateReportData(id, data) {
  const existing = db.prepare("SELECT created_at FROM reports WHERE id = ?").get(id);
  if (!existing) return null;
  db.prepare("UPDATE reports SET winner = ?, title = ?, prompt = ?, data = ? WHERE id = ?").run(
    data.winner || "tie",
    data.businessTitle || "AI Shark Tank Report",
    data.prompt || "",
    JSON.stringify({ ...data, reportId: id, reportUrl: `/reports/${id}` }),
    id,
  );
  return { id, createdAt: existing.created_at };
}

function getReport(id) {
  const row = db.prepare("SELECT data FROM reports WHERE id = ?").get(id);
  return row
    ? {
        ...enrichReportData(JSON.parse(row.data)),
        drillAttempts: listDrillAttemptsForReport(id),
      }
    : null;
}

function derivePracticeDrills(report = {}) {
  const existing = normalizePracticeDrills(report.practiceDrills);
  if (existing.length) {
    return existing;
  }

  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  return rounds.slice(0, 3).map((round, index) => ({
    name: sanitizeInput(round.title || round.focus, `Round ${index + 1} Drill`).slice(0, 80),
    goal: sanitizeInput(
      round.focus,
      "Practice answering a real investor question from this room.",
    ).slice(0, 180),
    prompt: sanitizeInput(
      round.panelQuestion || round.question,
      "Answer this investor question in 45 seconds with one metric, one risk, and one next milestone.",
    ).slice(0, 320),
  }));
}

function enrichReportData(report = {}) {
  return {
    ...report,
    practiceDrills: derivePracticeDrills(report),
  };
}

function saveDrillAttempt({ reportId, drill, answer, feedback }) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO drill_attempts (id, report_id, created_at, drill_name, drill_prompt, answer, score, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    reportId || null,
    createdAt,
    drill.name,
    drill.prompt,
    answer,
    toScore(feedback.score),
    JSON.stringify({
      id,
      reportId: reportId || null,
      createdAt,
      drill,
      answer,
      feedback,
    }),
  );

  return { id, createdAt };
}

function drillAttemptFromRow(row) {
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }

  return {
    id: row.id,
    reportId: row.report_id,
    createdAt: row.created_at,
    drillName: row.drill_name,
    drillPrompt: row.drill_prompt,
    score: toScore(row.score),
    verdict: sanitizeInput(data.feedback?.verdict).slice(0, 180),
    nextPracticeMove: sanitizeInput(data.feedback?.nextPracticeMove).slice(0, 180),
  };
}

function listDrillAttempts(limit = 24) {
  const rows = db
    .prepare("SELECT id, report_id, created_at, drill_name, drill_prompt, score, data FROM drill_attempts ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(50, Number(limit) || 24)));

  return rows.map(drillAttemptFromRow);
}

function listDrillAttemptsForReport(reportId, limit = 8) {
  const rows = db
    .prepare("SELECT id, report_id, created_at, drill_name, drill_prompt, score, data FROM drill_attempts WHERE report_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(reportId, Math.max(1, Math.min(20, Number(limit) || 8)));

  return rows.map(drillAttemptFromRow);
}

function summarizeDrillAttempts(attempts) {
  const scores = attempts
    .map((attempt) => Number(attempt.score))
    .filter((score) => Number.isFinite(score));
  const latest = attempts[0] || null;
  const best = attempts.reduce((bestAttempt, attempt) => {
    if (!bestAttempt || attempt.score > bestAttempt.score) {
      return attempt;
    }
    return bestAttempt;
  }, null);

  const recent = attempts.slice(0, 5);
  const trend =
    scores.length >= 2
      ? scores[0] - scores[Math.min(scores.length - 1, 4)]
      : null;

  return {
    attemptCount: attempts.length,
    averageScore: scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null,
    bestScore: best?.score ?? null,
    latestScore: latest?.score ?? null,
    trend,
    latest,
    best,
    recent,
  };
}

function getWeakestSkill(skillScores) {
  if (!Array.isArray(skillScores)) {
    return null;
  }

  return skillScores
    .filter((skill) => Number.isFinite(Number(skill.score)))
    .reduce((weakest, skill) => {
      const current = {
        label: sanitizeInput(skill.label, "Skill"),
        score: toScore(skill.score),
        note: sanitizeInput(skill.note).slice(0, 160),
      };

      return !weakest || current.score < weakest.score ? current : weakest;
    }, null);
}

function countBy(items) {
  return items.reduce((counts, item) => {
    if (!item?.key || !item?.label) {
      return counts;
    }

    counts[item.key] ||= { key: item.key, label: item.label, count: 0 };
    counts[item.key].count += 1;
    return counts;
  }, {});
}

function sortedCounts(items) {
  return Object.values(countBy(items)).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function averageSkillScores(reports) {
  const buckets = new Map();

  for (const report of reports) {
    for (const skill of report.skillScores || []) {
      if (!skill?.key || !Number.isFinite(Number(skill.score))) {
        continue;
      }

      const existing = buckets.get(skill.key) || {
        key: skill.key,
        label: sanitizeInput(skill.label, skill.key),
        total: 0,
        count: 0,
        latestNote: "",
      };
      existing.total += toScore(skill.score);
      existing.count += 1;
      existing.latestNote ||= sanitizeInput(skill.note).slice(0, 160);
      buckets.set(skill.key, existing);
    }
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      score: Math.round(bucket.total / bucket.count),
      count: bucket.count,
      note: bucket.latestNote,
    }))
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

function objectiveForSkill(skillKey, fallback = "growth") {
  const map = {
    clarity: "clarity",
    proof: "clarity",
    economics: "economics",
    scale: "growth",
    moat: "growth",
    deal: "deal",
  };
  return map[skillKey] || fallback;
}

function practiceLabel(kind, key, fallback) {
  if (kind === "stage") {
    return practiceStages[key]?.label || fallback;
  }
  if (kind === "objective") {
    return practiceObjectives[key]?.label || fallback;
  }
  if (kind === "length") {
    return practiceLengths[key]?.label || fallback;
  }
  return fallback;
}

function createTrainingPlan({ reports, drillProgress, weakestAverage, latestDrill, recommendedSetup }) {
  if (!reports.length) {
    return [
      {
        title: "Set the baseline",
        action: "Run a Quick Room with your rough business idea.",
        detail: "Start with a short investor room so the app can identify the first weak skill.",
      },
      {
        title: "Tighten the pitch",
        action: "Open Founder Prep and use the rewritten pitch.",
        detail: "Practice one clean version before running a full investor duel.",
      },
      {
        title: "Save one drill",
        action: "Complete one shark-scored drill from the report.",
        detail: "The dashboard starts tracking your own score after the first answer.",
      },
    ];
  }

  const plan = [];
  plan.push({
    title: "Next room",
    action: `${recommendedSetup.lengthLabel}: ${recommendedSetup.stageLabel} / ${recommendedSetup.objectiveLabel}`,
    detail: recommendedSetup.reason,
  });

  if (weakestAverage) {
    plan.push({
      title: `Repair ${weakestAverage.label}`,
      action: `Answer three investor questions focused on ${weakestAverage.label.toLowerCase()}.`,
      detail: weakestAverage.note || `Average score is ${weakestAverage.score}; the next practice should target this skill directly.`,
    });
  } else {
    plan.push({
      title: "Create a fresh scorecard",
      action: "Run one new room so the sharks can generate readiness and skill scores.",
      detail: "Older reports may not include the newer skill map, so a fresh run improves the dashboard.",
    });
  }

  if (latestDrill) {
    plan.push({
      title: "Human rep",
      action: latestDrill.prompt,
      detail: drillProgress?.attemptCount
        ? `Latest drill score is ${drillProgress.latestScore ?? "-"}; try to beat your best score of ${drillProgress.bestScore ?? "-"}.`
        : "Score your own answer once so the dashboard can track founder improvement.",
    });
  } else {
    plan.push({
      title: "Generate drills",
      action: "Run a new report and open its practice drills.",
      detail: "Drills turn the simulation into active rehearsal instead of passive reading.",
    });
  }

  return plan.slice(0, 3);
}

function createPlanSetup({ latest, latestDrill, recommendedSetup, trainingPlan }) {
  const focusLine = trainingPlan
    .map((item, index) => `${index + 1}. ${item.title}: ${item.action}`)
    .join("\n");
  const drillLine = latestDrill
    ? `Human drill to practice:\n${latestDrill.prompt}`
    : "Human drill to practice:\nRun the room, open the report, and score one founder answer.";

  return {
    ...recommendedSetup,
    prompt: [
      latest?.prompt && `Business prompt:\n${latest.prompt}`,
      "Training focus:",
      focusLine,
      drillLine,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 5000),
  };
}

function listReports(limit = 24) {
  const rows = db
    .prepare("SELECT id, created_at, title, winner, prompt, data FROM reports ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(50, Number(limit) || 24)));

  return rows.map((row) => {
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      data = {};
    }

    const stage = data.practiceContext?.stage || "early";
    const objective = data.practiceContext?.objective || "growth";
    const length = data.practiceContext?.length || "full";

    return {
      id: row.id,
      createdAt: row.created_at,
      title: row.title,
      winner: row.winner,
      kind: data.kind || "pitch-duel",
      dealOutcome: data.finalDeal?.outcome || null,
      reportUrl: `/reports/${row.id}`,
      prompt: data.prompt || row.prompt || "",
      promptSummary: data.promptSummary || "",
      stage,
      stageLabel: practiceLabel("stage", stage, data.practiceContext?.stageLabel || "Practice"),
      objective,
      objectiveLabel: practiceLabel("objective", objective, data.practiceContext?.objectiveLabel || "Pitch"),
      length,
      lengthLabel: practiceLabel("length", length, data.practiceContext?.lengthLabel || `${Array.isArray(data.rounds) ? data.rounds.length : 0} rounds`),
      readinessScore: data.readinessScore ?? null,
      weakestSkill: getWeakestSkill(data.skillScores),
      skillScores: Array.isArray(data.skillScores) ? data.skillScores : [],
      practiceDrills: derivePracticeDrills(data),
      totals: data.totals || null,
      finalDeal: data.finalDeal || null,
    };
  });
}

function summarizeReports(reports, drillAttempts = []) {
  const readinessScores = reports
    .filter((report) => report.readinessScore != null)
    .map((report) => Number(report.readinessScore))
    .filter((score) => Number.isFinite(score));

  const skillAverages = averageSkillScores(reports);
  const weakestAverage = skillAverages[0] || null;
  const latest = reports[0] || null;
  const recommendedObjective = objectiveForSkill(weakestAverage?.key, latest?.objective || "growth");
  const latestDrill = reports.find((report) => report.practiceDrills?.length)?.practiceDrills?.[0] || null;
  const drillProgress = summarizeDrillAttempts(drillAttempts);
  const recommendedSetup = reports.length
    ? {
        stage: latest.stage || "early",
        stageLabel: latest.stageLabel || "Early Traction",
        objective: recommendedObjective,
        objectiveLabel: practiceObjectives[recommendedObjective]?.label || "Growth Plan",
        length: "quick",
        lengthLabel: practiceLengths.quick.label,
        reason: weakestAverage
          ? `${weakestAverage.label} is the lowest average skill, so the next quick room should target it.`
          : "Run a quick room next to create a fresher baseline.",
      }
    : {
        stage: "early",
        stageLabel: practiceStages.early.label,
        objective: "growth",
        objectiveLabel: practiceObjectives.growth.label,
        length: "quick",
        lengthLabel: practiceLengths.quick.label,
        reason: "Start with a short room to establish a baseline before running a full investor duel.",
      };

  const trainingPlan = createTrainingPlan({
    reports,
    drillProgress,
    weakestAverage,
    latestDrill,
    recommendedSetup,
  });

  return {
    sessionCount: reports.length,
    averageReadiness: readinessScores.length
      ? Math.round(readinessScores.reduce((sum, score) => sum + score, 0) / readinessScores.length)
      : null,
    bestReadiness: readinessScores.length ? Math.max(...readinessScores) : null,
    latestStage: reports[0]?.stageLabel || null,
    latestWinner: reports[0]?.winner || null,
    latestWeakestSkill: reports.find((report) => report.weakestSkill)?.weakestSkill || null,
    dashboard: {
      stageMix: sortedCounts(reports.map((report) => ({ key: report.stage, label: report.stageLabel }))),
      focusMix: sortedCounts(reports.map((report) => ({ key: report.objective, label: report.objectiveLabel }))),
      skillAverages,
      latestDrill,
      drillProgress,
      recommendedSetup,
      trainingPlan,
      planSetup: createPlanSetup({
        latest,
        latestDrill,
        recommendedSetup,
        trainingPlan,
      }),
    },
  };
}

function getCachedReport(cacheKey) {
  const row = db.prepare("SELECT data FROM reports WHERE cache_key = ?").get(cacheKey);
  if (!row) {
    return null;
  }

  const data = JSON.parse(row.data);
  return {
    ...enrichReportData(data),
    cached: true,
  };
}

function buildSimulationData({ prompt, practiceContext, brief, nemotron, deepseek, judgement, negotiation, report, currentRoundIndex }) {
  const partialRounds = brief.questions.map((question, index) => ({
    ...question,
    nemotron: nemotron?.answers?.[index] || null,
    deepseek: deepseek?.answers?.[index] || null,
    scores: judgement?.rounds?.[index]?.scores || null,
    winner: judgement?.rounds?.[index]?.winner || null,
    judgeComment: judgement?.rounds?.[index]?.judgeComment || "",
  }));

  return {
    generatedAt: report?.createdAt || new Date().toISOString(),
    prompt,
    practiceContext,
    models: modelConfig,
    businessTitle: brief.businessTitle,
    promptSummary: brief.promptSummary,
    promptDiagnostics: brief.promptDiagnostics || null,
    facts: brief.facts,
    nemotron: {
      label: modelConfig.nemotron.label,
      model: modelConfig.nemotron.model,
      openingPosition: nemotron?.openingPosition || `${modelConfig.nemotron.label} is preparing its pitch.`,
    },
    deepseek: {
      label: modelConfig.deepseek.label,
      model: modelConfig.deepseek.model,
      openingPosition: deepseek?.openingPosition || "DeepSeek is preparing its pitch.",
    },
    judge: {
      label: modelConfig.judge.label,
      model: modelConfig.judge.model,
    },
    rounds: judgement?.rounds || partialRounds,
    totals: judgement?.totals || null,
    winner: judgement?.winner || null,
    verdict: judgement?.verdict || "",
    strongestMoment: judgement?.strongestMoment || "",
    weakestMoment: judgement?.weakestMoment || "",
    nextPractice: judgement?.nextPractice || [],
    readinessScore: judgement?.readinessScore || null,
    skillScores: judgement?.skillScores || [],
    practiceDrills: judgement?.practiceDrills || [],
    rewrittenPitch: judgement?.rewrittenPitch || "",
    investorHooks: judgement?.investorHooks || [],
    investorObjections: judgement?.investorObjections || [],
    nextDataToCollect: judgement?.nextDataToCollect || [],
    recommendedAskFraming: judgement?.recommendedAskFraming || "",
    negotiation: negotiation || null,
    reportId: report?.id || null,
    reportUrl: report?.id ? `/reports/${report.id}` : null,
    currentRoundIndex,
  };
}

