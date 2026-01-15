// server.js
import express from "express";
import axios from "axios";
import { z } from "zod";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
  OPENAI_API_KEY,
} = process.env;

if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is missing. AI extraction will not work.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const VoiceResponse = twilio.twiml.VoiceResponse;

/* -----------------------------
   Voice and recognition tuning
--------------------------------*/

// British sounding voice (Twilio Polly). If unsupported on your Twilio account,
// change to "alice" and keep language "en-GB".
const SAY_VOICE = "Polly.Amy";
const SAY_LANG = "en-GB";

const BASE_HINTS = [
  "home", "house", "flat", "apartment", "studio",
  "business", "office", "shop", "warehouse", "school", "clinic", "gym",
  "end of tenancy", "deep clean", "regular cleaning", "post construction", "disinfection", "sanitisation",
  "studio flat", "terraced house", "semi detached house", "detached house",
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
  const g = twiml.gather({ ...GATHER_OPTS, hints: hints.join(", ") });
  say(g, text);
  twiml.redirect({ method: "POST" }, "/call/input");
}

/* -----------------------------
   Currency lock (assistant speech only)
--------------------------------*/

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

function safeSpeak(text) {
  if (containsDollar(text)) {
    return "Sorry, that’s in pounds. We keep everything in £. Now, is the cleaning for a home or for a business premises?";
  }
  return text;
}

/* -----------------------------
   Schemas
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

const ConfirmBookingSchema = z.object({
  intent: z.literal("confirm_booking"),
  full_name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().min(1),
  address: z.string().min(1),
  postcode: z.string().min(1),
  preferred_date: z.string().min(1),
  preferred_time: z.string().min(1),
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

  // Capture "S for Sun" or "W as in Winter"
  const phoneticLetters = [];
  const re = /(^|[\s,])([a-z])\s*(for|as in|like)\s+([a-z]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) phoneticLetters.push(m[2].toUpperCase());

  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
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
   Guardrail helpers
--------------------------------*/

const DOMESTIC_PROPERTY_TYPES = [
  "Studio flat",
  "Flat",
  "Terraced house",
  "Semi-detached house",
  "Detached house",
];

const COMMERCIAL_PROPERTY_TYPES = [
  "Office",
  "School",
  "Medical clinic",
  "Warehouse",
  "Commercial kitchen",
  "Retail shop",
  "Nursery (daycare)",
  "Nursery",
  "Gym",
  "Industrial workshop",
  "Event venue",
];

function isHighRiskPropertyTypePhrase(text) {
  const t = String(text || "").toLowerCase();
  const risky = [
    "semi", "semmy", "semi-d", "terrace", "terraced", "mid-terrace", "end terrace",
    "detached-ish", "flat-ish", "apartment sort", "studio-type", "maisonette",
    "upstairs flat", "ground floor flat",
  ];
  return risky.some((x) => t.includes(x));
}

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

function initState() {
  return {
    transcript: [],
    stage: "need_category",
    data: {
      // quote object (progressively filled)
      quote: {
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
      },
      postcode_attempts: 0,
      property_type_confirmed: false,
    },
  };
}

const stateByCallSid = new Map();

/* -----------------------------
   OpenAI extraction (AI backing)
--------------------------------*/

