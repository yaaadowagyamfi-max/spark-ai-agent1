import express from "express";
import axios from "axios";
import { z } from "zod";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

/* -----------------------------
   Voice and hearing tuning
--------------------------------*/

// British voice (Twilio Polly). If your Twilio account does not support Polly voices,
// change to: const SAY_VOICE = "alice";
const SAY_VOICE = "Polly.Amy";
const SAY_LANG = "en-GB";

const BASE_HINTS = [
  "home", "house", "flat", "apartment", "studio",
  "business", "office", "shop", "warehouse", "school", "clinic", "gym",
  "end of tenancy", "deep clean", "regular cleaning", "post construction", "disinfection", "sanitisation",
  "postcode", "spell it", "letter by letter", "S for Sun", "W as in Winter", "double u", "zed",
];

const GATHER_OPTS = {
  input: "speech",
  method: "POST",
  action: "/call/input",
  language: SAY_LANG,
  speechModel: "phone_call",
  enhanced: true,
  speechTimeout: "auto",
  timeout: 7,
  profanityFilter: false,
};

function say(twiml, text) {
  twiml.say({ voice: SAY_VOICE, language: SAY_LANG }, text);
}

function gatherSay(twiml, text, hints = BASE_HINTS) {
  const gather = twiml.gather({ ...GATHER_OPTS, hints: hints.join(", ") });
  say(gather, safeSpeak(text));
  twiml.redirect({ method: "POST" }, "/call/input");
}

/* -----------------------------
   Currency lock for assistant speech
--------------------------------*/

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

/* -----------------------------
   Schemas (hard gates)
--------------------------------*/

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

/* -----------------------------
   Postcode parsing (supports "S for Sun")
--------------------------------*/

const DIGIT_WORDS = new Map([
  ["zero", "0"], ["oh", "0"],
  ["one", "1"], ["two", "2"], ["three", "3"],
  ["four", "4"], ["five", "5"], ["six", "6"],
  ["seven", "7"], ["eight", "8"], ["nine", "9"],
]);

const NATO = new Map([
  ["alpha","A"],["bravo","B"],["charlie","C"],["delta","D"],["echo","E"],
  ["foxtrot","F"],["golf","G"],["hotel","H"],["india","I"],["juliet","J"],
  ["kilo","K"],["lima","L"],["mike","M"],["november","N"],["oscar","O"],
  ["papa","P"],["quebec","Q"],["romeo","R"],["sierra","S"],["tango","T"],
  ["uniform","U"],["victor","V"],["whiskey","W"],["xray","X"],["x-ray","X"],
  ["yankee","Y"],["zulu","Z"],
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

/* -----------------------------
   AI extraction using OpenAI via HTTPS
--------------------------------*/

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

async function aiExtractQuoteDelta(currentQuote, lastUserUtterance) {
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
      "intent","service_category","domestic_service_type","commercial_service_type",
      "domestic_property_type","commercial_property_type","job_type","bedrooms","bathrooms",
      "toilets","kitchens","postcode","preferred_hours","visit_frequency_per_week",
      "areas_scope","extras","notes",
    ],
  };

  const system = [
    "You are a strict extraction engine for a UK cleaning receptionist.",
    "Return only JSON that matches the schema.",
    "Never output dollars. GBP only.",
    "Do not invent missing values. If unsure, keep fields unchanged from current data.",
  ].join(" ");

  const user = JSON.stringify({
    current: currentQuote,
    last_user_utterance: lastUserUtterance,
    task: "Update only fields you can confidently infer from the last utterance. Otherwise keep current values.",
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
        timeout: 15000,
      }
    );

    const outputText = resp.data?.output_text;
    if (!outputText) return null;

    const parsed = JSON.parse(outputText);
    return GetQuoteSchema.parse(parsed);
  } catch (e) {
    return null;
  }
}

/* -----------------------------
   Category detection (guardrail)
--------------------------------*/

