import express from "express";
import axios from "axios";
import { z } from "zod";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  VOICE_NAME,
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

/* =========================
   Voice + hearing tuning
========================= */

const SAY_LANG = "en-GB";

/*
Voice options:
- "alice" works on all accounts and sounds UK-neutral with language en-GB
- "Polly.Amy" sounds more British but depends on Twilio account support
Set Railway variable VOICE_NAME="Polly.Amy" after you confirm it works.
*/
const SAY_VOICE = VOICE_NAME || "alice";

const BASE_HINTS = [
  "home",
  "house",
  "flat",
  "apartment",
  "studio",
  "business",
  "office",
  "shop",
  "warehouse",
  "school",
  "clinic",
  "gym",
  "end of tenancy",
  "deep clean",
  "regular cleaning",
  "post construction",
  "disinfection",
  "sanitisation",
  "postcode",
  "spell it",
  "letter by letter",
  "S for Sun",
  "W as in Winter",
  "double u",
  "zed",
];

const GATHER_BASE = {
  input: "speech",
  method: "POST",
  action: "/call/input",
  language: SAY_LANG,
  speechModel: "phone_call",
  enhanced: true,
  timeout: 7,
  speechTimeout: "auto",
  profanityFilter: false,
};

function say(twiml, text) {
  twiml.say({ voice: SAY_VOICE, language: SAY_LANG }, safeSpeak(text));
}

function gatherSay(twiml, text, hints = BASE_HINTS) {
  const gather = twiml.gather({
    ...GATHER_BASE,
    hints: hints.join(", "),
  });
  say(gather, text);
  twiml.redirect({ method: "POST" }, "/call/input");
}

/* =========================
   Currency lock (assistant speech only)
========================= */

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

function safeSpeak(text) {
  if (containsDollar(text)) {
    return "Sorry, that’s in pounds. We keep everything in £. Is the cleaning for a home or for a business premises?";
  }
  return text;
}

/* =========================
   Schemas (hard gates)
========================= */

const ExtraSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});

const GetQuoteSchema = z.object({
  intent: z.literal("get_quote"),
  service_category: z.enum(["domestic", "commercial"]),
  domestic_service_type: z.string(),
  commercial_service_type: z.string(),
  domestic_property_type: z.string(),
  commercial_property_type: z.string(),
  job_type: z.string(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  toilets: z.number().int().nonnegative(),
  kitchens: z.number().int().nonnegative(),
  postcode: z.string(),
  preferred_hours: z.number().nonnegative(),
  visit_frequency_per_week: z.number().nonnegative(),
  areas_scope: z.string(),
  extras: z.array(ExtraSchema),
  notes: z.string(),
});

/* =========================
   State
========================= */

function emptyQuote() {
  return {
    intent: "get_quote",
    service_category: "domestic",
    domestic_service_type: "",
    commercial_service_type: "",
    domestic_property_type: "",
    commercial_property_type: "",
    job_type: "",
    bedrooms: 0,
    bathrooms: 0,
    toilets: 0,
    kitchens: 0,
    postcode: "",
    preferred_hours: 0,
    visit_frequency_per_week: 0,
    areas_scope: "",
    extras: [],
    notes: "",
  };
}

function initState() {
  return {
    transcript: [],
    stage: "need_category",
    quote: emptyQuote(),
    stage_attempts: {},
    postcode_attempts: 0,
    last_prompt: "",
  };
}

function bumpAttempt(state) {
  const s = state.stage;
  state.stage_attempts[s] = (state.stage_attempts[s] || 0) + 1;
  return state.stage_attempts[s];
}

function resetAttempt(state, stageName) {
  state.stage_attempts[stageName] = 0;
}

const stateByCallSid = new Map();

/* =========================
   Deterministic helpers (prevents loops)
========================= */

function detectCategory(text) {
  const lower = String(text || "").toLowerCase();

  const domestic = [
    "home",
    "house",
    "flat",
    "apartment",
    "studio",
    "tenancy",
    "landlord",
    "move out",
    "move-out",
  ];

  const commercial = [
    "office",
    "shop",
    "warehouse",
    "school",
    "clinic",
    "gym",
    "venue",
    "site",
    "business",
    "restaurant",
    "workplace",
  ];

  const d = domestic.some((w) => lower.includes(w));
  const c = commercial.some((w) => lower.includes(w));

  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return null;
}

function detectDomesticServiceType(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("tenancy") || t.includes("move out") || t.includes("move-out") || t.includes("checkout")) return "End of Tenancy Clean";
  if (t.includes("deep")) return "Deep Clean";
  if (t.includes("post") && (t.includes("construction") || t.includes("builder") || t.includes("build"))) return "Post-construction Clean";
  if (t.includes("disinfection") || t.includes("saniti") || t.includes("saniti")) return "Disinfection / Sanitisation";
  if (t.includes("regular") || t.includes("standard") || t.includes("weekly") || t.includes("fortnight") || t.includes("bi-week") || t.includes("monthly") || t.includes("recurring") || t.includes("ongoing")) return "Regular Cleaning";

  return "";
}

