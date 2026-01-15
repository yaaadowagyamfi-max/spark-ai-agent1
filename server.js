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

// In-memory state keyed by CallSid (ok for MVP; move to Redis later)
const callState = new Map();

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("$") ||
    t.includes("usd") ||
    t.includes("dollar") ||
    t.includes("bucks")
  );
}

function ensurePoundsOnly(text) {
  if (containsDollar(text)) {
    return "Sorry, that’s in pounds. Let’s keep everything in £. Could you repeat what you need cleaning and whether it’s for a home or a business?";
  }
  return text;
}

// Strict schemas (hard gates)
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

// Basic prompt-safe helper
function sayGather(twiml, text) {
  const base = process.env.PUBLIC_BASE_URL || "";
  const actionUrl = `${base}/call/input`;

  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
  });

  gather.say({ voice: "alice", language: "en-GB" }, ensurePoundsOnly(text));

  twiml.redirect({ method: "POST" }, actionUrl);
}


app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid;
  callState.set(callSid, {
    transcript: [],
    stage: "start",
    data: {},
  });

  const twiml = new VoiceResponse();
  sayGather(
    twiml,
    "Hi, you’re through to TotalSpark Solutions. What type of cleaning do you need, and is it for a home or a business?"
  );
  res.type("text/xml").send(twiml.toString());
});

app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = callState.get(callSid) || {
    transcript: [],
    stage: "start",
    data: {},
  };

  state.transcript.push(speech);
  callState.set(callSid, state);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(
      twiml,
      "Sorry, I didn’t catch that. What type of cleaning is it, and is it for a home or a business?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  const lower = speech.toLowerCase();

  const mentionedDomestic = [
    "home",
    "house",
    "flat",
    "tenancy",
    "apartment",
    "studio",
  ].some((x) => lower.includes(x));

  const mentionedCommercial = [
    "office",
    "shop",
    "warehouse",
    "school",
    "clinic",
    "gym",
    "business",
    "restaurant",
    "workplace",
  ].some((x) => lower.includes(x));

  if (!mentionedDomestic && !mentionedCommercial && !state.data.service_category) {
    sayGather(twiml, "No problem. Is the cleaning for a home or for a business premises?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (!state.data.service_category) {
    if (mentionedDomestic && !mentionedCommercial) state.data.service_category = "domestic";
    if (mentionedCommercial && !mentionedDomestic) state.data.service_category = "commercial";
  }

  if (!state.data.service_type) {
    sayGather(
      twiml,
      "Got it. What type of cleaning do you need? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  sayGather(twiml, "Thanks. Next, what’s the property type and the postcode?");
  return res.type("text/xml").send(twiml.toString());
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Brain API listening on ${port}`);
});
