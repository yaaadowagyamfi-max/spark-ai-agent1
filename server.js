import express from "express";
import axios from "axios";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  PUBLIC_BASE_URL,
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

// In-memory state keyed by CallSid
const callState = new Map();

/* -----------------------------
   Helpers: speech safety + GBP
------------------------------*/

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

function enforceGbpOnlySpoken(text = "") {
  const t = String(text);
  if (containsDollar(t)) {
    return "Sorry, I only quote in pounds, so I will use £. Is the cleaning for a home or for a business premises?";
  }
  // Also block the $ sign explicitly
  return t.replaceAll("$", "£");
}

function baseUrl() {
  // Must be absolute for Twilio
  if (!PUBLIC_BASE_URL) return "";
  return PUBLIC_BASE_URL.replace(/\/+$/, "");
}

function sayGather(twiml, text) {
  const actionUrl = `${baseUrl()}/call/input`;
  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
  });
  gather.say({ voice: "alice", language: "en-GB" }, enforceGbpOnlySpoken(text));
  twiml.redirect({ method: "POST" }, actionUrl);
}

function getState(callSid) {
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      transcript: [],
      stage: "need_category",
      data: {
        // unified fields for Make
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
        quote: null,
        booking: {
          full_name: "",
          phone: "",
          email: "",
          address: "",
          postcode: "",
          preferred_date: "",
          preferred_time: "",
        },
      },
      temp: {
        extras_queue: [],
        current_extra: null,
      },
    });
  }
  return callState.get(callSid);
}

function remember(callSid, speech) {
  const st = getState(callSid);
  if (speech) st.transcript.push(speech);
  callState.set(callSid, st);
  return st;
}

/* -----------------------------
   Parsing: category, frequency, numbers, postcode
------------------------------*/

function includesAny(t, list) {
  const s = (t || "").toLowerCase();
  return list.some((x) => s.includes(x));
}

function detectCategory(text) {
  const t = (text || "").toLowerCase();
  const domesticHints = ["home", "house", "flat", "apartment", "studio", "tenancy", "landlord", "move out", "move-out"];
  const commercialHints = ["office", "shop", "warehouse", "school", "clinic", "gym", "venue", "site", "business", "restaurant", "workplace"];

  const d = domesticHints.some((x) => t.includes(x));
  const c = commercialHints.some((x) => t.includes(x));
  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return "";
}

function parseYesNo(text) {
  const t = (text || "").toLowerCase();
  if (includesAny(t, ["yes", "yeah", "yep", "sure", "of course", "please", "ok"])) return "yes";
  if (includesAny(t, ["no", "nope", "not", "none", "nothing"])) return "no";
  return "";
}

function parseNumber(text) {
  // Extract first integer found
  const t = (text || "").toLowerCase();
  const m = t.match(/(\d+)/);
  if (m) return Number(m[1]);

  // Very small word mapping
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  for (const [k, v] of Object.entries(words)) {
    if (t.includes(k)) return v;
  }
  return null;
}

function parseUkPostcode(text) {
  const t = (text || "").toUpperCase().replace(/\s+/g, " ").trim();
  // Loose UK postcode pattern (good enough for capture)
  const m = t.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/);
  return m ? m[1].replace(/\s+/, " ") : "";
}

function frequencyToPerWeek(text) {
  const t = (text || "").toLowerCase();

  // Hard mappings you specified
  if (includesAny(t, ["every other week", "once every two weeks", "fortnightly", "bi-weekly", "alternate weeks"])) return 0.5;
  if (includesAny(t, ["once a month", "monthly", "every month", "one visit a month"])) return 0.25;
  if (includesAny(t, ["once a week", "weekly", "every week", "one day a week"])) return 1;
  if (includesAny(t, ["twice a week", "two times a week"])) return 2;
  if (includesAny(t, ["three times a week"])) return 3;
  if (includesAny(t, ["every weekday", "monday to friday", "mon to fri"])) return 5;
  if (includesAny(t, ["daily including weekends", "every day"])) return 7;

  // Numeric fallback
  const n = parseNumber(t);
  if (includesAny(t, ["times a week", "visits a week", "per week"]) && n !== null) return n;

  return null;
}