function detectCommercialServiceType(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("regular") || t.includes("contract") || t.includes("ongoing")) return "Regular Commercial Cleaning";
  if (t.includes("deep")) return "Deep Clean";
  if (t.includes("post") && (t.includes("construction") || t.includes("builder") || t.includes("build"))) return "Post-construction Clean";
  if (t.includes("disinfection") || t.includes("saniti") || t.includes("saniti")) return "Disinfection / Sanitisation";

  return "";
}

function looksLikeNonAnswer(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return true;
  if (t === "yes" || t === "no") return true;
  if (t === "cleaning") return true;
  if (t.length < 3) return true;
  return false;
}

function isHighRiskPropertyTypePhrase(text) {
  const t = String(text || "").toLowerCase();
  const risky = [
    "semi",
    "semmy",
    "semi-d",
    "terrace",
    "terraced",
    "mid-terrace",
    "end terrace",
    "detached-ish",
    "flat-ish",
    "apartment sort",
    "studio-type",
    "maisonette",
    "upstairs flat",
    "ground floor flat",
  ];
  return risky.some((x) => t.includes(x));
}

/* =========================
   UK postcode parsing (supports “S for Sun”)
========================= */

const DIGIT_WORDS = new Map([
  ["zero", "0"],
  ["oh", "0"],
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
  ["seven", "7"],
  ["eight", "8"],
  ["nine", "9"],
]);

const NATO = new Map([
  ["alpha", "A"],
  ["bravo", "B"],
  ["charlie", "C"],
  ["delta", "D"],
  ["echo", "E"],
  ["foxtrot", "F"],
  ["golf", "G"],
  ["hotel", "H"],
  ["india", "I"],
  ["juliet", "J"],
  ["kilo", "K"],
  ["lima", "L"],
  ["mike", "M"],
  ["november", "N"],
  ["oscar", "O"],
  ["papa", "P"],
  ["quebec", "Q"],
  ["romeo", "R"],
  ["sierra", "S"],
  ["tango", "T"],
  ["uniform", "U"],
  ["victor", "V"],
  ["whiskey", "W"],
  ["xray", "X"],
  ["x-ray", "X"],
  ["yankee", "Y"],
  ["zulu", "Z"],
]);

function looksLikeUkPostcode(compact) {
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact);
}

function formatUkPostcode(compact) {
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function extractUkPostcode(raw) {
  const text = String(raw || "");
  if (!text.trim()) return null;

  const phoneticLetters = [];
  const re = /(^|[\s,])([a-z])\s*(for|as in|like)\s+([a-z]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) phoneticLetters.push(m[2].toUpperCase());

  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  const out = [...phoneticLetters];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === "double" && tokens[i + 1] === "u") {
      out.push("W");
      i++;
      continue;
    }

    if (t === "zed") {
      out.push("Z");
      continue;
    }

    if (/^[a-z]$/.test(t)) {
      out.push(t.toUpperCase());
      continue;
    }

    if (NATO.has(t)) {
      out.push(NATO.get(t));
      continue;
    }

    if (DIGIT_WORDS.has(t)) {
      out.push(DIGIT_WORDS.get(t));
      continue;
    }

    if (/^[a-z0-9]+$/.test(t) && t.length <= 7) {
      out.push(t.toUpperCase());
      continue;
    }
  }

  const compact = out.join("").replace(/[^A-Z0-9]/g, "");
  if (!looksLikeUkPostcode(compact)) return null;
  return formatUkPostcode(compact);
}

