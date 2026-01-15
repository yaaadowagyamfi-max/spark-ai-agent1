// server.js
import express from "express";
import axios from "axios";
import { z } from "zod";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  TWILIO_AUTH_TOKEN,
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

// In-memory state keyed by CallSid (OK for MVP; use Redis later)
const callState = new Map();

/* -----------------------------
   Voice and recognition tuning
--------------------------------*/

// British-sounding voice via Twilio Polly (works on Twilio <Say>)
const SAY_VOICE = "Polly.Amy"; // en-GB
const SAY_LANG = "en-GB";

// Improve recognition for phone calls
const GATHER_OPTS = {
  input: "speech",
  speechTimeout: "auto",
  method: "POST",
  action: "/call/input",
  language: SAY_LANG,
  speechModel: "phone_call",
  enhanced: true,
  profanityFilter: false,
};

// Helpful hints for Twilio speech recognition
// Keep these short and relevant to reduce confusion.
const BASE_HINTS = [
  // Categories
  "home",
  "house",
  "flat",
  "apartment",
  "business",
  "office",
  "shop",
  "warehouse",
  "school",
  "clinic",
  "gym",
  // Services
  "end of tenancy",
  "deep clean",
  "regular cleaning",
  "post construction",
  "disinfection",
  "sanitisation",
  // Property types
  "studio flat",
  "flat",
  "terraced house",
  "semi detached house",
  "detached house",
  // Postcode related
  "postcode",
  "spell it",
  "letter by letter",
  "S for Sun",
  "W as in Winter",
  "double u",
  "zed",
];

function say(twiml, text) {
  twiml.say({ voice: SAY_VOICE, language: SAY_LANG }, text);
}

function sayGather(twiml, text, hints = BASE_HINTS) {
  const gather = twiml.gather({
    ...GATHER_OPTS,
    hints: hints.join(", "),
  });
  say(gather, text);
  // If no speech captured, Twilio will hit action with empty SpeechResult.
  twiml.redirect({ method: "POST" }, "/call/input");
}

/* -----------------------------
   Currency lock safety
--------------------------------*/

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("$") ||
    t.includes("usd") ||
    t.includes("dollar") ||
    t.includes("dollars") ||
    t.includes("bucks")
  );
}

function ensurePoundsOnly(text) {
  // This protects what Spark says, not what the caller says.
  if (containsDollar(text)) {
    return "Sorry, that’s in pounds. Let’s keep everything in £. Is the cleaning for a home or for a business premises?";
  }
  return text;
}

/* -----------------------------
   Strict tool schemas (hard gates)
--------------------------------*/

const ExtraSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});

const GetQuoteSchema = z.object({
  intent: z.literal("get_quote"),
  service_category: z.enum(["domestic", "commercial"]).or(z.string().min(1)),
  domestic_service_type: z.string(),
  commercial_service_type: z.string(),
  domestic_property_type: z.string(),
  commercial_property_type: z.string(),
  job_type: z.string(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  toilets: z.number().int().nonnegative(),
  kitchens: z.number().int().nonnegative(),
  postcode: z.string().min(1),
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
   Postcode handling (hearing + phonetics)
--------------------------------*/

// Normalize common spoken tokens to single characters
const LETTER_WORDS = new Map([
  ["double u", "W"],
  ["double-you", "W"],
  ["w", "W"],
  ["zed", "Z"],
  ["zee", "Z"],
]);

const DIGIT_WORDS = new Map([
  ["zero", "0"],
  ["oh", "0"],
  ["o", "0"],
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

// A small NATO subset helps callers who say "Sierra" etc.
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
  ["x-ray", "X"],
  ["xray", "X"],
  ["yankee", "Y"],
  ["zulu", "Z"],
]);

function cleanToken(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9- ]/g, " ").trim();
}

function looksLikeUkPostcode(compact) {
  // Loose but practical UK postcode check.
  // Examples: SW1A1AA, M11AE, B338TH, CR26XH
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact);
}

function formatUkPostcode(compact) {
  // Insert a space before last 3 characters: SW1A1AA -> SW1A 1AA
  const left = compact.slice(0, -3);
  const right = compact.slice(-3);
  return `${left} ${right}`;
}

