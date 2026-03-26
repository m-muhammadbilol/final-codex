import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import fetch from "node-fetch";
import FormData from "form-data";
import { v4 as uuidv4 } from "uuid";
import {
  KOTIBA_BASE_SYSTEM_PROMPT,
  KOTIBA_DESIGN_SYSTEM_PROMPT,
  isDesignOrProductRequest,
} from "./prompts/kotiba-system-prompt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const publicDir = path.resolve(__dirname, "../public");
const frontendDistDir = path.resolve(__dirname, "../frontend/dist");
const frontendStaticDir = fs.existsSync(publicDir) ? publicDir : frontendDistDir;
const hasFrontendStatic = fs.existsSync(frontendStaticDir);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
if (hasFrontendStatic) {
  app.use(express.static(frontendStaticDir));
}

const bundledDbFile = path.join(__dirname, "db.json");
const dbFile = process.env.VERCEL ? path.join("/tmp", "kotiba-db.json") : bundledDbFile;

if (process.env.VERCEL && !fs.existsSync(dbFile)) {
  if (fs.existsSync(bundledDbFile)) {
    fs.copyFileSync(bundledDbFile, dbFile);
  } else {
    fs.writeFileSync(dbFile, JSON.stringify({ tasks: [], reminders: [], expenses: [] }, null, 2));
  }
}

const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data ||= { tasks: [], reminders: [], expenses: [] };
  db.data.tasks ||= [];
  db.data.reminders ||= [];
  db.data.expenses ||= [];
  db.data.reminders = db.data.reminders.map((reminder) => ({
    done: false,
    ...reminder
  }));
  await db.write();
}

await initDb();

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // moved inside function

// Express upload middleware for audio blob
const upload = multer({ storage: multer.memoryStorage() });

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || 4000;

// util
const safeJsDate = (s) => (s ? new Date(s) : new Date());

function formatTime(t) {
  const d = safeJsDate(t);
  return d.toLocaleString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
}

function normalizeUzbekText(text = "") {
  return text
    .toLowerCase()
    .replace(/[’`ʻ‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function formatUzbekDateTime(value) {
  const date = safeJsDate(value);
  return date.toLocaleString("uz-UZ", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatMoney(amount = 0, currency = "UZS") {
  const numeric = Number(amount) || 0;
  const formatted = numeric.toLocaleString("uz-UZ", {
    minimumFractionDigits: currency === "USD" && numeric % 1 !== 0 ? 2 : 0,
    maximumFractionDigits: currency === "USD" ? 2 : 0
  });

  return currency === "USD" ? `${formatted} $` : `${formatted} so'm`;
}

function startOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function getExpensePeriodRange(period = "today") {
  const now = new Date();

  if (period === "week") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 6);
    return { start, end: endOfDay(now) };
  }

  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: startOfDay(start), end: endOfDay(now) };
  }

  return { start: startOfDay(now), end: endOfDay(now) };
}

function getExpensePeriodLabel(period = "today") {
  if (period === "week") return "Bu hafta";
  if (period === "month") return "Bu oy";
  return "Bugun";
}