/* =========================
   AI enhancer (optional)
   This must never block progress.
========================= */

function mergeKeepExisting(current, ai) {
  const merged = { ...current };

  for (const k of Object.keys(current)) {
    const curVal = current[k];
    const aiVal = ai[k];

    const curHas =
      (typeof curVal === "string" && curVal.trim().length > 0) ||
      (typeof curVal === "number" && curVal !== 0) ||
      (Array.isArray(curVal) && curVal.length > 0);

    const aiHas =
      (typeof aiVal === "string" && aiVal.trim().length > 0) ||
      (typeof aiVal === "number" && aiVal !== 0) ||
      (Array.isArray(aiVal) && aiVal.length > 0);

    if (!curHas && aiHas) merged[k] = aiVal;
  }

  return merged;
}

async function aiEnhanceQuote(currentQuote, lastUserUtterance) {
  if (!OPENAI_API_KEY) return null;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { const: "get_quote" },
      service_category: { type: "string" },
      domestic_service_type: { type: "string" },
      commercial_service_type: { type: "string" },
      domestic_property_type: { type: "string" },
      commercial_property_type: { type: "string" },
      job_type: { type: "string" },
      bedrooms: { type: "number" },
      bathrooms: { type: "number" },
      toilets: { type: "number" },
      kitchens: { type: "number" },
      postcode: { type: "string" },
      preferred_hours: { type: "number" },
      visit_frequency_per_week: { type: "number" },
      areas_scope: { type: "string" },
      extras: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            quantity: { type: "number" },
          },
          required: ["name", "quantity"],
        },
      },
      notes: { type: "string" },
    },
    required: [
      "intent",
      "service_category",
      "domestic_service_type",
      "commercial_service_type",
      "domestic_property_type",
      "commercial_property_type",
      "job_type",
      "bedrooms",
      "bathrooms",
      "toilets",
      "kitchens",
      "postcode",
      "preferred_hours",
      "visit_frequency_per_week",
      "areas_scope",
      "extras",
      "notes",
    ],
  };

  const system = [
    "Return only JSON that matches the schema.",
    "GBP only. Never output dollars.",
    "Do not invent missing values.",
    "If unsure, keep the field unchanged from current.",
  ].join(" ");

  const user = JSON.stringify({
    current: currentQuote,
    last_user_utterance: lastUserUtterance,
    task: "Update only what the caller clearly stated in the last utterance.",
  });

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: OPENAI_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "quote_state",
            schema,
            strict: true,
          },
        },
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 12000,
      }
    );

    const outputText = resp.data?.output_text;
    if (!outputText) return null;

    const parsed = JSON.parse(outputText);
    return GetQuoteSchema.parse(parsed);
  } catch {
    return null;
  }
}

/* =========================
   Routes
========================= */

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid;
  stateByCallSid.set(callSid, initState());

  const twiml = new VoiceResponse();
  gatherSay(
    twiml,
    "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?"
  );

  res.type("text/xml").send(twiml.toString());
});