function detectCategory(text) {
  const lower = String(text || "").toLowerCase();

  const domestic = ["home","house","flat","apartment","studio","tenancy","landlord","move out","move-out"];
  const commercial = ["office","shop","warehouse","school","clinic","gym","venue","site","business","restaurant","workplace"];

  const d = domestic.some((w) => lower.includes(w));
  const c = commercial.some((w) => lower.includes(w));

  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return null;
}

/* -----------------------------
   Call state
--------------------------------*/

const stateByCallSid = new Map();

function initState() {
  return {
    transcript: [],
    stage: "need_category",
    quote: emptyQuote(),
    postcode_attempts: 0,
  };
}

/* -----------------------------
   Routes
--------------------------------*/

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
  if (speech) state.transcript.push(speech);

  const twiml = new VoiceResponse();

  if (!speech) {
    gatherSay(twiml, "Sorry, I didn’t catch that. Is it for a home or for a business premises?");
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // AI-backed update (best effort). Code still enforces critical gates.
  const aiQuote = await aiExtractQuoteDelta(state.quote, speech);
  if (aiQuote) state.quote = aiQuote;

  // Stage: need_category
  if (state.stage === "need_category") {
    const cat = detectCategory(speech) || state.quote.service_category;
    if (cat !== "domestic" && cat !== "commercial") {
      gatherSay(twiml, "No problem. Is the cleaning for a home or for a business premises?");
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.quote.service_category = cat;
    state.stage = "need_service_type";

    if (cat === "domestic") {
      gatherSay(twiml, "Thanks. What type of cleaning do you need for the home? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection.");
    } else {
      gatherSay(twiml, "Thanks. What type of commercial cleaning do you need? For example regular commercial cleaning, deep clean, post-construction, or disinfection.");
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need_service_type
  if (state.stage === "need_service_type") {
    const q = state.quote;

    const ok =
      (q.service_category === "domestic" && q.domestic_service_type.trim().length > 0) ||
      (q.service_category === "commercial" && q.commercial_service_type.trim().length > 0);

    if (!ok) {
      gatherSay(twiml, "Sorry, which type of cleaning is it? End of tenancy, deep clean, regular cleaning, post-construction, or disinfection.");
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.stage = "need_property_type";

    if (q.service_category === "domestic") {
      gatherSay(twiml, "Thanks. What’s the property type? A studio flat, a flat, or a house? If it’s a house, is it terraced, semi-detached, or detached?");
    } else {
      gatherSay(twiml, "Thanks. What type of premises is it? For example office, shop, warehouse, school, clinic, gym, or event venue.");
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need_property_type (for now, we move on without full normalisation here)
  if (state.stage === "need_property_type") {
    state.stage = "need_postcode";
    gatherSay(
      twiml,
      "Thanks. What’s the postcode? You can say it letter by letter, or like S for Sun, W as in Winter."
    );
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need_postcode (robust)
  if (state.stage === "need_postcode") {
    const parsed = extractUkPostcode(speech);

    if (!parsed) {
      state.postcode_attempts += 1;

      if (state.postcode_attempts >= 2) {
        state.quote.notes = `${state.quote.notes || ""} Postcode capture failed. Caller said: "${speech}".`;
        state.stage = "postcode_fallback";
        gatherSay(twiml, "No worries. Postcodes are tricky on calls. What town are you in, and the nearest landmark or street name?");
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }

      gatherSay(twiml, "Sorry, I didn’t get that. Please say the postcode slowly, letter by letter. You can also say S for Sun style.");
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.quote.postcode = parsed;
    state.stage = "next_placeholder";
    gatherSay(twiml, `Thanks. I got ${parsed}. Next, how many bedrooms and bathrooms is it?`);
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "postcode_fallback") {
    state.quote.notes = `${state.quote.notes || ""} Fallback location: "${speech}".`;
    state.stage = "next_placeholder";
    gatherSay(twiml, "Thanks. Next, how many bedrooms and bathrooms is it?");
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Placeholder
  gatherSay(twiml, "Thanks. Tell me the bedrooms and bathrooms, and we’ll carry on from there.");
  stateByCallSid.set(callSid, state);
  return res.type("text/xml").send(twiml.toString());
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on ${port}`));