function parseExpensePeriodFromText(normalized = "") {
  if (/\b(oylik|bu oy|shu oy|oy bo'yicha)\b/.test(normalized)) return "month";
  if (/\b(haftalik|bu hafta|shu hafta)\b/.test(normalized)) return "week";
  return "today";
}

function buildExpenseTitle(text = "") {
  const cleaned = text
    .replace(/(\d+(?:[.,]\d+)?)\s*(ming|mln|million)?\s*(\$|usd|dollar|so'm|som|s[oʻ'`’]?m)?/i, "")
    .replace(/\b(bugun|kecha|ertaga|ishlatdim|sarfladim|xarajat|xarajatim|ketdi|qildi|bo'ldi|to'ladim|tulov|sarf)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,:.\-\s]+|[,:.\-\s]+$/g, "")
    .trim();

  return cleaned || "Xarajat";
}

function extractExpensePayload(text = "") {
  const normalized = normalizeUzbekText(text);
  const amountMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(ming|mln|million)?\s*(\$|usd|dollar|so'm|som|s[oʻ'`’]?m)?/i);
  if (!amountMatch) return null;

  let amount = Number.parseFloat(amountMatch[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;

  const unit = amountMatch[2] || "";
  const currencyToken = amountMatch[3] || "";

  if (/ming/.test(unit)) amount *= 1000;
  if (/mln|million/.test(unit)) amount *= 1000000;

  const currency = /\$|usd|dollar/.test(currencyToken) ? "USD" : "UZS";
  const occurredAt = startOfDay(new Date());

  if (/\bkecha\b/.test(normalized)) {
    occurredAt.setDate(occurredAt.getDate() - 1);
  } else if (/\bertaga\b/.test(normalized)) {
    occurredAt.setDate(occurredAt.getDate() + 1);
  }

  return {
    id: uuidv4(),
    title: buildExpenseTitle(text),
    amount,
    currency,
    createdAt: new Date().toISOString(),
    occurredAt: occurredAt.toISOString(),
    rawText: text.trim()
  };
}

function summarizeExpenses(expenses = [], period = "today") {
  const { start, end } = getExpensePeriodRange(period);
  const filtered = expenses.filter((expense) => {
    const value = new Date(expense.occurredAt || expense.createdAt).getTime();
    return value >= start.getTime() && value <= end.getTime();
  });

  const totals = filtered.reduce(
    (acc, expense) => {
      const currency = expense.currency === "USD" ? "USD" : "UZS";
      acc[currency] += Number(expense.amount) || 0;
      return acc;
    },
    { UZS: 0, USD: 0 }
  );

  return { items: filtered, totals, period };
}

function formatExpenseTotals(totals = {}) {
  const parts = [];
  if (totals.UZS > 0) parts.push(formatMoney(totals.UZS, "UZS"));
  if (totals.USD > 0) parts.push(formatMoney(totals.USD, "USD"));
  return parts.join(" va ");
}

function buildExpenseSummaryText(summary) {
  const label = getExpensePeriodLabel(summary.period);
  const totalsText = formatExpenseTotals(summary.totals);

  if (!totalsText) {
    return `${label} xarajat yozilmagan.`;
  }

  return `${label} xarajat: ${totalsText}.`;
}

function getGeminiApiKey() {
  const explicitGeminiKey = process.env.GEMINI_API_KEY;
  if (explicitGeminiKey) return explicitGeminiKey;

  const legacyKey = process.env.OPENAI_API_KEY;
  if (legacyKey && /^AIza/.test(legacyKey)) return legacyKey;

  return null;
}

function getGeminiApiUrl(model) {
  const baseUrl = process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
  const normalizedModel = model.startsWith("models/") ? model : `models/${model}`;
  return `${baseUrl}/${normalizedModel}:generateContent`;
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildGeminiSystemInstruction(text) {
  const designMode = isDesignOrProductRequest(text);
  const promptSections = [KOTIBA_BASE_SYSTEM_PROMPT];
  const appendPrompt = process.env.GEMINI_SYSTEM_PROMPT_APPEND?.trim();

  if (designMode) {
    promptSections.push(KOTIBA_DESIGN_SYSTEM_PROMPT);
  }

  if (appendPrompt) {
    promptSections.push(`Qo'shimcha loyiha ko'rsatmasi:\n${appendPrompt}`);
  }

  promptSections.push(`
Texnik javob formati:
- Har doim faqat bitta JSON obyekt qaytaring.
- replyText foydalanuvchiga ko'rinadigan yakuniy matn bo'lsin.
- intent faqat quyidagi qiymatlardan biri bo'lsin: general_chat, time_check, date_check, task_create, task_list, task_complete, reminder_create, reminder_list, agenda_today, agenda_tomorrow, expense_create, expense_list, expense_summary_today, expense_summary_week, expense_summary_month.
- action null yoki kichik obyekt bo'lsin.
- Agar foydalanuvchi dizayn, product strategy, UI/UX yoki app structure haqida so'rasa, intent="general_chat" va action=null ishlating.
- Agar foydalanuvchi task yoki eslatma yaratmoqchi bo'lsa, intentni to'g'ri tanlang.
- replyText qisqa bo'lishi shart emas; dizayn va product savollarida u batafsil va bo'limlarga ajratilgan bo'lishi mumkin.
`.trim());

  return {
    designMode,
    systemInstruction: promptSections.join("\n\n")
  };
}

function getUzbekVoiceHeaders(extraHeaders = {}) {
  const apiKey = process.env.UZBEKVOICEAI_API_KEY;
  if (!apiKey) throw new Error("UZBEKVOICEAI_API_KEY missing");

  return {
    Authorization: apiKey,
    ...extraHeaders
  };
}

async function readErrorBody(resp) {
  try {
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return JSON.stringify(await resp.json());
    }

    return await resp.text();
  } catch {
    return "";
  }
}

function extractTranscriptFromResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.transcript === "string" && payload.transcript.trim()) return payload.transcript.trim();
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
  if (typeof payload.result?.text === "string" && payload.result.text.trim()) return payload.result.text.trim();
  return null;
}

function isRecoverableVoiceProviderError(message = "") {
  return /insufficient funds|missing|failed \((401|402|403|429|5\d\d)\)/i.test(String(message));
}

async function fetchAudioAsDataUrl(url, apiKey) {
  const response = await fetch(url, {
    headers: apiKey ? { Authorization: apiKey } : {}
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(`TTS audio fetch failed (${response.status}): ${details || response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "audio/mpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function extractAudioDataUrlFromTtsResponse(resp) {
  const contentType = resp.headers.get("content-type") || "";

  if (contentType.startsWith("audio/")) {
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }

  const json = await resp.json();

  const directAudio =
    json.audio ??
    json.audio_base64 ??
    json.data ??
    json.result?.audio ??
    json.result?.audio_base64 ??
    json.result?.data;

  if (typeof directAudio === "string" && directAudio.startsWith("data:audio")) {
    return directAudio;
  }

  if (typeof directAudio === "string" && directAudio.trim()) {
    const audioFormat = json.format ?? json.result?.format ?? process.env.UZBEKVOICEAI_TTS_AUDIO_FORMAT ?? "mp3";
    return `data:audio/${audioFormat};base64,${directAudio.trim()}`;
  }

  const remoteAudioUrl =
    json.audio_url ??
    json.url ??
    json.file_url ??
    json.result?.audio_url ??
    json.result?.url ??
    json.result?.file_url;

  if (typeof remoteAudioUrl === "string" && remoteAudioUrl.trim()) {
    return fetchAudioAsDataUrl(remoteAudioUrl.trim(), process.env.UZBEKVOICEAI_API_KEY);
  }

  throw new Error(`TTS invalid payload: ${JSON.stringify(json)}`);
}

async function keyToTextFromGemini(text) {
  const geminiApiKey = getGeminiApiKey();
  if (!geminiApiKey) return null;

  try {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const { designMode, systemInstruction } = buildGeminiSystemInstruction(text);
    const responseSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        replyText: { type: "string" },
        intent: {
          type: "string",
          enum: [
            "general_chat",
            "time_check",
            "date_check",
            "task_create",
            "task_list",
            "task_complete",
            "reminder_create",
            "reminder_list",
            "agenda_today",
            "agenda_tomorrow",
            "expense_create",
            "expense_list",
            "expense_summary_today",
            "expense_summary_week",
            "expense_summary_month"
          ]
        },
        action: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                title: { type: "string" },
                timeText: { type: "string" },
                repeat: { type: "string" }
              }
            }
          ]
        }
      },
      required: ["replyText", "intent", "action"]
    };

    const resp = await fetch(`${getGeminiApiUrl(model)}?key=${encodeURIComponent(geminiApiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `Foydalanuvchi matni: "${text}"` }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema,
          temperature: designMode ? 0.35 : 0.2,
          maxOutputTokens: designMode
            ? parseIntegerEnv(process.env.GEMINI_DESIGN_MAX_OUTPUT_TOKENS, 1800)
            : parseIntegerEnv(process.env.GEMINI_MAX_OUTPUT_TOKENS, 450)
        }
      })
    });

    if (!resp.ok) {
      const details = await readErrorBody(resp);
      const error = new Error(`Gemini request failed (${resp.status}): ${details || resp.statusText}`);
      error.status = resp.status;
      error.details = details;
      throw error;
    }

    const payload = await resp.json();
    const content = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!content) {
      const reason = payload?.promptFeedback?.blockReason || payload?.candidates?.[0]?.finishReason || "EMPTY_RESPONSE";
      throw new Error(`Gemini javobi bo'sh: ${reason}`);
    }

    const jsonText = content.trim().replace(/^```json/, "").replace(/```$/, "").trim();
    return JSON.parse(jsonText);
  } catch (err) {
    if (err?.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(err?.message || "")) {
      throw err;
    }

    console.error("Gemini parse error", err);
    return null;
  }
}