function extractPostcodeFromSpeech(raw) {
  const text = String(raw || "");
  if (!text.trim()) return null;

  // 1) Capture phonetic patterns like "S for Sun", "W as in Winter", "A like Apple"
  // We keep only the letter token before for/as in/like.
  const phoneticLetters = [];
  const phoneticRegex = /(^|[\s,])([a-z])\s*(for|as in|like)\s+([a-z]+)/gi;
  let m;
  while ((m = phoneticRegex.exec(text)) !== null) {
    phoneticLetters.push(m[2].toUpperCase());
  }

  // 2) Tokenize and map known words
  const normalized = cleanToken(text)
    .replace(/\s+/g, " ")
    .trim();

  const tokens = normalized.split(" ").filter(Boolean);

  const out = [];

  // Add phonetic letters first if present
  if (phoneticLetters.length) out.push(...phoneticLetters);

  // Walk tokens and convert to letters/digits
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Skip example words after phonetic markers, since we already captured the letter
    if (token === "for") continue;
    if (token === "as" && tokens[i + 1] === "in") continue;
    if (token === "in" && tokens[i - 1] === "as") continue;
    if (token === "like") continue;

    // "double u"
    if (token === "double" && tokens[i + 1] === "u") {
      out.push("W");
      i++;
      continue;
    }

    // Single letter token
    if (/^[a-z]$/.test(token)) {
      out.push(token.toUpperCase());
      continue;
    }

    // NATO word
    if (NATO.has(token)) {
      out.push(NATO.get(token));
      continue;
    }

    // Known letter-words
    if (LETTER_WORDS.has(token)) {
      out.push(LETTER_WORDS.get(token));
      continue;
    }

    // Digit word
    if (DIGIT_WORDS.has(token)) {
      out.push(DIGIT_WORDS.get(token));
      continue;
    }

    // Alphanumeric chunks like "sw1a" or "1aa"
    if (/^[a-z0-9]+$/.test(token) && token.length <= 7) {
      out.push(token.toUpperCase());
      continue;
    }
  }

  // 3) Compact and validate
  const compact = out.join("").replace(/\s+/g, "").toUpperCase();

  // Remove any non A-Z0-9 (defensive)
  const compact2 = compact.replace(/[^A-Z0-9]/g, "");

  if (!looksLikeUkPostcode(compact2)) return null;

  return formatUkPostcode(compact2);
}

/* -----------------------------
   Helpers: category and property type hearing
--------------------------------*/

function detectServiceCategory(text) {
  const lower = String(text || "").toLowerCase();

  const domesticHits = [
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
  const commercialHits = [
    "office",
    "shop",
    "warehouse",
    "school",
    "clinic",
    "gym",
    "venue",
    "business",
    "restaurant",
    "workplace",
  ];

  const d = domesticHits.some((x) => lower.includes(x));
  const c = commercialHits.some((x) => lower.includes(x));

  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return null;
}

function likelyPropertyTypeUnclear(text) {
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

/* -----------------------------
   Routes
--------------------------------*/

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Twilio will POST on call, but having GET helps quick browser checks.
app.get("/call/start", (req, res) => {
  const twiml = new VoiceResponse();
  sayGather(
    twiml,
    ensurePoundsOnly(
      "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?"
    )
  );
  res.type("text/xml").send(twiml.toString());
});

// Start call (Twilio Voice webhook)
app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid;

  callState.set(callSid, {
    transcript: [],
    stage: "need_category",
    data: {
      service_category: "",
      domestic_service_type: "",
      commercial_service_type: "",
      domestic_property_type: "",
      commercial_property_type: "",
      postcode: "",
      postcode_attempts: 0,
      notes: "",
    },
  });

  const twiml = new VoiceResponse();
  sayGather(
    twiml,
    ensurePoundsOnly(
      "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?"
    )
  );
  res.type("text/xml").send(twiml.toString());
});