/* -----------------------------
   Allowed values + normalization
------------------------------*/

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

function normalizeDomesticProperty(text) {
  const t = (text || "").toLowerCase();
  if (includesAny(t, ["studio"])) return "Studio flat";
  if (includesAny(t, ["flat", "apartment"])) return "Flat";
  if (includesAny(t, ["terrace", "terraced"])) return "Terraced house";
  if (includesAny(t, ["semi", "semi detached", "semi-detached"])) return "Semi-detached house";
  if (includesAny(t, ["detached"])) return "Detached house";
  return "";
}

function normalizeCommercialProperty(text) {
  const t = (text || "").toLowerCase();
  if (includesAny(t, ["office"])) return "Office";
  if (includesAny(t, ["school"])) return "School";
  if (includesAny(t, ["clinic", "medical"])) return "Medical clinic";
  if (includesAny(t, ["warehouse"])) return "Warehouse";
  if (includesAny(t, ["commercial kitchen", "kitchen"])) return "Commercial kitchen";
  if (includesAny(t, ["retail", "shop", "store"])) return "Retail shop";
  if (includesAny(t, ["nursery", "daycare", "day care"])) return "Nursery (daycare)";
  if (includesAny(t, ["gym"])) return "Gym";
  if (includesAny(t, ["workshop", "industrial"])) return "Industrial workshop";
  if (includesAny(t, ["venue", "event"])) return "Event venue";
  return "";
}

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

function normalizeService(text, category) {
  const t = (text || "").toLowerCase();

  if (includesAny(t, ["end of tenancy", "move out", "move-out"])) return "End of Tenancy Clean";
  if (includesAny(t, ["deep"])) return "Deep Clean";
  if (includesAny(t, ["post construction", "after builders", "after-builders", "builders", "post-construction"])) return "Post-construction Clean";
  if (includesAny(t, ["disinfection", "sanitisation", "sanitization"])) return "Disinfection / Sanitisation";
  if (includesAny(t, ["regular", "weekly", "fortnightly", "monthly", "recurring", "ongoing", "standard", "maintenance"])) {
    return category === "commercial" ? "Regular Commercial Cleaning" : "Regular Cleaning";
  }

  return "";
}

/* -----------------------------
   Extras: recognition and quantity capture
------------------------------*/