async function sendToGeminiEcho(text) {
  try {
    const parsed = await keyToTextFromGemini(text);
    if (parsed && parsed.replyText) return parsed;

    // fallback heuristic if Gemini doesn't return expected format
    const heuristic = { replyText: "Hmm, so'rovni tushunmadim, iltimos qaytadan so'rang.", intent: "general_chat", action: null };
    const normalized = normalizeUzbekText(text);
    const isTimeQuestion =
      /(hozir.*soat|soat.*nech|nechchi|nechta|qancha vaqt|vaqt qancha|soat nechi|soat netchi)/.test(normalized);
    const isDateQuestion = /(bugun sana|bugun nima kun|sana qanday|bugungi sana)/.test(normalized);
    const isExpenseCreate =
      /(\d|\$|dollar|usd|so'm|som|s[oʻ'`’]?m)/.test(normalized) &&
      /(ishlatdim|sarfladim|xarajat|ketdi|to'ladim|qildi|bo'ldi|sarf)/.test(normalized);
    const isExpenseList = /(xarajatlarim|sarflarim|xarajatlar ro'yxati)/.test(normalized);
    const isExpenseSummary = /(xarajat|sarf)/.test(normalized) && /(hisobla|qancha|necha|ko'rsat)/.test(normalized);

    if (isTimeQuestion) {
      heuristic.replyText = `Hozirgi vaqt: ${formatTime(new Date())}`;
      heuristic.intent = "time_check";
    } else if (isDateQuestion) {
      heuristic.replyText = `Bugun ${new Date().toLocaleDateString("uz-UZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
      heuristic.intent = "date_check";
    } else if (/(tasklarim|vazifalarim)/.test(normalized)) {
      heuristic.replyText = "Vazifalaringizni ko'rsataman.";
      heuristic.intent = "task_list";
    } else if (/(task|vazifa).*(qo'sh|qosh|qoʻsh)|^(task|vazifa)\b/.test(normalized)) {
      heuristic.replyText = "Xo'p, vazifa qo'shaman.";
      heuristic.intent = "task_create";
    } else if (/(eslatmalarim|reminderlarim|eslatmalar ro'yxati)/.test(normalized)) {
      heuristic.replyText = "Eslatmalaringizni ko'rsataman.";
      heuristic.intent = "reminder_list";
    } else if (/(eslat|uyg'ot|uygot|soat\s*\d|ertaga.*soat|bugun.*soat|har kuni)/.test(normalized)) {
      heuristic.replyText = "Xo'p, eslatma yarataman.";
      heuristic.intent = "reminder_create";
    } else if (isExpenseCreate) {
      heuristic.replyText = "Xo'p, xarajatni yozib qo'yaman.";
      heuristic.intent = "expense_create";
    } else if (isExpenseList) {
      heuristic.replyText = "Xarajatlaringizni ko'rsataman.";
      heuristic.intent = "expense_list";
    } else if (isExpenseSummary) {
      const period = parseExpensePeriodFromText(normalized);
      heuristic.replyText = "Xarajatlaringizni hisoblayman.";
      heuristic.intent =
        period === "month"
          ? "expense_summary_month"
          : period === "week"
            ? "expense_summary_week"
            : "expense_summary_today";
    } else if (/bugun.*reja|bugungi reja/.test(normalized)) {
      heuristic.replyText = "Bugungi rejangizni tekshiraman.";
      heuristic.intent = "agenda_today";
    } else if (/ertaga/.test(normalized)) {
      heuristic.replyText = "Ertangi rejangizni tekshiraman.";
      heuristic.intent = "agenda_tomorrow";
    }

    return heuristic;
  } catch (err) {
    if (err?.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(err?.message || "")) {
      console.error("Gemini quota exhausted", err);
      return {
        replyText:
          "Gemini limiti tugagan. Iltimos, keyinroq qayta urinib ko'ring yoki yangi Gemini API kaliti bilan davom eting.",
        intent: "general_chat",
        action: null
      };
    }

    console.error(err);
    return { replyText: "Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.", intent: "error", action: null };
  }
}

async function buildActionFromIntent(parsedIntent, text) {
  const normalized = normalizeUzbekText(text);
  if (parsedIntent === "task_create" || /\btask\b/.test(normalized) || /\bvazifa\b/.test(normalized)) {
    const description = text
      .replace(/.*?(?:task|vazifa)\s*(?:qo['’`‘ʻ]?sh|qosh|qoʻsh)?\s*:?\s*/i, "")
      .replace(/^\s*(?:qo['’`‘ʻ]?sh|qosh|qoʻsh)\s*/i, "")
      .trim();
    if (!description) return { needClarification: "Task nomini ayting" };
    return { type: "task_create", payload: { id: uuidv4(), title: description, completed: false, createdAt: new Date().toISOString() } };
  }

  if (parsedIntent === "task_list" || /tasklarim|vazifalarim/.test(normalized)) {
    return { type: "task_list" };
  }

  if (parsedIntent === "task_complete" || /bajarildi/.test(normalized)) {
    const idMatch = normalized.match(/(?:birinchi|1-chi|1chi|first).*task/);
    return { type: "task_complete", payload: { token: idMatch ? "first" : null } };
  }

  if (parsedIntent === "reminder_create" || /eslat|uyg'ot|uygot/.test(normalized) || /\bsoat\s*\d/.test(normalized)) {
    let dueDate = null;
    const relativeHoursMatch = normalized.match(/(\d{1,2})\s*soat(?:dan)?\s*keyin/);
    const absoluteTimeMatch = normalized.match(/(?:bugun|ertaga)?\s*soat\s*(\d{1,2})(?::(\d{2}))?/);
    const hasTomorrow = /\bertaga\b/.test(normalized);
    const hasToday = /\bbugun\b/.test(normalized);

    if (relativeHoursMatch) {
      dueDate = new Date(Date.now() + parseInt(relativeHoursMatch[1], 10) * 60 * 60 * 1000);
    } else if (absoluteTimeMatch) {
      const now = new Date();
      dueDate = new Date(now);
      dueDate.setSeconds(0, 0);
      dueDate.setHours(parseInt(absoluteTimeMatch[1], 10), parseInt(absoluteTimeMatch[2] ?? "0", 10), 0, 0);

      if (hasTomorrow) {
        dueDate.setDate(dueDate.getDate() + 1);
      } else if (!hasToday && dueDate.getTime() <= now.getTime()) {
        dueDate.setDate(dueDate.getDate() + 1);
      }
    }

    let repeat = null;
    const everyMinutesMatch = normalized.match(/har\s*(\d+)\s*minut/);
    if (everyMinutesMatch) {
      repeat = everyMinutesMatch[1];
    } else if (/har\s*kuni/.test(normalized)) {
      repeat = String(24 * 60);
    } else if (/har\s*hafta/.test(normalized)) {
      repeat = String(7 * 24 * 60);
    }

    return {
      type: "reminder_create",
      payload: {
        id: uuidv4(),
        title: text.trim(),
        time: (dueDate || new Date()).toISOString(),
        repeat
      }
    };
  }

  if (parsedIntent === "reminder_list" || /eslatmalarim|reminder/.test(normalized)) {
    return { type: "reminder_list" };
  }

  if (
    parsedIntent === "expense_create" ||
    (/(ishlatdim|sarfladim|xarajat|ketdi|to'ladim|qildi|bo'ldi|sarf)/.test(normalized) &&
      /(\d|\$|dollar|usd|so'm|som|s[oʻ'`’]?m)/.test(normalized))
  ) {
    const payload = extractExpensePayload(text);
    if (!payload) return { needClarification: "Qancha xarajat qilganingizni ayting." };
    return { type: "expense_create", payload };
  }

  if (parsedIntent === "expense_list" || /xarajatlarim|sarflarim|xarajatlar ro'yxati/.test(normalized)) {
    return { type: "expense_list" };
  }

  if (
    parsedIntent === "expense_summary_today" ||
    parsedIntent === "expense_summary_week" ||
    parsedIntent === "expense_summary_month" ||
    (/(xarajat|sarf)/.test(normalized) && /(hisobla|qancha|necha|ko'rsat)/.test(normalized))
  ) {
    const period =
      parsedIntent === "expense_summary_month"
        ? "month"
        : parsedIntent === "expense_summary_week"
          ? "week"
          : parsedIntent === "expense_summary_today"
            ? "today"
            : parseExpensePeriodFromText(normalized);

    return { type: "expense_summary", payload: { period } };
  }

  if (parsedIntent === "agenda_today" || /bugun.*reja|bugungi/.test(normalized)) {
    return { type: "agenda_today" };
  }

  if (parsedIntent === "agenda_tomorrow" || /ertaga/.test(normalized)) {
    return { type: "agenda_tomorrow" };
  }

  return { type: "general_chat" };
}

function buildReplyFromAction(actionPlan, actionResult, uiResponse, fallbackReply) {
  switch (actionPlan.type) {
    case "task_create":
      if (actionResult?.task) {
        return `Xo'p, "${actionResult.task.title}" vazifasini qo'shdim.`;
      }
      break;
    case "task_list":
      return `Sizda ${uiResponse?.tasks?.length ?? 0} ta vazifa bor.`;
    case "task_complete":
      if (actionResult?.task) {
        return `Xo'p, "${actionResult.task.title}" vazifasi bajarildi deb belgilandi.`;
      }
      break;
    case "reminder_create":
      if (actionResult?.reminder) {
        return `Xo'p, "${actionResult.reminder.title}" uchun ${formatUzbekDateTime(actionResult.reminder.time)} ga eslatma qo'ydim.`;
      }
      break;
    case "reminder_list":
      return `Sizda ${uiResponse?.reminders?.length ?? 0} ta eslatma bor.`;
    case "expense_create":
      if (actionResult?.expense) {
        return `Xo'p, ${formatMoney(actionResult.expense.amount, actionResult.expense.currency)} xarajatni yozdim.`;
      }
      break;
    case "expense_list":
      return `Sizda ${uiResponse?.expenses?.length ?? 0} ta xarajat yozuvi bor.`;
    case "expense_summary":
      if (actionResult?.summary) {
        return buildExpenseSummaryText(actionResult.summary);
      }
      break;
    case "agenda_today":
    case "agenda_tomorrow":
      if (fallbackReply) return fallbackReply;
      break;
    default:
      break;
  }

  return fallbackReply;
}

async function sendTextToTTS(text, modelOverride = null) {
  const ttsUrl = process.env.UZBEKVOICEAI_TTS_URL || "https://uzbekvoice.ai/api/v1/tts";
  const ttsModel = modelOverride || process.env.UZBEKVOICEAI_TTS_MODEL || "lola";
  const blocking = parseBooleanEnv(process.env.UZBEKVOICEAI_TTS_BLOCKING, true);
  const webhookNotificationUrl = process.env.UZBEKVOICEAI_WEBHOOK_NOTIFICATION_URL;

  const resp = await fetch(ttsUrl, {
    method: "POST",
    headers: getUzbekVoiceHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      text,
      model: ttsModel,
      blocking: String(blocking),
      ...(webhookNotificationUrl ? { webhook_notification_url: webhookNotificationUrl } : {})
    })
  });

  if (!resp.ok) {
    const details = await readErrorBody(resp);
    throw new Error(`TTS request failed (${resp.status}): ${details || resp.statusText}`);
  }

  return extractAudioDataUrlFromTtsResponse(resp);
}

async function sendAudioToSTT(fileBuffer, mimetype) {
  const sttUrl = process.env.UZBEKVOICEAI_STT_URL || "https://uzbekvoice.ai/api/v1/stt";
  const language = process.env.UZBEKVOICEAI_STT_LANGUAGE || "uz";
  const blocking = parseBooleanEnv(process.env.UZBEKVOICEAI_STT_BLOCKING, true);
  const returnOffsets = parseBooleanEnv(process.env.UZBEKVOICEAI_STT_RETURN_OFFSETS, false);
  const diarization = process.env.UZBEKVOICEAI_STT_RUN_DIARIZATION || "false";
  const webhookNotificationUrl = process.env.UZBEKVOICEAI_WEBHOOK_NOTIFICATION_URL;

  const formData = new FormData();
  formData.append("file", fileBuffer, { filename: "voice.webm", contentType: mimetype || "audio/webm" });
  formData.append("return_offsets", String(returnOffsets));
  formData.append("run_diarization", diarization);
  formData.append("language", language);
  formData.append("blocking", String(blocking));
  if (webhookNotificationUrl) {
    formData.append("webhook_notification_url", webhookNotificationUrl);
  }

  const headers = getUzbekVoiceHeaders(formData.getHeaders ? formData.getHeaders() : {});

  const resp = await fetch(sttUrl, {
    method: "POST",
    headers,
    body: formData
  });

  if (!resp.ok) {
    const details = await readErrorBody(resp);
    throw new Error(`STT request failed (${resp.status}): ${details || resp.statusText}`);
  }

  const json = await resp.json();
  const transcript = extractTranscriptFromResponse(json);

  if (!transcript) throw new Error(`STT transcript missing: ${JSON.stringify(json)}`);
  return transcript;
}

app.get("/api/health", async (req, res) => {
  res.json({ status: "ok", version: "1.0.0", uptime: process.uptime() });
});

app.get("/api/tasks", async (req, res) => {
  await db.read();
  return res.json({ tasks: db.data.tasks || [] });
});

app.post("/api/tasks", async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });

  const task = { id: uuidv4(), title: title.toString(), completed: false, createdAt: new Date().toISOString() };
  await db.read();
  db.data.tasks.push(task);
  await db.write();
  res.json({ task });
});

app.patch("/api/tasks/:id/complete", async (req, res) => {
  const { id } = req.params;
  await db.read();
  const task = db.data.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: "not found" });
  task.completed = true;
  await db.write();
  res.json({ task });
});

app.put("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  await db.read();
  const task = db.data.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: "not found" });
  if (title) task.title = title;
  await db.write();
  res.json({ task });
});

app.get("/api/reminders", async (req, res) => {
  await db.read();
  return res.json({ reminders: db.data.reminders || [] });
});

app.post("/api/reminders", async (req, res) => {
  const { title, time, repeat } = req.body;
  if (!title || !time) return res.status(400).json({ error: "title and time required" });

  const reminder = { id: uuidv4(), title, time, repeat: repeat || null, createdAt: new Date().toISOString(), done: false };
  await db.read();
  db.data.reminders.push(reminder);
  await db.write();
  res.json({ reminder });
});

app.patch("/api/reminders/:id", async (req, res) => {
  const { id } = req.params;
  const { title, time, repeat, done } = req.body;

  await db.read();
  const reminder = db.data.reminders.find((item) => item.id === id);
  if (!reminder) return res.status(404).json({ error: "not found" });

  if (title !== undefined) reminder.title = String(title);
  if (time !== undefined) reminder.time = time;
  if (repeat !== undefined) reminder.repeat = repeat;
  if (done !== undefined) reminder.done = Boolean(done);

  await db.write();
  res.json({ reminder });
});

app.delete("/api/reminders/:id", async (req, res) => {
  const { id } = req.params;

  await db.read();
  const reminderIndex = db.data.reminders.findIndex((item) => item.id === id);
  if (reminderIndex === -1) return res.status(404).json({ error: "not found" });

  const [reminder] = db.data.reminders.splice(reminderIndex, 1);
  await db.write();
  res.json({ reminder });
});

app.delete("/api/reminders", async (req, res) => {
  await db.read();
  const deleted = [...db.data.reminders];
  db.data.reminders = [];
  await db.write();
  res.json({ reminders: deleted });
});

app.get("/api/expenses", async (req, res) => {
  await db.read();
  const expenses = [...(db.data.expenses || [])].sort(
    (a, b) => new Date(b.occurredAt || b.createdAt || 0).getTime() - new Date(a.occurredAt || a.createdAt || 0).getTime()
  );
  return res.json({ expenses });
});

app.post("/api/expenses", async (req, res) => {
  const { title, amount, currency = "UZS", occurredAt } = req.body;
  const numericAmount = Number(amount);

  if (!title || !Number.isFinite(numericAmount)) {
    return res.status(400).json({ error: "title and valid amount required" });
  }

  const expense = {
    id: uuidv4(),
    title: String(title),
    amount: numericAmount,
    currency: currency === "USD" ? "USD" : "UZS",
    occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
    createdAt: new Date().toISOString(),
    rawText: String(title)
  };

  await db.read();
  db.data.expenses.push(expense);
  await db.write();
  res.json({ expense });
});

app.delete("/api/expenses/:id", async (req, res) => {
  const { id } = req.params;
  await db.read();

  const expenseIndex = db.data.expenses.findIndex((item) => item.id === id);
  if (expenseIndex === -1) return res.status(404).json({ error: "not found" });

  const [expense] = db.data.expenses.splice(expenseIndex, 1);
  await db.write();
  res.json({ expense });
});

app.post("/api/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "audio file required" });
    const transcript = await sendAudioToSTT(req.file.buffer, req.file.mimetype);
    if (!transcript || !transcript.trim()) {
      return res.status(200).json({ transcript: "", userMessage: "Sizni yaxshi tushunmadim, yana bir bor ayting." });
    }

    res.json({ transcript });
  } catch (err) {
    console.error("/api/stt", err);
    if (isRecoverableVoiceProviderError(err?.message)) {
      return res.json({
        transcript: "",
        fallback: "browser_speech",
        message: "Bulut STT hozir ishlamadi. Brauzer orqali gapirish rejimiga o'ting."
      });
    }

    res.status(500).json({ error: "STT xatolik yuz berdi", message: err.message });
  }
});