app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = stateByCallSid.get(callSid) || initState();
  const twiml = new VoiceResponse();

  if (speech) state.transcript.push(speech);

  if (!speech) {
    bumpAttempt(state);
    gatherSay(twiml, "Sorry, I didn’t catch that. Is it for a home or for a business premises?");
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // AI enhancer (never blocks)
  const enhanced = await aiEnhanceQuote(state.quote, speech);
  if (enhanced) state.quote = mergeKeepExisting(state.quote, enhanced);

  // Stage flow with deterministic capture per stage
  if (state.stage === "need_category") {
    const attempt = bumpAttempt(state);

    const cat = detectCategory(speech);
    if (!cat) {
      const prompt =
        attempt >= 2
          ? "No worries. Is it a home, like a house or flat, or a business premises, like an office or shop?"
          : "No problem. Is the cleaning for a home or for a business premises?";

      gatherSay(twiml, prompt);
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.quote.service_category = cat;
    resetAttempt(state, "need_category");
    state.stage = "need_service_type";

    if (cat === "domestic") {
      gatherSay(
        twiml,
        "Thanks. What type of cleaning do you need for the home? End of tenancy, deep clean, regular cleaning, post-construction, or disinfection."
      );
    } else {
      gatherSay(
        twiml,
        "Thanks. What type of commercial cleaning do you need? Regular commercial cleaning, deep clean, post-construction, or disinfection."
      );
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_service_type") {
    const attempt = bumpAttempt(state);
    const cat = state.quote.service_category;

    if (cat === "domestic") {
      const detected = detectDomesticServiceType(speech);
      state.quote.domestic_service_type = detected || state.quote.domestic_service_type || speech;
    } else {
      const detected = detectCommercialServiceType(speech);
      state.quote.commercial_service_type = detected || state.quote.commercial_service_type || speech;
    }

    const ok =
      (cat === "domestic" && !looksLikeNonAnswer(state.quote.domestic_service_type)) ||
      (cat === "commercial" && !looksLikeNonAnswer(state.quote.commercial_service_type));

    if (!ok) {
      const prompt =
        attempt >= 2
          ? "Sorry. Is it end of tenancy, deep clean, regular cleaning, post-construction, or disinfection?"
          : "Which type of cleaning is it? End of tenancy, deep clean, regular cleaning, post-construction, or disinfection?";

      gatherSay(twiml, prompt);
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    resetAttempt(state, "need_service_type");
    state.stage = "need_property_type";

    if (cat === "domestic") {
      gatherSay(
        twiml,
        "Thanks. What’s the property type? A studio flat, a flat, or a house? If it’s a house, is it terraced, semi-detached, or detached?"
      );
    } else {
      gatherSay(
        twiml,
        "Thanks. What type of premises is it? For example office, shop, warehouse, school, clinic, gym, or event venue."
      );
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_property_type") {
    const attempt = bumpAttempt(state);
    const cat = state.quote.service_category;

    if (cat === "domestic") state.quote.domestic_property_type = speech;
    else state.quote.commercial_property_type = speech;

    if (isHighRiskPropertyTypePhrase(speech) && attempt < 2) {
      gatherSay(
        twiml,
        "Just to check, is it a flat, or a house? And if it’s a house, is it terraced, semi-detached, or detached?"
      );
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    resetAttempt(state, "need_property_type");
    state.stage = "need_postcode";
    state.postcode_attempts = 0;

    gatherSay(
      twiml,
      "Thanks. What’s the postcode? You can say it letter by letter, or like S for Sun, W as in Winter.",
      [...BASE_HINTS, "as in", "for", "like"]
    );

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_postcode") {
    const parsed = extractUkPostcode(speech);

    if (!parsed) {
      state.postcode_attempts += 1;

      if (state.postcode_attempts === 1) {
        gatherSay(
          twiml,
          "Sorry, I didn’t get that. Please say it slowly, letter by letter. For example, S W 1 A, pause, 1 A A."
        );
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }

      if (state.postcode_attempts === 2) {
        gatherSay(
          twiml,
          "Sorry, one more time. You can also say it like S for Sun, W as in Winter."
        );
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }

      state.quote.notes = `${state.quote.notes || ""} Postcode capture failed. Caller said: "${speech}".`;
      state.stage = "postcode_fallback";

      gatherSay(
        twiml,
        "No worries. Postcodes are tricky on calls. What town are you in, and the nearest landmark or street name?"
      );
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.quote.postcode = parsed;
    state.stage = "next_step_rooms";
    gatherSay(twiml, `Thanks. I got ${parsed}. How many bedrooms and bathrooms is it?`);
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "postcode_fallback") {
    state.quote.notes = `${state.quote.notes || ""} Fallback location: "${speech}".`;
    state.stage = "next_step_rooms";
    gatherSay(twiml, "Thanks. How many bedrooms and bathrooms is it?");
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Placeholder continuation, so the call does not dead-end
  gatherSay(twiml, "Thanks. Tell me the bedrooms and bathrooms, and we’ll carry on from there.");
  stateByCallSid.set(callSid, state);
  return res.type("text/xml").send(twiml.toString());
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  if (MAKE_GETQUOTE_WEBHOOK_URL) console.log("MAKE_GETQUOTE_WEBHOOK_URL set");
  if (MAKE_CONFIRMBOOKING_WEBHOOK_URL) console.log("MAKE_CONFIRMBOOKING_WEBHOOK_URL set");
});
