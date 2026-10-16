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