app.post("/api/assistant", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ replyText: "Sizni yaxshi tushunmadim, yana bir bor ayting.", type: "error" });

    const gemini = await sendToGeminiEcho(text);
    if (!gemini) {
      return res.status(500).json({ replyText: "Xatolik yuz berdi. Iltimos, qayta urinib ko‘ring.", action: null });
    }

    const actionPlan = await buildActionFromIntent(gemini.intent, text);
    if (actionPlan.needClarification) {
      return res.json({
        replyText: actionPlan.needClarification,
        intent: gemini.intent,
        uiResponse: null,
        actionResult: null
      });
    }

    let actionResult = null;
    let uiResponse = null;

    // Handle action plan
    switch (actionPlan.type) {
      case "task_create": {
        const task = actionPlan.payload;
        await db.read();
        db.data.tasks.push(task);
        await db.write();
        actionResult = { task };
        uiResponse = { tasks: db.data.tasks };
        break;
      }
      case "task_list": {
        await db.read();
        uiResponse = { tasks: db.data.tasks };
        break;
      }
      case "task_complete": {
        await db.read();
        let target = null;
        if (actionPlan.payload?.token === "first") {
          target = db.data.tasks.find((t) => !t.completed);
        }
        if (target) {
          target.completed = true;
          await db.write();
          actionResult = { task: target };
          uiResponse = { tasks: db.data.tasks };
        } else {
          gemini.replyText = "Bajarilishi kerak bo‘lgan task topilmadi.";
          uiResponse = { tasks: db.data.tasks };
        }
        break;
      }
      case "reminder_create": {
        if (actionPlan.payload?.title && actionPlan.payload?.time) {
          await db.read();
          db.data.reminders.push(actionPlan.payload);
          await db.write();
          actionResult = { reminder: actionPlan.payload };
          uiResponse = { reminders: db.data.reminders };
        } else {
          gemini.replyText = "Qaysi vaqtda eslatay?";
        }
        break;
      }
      case "reminder_list": {
        await db.read();
        uiResponse = { reminders: db.data.reminders };
        break;
      }
      case "expense_create": {
        await db.read();
        db.data.expenses.push(actionPlan.payload);
        await db.write();
        actionResult = { expense: actionPlan.payload };
        uiResponse = { expenses: db.data.expenses };
        break;
      }
      case "expense_list": {
        await db.read();
        uiResponse = { expenses: db.data.expenses };
        break;
      }
      case "expense_summary": {
        await db.read();
        const summary = summarizeExpenses(db.data.expenses, actionPlan.payload?.period || "today");
        actionResult = { summary };
        uiResponse = {
          expenses: db.data.expenses,
          expenseSummary: summary
        };
        gemini.replyText = buildExpenseSummaryText(summary);
        break;
      }
      case "agenda_today": {
        await db.read();
        const today = new Date().toISOString().slice(0, 10);
        const tasks = db.data.tasks;
        const reminders = db.data.reminders.filter((r) => r.time && r.time.startsWith(today));
        uiResponse = { agenda: { tasks, reminders } };
        gemini.replyText = `Bugungi rejalar:
- ${tasks.length} task
- ${reminders.length} eslatma`; 
        break;
      }
      case "agenda_tomorrow": {
        await db.read();
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const reminders = db.data.reminders.filter((r) => r.time && r.time.startsWith(tomorrow));
        uiResponse = { agenda: { reminders } };
        gemini.replyText = `Ertaga reja:
- ${reminders.length} eslatma`; 
        break;
      }
      default: {
        // general chat
        uiResponse = null;
      }
    }

    const replyText = buildReplyFromAction(actionPlan, actionResult, uiResponse, gemini.replyText);
    res.json({ replyText, intent: gemini.intent, uiResponse, actionResult });
  } catch (err) {
    console.error("/api/assistant", err);
    res.status(500).json({ replyText: "Xatolik yuz berdi. Iltimos, qayta urinib ko‘ring.", error: err.message });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text, model } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });

    const audioData = await sendTextToTTS(text, model);
    res.json({ audio: audioData });
  } catch (err) {
    console.error("/api/tts", err);
    if (isRecoverableVoiceProviderError(err?.message)) {
      return res.json({
        audio: null,
        fallback: "browser",
        message: "Bulut ovozi hozir ishlamadi. Brauzer ovoziga o'tildi."
      });
    }

    res.status(500).json({ error: "TTS xatolik yuz berdi", message: err.message });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  if (hasFrontendStatic) {
    return res.sendFile(path.join(frontendStaticDir, "index.html"));
  }

  return res.status(404).json({ error: "Frontend build topilmadi. `npm run build` ni ishga tushiring." });
});

if (isDirectExecution) {
  const server = app.listen(port, host, () => {
    console.log(`Backend running on http://${host}:${port}`);
  });

  server.on("error", (err) => {
    console.error(`Backend listen xatoligi (${host}:${port})`, err);
    process.exit(1);
  });
}

export default app;