app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = callState.get(callSid) || {
    transcript: [],
    stage: "need_category",
    data: { postcode_attempts: 0, notes: "" },
  };

  if (speech) state.transcript.push(speech);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(
      twiml,
      ensurePoundsOnly(
        "Sorry, I didn’t catch that. Is the cleaning for a home or for a business premises?"
      )
    );
    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage machine (minimal but stable)
  if (state.stage === "need_category") {
    const category = detectServiceCategory(speech);
    if (!category) {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "No problem. Is it for a home, or for a business premises?"
        )
      );
      callState.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.data.service_category = category;
    state.stage = "need_service_type";

    if (category === "domestic") {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Thanks. What type of cleaning do you need for the home? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection."
        )
      );
    } else {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Thanks. What type of commercial cleaning do you need? For example regular commercial cleaning, deep clean, post-construction, or disinfection."
        )
      );
    }

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_service_type") {
    // For MVP we store raw and move on.
    // You can plug in full guardrails and strict flow selection next.
    if (state.data.service_category === "domestic") {
      state.data.domestic_service_type = speech;
    } else {
      state.data.commercial_service_type = speech;
    }

    state.stage = "need_property_type";

    if (state.data.service_category === "domestic") {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Thanks. What’s the property type, flat or house? If house, is it terraced, semi-detached, or detached?"
        ),
        BASE_HINTS
      );
    } else {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Thanks. What type of premises is it, for example office, shop, warehouse, school, clinic, or gym?"
        ),
        BASE_HINTS
      );
    }

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_property_type") {
    // Keep raw for now, but confirm if high-risk wording appears.
    if (likelyPropertyTypeUnclear(speech)) {
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Just to check, is that a flat, or a house? And if it’s a house, is it terraced, semi-detached, or detached?"
        )
      );
      callState.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    if (state.data.service_category === "domestic") {
      state.data.domestic_property_type = speech;
    } else {
      state.data.commercial_property_type = speech;
    }

    state.stage = "need_postcode";

    sayGather(
      twiml,
      ensurePoundsOnly(
        "Thanks. What’s the postcode? You can say it letter by letter, or like S for Sun, W as in Winter."
      ),
      [
        ...BASE_HINTS,
        "letter by letter",
        "as in",
        "for",
        "S for Sun",
        "W as in Winter",
        "double u",
        "zed",
      ]
    );

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "need_postcode") {
    const parsed = extractPostcodeFromSpeech(speech);

    if (!parsed) {
      state.data.postcode_attempts = (state.data.postcode_attempts || 0) + 1;

      // After 2 attempts, stop looping and move to a fallback so calls do not stall.
      if (state.data.postcode_attempts >= 2) {
        state.data.postcode = "UNKNOWN";
        state.data.notes = `${state.data.notes || ""} Postcode capture failed. Caller provided: "${speech}".`;
        state.stage = "postcode_fallback";

        sayGather(
          twiml,
          ensurePoundsOnly(
            "No worries. The postcode is coming through unclear. What town are you in, and the nearest landmark or street name?"
          )
        );

        callState.set(callSid, state);
        return res.type("text/xml").send(twiml.toString());
      }

      sayGather(
        twiml,
        ensurePoundsOnly(
          "Sorry, I didn’t get that. Please say the postcode slowly, letter by letter. You can also use ‘S for Sun’ style."
        )
      );

      callState.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    state.data.postcode = parsed;
    state.stage = "confirm_postcode";

    sayGather(
      twiml,
      ensurePoundsOnly(`Thanks. I got ${parsed}. Is that right? Say yes or no.`),
      ["yes", "no", ...BASE_HINTS]
    );

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "confirm_postcode") {
    const lower = speech.toLowerCase();
    if (lower.includes("yes")) {
      state.stage = "next_steps_placeholder";
      sayGather(
        twiml,
        ensurePoundsOnly(
          "Perfect. Next, how many bedrooms and bathrooms is it?"
        ),
        [...BASE_HINTS, "one", "two", "three", "four", "five"]
      );
      callState.set(callSid, state);
      return res.type("text/xml").send(twiml.toString());
    }

    // Reset postcode attempt loop once more
    state.data.postcode_attempts = 0;
    state.stage = "need_postcode";

    sayGather(
      twiml,
      ensurePoundsOnly(
        "Thanks. Please say the postcode again, letter by letter. You can say S for Sun, W as in Winter."
      )
    );

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  if (state.stage === "postcode_fallback") {
    // Capture town/landmark and continue so the call does not stall
    state.data.notes = `${state.data.notes || ""} Fallback location: "${speech}".`;
    state.stage = "next_steps_placeholder";

    sayGather(
      twiml,
      ensurePoundsOnly(
        "Thanks. Next, how many bedrooms and bathrooms is it?"
      )
    );

    callState.set(callSid, state);
    return res.type("text/xml").send(twiml.toString());
  }

  // Default: keep moving without getting stuck
  sayGather(
    twiml,
    ensurePoundsOnly(
      "Thanks. Tell me a bit more about what you need, starting with the bedrooms and bathrooms."
    )
  );
  callState.set(callSid, state);
  return res.type("text/xml").send(twiml.toString());
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Brain API listening on ${port}`);
});
