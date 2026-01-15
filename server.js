import express from "express";
import axios from "axios";
import twilio from "twilio";
import { z } from "zod";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  PUBLIC_BASE_URL,
  TWILIO_AUTH_TOKEN,
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

const callState = new Map();

const DOMESTIC_SERVICES = [
  "End of Tenancy Clean",
  "Deep Clean",
  "Regular Cleaning",
  "Post-construction Clean",
  "Disinfection / Sanitisation",
];

const COMMERCIAL_SERVICES = [
  "Regular Commercial Cleaning",
  "Deep Clean",
  "Post-construction Clean",
  "Disinfection / Sanitisation",
];

const EXTRAS_ALLOWED = [
  "Oven cleaning",
  "Carpet cleaning",
  "Upholstery cleaning",
  "Inside windows",
  "Limescale removal",
  "Deep toilet clean",
  "Fridge / freezer cleaning",
  "Internal cabinet cleaning",
  "Blinds dusting",
  "Wall spot cleaning",
  "Pet hair removal",
  "Mold spot treatment",
  "Mattress steam clean",
  "Degreasing extractor fans",
];

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

function baseUrl() {
  return (PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

function abs(path) {
  const b = baseUrl();
  if (!b) return path;
  return `${b}${path}`;
}

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

function ensureGbpSpeech(text) {
  if (containsDollar(text)) {
    return "Sorry, I only quote in pounds. Is the cleaning for a home or for a business premises?";
  }
  return text;
}

function sayGather(twiml, text) {
  const actionUrl = abs("/call/input");
  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
  });
  gather.say({ voice: "alice", language: "en-GB" }, ensureGbpSpeech(text));
  twiml.redirect({ method: "POST" }, actionUrl);
}