const ALLOWED_EXTRAS = [
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

function detectExtras(text) {
  const t = (text || "").toLowerCase();
  const found = [];

  const map = [
    ["oven", "Oven cleaning"],
    ["carpet", "Carpet cleaning"],
    ["upholstery", "Upholstery cleaning"],
    ["sofa", "Upholstery cleaning"],
    ["inside windows", "Inside windows"],
    ["internal windows", "Inside windows"],
    ["windows inside", "Inside windows"],
    ["limescale", "Limescale removal"],
    ["toilet", "Deep toilet clean"],
    ["fridge", "Fridge / freezer cleaning"],
    ["freezer", "Fridge / freezer cleaning"],
    ["cabinet", "Internal cabinet cleaning"],
    ["cupboard", "Internal cabinet cleaning"],
    ["blinds", "Blinds dusting"],
    ["walls", "Wall spot cleaning"],
    ["pet hair", "Pet hair removal"],
    ["mould", "Mold spot treatment"],
    ["mold", "Mold spot treatment"],
    ["mattress", "Mattress steam clean"],
    ["extractor", "Degreasing extractor fans"],
    ["degrease", "Degreasing extractor fans"],
  ];

  for (const [k, v] of map) {
    if (t.includes(k) && !found.includes(v)) found.push(v);
  }
  return found;
}

/* -----------------------------
   Hours estimation and minimums
------------------------------*/

function applyMinimumHours(category, jobType, preferredHours, visitFreqPerWeek) {
  let h = preferredHours || 0;

  if (category === "domestic") {
    if (jobType === "regular") h = Math.max(h, 3);
    if (jobType === "one_time") h = Math.max(h, 5);
    return h;
  }

  // commercial
  if (jobType === "one_time") {
    h = Math.max(h, 5);
    return h;
  }

  // regular commercial
  if (visitFreqPerWeek >= 3) {
    h = Math.max(h, 1);
    return h;
  }

  h = Math.max(h, 3);
  return h;
}

function estimateHoursFallback(category, bedrooms, bathrooms, toilets, kitchens) {
  // Simple conservative estimator when caller does not know hours.
  // You can replace with your Airtable-based model later.
  const base = category === "commercial" ? 3 : 2;
  const rooms = (bedrooms || 0) + (bathrooms || 0) + (toilets || 0) + (kitchens || 0);
  return Math.max(base, Math.ceil(rooms * 0.75));
}

/* -----------------------------
   Make webhooks
------------------------------*/

async function callMakeGetQuote(payload) {
  if (!MAKE_GETQUOTE_WEBHOOK_URL) throw new Error("Missing MAKE_GETQUOTE_WEBHOOK_URL");
  const { data } = await axios.post(MAKE_GETQUOTE_WEBHOOK_URL, payload, { timeout: 20000 });
  return data;
}

async function callMakeConfirmBooking(payload) {
  if (!MAKE_CONFIRMBOOKING_WEBHOOK_URL) throw new Error("Missing MAKE_CONFIRMBOOKING_WEBHOOK_URL");
  const { data } = await axios.post(MAKE_CONFIRMBOOKING_WEBHOOK_URL, payload, { timeout: 20000 });
  return data;
}

/* -----------------------------
   Routes
------------------------------*/

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid || `local_${Date.now()}`;
  const st = getState(callSid);

  st.stage = "need_category";
  st.transcript = [];
  st.data.quote = null;
  st.temp.extras_queue = [];
  st.temp.current_extra = null;

  callState.set(callSid, st);

  const twiml = new VoiceResponse();
  sayGather(twiml, "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid || `local_${Date.now()}`;
  const speech = String(req.body.SpeechResult || "").trim();
  const st = remember(callSid, speech);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(twiml, "Sorry, I didn’t catch that. Is the cleaning for a home or for a business premises?");
    return res.type("text/xml").send(twiml.toString());
  }

  const lower = speech.toLowerCase();

  // Stage: need category
  if (st.stage === "need_category") {
    let cat = detectCategory(speech);
    if (!cat) {
      if (includesAny(lower, ["domestic", "home"])) cat = "domestic";
      if (includesAny(lower, ["commercial", "business"])) cat = "commercial";
    }

    if (!cat) {
      sayGather(twiml, "No problem. Is the cleaning for a home, like a flat or house, or for a business premises, like an office or shop?");
      return res.type("text/xml").send(twiml.toString());
    }

    st.data.service_category = cat;
    st.stage = "need_service_type";
    callState.set(callSid, st);

    if (cat === "commercial") {
      sayGather(twiml, "Thanks. What type of commercial cleaning do you need. Regular commercial cleaning, deep clean, post-construction, or disinfection?");
    } else {
      sayGather(twiml, "Thanks. What type of domestic cleaning do you need. End of tenancy, deep clean, regular cleaning, post-construction, or disinfection?");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need service type
  if (st.stage === "need_service_type") {
    const cat = st.data.service_category;
    const svc = normalizeService(speech, cat);

    if (!svc) {
      sayGather(twiml, "Which one would it be. End of tenancy, deep clean, regular cleaning, post-construction, or disinfection?");
      return res.type("text/xml").send(twiml.toString());
    }

    if (cat === "commercial") st.data.commercial_service_type = svc;
    if (cat === "domestic") st.data.domestic_service_type = svc;

    // Job type required for regular hourly and all commercial
    if (cat === "commercial") {
      st.stage = "need_job_type";
      callState.set(callSid, st);
      sayGather(twiml, "Is this a one-time clean or an ongoing service?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Domestic: only ask job_type for Regular Cleaning (hourly)
    if (svc === "Regular Cleaning") {
      st.stage = "need_job_type";
      callState.set(callSid, st);
      sayGather(twiml, "Is this a one-off clean or ongoing regular visits?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Domestic flat-fee services go to property type next
    st.stage = "need_property_type";
    callState.set(callSid, st);
    sayGather(twiml, "Thanks. What type of property is it. For example flat, studio flat, terraced house, semi-detached, or detached?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need job type
  if (st.stage === "need_job_type") {
    const yn = parseYesNo(speech);
    const t = lower;

    if (includesAny(t, ["one off", "one-off", "one time", "one-time", "once", "just once"])) st.data.job_type = "one_time";
    if (includesAny(t, ["ongoing", "regular", "weekly", "monthly", "fortnight", "bi-week", "recurring"])) st.data.job_type = "regular";

    if (!st.data.job_type) {
      sayGather(twiml, "Just to confirm, is it a one-time clean, or ongoing regular visits?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Next: property type
    st.stage = "need_property_type";
    callState.set(callSid, st);

    if (st.data.service_category === "commercial") {
      sayGather(twiml, "Thanks. What type of business premises is it. For example office, shop, warehouse, school, clinic, or gym?");
    } else {
      sayGather(twiml, "Thanks. What type of property is it. For example flat, studio flat, terraced house, semi-detached, or detached?");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need property type
  if (st.stage === "need_property_type") {
    const cat = st.data.service_category;

    if (cat === "domestic") {
      const p = normalizeDomesticProperty(speech);
      if (!p) {
        sayGather(twiml, "Sorry, I didn’t catch the property type. Is it a flat, studio flat, terraced, semi-detached, or detached?");
        return res.type("text/xml").send(twiml.toString());
      }
      st.data.domestic_property_type = p;
    } else {
      const p = normalizeCommercialProperty(speech);
      if (!p) {
        sayGather(twiml, "Sorry, I didn’t catch the premises type. Is it an office, shop, warehouse, school, clinic, or gym?");
        return res.type("text/xml").send(twiml.toString());
      }
      st.data.commercial_property_type = p;
    }

    st.stage = "need_postcode";
    callState.set(callSid, st);
    sayGather(twiml, "Thanks. What’s the postcode?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage: need postcode
  if (st.stage === "need_postcode") {
    const pc = parseUkPostcode(speech);
    if (!pc) {
      sayGather(twiml, "Could you share the postcode, please?");
      return res.type("text/xml").send(twiml.toString());
    }
    st.data.postcode = pc;

    // Domestic flow: bedrooms/bathrooms next
    // Commercial flow: toilets/kitchens/size then hours
    const cat = st.data.service_category;
    if (cat === "domestic") {
      st.stage = "need_bedrooms";
      callState.set(callSid, st);
      sayGather(twiml, "How many bedrooms is it?");
      return res.type("text/xml").send(twiml.toString());
    }

    st.stage = "need_rooms_or_size";
    callState.set(callSid, st);
    sayGather(twiml, "Roughly how many rooms is it, or what’s the size if it’s a large open space?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Domestic: bedrooms
  if (st.stage === "need_bedrooms") {
    const n = parseNumber(speech);
    if (n === null) {
      sayGather(twiml, "How many bedrooms would that be?");
      return res.type("text/xml").send(twiml.toString());
    }
    st.data.bedrooms = n;

    st.stage = "need_bathrooms";
    callState.set(callSid, st);
    sayGather(twiml, "And how many bathrooms?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Domestic: bathrooms
  if (st.stage === "need_bathrooms") {
    const n = parseNumber(speech);
    if (n === null) {
      sayGather(twiml, "How many bathrooms would that be?");
      return res.type("text/xml").send(twiml.toString());
    }
    st.data.bathrooms = n;

    // Toilets separate from bathrooms (only asked for flat-fee domestic per your rules)
    if (st.data.domestic_service_type && st.data.domestic_service_type !== "Regular Cleaning") {
      st.stage = "need_toilets";
      callState.set(callSid, st);
      sayGather(twiml, "Any toilets separate from the bathrooms?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Regular domestic: hours then frequency
    if (st.data.domestic_service_type === "Regular Cleaning") {
      st.stage = "need_hours";
      callState.set(callSid, st);
      sayGather(twiml, "How many hours per visit were you expecting?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Flat-fee domestic: extras optional
    st.stage = "need_extras";
    callState.set(callSid, st);
    sayGather(twiml, "Any extras you want to add, like oven, carpets, upholstery, or inside windows? If none, say no extras.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Domestic: toilets (separate)
  if (st.stage === "need_toilets") {
    const yn = parseYesNo(speech);
    const n = parseNumber(speech);

    if (yn === "no") st.data.toilets = 0;
    else if (n !== null) st.data.toilets = n;
    else {
      sayGather(twiml, "How many separate toilets would that be? If none, say zero.");
      return res.type("text/xml").send(twiml.toString());
    }

    st.stage = "need_extras";
    callState.set(callSid, st);
    sayGather(twiml, "Any extras you want to add, like oven, carpets, upholstery, or inside windows? If none, say no extras.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Commercial: rooms/size
  if (st.stage === "need_rooms_or_size") {
    // Store raw notes for now
    st.data.notes = `Size/rooms: ${speech}`;

    st.stage = "need_toilets_commercial";
    callState.set(callSid, st);
    sayGather(twiml, "How many toilets are there?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Commercial: toilets
  if (st.stage === "need_toilets_commercial") {
    const n = parseNumber(speech);
    if (n === null) {
      sayGather(twiml, "How many toilets would that be? If none, say zero.");
      return res.type("text/xml").send(twiml.toString());
    }
    st.data.toilets = n;

    st.stage = "need_kitchens_commercial";
    callState.set(callSid, st);
    sayGather(twiml, "Any kitchens on site?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Commercial: kitchens
  if (st.stage === "need_kitchens_commercial") {
    const yn = parseYesNo(speech);
    const n = parseNumber(speech);

    if (yn === "no") st.data.kitchens = 0;
    else if (n !== null) st.data.kitchens = n;
    else st.data.kitchens = 1; // your rule allows assume 1 if mentioned without number, and note
    if (!yn && n === null) st.data.notes = `${st.data.notes} | Kitchens assumed 1`;

    st.stage = "need_hours";
    callState.set(callSid, st);
    sayGather(twiml, "How many hours per visit were you expecting? If you’re not sure, say not sure and I’ll estimate.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Hours (domestic regular or commercial)
  if (st.stage === "need_hours") {
    const t = lower;
    const n = parseNumber(speech);

    if (includesAny(t, ["not sure", "no idea", "you decide", "estimate"])) {
      const est = estimateHoursFallback(
        st.data.service_category,
        st.data.bedrooms,
        st.data.bathrooms,
        st.data.toilets,
        st.data.kitchens
      );
      st.data.preferred_hours = est;
      st.data.notes = `${st.data.notes} | Hours estimated ${est}`;
    } else if (n !== null) {
      st.data.preferred_hours = n;
    } else {
      sayGather(twiml, "How many hours would you like per visit? If you’re not sure, say not sure.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Next: frequency for regular services
    if (st.data.service_category === "commercial" && st.data.job_type === "regular") {
      st.stage = "need_frequency";
      callState.set(callSid, st);
      sayGather(twiml, "How many visits per week would that be?");
      return res.type("text/xml").send(twiml.toString());
    }

    if (st.data.service_category === "domestic" && st.data.domestic_service_type === "Regular Cleaning") {
      st.stage = "need_frequency";
      callState.set(callSid, st);
      sayGather(twiml, "How many visits per week would that be?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Otherwise go to extras (optional)
    st.stage = "need_extras";
    callState.set(callSid, st);
    sayGather(twiml, "Any extras you want to add, like oven, carpets, upholstery, or inside windows? If none, say no extras.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Frequency
  if (st.stage === "need_frequency") {
    const val = frequencyToPerWeek(speech);

    if (val === null) {
      // Mandatory clarify for ambiguous phrases
      if (includesAny(lower, ["regularly", "ongoing", "as needed", "now and then", "occasionally"])) {
        sayGather(twiml, "Just to confirm, how many visits per week would that be?");
        return res.type("text/xml").send(twiml.toString());
      }
      sayGather(twiml, "Just to confirm, how many visits per week would that be? For example 1 for weekly, 0.5 for fortnightly, or 2 for twice a week.");
      return res.type("text/xml").send(twiml.toString());
    }

    st.data.visit_frequency_per_week = val;

    st.stage = "need_extras";
    callState.set(callSid, st);
    sayGather(twiml, "Any extras you want to add, like oven, carpets, upholstery, or inside windows? If none, say no extras.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Extras (optional)
  if (st.stage === "need_extras") {
    const yn = parseYesNo(speech);
    if (includesAny(lower, ["no extras", "no", "none", "nothing"])) {
      st.data.extras = [];
      st.stage = "confirm_details_before_quote";
      callState.set(callSid, st);
      sayGather(twiml, "Alright. I’ll repeat the key details and then price it. Is that okay?");
      return res.type("text/xml").send(twiml.toString());
    }

    const extrasFound = detectExtras(speech);
    if (!extrasFound.length) {
      // Ask once more, do not block quoting if they insist no extras
      sayGather(twiml, "No problem. Any extras at all, or should I price it with no extras?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Add extras and ask quantities one by one
    st.data.extras = extrasFound.map((name) => ({ name, quantity: 0 }));
    st.temp.extras_queue = [...extrasFound];
    st.temp.current_extra = st.temp.extras_queue.shift();

    st.stage = "need_extra_quantity";
    callState.set(callSid, st);

    // Mandatory impact explanation once per call
    sayGather(twiml, "Got it. Just so you know, adding extras increases the time and the price. How many of that extra do you need?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Extra quantity loop
  if (st.stage === "need_extra_quantity") {
    const current = st.temp.current_extra;
    if (!current) {
      st.stage = "confirm_details_before_quote";
      callState.set(callSid, st);
      sayGather(twiml, "Thanks. I’ll repeat the key details and then price it. Is that okay?");
      return res.type("text/xml").send(twiml.toString());
    }

    const n = parseNumber(speech);
    if (n === null) {
      sayGather(twiml, `How many would that be for ${current}? Please give a number.`);
      return res.type("text/xml").send(twiml.toString());
    }

    // Set quantity for current extra
    st.data.extras = st.data.extras.map((e) => (e.name === current ? { ...e, quantity: n } : e));

    // Next extra
    const next = st.temp.extras_queue.shift() || null;
    st.temp.current_extra = next;

    callState.set(callSid, st);

    if (next) {
      sayGather(twiml, `And how many for ${next}?`);
      return res.type("text/xml").send(twiml.toString());
    }

    st.stage = "confirm_details_before_quote";
    callState.set(callSid, st);
    sayGather(twiml, "Thanks. I’ll repeat the key details and then price it. Is that okay?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Confirm details (light confirmation, not long summary)
  if (st.stage === "confirm_details_before_quote") {
    // If they say no, repeat the last question that matters
    const yn = parseYesNo(speech);
    if (yn === "no") {
      sayGather(twiml, "No problem. What would you like to change?");
      st.stage = "free_edit_note";
      callState.set(callSid, st);
      return res.type("text/xml").send(twiml.toString());
    }

    // Move to quote
    st.stage = "get_quote";
    callState.set(callSid, st);

    // Apply minimums for hourly
    const cat = st.data.service_category;
    const jobType = st.data.job_type || (st.data.domestic_service_type === "Regular Cleaning" ? "regular" : "");
    const freq = st.data.visit_frequency_per_week || 0;

    if (cat === "domestic" && st.data.domestic_service_type === "Regular Cleaning") {
      st.data.preferred_hours = applyMinimumHours("domestic", jobType || "regular", st.data.preferred_hours, freq);
    }

    if (cat === "commercial") {
      st.data.preferred_hours = applyMinimumHours("commercial", jobType || "one_time", st.data.preferred_hours, freq);
    }

    const payload = {
      intent: "get_quote",
      service_category: st.data.service_category,
      domestic_service_type: st.data.domestic_service_type,
      commercial_service_type: st.data.commercial_service_type,
      domestic_property_type: st.data.domestic_property_type,
      commercial_property_type: st.data.commercial_property_type,
      job_type: st.data.job_type,
      bedrooms: st.data.bedrooms,
      bathrooms: st.data.bathrooms,
      toilets: st.data.toilets,
      kitchens: st.data.kitchens,
      postcode: st.data.postcode,
      preferred_hours: st.data.preferred_hours,
      visit_frequency_per_week: st.data.visit_frequency_per_week,
      areas_scope: st.data.areas_scope,
      extras: st.data.extras,
      notes: st.data.notes,
    };

    try {
      const quote = await callMakeGetQuote(payload);
      st.data.quote = quote;
      st.stage = "offer_booking";
      callState.set(callSid, st);

      const explanation = quote?.explanation
        ? String(quote.explanation)
        : `Alright. That comes to £${quote?.total ?? ""}. That’s an estimate based on what you’ve told me and we confirm on arrival if anything changes. Want me to get that booked in?`;

      sayGather(twiml, enforceGbpOnlySpoken(explanation + " Want me to get that booked in?"));
      return res.type("text/xml").send(twiml.toString());
    } catch (e) {
      st.stage = "need_postcode";
      callState.set(callSid, st);
      sayGather(twiml, "I couldn’t pull the quote through right now. Let’s try again. What’s the postcode?");
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // Free edit note (simple MVP)
  if (st.stage === "free_edit_note") {
    st.data.notes = `${st.data.notes} | Caller change request: ${speech}`;
    st.stage = "confirm_details_before_quote";
    callState.set(callSid, st);
    sayGather(twiml, "Thanks. I’ll re-price it with that change. Is that okay?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Offer booking
  if (st.stage === "offer_booking") {
    const yn = parseYesNo(speech);
    if (yn === "no") {
      st.stage = "end";
      callState.set(callSid, st);
      twiml.say({ voice: "alice", language: "en-GB" }, "No worries. If you want to book later, you can call us back anytime. Thanks.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (yn !== "yes") {
      sayGather(twiml, "Do you want me to book that in for you?");
      return res.type("text/xml").send(twiml.toString());
    }

    st.stage = "need_full_name";
    callState.set(callSid, st);
    sayGather(twiml, "Perfect. What’s your full name?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Booking: name, phone, email, address, date, time
  if (st.stage === "need_full_name") {
    st.data.booking.full_name = speech;
    st.stage = "need_phone";
    callState.set(callSid, st);
    sayGather(twiml, "And the best phone number for you?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (st.stage === "need_phone") {
    st.data.booking.phone = speech;
    st.stage = "need_email";
    callState.set(callSid, st);
    sayGather(twiml, "What’s your email address?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (st.stage === "need_email") {
    st.data.booking.email = speech;
    st.stage = "need_address";
    callState.set(callSid, st);
    sayGather(twiml, "What’s the address for the clean? If you prefer, postcode is fine.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (st.stage === "need_address") {
    st.data.booking.address = speech;
    // keep postcode too if we can
    const pc = parseUkPostcode(speech);
    if (pc) st.data.booking.postcode = pc;
    else st.data.booking.postcode = st.data.postcode || "";

    st.stage = "need_date";
    callState.set(callSid, st);
    sayGather(twiml, "What date would you like?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (st.stage === "need_date") {
    st.data.booking.preferred_date = speech;
    st.stage = "need_time";
    callState.set(callSid, st);
    sayGather(twiml, "And what time works for you?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (st.stage === "need_time") {
    st.data.booking.preferred_time = speech;

    const payload = {
      intent: "confirm_booking",
      full_name: st.data.booking.full_name,
      phone: st.data.booking.phone,
      email: st.data.booking.email,
      address: st.data.booking.address,
      postcode: st.data.booking.postcode || st.data.postcode || "",
      preferred_date: st.data.booking.preferred_date,
      preferred_time: st.data.booking.preferred_time,
    };

    try {
      await callMakeConfirmBooking(payload);
      st.stage = "end";
      callState.set(callSid, st);
      twiml.say({ voice: "alice", language: "en-GB" }, "All sorted. You’re booked in. We’ll be in touch if we need anything else. Thanks.");
      return res.type("text/xml").send(twiml.toString());
    } catch (e) {
      st.stage = "need_date";
      callState.set(callSid, st);
      sayGather(twiml, "I couldn’t confirm that booking right now. Let’s try again. What date would you like?");
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // Fallback
  sayGather(twiml, "Sorry, I lost my place for a second. Is the cleaning for a home or for a business premises?");
  st.stage = "need_category";
  callState.set(callSid, st);
  return res.type("text/xml").send(twiml.toString());
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Brain API listening on ${port}`));