// We force JSON that matches GetQuoteSchema so the model cannot return random text. :contentReference[oaicite:1]{index=1}
async function aiExtractQuoteDelta({ currentQuote, lastUserUtterance }) {
  if (!OPENAI_API_KEY) return null;

  // Keep the instruction short and enforce your key rules.
  const system = `
You are Spark’s extraction engine.
Return ONLY JSON that conforms to the provided schema.
Do not include currency other than GBP.
Do not invent missing values.
If you are unsure about a field, keep it unchanged.
`;

  const user = `
Current data:
${JSON.stringify(currentQuote)}

Caller said:
${lastUserUtterance}

Task:
Update only fields you can confidently infer from the caller’s last message.
`;

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

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "quote_delta",
        schema,
        strict: true,
      },
    },
    temperature: 0,
  });

  const text = resp.output_text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    // Validate shape using zod
    const validated = GetQuoteSchema.parse(parsed);
    return validated;
  } catch {
    return null;
  }
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
    safeSpeak("Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?")
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
    gatherSay(
      twiml,
      safeSpeak("Sorry, I didn’t catch that. Is it for a home or for a business premises?")
    );
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // AI extraction (fills what it can, but code enforces guardrails)
  const currentQuote = state.data.quote;
  const aiDelta = await aiExtractQuoteDelta({ currentQuote, lastUserUtterance: speech });
  if (aiDelta) state.data.quote = aiDelta;

  const q = state.data.quote;

  // Hard category enforcement: never assume if still empty
  if (state.stage === "need_category") {
    const category = detectCategory(speech) || q.service_category || "";
    if (category !== "domestic" && category !== "commercial") {
      gatherSay(twiml, safeSpeak("No problem. Is the cleaning for a home or for a business premises?"));
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }
    q.service_category = category;
    state.stage = "need_service_type";

    if (category === "domestic") {
      gatherSay(twiml, safeSpeak("Thanks. What type of cleaning do you need for the home? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection."));
    } else {
      gatherSay(twiml, safeSpeak("Thanks. What type of commercial cleaning do you need? For example regular commercial cleaning, deep clean, post-construction, or disinfection."));
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_service_type") {
    // Guardrail: we require a service type string before moving on
    const hasDomestic = q.service_category === "domestic" && q.domestic_service_type.trim();
    const hasCommercial = q.service_category === "commercial" && q.commercial_service_type.trim();

    if (!hasDomestic && !hasCommercial) {
      gatherSay(twiml, safeSpeak("Sorry, which type of cleaning is it? End of tenancy, deep clean, regular cleaning, post-construction, or disinfection."));
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.stage = "need_property_type";
    if (q.service_category === "domestic") {
      gatherSay(twiml, safeSpeak("Thanks. What’s the property type? Is it a studio flat, a flat, or a house? If it’s a house, is it terraced, semi-detached, or detached?"));
    } else {
      gatherSay(twiml, safeSpeak("Thanks. What type of premises is it? For example office, shop, warehouse, school, clinic, gym, or event venue."));
    }

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_property_type") {
    // Hearing guardrail: confirm if high-risk phrase appears
    if (isHighRiskPropertyTypePhrase(speech) && !state.data.property_type_confirmed) {
      state.data.property_type_confirmed = false;
      gatherSay(twiml, safeSpeak("Just to check, is it a flat, or a house? And if it’s a house, is it terraced, semi-detached, or detached?"));
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    // Minimal confirmation: require one of allowed types, otherwise ask again
    if (q.service_category === "domestic") {
      const ok = DOMESTIC_PROPERTY_TYPES.some((t) => q.domestic_property_type.toLowerCase().includes(t.toLowerCase().split(" ")[0]));
      if (!ok) {
        gatherSay(twiml, safeSpeak("Sorry, is it a studio flat, a flat, or a house? If house, is it terraced, semi-detached, or detached?"));
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }
    } else {
      const ok = COMMERCIAL_PROPERTY_TYPES.some((t) => q.commercial_property_type.toLowerCase().includes(t.toLowerCase().split(" ")[0]));
      if (!ok) {
        gatherSay(twiml, safeSpeak("Sorry, what type of premises is it? For example office, shop, warehouse, school, clinic, or gym."));
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }
    }

    state.data.property_type_confirmed = true;
    state.stage = "need_postcode";

    gatherSay(
      twiml,
      safeSpeak("Thanks. What’s the postcode? You can say it letter by letter, or like S for Sun, W as in Winter."),
      [...BASE_HINTS, "S for Sun", "W as in Winter", "as in", "for", "spell it"]
    );

    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_postcode") {
    const parsed = extractUkPostcode(speech);

    if (!parsed) {
      state.data.postcode_attempts += 1;

      if (state.data.postcode_attempts >= 2) {
        q.postcode = "";
        q.notes = `${q.notes || ""} Postcode capture failed. Caller said: "${speech}".`;
        state.stage = "postcode_fallback";

        gatherSay(twiml, safeSpeak("No worries. Postcodes are tricky on calls. What town are you in, and the nearest landmark or street name?"));
        stateByCallSid.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }

      gatherSay(twiml, safeSpeak("Sorry, I didn’t get that. Please say the postcode slowly, letter by letter. You can also say S for Sun style."));
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    q.postcode = parsed;
    state.stage = "confirm_postcode";

    gatherSay(twiml, safeSpeak(`Thanks. I got ${parsed}. Is that right? Say yes or no.`), ["yes", "no"]);
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "confirm_postcode") {
    const lower = speech.toLowerCase();
    if (lower.includes("yes")) {
      // Continue into your full flows next (bedrooms/bathrooms etc.)
      state.stage = "need_rooms";
      gatherSay(twiml, safeSpeak("Perfect. How many bedrooms and bathrooms is it?"));
      stateByCallSid.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.data.postcode_attempts = 0;
    state.stage = "need_postcode";
    gatherSay(twiml, safeSpeak("Thanks. Please say the postcode again, letter by letter."));
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "postcode_fallback") {
    q.notes = `${q.notes || ""} Fallback location: "${speech}".`;
    state.stage = "need_rooms";
    gatherSay(twiml, safeSpeak("Thanks. How many bedrooms and bathrooms is it?"));
    stateByCallSid.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Placeholder continuation
  gatherSay(twiml, safeSpeak("Thanks. Tell me the bedrooms and bathrooms, and we’ll carry on from there."));
  stateByCallSid.set(callSid, state);
  return res.type("text/xml").send(twiml.toString());
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on ${port}`));