function say(twiml, text) {
  twiml.say({ voice: "alice", language: "en-GB" }, ensureGbpSpeech(text));
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function lower(s) {
  return normalizeSpaces(s).toLowerCase();
}

function looksLikePostcode(s) {
  const t = normalizeSpaces(s).toUpperCase();
  return /([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/.test(t);
}

function extractPostcode(s) {
  const t = normalizeSpaces(s).toUpperCase();
  const m = t.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/);
  return m ? m[1].replace(/\s+/, " ") : "";
}

function extractNumber(s) {
  const m = String(s || "").match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isAffirmative(s) {
  const t = lower(s);
  return ["yes", "yeah", "yep", "correct", "that’s right", "thats right", "sure", "ok", "okay"].some((x) => t.includes(x));
}

function isNegative(s) {
  const t = lower(s);
  return ["no", "nope", "none", "nothing", "not", "don’t", "dont"].some((x) => t === x || t.startsWith(x + " "));
}

function detectServiceCategoryFromSpeech(s) {
  const t = lower(s);
  const domesticHints = ["home", "house", "flat", "apartment", "studio", "tenancy", "landlord", "move out", "move-out", "property"];
  const commercialHints = ["office", "shop", "warehouse", "school", "clinic", "gym", "venue", "site", "business", "restaurant", "workplace"];
  const d = domesticHints.some((x) => t.includes(x));
  const c = commercialHints.some((x) => t.includes(x));
  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return "";
}

function detectPartialAreas(s) {
  const t = lower(s);
  const hits = [];
  if (t.includes("only kitchen") || t.includes("just kitchen") || t === "kitchen") hits.push("kitchen only");
  if (t.includes("only bathroom") || t.includes("just bathroom") || t === "bathroom") hits.push("bathroom only");
  if (t.includes("toilets only") || t.includes("only toilets") || t.includes("just toilets") || t.includes("wc only")) hits.push("toilets only");
  return hits.length ? hits.join(", ") : "";
}

function serviceTypeFromSpeech(category, s) {
  const t = lower(s);

  if (category === "domestic") {
    if (t.includes("end of tenancy") || t.includes("move out") || t.includes("move-out")) return "End of Tenancy Clean";
    if (t.includes("deep")) return "Deep Clean";
    if (t.includes("post") && (t.includes("construction") || t.includes("builder") || t.includes("after builders") || t.includes("after-builder") || t.includes("after builder"))) {
      return "Post-construction Clean";
    }
    if (t.includes("disinfect") || t.includes("saniti") || t.includes("sanit")) return "Disinfection / Sanitisation";
    if (t.includes("regular") || t.includes("standard") || t.includes("weekly") || t.includes("fortnight") || t.includes("bi-weekly") || t.includes("every other week") || t.includes("monthly") || t.includes("recurring") || t.includes("ongoing")) {
      return "Regular Cleaning";
    }
    return "";
  }

  if (category === "commercial") {
    if (t.includes("regular")) return "Regular Commercial Cleaning";
    if (t.includes("deep")) return "Deep Clean";
    if (t.includes("post") && (t.includes("construction") || t.includes("builder") || t.includes("after builders") || t.includes("after builder"))) {
      return "Post-construction Clean";
    }
    if (t.includes("disinfect") || t.includes("saniti") || t.includes("sanit")) return "Disinfection / Sanitisation";
    if (t.includes("office cleaning") || t.includes("commercial cleaning")) return "Regular Commercial Cleaning";
    return "";
  }

  return "";
}

function jobTypeFromSpeech(s) {
  const t = lower(s);
  if (t.includes("one off") || t.includes("one-off") || t.includes("one time") || t.includes("one-time") || t.includes("once")) return "one_time";
  if (t.includes("ongoing") || t.includes("regular") || t.includes("recurring")) return "regular";
  return "";
}

function frequencyFromSpeech(s) {
  const t = lower(s);

  const hard = [
    { phrases: ["weekly", "once a week", "every week", "one day a week"], val: 1 },
    { phrases: ["fortnightly", "bi-weekly", "every other week", "once every two weeks", "alternate weeks"], val: 0.5 },
    { phrases: ["monthly", "once a month", "every month", "one visit a month"], val: 0.25 },
    { phrases: ["twice a week", "two times a week", "2 times a week", "2x a week"], val: 2 },
    { phrases: ["three times a week", "3 times a week", "3x a week"], val: 3 },
    { phrases: ["every weekday", "weekdays"], val: 5 },
    { phrases: ["daily monday to friday", "daily mon to fri", "daily monday-friday"], val: 5 },
    { phrases: ["daily including weekends", "every day"], val: 7 },
  ];

  for (const h of hard) {
    if (h.phrases.some((p) => t.includes(p))) return h.val;
  }

  if (t.includes("per week")) {
    const n = extractNumber(t);
    if (n !== null) return n;
  }

  const ambiguous = ["regularly", "ongoing", "as needed", "when required", "now and then", "occasionally"];
  if (ambiguous.some((p) => t.includes(p))) return null;

  return null;
}

function normalizeDomesticPropertyType(s) {
  const t = lower(s);

  if (t.includes("studio")) return { value: "Studio flat", needsConfirm: false };

  if (t.includes("flat") || t.includes("apartment") || t.includes("maisonette") || t.includes("maisonette") || t.includes("upstairs flat") || t.includes("ground floor flat")) {
    return { value: "Flat", needsConfirm: false };
  }

  const highRisk = ["semi", "semmy", "semi-d", "terrace", "terraced", "mid-terrace", "end terrace", "detached-ish", "flat-ish", "apartment sort of", "studio-type"];
  const needsConfirm = highRisk.some((p) => t.includes(p));

  if (t.includes("semi")) return { value: "Semi-detached house", needsConfirm: true };
  if (t.includes("detached")) return { value: "Detached house", needsConfirm: needsConfirm };
  if (t.includes("terrace") || t.includes("terraced")) return { value: "Terraced house", needsConfirm: true };
  if (t.includes("house")) return { value: "", needsConfirm: true };

  return { value: "", needsConfirm: true };
}

function normalizeCommercialPropertyType(s) {
  const t = lower(s);

  const map = [
    { k: ["office"], v: "Office" },
    { k: ["school"], v: "School" },
    { k: ["clinic", "medical"], v: "Medical clinic" },
    { k: ["warehouse"], v: "Warehouse" },
    { k: ["commercial kitchen", "kitchen"], v: "Commercial kitchen" },
    { k: ["retail", "shop", "store"], v: "Retail shop" },
    { k: ["nursery", "daycare", "day care"], v: "Nursery (daycare)" },
    { k: ["gym"], v: "Gym" },
    { k: ["workshop", "industrial"], v: "Industrial workshop" },
    { k: ["venue", "event"], v: "Event venue" },
  ];

  for (const m of map) {
    if (m.k.some((x) => t.includes(x))) return { value: m.v, needsConfirm: false };
  }

  return { value: "", needsConfirm: true };
}

function detectExtrasMention(s) {
  const t = lower(s);

  const hits = [];
  const checks = [
    { key: ["oven"], name: "Oven cleaning" },
    { key: ["carpet", "carpets"], name: "Carpet cleaning" },
    { key: ["upholstery", "sofa", "couch"], name: "Upholstery cleaning" },
    { key: ["inside windows", "internal windows", "inside window"], name: "Inside windows" },
    { key: ["limescale"], name: "Limescale removal" },
    { key: ["deep toilet", "toilet deep"], name: "Deep toilet clean" },
    { key: ["fridge", "freezer"], name: "Fridge / freezer cleaning" },
    { key: ["cabinet", "cupboard"], name: "Internal cabinet cleaning" },
    { key: ["blinds"], name: "Blinds dusting" },
    { key: ["wall spot", "walls"], name: "Wall spot cleaning" },
    { key: ["pet hair"], name: "Pet hair removal" },
    { key: ["mold", "mould"], name: "Mold spot treatment" },
    { key: ["mattress"], name: "Mattress steam clean" },
    { key: ["extractor", "degrease"], name: "Degreasing extractor fans" },
  ];

  for (const c of checks) {
    if (c.key.some((k) => t.includes(k))) hits.push(c.name);
  }

  return Array.from(new Set(hits));
}

function ensureState(callSid) {
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      stage: "start",
      transcript: [],
      data: {
        intent: "",
        service_category: "",
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
      extrasImpactSpoken: false,
      pendingExtraName: "",
      pendingExtraQty: null,
      confirmSummaryPending: false,
      quoteResult: null,
      booking: {
        full_name: "",
        phone: "",
        email: "",
        address: "",
        postcode: "",
        preferred_date: "",
        preferred_time: "",
      },
    });
  }
  return callState.get(callSid);
}

function applyMinimumHours(data) {
  const sc = data.service_category;

  if (sc === "domestic") {
    if (data.domestic_service_type === "Regular Cleaning") {
      if (data.job_type === "one_time") {
        if (data.preferred_hours > 0 && data.preferred_hours < 5) data.preferred_hours = 5;
        if (data.preferred_hours === 0) data.preferred_hours = 5;
      } else if (data.job_type === "regular") {
        if (data.preferred_hours > 0 && data.preferred_hours < 3) data.preferred_hours = 3;
        if (data.preferred_hours === 0) data.preferred_hours = 3;
      }
    }
    return;
  }

  if (sc === "commercial") {
    if (data.job_type === "one_time") {
      if (data.preferred_hours > 0 && data.preferred_hours < 5) data.preferred_hours = 5;
      if (data.preferred_hours === 0) data.preferred_hours = 5;
    } else if (data.job_type === "regular") {
      const f = data.visit_frequency_per_week || 0;
      if (f >= 3) {
        if (data.preferred_hours > 0 && data.preferred_hours < 1) data.preferred_hours = 1;
        if (data.preferred_hours === 0) data.preferred_hours = 1;
      } else {
        if (data.preferred_hours > 0 && data.preferred_hours < 3) data.preferred_hours = 3;
        if (data.preferred_hours === 0) data.preferred_hours = 3;
      }
    }
  }
}

function quoteCriticalMissing(data) {
  if (!data.service_category) return "service category";
  if (data.service_category === "domestic") {
    if (!data.domestic_service_type) return "domestic service type";
    if (!data.domestic_property_type) return "domestic property type";
    if (!data.postcode) return "postcode";
    if (!Number.isFinite(data.bedrooms) || data.bedrooms < 0) return "bedrooms";
    if (!Number.isFinite(data.bathrooms) || data.bathrooms < 0) return "bathrooms";

    const flatFee = ["End of Tenancy Clean", "Deep Clean", "Post-construction Clean", "Disinfection / Sanitisation"];
    const hourly = ["Regular Cleaning"];

    if (hourly.includes(data.domestic_service_type)) {
      if (!data.job_type) return "job type";
      if (!Number.isFinite(data.preferred_hours) || data.preferred_hours <= 0) return "hours per visit";
      if (!Number.isFinite(data.visit_frequency_per_week) || data.visit_frequency_per_week <= 0) return "visit frequency";
    }

    if (flatFee.includes(data.domestic_service_type)) {
      if (!Number.isFinite(data.toilets) || data.toilets < 0) return "toilets";
    }

    return "";
  }

  if (data.service_category === "commercial") {
    if (!data.commercial_service_type) return "commercial service type";
    if (!data.commercial_property_type) return "commercial property type";
    if (!data.job_type) return "job type";
    if (!data.postcode) return "postcode";
    if (!Number.isFinite(data.toilets) || data.toilets < 0) return "toilets";
    if (!Number.isFinite(data.kitchens) || data.kitchens < 0) return "kitchens";
    if (!Number.isFinite(data.preferred_hours) || data.preferred_hours <= 0) return "hours expected";
    if (data.job_type === "regular") {
      if (!Number.isFinite(data.visit_frequency_per_week) || data.visit_frequency_per_week <= 0) return "visit frequency";
    }
    return "";
  }

  return "service category";
}

function makeSummaryForCaller(data) {
  if (data.service_category === "domestic") {
    const svc = data.domestic_service_type;
    const pt = data.domestic_property_type;
    const pc = data.postcode;
    const b = data.bedrooms;
    const ba = data.bathrooms;
    const t = data.toilets;

    let s = `Just to confirm, it’s ${svc} for a ${b}-bed ${pt}, with ${ba} bathroom`;
    if (ba !== 1) s += "s";
    if (["End of Tenancy Clean", "Deep Clean", "Post-construction Clean", "Disinfection / Sanitisation"].includes(svc)) {
      s += `, and ${t} separate toilet`;
      if (t !== 1) s += "s";
    }
    s += `, postcode ${pc}.`;

    if (svc === "Regular Cleaning") {
      s += ` It’s ${data.job_type === "regular" ? "ongoing" : "a one-off"} at ${data.preferred_hours} hours per visit, about ${data.visit_frequency_per_week} visit`;
      if (data.visit_frequency_per_week !== 1) s += "s";
      s += " per week.";
    }

    if (data.areas_scope) {
      s += ` You only want: ${data.areas_scope}.`;
    }

    if (data.extras && data.extras.length) {
      const extrasText = data.extras.map((e) => `${e.name} x${e.quantity}`).join(", ");
      s += ` Extras: ${extrasText}.`;
    } else {
      s += " No extras.";
    }

    s += " Is that all correct before I price it?";
    return s;
  }

  const svc = data.commercial_service_type;
  const pt = data.commercial_property_type;
  const pc = data.postcode;
  const jt = data.job_type;

  let s = `Just to confirm, it’s ${svc} for a ${pt}, postcode ${pc}.`;
  s += ` This is ${jt === "regular" ? "ongoing" : "a one-time clean"}.`;
  s += ` Toilets: ${data.toilets}. Kitchens: ${data.kitchens}.`;
  s += ` Hours: ${data.preferred_hours}.`;
  if (jt === "regular") {
    s += ` Frequency: ${data.visit_frequency_per_week} visit`;
    if (data.visit_frequency_per_week !== 1) s += "s";
    s += " per week.";
  }
  if (data.extras && data.extras.length) {
    const extrasText = data.extras.map((e) => `${e.name} x${e.quantity}`).join(", ");
    s += ` Extras: ${extrasText}.`;
  } else {
    s += " No extras.";
  }
  s += " Is that all correct before I price it?";
  return s;
}

async function callMakeGetQuote(payload) {
  if (!MAKE_GETQUOTE_WEBHOOK_URL) {
    return { ok: false, error: "Missing MAKE_GETQUOTE_WEBHOOK_URL" };
  }
  try {
    const resp = await axios.post(MAKE_GETQUOTE_WEBHOOK_URL, payload, {
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
    return { ok: true, data: resp.data };
  } catch (e) {
    return { ok: false, error: e?.message || "GetQuote webhook failed" };
  }
}

async function callMakeConfirmBooking(payload) {
  if (!MAKE_CONFIRMBOOKING_WEBHOOK_URL) {
    return { ok: false, error: "Missing MAKE_CONFIRMBOOKING_WEBHOOK_URL" };
  }
  try {
    const resp = await axios.post(MAKE_CONFIRMBOOKING_WEBHOOK_URL, payload, {
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
    return { ok: true, data: resp.data };
  } catch (e) {
    return { ok: false, error: e?.message || "ConfirmBooking webhook failed" };
  }
}

function requireClarifyBeforeRefusal(speech) {
  const t = lower(speech);
  const cleaningWords = ["clean", "cleaning", "cleaner"];
  const outsideWords = ["plumbing", "electric", "gardening", "moving", "removal", "waste", "rubbish", "painting", "handyman", "repair"];
  const hasCleaning = cleaningWords.some((x) => t.includes(x));
  const hasOutside = outsideWords.some((x) => t.includes(x));
  if (!hasCleaning && hasOutside) return true;
  return false;
}

function setAreasScopeIfAny(state, speech) {
  if (!state.data.areas_scope) {
    const scope = detectPartialAreas(speech);
    if (scope) {
      state.data.areas_scope = scope;
      if (state.data.service_category === "domestic") {
        state.data.domestic_service_type = "Deep Clean";
      }
    }
  }
}

function ensureExtrasImpactSpokenOnce(state, twiml) {
  if (state.extrasImpactSpoken) return;
  state.extrasImpactSpoken = true;
  say(twiml, "Just so you know, adding that will increase the time needed to finish the job, and the price will go up slightly.");
}

function upsertExtra(state, extraName, qty) {
  const idx = state.data.extras.findIndex((e) => e.name === extraName);
  const obj = { name: extraName, quantity: qty };
  if (idx >= 0) state.data.extras[idx] = obj;
  else state.data.extras.push(obj);
}

function ensureExtrasArrayHasObjects(state) {
  if (!Array.isArray(state.data.extras)) state.data.extras = [];
  state.data.extras = state.data.extras
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ name: String(x.name || "").trim(), quantity: Number(x.quantity ?? 0) }))
    .filter((x) => x.name.length > 0 && Number.isFinite(x.quantity) && x.quantity >= 0);
}

function forceGbpInQuoteResponse(raw) {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (containsDollar(s)) {
    return {
      ok: false,
      error: "Quote response contained dollars. Fix your Make scenario to output GBP only.",
    };
  }
  return { ok: true };
}

function safeNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return x;
}

function tryCaptureBedroomsBathrooms(state, speech) {
  const t = lower(speech);

  const bedMatch = t.match(/(\d+)\s*(bed|beds|bedroom|bedrooms)/);
  if (bedMatch) state.data.bedrooms = Number(bedMatch[1]);

  const bathMatch = t.match(/(\d+)\s*(bath|baths|bathroom|bathrooms)/);
  if (bathMatch) state.data.bathrooms = Number(bathMatch[1]);
}

function twimlEnd(twiml, res) {
  res.type("text/xml").send(twiml.toString());
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid || `CALL_${Date.now()}`;
  const state = ensureState(callSid);

  state.stage = "need_category";
  state.transcript = [];
  state.extrasImpactSpoken = false;
  state.pendingExtraName = "";
  state.pendingExtraQty = null;
  state.confirmSummaryPending = false;
  state.quoteResult = null;
  state.data = {
    intent: "",
    service_category: "",
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
  state.booking = {
    full_name: "",
    phone: "",
    email: "",
    address: "",
    postcode: "",
    preferred_date: "",
    preferred_time: "",
  };

  callState.set(callSid, state);

  const twiml = new VoiceResponse();
  sayGather(twiml, "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?");
  return twimlEnd(twiml, res);
});

app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid || `CALL_${Date.now()}`;
  const speechRaw = normalizeSpaces(req.body.SpeechResult || "");
  const speech = speechRaw;
  const state = ensureState(callSid);

  if (speech) state.transcript.push(speech);
  ensureExtrasArrayHasObjects(state);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(twiml, "Sorry, I didn’t catch that. Is the cleaning for a home or for a business premises?");
    return twimlEnd(twiml, res);
  }

  if (containsDollar(speech)) {
    sayGather(twiml, "Sorry, I only quote in pounds. Is the cleaning for a home or for a business premises?");
    return twimlEnd(twiml, res);
  }

  setAreasScopeIfAny(state, speech);

  const t = lower(speech);

  if (requireClarifyBeforeRefusal(speech)) {
    sayGather(twiml, "What kind of cleaning is this for, a home or a business?");
    return twimlEnd(twiml, res);
  }

  const mentionedExtras = detectExtrasMention(speech);
  if (mentionedExtras.length) {
    ensureExtrasImpactSpokenOnce(state, twiml);
    for (const ex of mentionedExtras) {
      const exists = state.data.extras.some((e) => e.name === ex);
      if (!exists) upsertExtra(state, ex, 0);
    }
  }

  if (state.pendingExtraName) {
    const qty = extractNumber(speech);
    if (qty === null) {
      sayGather(twiml, `Sorry, how many would that be for ${state.pendingExtraName}?`);
      return twimlEnd(twiml, res);
    }
    upsertExtra(state, state.pendingExtraName, Math.max(0, Math.floor(qty)));
    state.pendingExtraName = "";
    state.pendingExtraQty = null;
  }

  if (state.confirmSummaryPending) {
    if (!isAffirmative(speech)) {
      sayGather(twiml, "No problem. What would you like to change?");
      state.confirmSummaryPending = false;
      return twimlEnd(twiml, res);
    }

    const missing = quoteCriticalMissing(state.data);
    if (missing) {
      state.confirmSummaryPending = false;
      sayGather(twiml, `I still need your ${missing}.`);
      return twimlEnd(twiml, res);
    }

    applyMinimumHours(state.data);

    const payload = {
      intent: "get_quote",
      service_category: state.data.service_category,
      domestic_service_type: state.data.domestic_service_type || "",
      commercial_service_type: state.data.commercial_service_type || "",
      domestic_property_type: state.data.domestic_property_type || "",
      commercial_property_type: state.data.commercial_property_type || "",
      job_type: state.data.job_type || "",
      bedrooms: safeNumber(state.data.bedrooms),
      bathrooms: safeNumber(state.data.bathrooms),
      toilets: safeNumber(state.data.toilets),
      kitchens: safeNumber(state.data.kitchens),
      postcode: state.data.postcode || "",
      preferred_hours: safeNumber(state.data.preferred_hours),
      visit_frequency_per_week: safeNumber(state.data.visit_frequency_per_week),
      areas_scope: state.data.areas_scope || "",
      extras: state.data.extras || [],
      notes: state.data.notes || "",
    };

    const parsed = GetQuoteSchema.safeParse(payload);
    if (!parsed.success) {
      state.confirmSummaryPending = false;
      sayGather(twiml, "Sorry, I’m missing a detail to price this. Can I quickly confirm the postcode and property type?");
      return twimlEnd(twiml, res);
    }

    const q = await callMakeGetQuote(parsed.data);
    if (!q.ok) {
      state.confirmSummaryPending = false;
      sayGather(twiml, "Sorry, I couldn’t pull the price right now. Can I take your postcode again and I’ll try once more?");
      return twimlEnd(twiml, res);
    }

    const currencyCheck = forceGbpInQuoteResponse(q.data);
    if (!currencyCheck.ok) {
      state.confirmSummaryPending = false;
      sayGather(twiml, "Sorry, I’m only able to quote in pounds. I need to fix the pricing feed first. Can I take your name and number so we call you back with the correct price?");
      state.stage = "need_booking_name";
      return twimlEnd(twiml, res);
    }

    state.quoteResult = q.data;

    const explanation =
      (q.data && (q.data.explanation || q.data.message || q.data.speech)) ||
      "";

    const total =
      (q.data && (q.data.total || q.data.total_price || q.data.price || q.data.amount)) ||
      null;

    if (explanation) {
      say(twiml, explanation);
    } else if (total !== null) {
      say(twiml, `Alright. The total comes to £${total} including any extras. Would you like to book it in?`);
    } else {
      say(twiml, "Alright. I have the estimate. Would you like to book it in?");
    }

    sayGather(twiml, "Would you like to book that in?");
    state.stage = "post_quote_booking_decision";
    state.confirmSummaryPending = false;
    return twimlEnd(twiml, res);
  }

  if (state.stage === "post_quote_booking_decision") {
    if (isAffirmative(speech)) {
      state.stage = "need_booking_name";
      sayGather(twiml, "Perfect. What’s your full name?");
      return twimlEnd(twiml, res);
    }
    sayGather(twiml, "No problem. Would you like me to send the estimate by text or email?");
    state.stage = "offer_followup";
    return twimlEnd(twiml, res);
  }

  if (state.stage === "offer_followup") {
    say(twiml, "Alright. Thanks for calling TotalSpark Solutions.");
    twiml.hangup();
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_name") {
    state.booking.full_name = speech;
    state.stage = "need_booking_phone";
    sayGather(twiml, "Thanks. What’s the best phone number for you?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_phone") {
    state.booking.phone = speech;
    state.stage = "need_booking_email";
    sayGather(twiml, "And what email should I use?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_email") {
    state.booking.email = speech;
    state.stage = "need_booking_address";
    sayGather(twiml, "What’s the address for the job? Postcode is fine if you prefer.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_address") {
    state.booking.address = speech;
    if (!state.booking.postcode) {
      const pc = extractPostcode(speech);
      if (pc) state.booking.postcode = pc;
    }
    state.stage = "need_booking_date";
    sayGather(twiml, "What date would you like?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_date") {
    state.booking.preferred_date = speech;
    state.stage = "need_booking_time";
    sayGather(twiml, "And what time suits you?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_booking_time") {
    state.booking.preferred_time = speech;

    if (!state.booking.postcode) state.booking.postcode = state.data.postcode || "";

    const payload = {
      intent: "confirm_booking",
      full_name: state.booking.full_name,
      phone: state.booking.phone,
      email: state.booking.email,
      address: state.booking.address,
      postcode: state.booking.postcode,
      preferred_date: state.booking.preferred_date,
      preferred_time: state.booking.preferred_time,
    };

    const parsed = ConfirmBookingSchema.safeParse(payload);
    if (!parsed.success) {
      sayGather(twiml, "Sorry, I’m missing a detail to confirm the booking. Can you repeat your full name and phone number?");
      state.stage = "need_booking_name";
      return twimlEnd(twiml, res);
    }

    const b = await callMakeConfirmBooking(parsed.data);
    if (!b.ok) {
      sayGather(twiml, "Sorry, I couldn’t confirm that booking right now. Can you tell me your preferred date and time again?");
      state.stage = "need_booking_date";
      return twimlEnd(twiml, res);
    }

    say(twiml, "Perfect, you’re booked in. We’ll be in touch if we need anything else.");
    twiml.hangup();
    return twimlEnd(twiml, res);
  }

  if (state.stage === "start") {
    state.stage = "need_category";
  }

  if (state.stage === "need_category") {
    const cat = detectServiceCategoryFromSpeech(speech);
    if (!cat) {
      sayGather(twiml, "Is the cleaning for a home or for a business premises?");
      return twimlEnd(twiml, res);
    }
    state.data.service_category = cat;

    if (cat === "domestic") {
      state.stage = "need_domestic_service_type";
      sayGather(twiml, "What type of cleaning do you need?");
      return twimlEnd(twiml, res);
    }

    state.stage = "need_commercial_service_type";
    sayGather(twiml, "What type of commercial cleaning do you need?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_service_type") {
    const svc = serviceTypeFromSpeech("domestic", speech);
    if (!svc) {
      sayGather(twiml, "What type of cleaning do you need? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection.");
      return twimlEnd(twiml, res);
    }
    state.data.domestic_service_type = svc;

    const scope = detectPartialAreas(speech);
    if (scope) {
      state.data.areas_scope = scope;
      state.data.domestic_service_type = "Deep Clean";
    }

    state.stage = "need_domestic_property_type";
    sayGather(twiml, "What’s the property type? For example flat or house.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_service_type") {
    const svc = serviceTypeFromSpeech("commercial", speech);
    if (!svc) {
      sayGather(twiml, "What type of commercial cleaning do you need? Regular, deep clean, post-construction, or disinfection.");
      return twimlEnd(twiml, res);
    }
    state.data.commercial_service_type = svc;

    state.stage = "need_commercial_job_type";
    sayGather(twiml, "Is this a one-time clean or an ongoing service?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_job_type") {
    const jt = jobTypeFromSpeech(speech);
    if (!jt) {
      sayGather(twiml, "Just to confirm, is this a one-time clean or an ongoing service?");
      return twimlEnd(twiml, res);
    }
    state.data.job_type = jt;

    state.stage = "need_commercial_property_type";
    sayGather(twiml, "What type of business premises is it? For example office, shop, warehouse, school, or clinic.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_property_type") {
    const n = normalizeDomesticPropertyType(speech);

    if (!n.value) {
      sayGather(twiml, "Just to check, is that a flat or a house? If it’s a house, would it be terraced, semi-detached, or detached?");
      return twimlEnd(twiml, res);
    }

    state.data.domestic_property_type = n.value;

    if (n.needsConfirm) {
      state.stage = "confirm_domestic_property_type";
      sayGather(twiml, `Just to check, would that be ${n.value}?`);
      return twimlEnd(twiml, res);
    }

    state.stage = "need_domestic_postcode";
    sayGather(twiml, "What’s the postcode?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "confirm_domestic_property_type") {
    if (!isAffirmative(speech)) {
      state.data.domestic_property_type = "";
      state.stage = "need_domestic_property_type";
      sayGather(twiml, "No worries. Is it a flat, terraced house, semi-detached, or detached?");
      return twimlEnd(twiml, res);
    }

    state.stage = "need_domestic_postcode";
    sayGather(twiml, "What’s the postcode?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_postcode") {
    const pc = extractPostcode(speech);
    if (!pc) {
      sayGather(twiml, "Sorry, can you repeat the postcode?");
      return twimlEnd(twiml, res);
    }
    state.data.postcode = pc;

    state.stage = "need_domestic_bedrooms";
    sayGather(twiml, "How many bedrooms is it?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_bedrooms") {
    const n = extractNumber(speech);
    if (n === null) {
      tryCaptureBedroomsBathrooms(state, speech);
      if (!state.data.bedrooms) {
        sayGather(twiml, "Sorry, how many bedrooms is it?");
        return twimlEnd(twiml, res);
      }
    } else {
      state.data.bedrooms = Math.max(0, Math.floor(n));
    }

    state.stage = "need_domestic_bathrooms";
    sayGather(twiml, "How many bathrooms is it?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_bathrooms") {
    const n = extractNumber(speech);
    if (n === null) {
      tryCaptureBedroomsBathrooms(state, speech);
      if (!state.data.bathrooms) {
        sayGather(twiml, "Sorry, how many bathrooms is it?");
        return twimlEnd(twiml, res);
      }
    } else {
      state.data.bathrooms = Math.max(0, Math.floor(n));
    }

    const flatFee = ["End of Tenancy Clean", "Deep Clean", "Post-construction Clean", "Disinfection / Sanitisation"];

    if (flatFee.includes(state.data.domestic_service_type)) {
      state.stage = "need_domestic_toilets";
      sayGather(twiml, "Any toilets separate from the bathrooms? If none, say zero.");
      return twimlEnd(twiml, res);
    }

    if (state.data.domestic_service_type === "Regular Cleaning") {
      state.stage = "need_domestic_job_type";
      sayGather(twiml, "Is this a one-off clean or ongoing?");
      return twimlEnd(twiml, res);
    }

    state.stage = "ask_extras_domestic_optional";
    sayGather(twiml, "Any extras you want to add, or no extras?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_toilets") {
    const n = extractNumber(speech);
    if (n === null) {
      if (isNegative(speech)) state.data.toilets = 0;
      else {
        sayGather(twiml, "Sorry, how many separate toilets would that be? If none, say zero.");
        return twimlEnd(twiml, res);
      }
    } else {
      state.data.toilets = Math.max(0, Math.floor(n));
    }

    state.stage = "ask_extras_domestic_optional";
    sayGather(twiml, "Any extras you want to add, or no extras?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_job_type") {
    const jt = jobTypeFromSpeech(speech);
    if (!jt) {
      sayGather(twiml, "Just to confirm, is this a one-off clean or ongoing?");
      return twimlEnd(twiml, res);
    }
    state.data.job_type = jt;

    state.stage = "need_domestic_hours";
    sayGather(twiml, "How many hours per visit were you expecting?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_hours") {
    const n = extractNumber(speech);
    if (n === null) {
      sayGather(twiml, "Sorry, how many hours per visit were you expecting?");
      return twimlEnd(twiml, res);
    }
    state.data.preferred_hours = Math.max(0, n);

    state.stage = "need_domestic_frequency";
    sayGather(twiml, "How many visits per week would that be?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_domestic_frequency") {
    const f = frequencyFromSpeech(speech);
    if (f === null) {
      sayGather(twiml, "Just to confirm, how many visits per week would that be?");
      return twimlEnd(twiml, res);
    }
    state.data.visit_frequency_per_week = Math.max(0, f);

    state.stage = "ask_extras_domestic_optional";
    sayGather(twiml, "Any extras you want to add, or no extras?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "ask_extras_domestic_optional") {
    if (isNegative(speech) && !mentionedExtras.length) {
      state.data.extras = state.data.extras.filter((e) => e.quantity > 0);
      state.confirmSummaryPending = true;
      say(twiml, makeSummaryForCaller(state.data));
      sayGather(twiml, "Is that correct?");
      return twimlEnd(twiml, res);
    }

    if (mentionedExtras.length) {
      ensureExtrasImpactSpokenOnce(state, twiml);
      const needQty = state.data.extras.find((e) => e.quantity === 0);
      if (needQty) {
        state.pendingExtraName = needQty.name;
        sayGather(twiml, `How many would that be for ${needQty.name}?`);
        return twimlEnd(twiml, res);
      }
    }

    sayGather(twiml, "Which extra would you like to add? For example oven cleaning or carpet cleaning. If none, say no extras.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_property_type") {
    const n = normalizeCommercialPropertyType(speech);
    if (!n.value) {
      sayGather(twiml, "Sorry, what type of premises is it? For example office, shop, warehouse, school, or clinic.");
      return twimlEnd(twiml, res);
    }
    state.data.commercial_property_type = n.value;

    state.stage = "need_commercial_rooms_or_area";
    sayGather(twiml, "Roughly how many rooms is it, or what size is the area?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_rooms_or_area") {
    state.data.notes = state.data.notes ? `${state.data.notes}; size: ${speech}` : `size: ${speech}`;
    state.stage = "need_commercial_toilets";
    sayGather(twiml, "How many toilets are there?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_toilets") {
    const n = extractNumber(speech);
    if (n === null) {
      sayGather(twiml, "Sorry, how many toilets are there?");
      return twimlEnd(twiml, res);
    }
    state.data.toilets = Math.max(0, Math.floor(n));
    state.stage = "need_commercial_kitchens";
    sayGather(twiml, "Any kitchens on site? If yes, how many? If none, say zero.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_kitchens") {
    const n = extractNumber(speech);
    if (n === null) {
      if (isNegative(speech)) state.data.kitchens = 0;
      else {
        sayGather(twiml, "Sorry, how many kitchens would that be? If none, say zero.");
        return twimlEnd(twiml, res);
      }
    } else {
      state.data.kitchens = Math.max(0, Math.floor(n));
    }

    state.stage = "need_commercial_postcode";
    sayGather(twiml, "What’s the postcode?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_postcode") {
    const pc = extractPostcode(speech);
    if (!pc) {
      sayGather(twiml, "Sorry, can you repeat the postcode?");
      return twimlEnd(twiml, res);
    }
    state.data.postcode = pc;

    state.stage = "need_commercial_hours";
    sayGather(twiml, "How many hours were you expecting per visit? If you’re not sure, give me your best estimate.");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_hours") {
    const n = extractNumber(speech);
    if (n === null) {
      sayGather(twiml, "No problem. Roughly how many hours do you think it will take per visit?");
      return twimlEnd(twiml, res);
    }
    state.data.preferred_hours = Math.max(0, n);

    if (state.data.job_type === "regular") {
      state.stage = "need_commercial_frequency";
      sayGather(twiml, "How many visits per week would that be?");
      return twimlEnd(twiml, res);
    }

    state.stage = "ask_extras_commercial_optional";
    sayGather(twiml, "Any extras you want to add, or no extras?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "need_commercial_frequency") {
    const f = frequencyFromSpeech(speech);
    if (f === null) {
      sayGather(twiml, "Just to confirm, how many visits per week would that be?");
      return twimlEnd(twiml, res);
    }
    state.data.visit_frequency_per_week = Math.max(0, f);

    state.stage = "ask_extras_commercial_optional";
    sayGather(twiml, "Any extras you want to add, or no extras?");
    return twimlEnd(twiml, res);
  }

  if (state.stage === "ask_extras_commercial_optional") {
    if (isNegative(speech) && !mentionedExtras.length) {
      state.data.extras = state.data.extras.filter((e) => e.quantity > 0);
      state.confirmSummaryPending = true;
      say(twiml, makeSummaryForCaller(state.data));
      sayGather(twiml, "Is that correct?");
      return twimlEnd(twiml, res);
    }

    if (mentionedExtras.length) {
      ensureExtrasImpactSpokenOnce(state, twiml);
      const needQty = state.data.extras.find((e) => e.quantity === 0);
      if (needQty) {
        state.pendingExtraName = needQty.name;
        sayGather(twiml, `How many would that be for ${needQty.name}?`);
        return twimlEnd(twiml, res);
      }
    }

    sayGather(twiml, "Which extra would you like to add? If none, say no extras.");
    return twimlEnd(twiml, res);
  }

  sayGather(twiml, "Sorry, I might have missed that. Is the cleaning for a home or for a business premises?");
  return twimlEnd(twiml, res);
});

app.get("/call/start", (req, res) => res.status(200).send("OK. Use POST for Twilio."));
app.get("/call/input", (req, res) => res.status(200).send("OK. Use POST for Twilio."));

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Brain API listening on ${port}`);
});
