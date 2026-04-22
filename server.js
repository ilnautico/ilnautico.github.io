import express from "express";
import puppeteer from "puppeteer";　
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PQueue from "p-queue";

const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : async (...args) => {
      const mod = await import("node-fetch");
      return mod.default(...args);
    };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const htmlTemplate = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY not set — Claude narrative disabled, deterministic fallback active");
}

// ══════════════════════════════════════════════════════════════
// CONCURRENCY CONTROL  — max 2 simultaneous Puppeteer jobs
// ══════════════════════════════════════════════════════════════

const queue = new PQueue({ concurrency: 2 });

// ══════════════════════════════════════════════════════════════
// GLOBAL TIMEOUT HELPER
// ══════════════════════════════════════════════════════════════

const globalTimeout = (ms) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Global PDF generation timeout after ${ms}ms`)), ms)
  );

// ══════════════════════════════════════════════════════════════
// BROWSER SINGLETON  — reuse across requests; auto-restart on crash
// ══════════════════════════════════════════════════════════════

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  _browser.on("disconnected", () => {
    _browser = null;
  });
  return _browser;
}

// ══════════════════════════════════════════════════════════════
// § 1  UTILITIES
// ══════════════════════════════════════════════════════════════

const safe = (v, fallback = "—") => {
  if (v === undefined || v === null || v === "") return fallback;
  return String(v);
};

const clamp = (v) => Math.max(0, Math.min(100, v));

function safeParseJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in response");
    return JSON.parse(match[0]);
  } catch {
    throw new Error("JSON parse failed");
  }
}

function validateNarrative(obj) {
  const keys = [
    "executive_summary",
    "risk_primary",
    "risk_secondary",
    "mechanism",
    "processing_window_note",
    "application_implication",
    "next_step",
  ];
  for (const k of keys) {
    if (!obj || typeof obj[k] !== "string") {
      throw new Error(`Invalid narrative structure — missing or non-string key: ${k}`);
    }
  }
  return obj;
}

function validateMechanism(obj) {
  if (!obj || typeof obj.mechanism !== "string") {
    throw new Error("Invalid mechanism structure — missing or non-string key: mechanism");
  }
  if (
    !Array.isArray(obj.expected_deviations) ||
    obj.expected_deviations.length !== 3 ||
    obj.expected_deviations.some((d) => typeof d !== "string")
  ) {
    throw new Error("Invalid mechanism structure — expected_deviations must be array of 3 strings");
  }
  return obj;
}

// ══════════════════════════════════════════════════════════════
// § 2  INPUT NORMALIZATION  (label-based; expanded)
// ══════════════════════════════════════════════════════════════

function normalizeInput(raw) {
  if (!raw) return {};

  if (!(raw.data && Array.isArray(raw.data.fields))) {
    return raw;
  }

  const parsed = {
    project_name: "",
    project_stage: "",
    product_type: "",
    application: "",
    mechanical_requirement: "",
    material: "",
    issues: "",
    bio_material: "",
    transition_goal: "",
    processing: "",
    equipment: "",
    screw_diameter: "",
    ld_ratio: "",
    die_mold: "",
    scale: "",
    concern: "",
    notes: "",
    requirement_focus: null,
    current_material_focus: null,
    transition_focus: null,
    risk_focus: null,
  };

  const norm = (s) => String(s || "").trim();
  const low = (s) => norm(s).toLowerCase();

  for (const f of raw.data.fields) {
    const label = low(f.label);
    const value = Array.isArray(f.value) ? f.value.join(", ") : norm(f.value);
    const type = low(f.type);

    // ---- exact / high-confidence field mapping ----
    if (label === "project name") parsed.project_name = value;
    else if (label === "project stage") parsed.project_stage = value;
    else if (label === "product type") parsed.product_type = value;
    else if (label === "application") parsed.application = value;
    else if (label === "mechanical requirement") parsed.mechanical_requirement = value;
    else if (label === "current material") parsed.material = value;
    else if (label === "known issues") parsed.issues = value;
    else if (label === "target material") parsed.bio_material = value;
    else if (label === "processing method") parsed.processing = value;
    else if (label === "equipment type") parsed.equipment = value;
    else if (label === "screw diameter") parsed.screw_diameter = value;
    else if (label === "l/d") parsed.ld_ratio = value;
    else if (label === "die / mold" || label === "die/mold") parsed.die_mold = value;
    else if (label === "production scale") parsed.scale = value;
    else if (label === "primary concern") parsed.concern = value;
    else if (label === "additional notes") parsed.notes = value;

    // ---- option labels from Tally ----
    else if (label.includes("visual requirement")) parsed.requirement_focus = "VISUAL";
    else if (label.includes("environment condition")) parsed.requirement_focus = "ENVIRONMENT";
    else if (label.includes("product stability")) parsed.current_material_focus = "PRODUCT_STABILITY";
    else if (label.includes("transition purpose")) {
      parsed.transition_focus = "PURPOSE";
      if (value) parsed.transition_goal = value;
    }
    else if (label.includes("certification requirement")) parsed.transition_focus = "CERTIFICATION";
    else if (label.includes("critical area")) parsed.risk_focus = "CRITICAL_AREA";

    // ---- fallback multiple choice parsing ----
    if (type.includes("multiple") || type.includes("choice")) {
      const lv = low(value);

      if (lv.includes("visual")) parsed.requirement_focus = "VISUAL";
      if (lv.includes("environment")) parsed.requirement_focus = "ENVIRONMENT";
      if (lv.includes("product stability")) parsed.current_material_focus = "PRODUCT_STABILITY";
      if (lv.includes("transition purpose")) parsed.transition_focus = "PURPOSE";
      if (lv.includes("certification")) parsed.transition_focus = "CERTIFICATION";
      if (lv.includes("critical area")) parsed.risk_focus = "CRITICAL_AREA";
    }
  }

  // ---- hard cleanup: prevent bio_material pollution ----
  const badBio =
    !parsed.bio_material ||
    /replace fossil plastic|biodegradable alternative|transition purpose|certification/i.test(parsed.bio_material);

  if (badBio) {
    parsed.bio_material = "";
  }

  // fallback: if target material missing, try raw direct body keys
  if (!parsed.bio_material && raw.target_material) {
    parsed.bio_material = norm(raw.target_material);
  }
  if (!parsed.material && raw.current_material) {
    parsed.material = norm(raw.current_material);
  }

  return parsed;
}

// ══════════════════════════════════════════════════════════════
// § 2b  CONTEXT INTERPRETATION HELPERS
// ══════════════════════════════════════════════════════════════

function classifyMaterial(material) {
  const m = safe(material, "").toUpperCase();

  if (m.includes("PET")) return "PET";
  if (m.includes("LLDPE")) return "POLYOLEFIN_PE";
  if (m.includes("LDPE")) return "POLYOLEFIN_PE";
  if (m.includes("HDPE")) return "POLYOLEFIN_PE";
  if (m.includes("PE")) return "POLYOLEFIN_PE";
  if (m.includes("CPP")) return "POLYOLEFIN_PP";
  if (m.includes("PP")) return "POLYOLEFIN_PP";
  if (m.includes("PLA")) return "PLA_BASED";
  if (m.includes("PHA") || m.includes("PHB")) return "PHA_BASED";

  return "OTHER";
}

function classifyApplication(application, processing) {
  const a = safe(application, "").toUpperCase();
  const p = safe(processing, "").toUpperCase();
  const text = `${a} ${p}`;

  if (
    text.includes("HOT-FILL") ||
    text.includes("HOT FILL") ||
    text.includes("HEAT EXPOSURE")
  ) return "HOT_FILL_RIGID";

  if (
    text.includes("MICROWAVE") ||
    text.includes("MICROWAVEABLE") ||
    text.includes("MICROWAVABLE")
  ) return "MICROWAVEABLE_RIGID";

  if (
    text.includes("HIGH-TEMPERATURE") ||
    text.includes("HIGH TEMPERATURE") ||
    text.includes("HEAT LOAD") ||
    text.includes("HEAT RESISTANCE")
  ) return "HEAT_EXPOSED_RIGID";

  if (
    text.includes("LOW-TEMPERATURE") ||
    text.includes("LOW TEMPERATURE") ||
    text.includes("FROZEN")
  ) return "LOW_TEMP_FILM";

  if (
    text.includes("HIGH-SPEED FILM") ||
    text.includes("HIGH SPEED FILM") ||
    (text.includes("FILM") && text.includes("HIGH-SPEED"))
  ) return "HIGH_SPEED_FILM";

  if (text.includes("FILM")) return "GENERAL_FILM";
  if (text.includes("INJECTION")) return "GENERAL_INJECTION";

  return "GENERAL";
}

function extractNoteFlags(notes) {
  const n = safe(notes, "").toUpperCase();
  const flags = new Set();

  if (n.includes("NO EQUIPMENT MODIFICATION") || n.includes("NO EQUIPMENT CHANGE")) flags.add("NO_EQUIPMENT_CHANGE");
  if (n.includes("REPEATED HEAT") || n.includes("REPEATED HEATING")) flags.add("REPEATED_HEAT");
  if (n.includes("LONG RUN") || n.includes("EXTENDED RUN")) flags.add("LONG_RUN");
  if (n.includes("LOW TEMP") || n.includes("LOW-TEMPERATURE") || n.includes("FROZEN")) flags.add("LOW_TEMP_USE");
  if (n.includes("SEAL")) flags.add("SEAL_IMPORTANT");
  if (n.includes("DIMENSION")) flags.add("DIMENSION_CRITICAL");
  if (n.includes("HIGH SPEED") || n.includes("HIGH-SPEED")) flags.add("HIGH_SPEED");
  if (n.includes("SURFACE")) flags.add("SURFACE_IMPORTANT");

  return [...flags];
}

function interpretInputContext(input) {
  const processText = `${safe(input.processing, "")} ${safe(input.mechanical_requirement, "")} ${safe(input.equipment, "")}`.toUpperCase();
  const applicationFamily = classifyApplication(input.application, input.processing);
  const materialClass = classifyMaterial(input.material);
  const targetMaterialClass = classifyMaterial(input.bio_material);
  const noteFlags = extractNoteFlags(input.notes);

  let process_family = "GENERAL";
  if (processText.includes("BLOWN FILM")) process_family = "BLOWN_FILM";
  else if (processText.includes("FILM")) process_family = "FILM_EXTRUSION";
  else if (processText.includes("INJECTION")) process_family = "INJECTION";

  let use_condition_family = "GENERAL";
  if (
    applicationFamily === "HOT_FILL_RIGID" ||
    applicationFamily === "MICROWAVEABLE_RIGID" ||
    applicationFamily === "HEAT_EXPOSED_RIGID"
  ) {
    use_condition_family = "THERMAL_STRESS";
  } else if (
    applicationFamily === "HIGH_SPEED_FILM" ||
    applicationFamily === "GENERAL_FILM"
  ) {
    use_condition_family = "FLOW_STRESS";
  } else if (applicationFamily === "LOW_TEMP_FILM") {
    use_condition_family = "LOW_TEMP_HANDLING";
  }

  const stageText = safe(input.project_stage, "").toUpperCase();
  let stage_level = "EARLY";
  if (stageText.includes("PILOT")) stage_level = "PILOT";
  if (stageText.includes("PRE-COMMERCIAL") || stageText.includes("PRE COMMERCIAL")) stage_level = "PRE_COMMERCIAL";
  if (stageText.includes("MASS")) stage_level = "MASS_TARGET";

  const scaleText = safe(input.scale, "").toUpperCase();
  let production_risk_level = "LOW";
  if (scaleText.includes("PILOT") || scaleText.includes("MEDIUM")) production_risk_level = "MEDIUM";
  if (scaleText.includes("MASS") || scaleText.includes("COMMERCIAL")) production_risk_level = "HIGH";

  return {
    process_family,
    application_family: applicationFamily,
    use_condition_family,
    stage_level,
    production_risk_level,
    note_flags: noteFlags,
    option_flags: {
      requirement_focus: input.requirement_focus || null,
      transition_focus: input.transition_focus || null,
      current_material_focus: input.current_material_focus || null,
      risk_focus: input.risk_focus || null,
    },
    material_class: materialClass,
    target_material_class: targetMaterialClass,
  };
}

function applyOptionModifiers(scores, context) {
  const next = { ...scores };

  if (context.option_flags.requirement_focus === "ENVIRONMENT") {
    next.flow = clamp(next.flow - 2);
  }

  if (context.option_flags.requirement_focus === "VISUAL") {
    next.flow = clamp(next.flow - 3);
  }

  if (context.option_flags.current_material_focus === "PRODUCT_STABILITY") {
    next.mechanical = clamp(next.mechanical - 2);
  }

  if (context.option_flags.transition_focus === "CERTIFICATION") {
    next.total = clamp(next.total - 1);
  }

  return next;
}
function getNarrativeSpecialization(context) {
  const mc = context.material_class;
  const tc = context.target_material_class;
  const pf = context.process_family;
  const af = context.application_family;
  const uf = context.use_condition_family;

  if (mc === "POLYOLEFIN_PE" && tc === "PHA_BASED" && pf === "BLOWN_FILM" && af === "LOW_TEMP_FILM") {
    return "LDPE_PHA_LOW_TEMP_FILM";
  }

  if (mc === "POLYOLEFIN_PE" && (tc === "PHA_BASED" || tc === "OTHER_BIO") && pf === "BLOWN_FILM" && af === "HIGH_SPEED_FILM") {
    return "LDPE_BIO_HIGH_SPEED_FILM";
  }

  if (mc === "POLYOLEFIN_PP" && tc === "PLA_BASED" && uf === "THERMAL_STRESS") {
    return "PP_PLA_THERMAL_STRESS";
  }

  if (mc === "PET" && tc === "PLA_BASED" && uf === "THERMAL_STRESS") {
    return "PET_PLA_THERMAL_STRESS";
  }

  return "GENERIC";
}

function shouldForceDeterministicMechanism(context) {
  return getNarrativeSpecialization(context) !== "GENERIC";
}

function shouldForceDeterministicDeviations(context) {
  return getNarrativeSpecialization(context) !== "GENERIC";
}
// ══════════════════════════════════════════════════════════════
// § 3  SCORING ENGINE
// ══════════════════════════════════════════════════════════════

function calculateScores(input, context = null) {
  let thermal = 85;
  let flow = 85;
  let mechanical = 85;

  const mat = (input.material || "").toUpperCase();
  const bio = (input.bio_material || "").toUpperCase();
  const app = (input.application || "").toUpperCase();
  const processing = (input.processing || "").toUpperCase();
  const appTokens = app.split(/\W+/);

  if (!context) {
    context = interpretInputContext(input);
  }

  if ((mat.includes("CPP") || mat.includes("PP")) && !mat.includes("PET")) thermal -= 10;
  if (mat.includes("PE") && !mat.includes("PET")) thermal -= 5;
  if (mat.includes("PET")) thermal -= 25;

  if (bio.includes("PLA")) thermal -= 10;
  if (bio.includes("PHA") || bio.includes("PHB")) flow -= 10;

  const isFilm = app.includes("FILM") || appTokens.includes("FILM") || processing.includes("FILM");
  const isInjection =
    app.includes("INJECT") ||
    app.includes("MOLD") ||
    app.includes("MOULD") ||
    appTokens.includes("IM") ||
    processing.includes("INJECTION");

  if (isFilm) flow -= 15;
  if (isInjection) mechanical -= 10;

  if (context.application_family === "MICROWAVEABLE_RIGID") thermal -= 10;
  if (context.application_family === "HOT_FILL_RIGID") thermal -= 15;
  if (context.application_family === "HEAT_EXPOSED_RIGID") thermal -= 10;
  if (context.application_family === "HIGH_SPEED_FILM") flow -= 10;
  if (context.application_family === "LOW_TEMP_FILM") {
    flow -= 5;
    mechanical -= 3;
  }

  if (context.note_flags.includes("NO_EQUIPMENT_CHANGE")) thermal -= 5;
  if (context.note_flags.includes("REPEATED_HEAT")) thermal -= 5;
  if (context.note_flags.includes("LONG_RUN")) flow -= 5;
  if (context.note_flags.includes("LOW_TEMP_USE")) mechanical -= 3;
  if (context.note_flags.includes("SEAL_IMPORTANT")) flow -= 3;
  if (context.note_flags.includes("DIMENSION_CRITICAL")) mechanical -= 5;
  if (context.note_flags.includes("HIGH_SPEED")) flow -= 5;
  if (context.note_flags.includes("SURFACE_IMPORTANT")) flow -= 2;

  if (
    context.material_class === "POLYOLEFIN_PP" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    thermal -= 10;
  }

  if (
    context.material_class === "PET" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    thermal -= 5;
  }

  if (
    context.material_class === "POLYOLEFIN_PE" &&
    context.target_material_class === "PHA_BASED" &&
    context.process_family === "BLOWN_FILM"
  ) {
    flow -= 5;
  }

  thermal = clamp(thermal);
  flow = clamp(flow);
  mechanical = clamp(mechanical);

  let scores = { thermal, flow, mechanical, total: 0, tokens: appTokens };
  scores = applyOptionModifiers(scores, context);

  const bottleneck = Math.min(scores.thermal, scores.flow, scores.mechanical);
  const avg = (scores.thermal + scores.flow + scores.mechanical) / 3;
  const total = Math.round(bottleneck * 0.7 + avg * 0.3);

  return { ...scores, total };
}

// ══════════════════════════════════════════════════════════════
// § 4  CONSTRAINT LOGIC  — tie-breaking: Flow > Thermal > Mechanical
// ══════════════════════════════════════════════════════════════

function getConstraint(scores) {
  const min = Math.min(scores.thermal, scores.flow, scores.mechanical);

  if (scores.flow === min) {
    return {
      type: "FLOW",
      score: scores.flow,
      factor: "flow consistency during extended production runs",
      impact: "production consistency, yield rate, and operational efficiency",
      control: "pressure stability, melt uniformity, and extrusion flow balance",
    };
  }

  if (scores.thermal === min) {
    return {
      type: "THERMAL",
      score: scores.thermal,
      factor: "thermal stability under processing conditions",
      impact: "material degradation risk and process reliability",
      control: "temperature control precision and thermal distribution uniformity",
    };
  }

  return {
    type: "MECHANICAL",
    score: scores.mechanical,
    factor: "mechanical integrity under load conditions",
    impact: "product strength and structural performance",
    control: "material strength consistency and structural reliability",
  };
}

function determineDecisionBand(total, scores, context) {
  if (total >= 75) {
    return {
      level: "HIGH",
      sublevel: null,
      blocker_type: "NONE",
      commercial_readiness: "READY_FOR_PILOT_SCALEUP",
      validation_priority: "PERFORMANCE_CONFIRMATION",
    };
  }

  if (total >= 70) {
    return {
      level: "MODERATE",
      sublevel: "A",
      blocker_type: "MANAGEABLE_CONSTRAINT",
      commercial_readiness: "CONTROLLED_PILOT_READY",
      validation_priority: "STABILITY_CONFIRMATION",
    };
  }

  if (total >= 62) {
    return {
      level: "MODERATE",
      sublevel: "B",
      blocker_type: "CONDITIONALLY_LIMITING",
      commercial_readiness: "PILOT_WITH_TIGHT_CONTROLS",
      validation_priority: "CONSTRAINT_REDUCTION",
    };
  }

  if (total >= 55) {
    return {
      level: "MODERATE",
      sublevel: "C",
      blocker_type: "COMMERCIAL_LIMITING",
      commercial_readiness: "RESTRICTED_PILOT_ONLY",
      validation_priority: "LIMITATION_MAPPING",
    };
  }

  const lowType =
    context.use_condition_family === "THERMAL_STRESS"
      ? "LOW_STRUCTURAL"
      : "LOW_CONDITIONAL";

  return {
    level: "LOW",
    sublevel: null,
    blocker_type: lowType,
    commercial_readiness: "NOT_READY",
    validation_priority: "ALTERNATIVE_PATH_REVIEW",
  };
}

function buildConstraintArchitecture(scores, context) {
  const primary = getConstraint(scores);

  let secondaryTitle = "Process Interaction Risk";
  let secondaryType = "";
  let enablingType = "";

  if (primary.type === "FLOW") {
    secondaryType = "THERMAL";
    enablingType = "MECHANICAL";
  } else if (primary.type === "THERMAL") {
    secondaryType = "FLOW";
    enablingType = "MECHANICAL";
  } else {
    secondaryType = "THERMAL";
    enablingType = "FLOW";
  }

  const scoreMap = {
    THERMAL: scores.thermal,
    FLOW: scores.flow,
    MECHANICAL: scores.mechanical,
  };

  return {
    primary_constraint: primary,
    secondary_interaction: {
      title: secondaryTitle,
      type: secondaryType,
      score: scoreMap[secondaryType],
    },
    enabling_factor: {
      type: enablingType,
      score: scoreMap[enablingType],
    },
    blocker_type:
      primary.type === "THERMAL" && context.use_condition_family === "THERMAL_STRESS"
        ? "THERMAL_READINESS_BLOCKER"
        : primary.type === "FLOW"
          ? "PROCESS_STABILITY_BLOCKER"
          : "STRUCTURAL_CONSISTENCY_BLOCKER",
  };
}

// ══════════════════════════════════════════════════════════════
// § 5  DECISION ENGINE
// ══════════════════════════════════════════════════════════════

function determineDecision(total) {
  if (total >= 75) return { decision: "GO", level: "HIGH" };
  if (total >= 55) return { decision: "CONDITIONAL GO", level: "MODERATE" };
  return { decision: "HOLD", level: "LOW" };
}

// ══════════════════════════════════════════════════════════════
// § 6  ECONOMIC IMPACT
// ══════════════════════════════════════════════════════════════

function calculateEconomic(total) {
  if (total >= 75) return "+5–15%";
  if (total >= 55) return "+15–30%";
  return "+30%+";
}

// ══════════════════════════════════════════════════════════════
// § 7  EXECUTIVE SUMMARY
// ══════════════════════════════════════════════════════════════

function generateExecutive(scores, decision, economic, constraint) {
  const { thermal, flow, mechanical, total } = scores;
  const scoreBlock = `Thermal (${thermal}) / Flow (${flow}) / Mechanical (${mechanical}) / Composite: ${total}`;

  if (decision.level === "LOW") {
    return (
      `This assessment determines LOW technical feasibility for the evaluated material transition ` +
      `within the current processing configuration.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is critically constrained by instability in ${constraint.factor} ` +
      `(score: ${constraint.score}/100). ` +
      `This constraint directly prevents stable ${constraint.impact}, ` +
      `rendering stable commercial production unattainable under existing process conditions. ` +
      `The identified instability levels indicate a high probability of operational failure, ` +
      `unacceptable scrap generation, and non-compliant output variability.\n\n` +
      `Material cost variance is projected at ${economic}, reflecting the scope of re-engineering ` +
      `required under the current configuration.\n\n` +
      `Deployment Decision: HOLD — Commercial-scale implementation is not recommended at this stage. ` +
      `A fundamental reassessment of material compatibility or processing architecture is required ` +
      `prior to any further validation activity.`
    );
  }

  if (decision.level === "MODERATE" && constraint.type === "FLOW") {
    return (
      `This assessment determines MODERATE technical feasibility for the evaluated material transition ` +
      `within the current processing configuration.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable, subject to constraint by flow-related instability. ` +
      `Variability in ${constraint.factor} (score: ${constraint.score}/100) directly impacts ` +
      `${constraint.impact}, with elevated sensitivity under extended production cycles ` +
      `and high line-speed conditions. ` +
      `Melt behaviour management constitutes the primary engineering challenge for achieving ` +
      `stable commercial production.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `A controlled pilot validation phase is recommended, with primary focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO — Controlled pilot validation required prior to commercial commitment`
    );
  }

  if (decision.level === "MODERATE" && constraint.type === "THERMAL") {
    return (
      `This assessment determines MODERATE technical feasibility for the evaluated material transition ` +
      `within the current processing configuration.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable, subject to thermal constraint. ` +
      `Instability in ${constraint.factor} (score: ${constraint.score}/100) directly impacts ` +
      `${constraint.impact}, with elevated sensitivity under elevated or fluctuating processing temperatures. ` +
      `The target biodegradable material's narrow thermal operating window requires precision ` +
      `temperature control to prevent degradation onset during sustained production runs.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with primary emphasis on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO — Controlled pilot validation required prior to commercial commitment`
    );
  }

  if (decision.level === "MODERATE") {
    return (
      `This assessment determines MODERATE technical feasibility for the evaluated material transition ` +
      `within the current processing configuration.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is technically feasible, subject to structural performance constraints under load conditions. ` +
      `Limitations in ${constraint.factor} (score: ${constraint.score}/100) directly impact ` +
      `${constraint.impact}, with elevated sensitivity in demanding application environments. ` +
      `Product performance consistency must be verified through controlled mechanical testing ` +
      `prior to commercial commitment.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with primary focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO — Controlled pilot validation required prior to commercial commitment`
    );
  }

  return (
    `This assessment determines HIGH technical feasibility for the evaluated material transition ` +
    `within the current processing configuration.\n\n` +
    `${scoreBlock}\n\n` +
    `The system demonstrates strong compatibility across all key processing parameters. ` +
    `Residual sensitivity to ${constraint.factor} (score: ${constraint.score}/100) is noted, ` +
    `but does not materially compromise ${constraint.impact} under standard operating conditions. ` +
    `Stable production output is attainable within existing process controls ` +
    `without fundamental configuration redesign.\n\n` +
    `Material cost variance is projected at ${economic}.\n\n` +
    `Deployment Decision: GO — Proceed to controlled pilot validation and systematic scale-up.`
  );
}
function generateMechanism(input, constraint, context) {
  const spec = getNarrativeSpecialization(context);
  const source = safe(input.material, "the source material");
  const target = safe(input.bio_material, "the target biodegradable material");
  const app = safe(input.application, "the specified application");

  if (spec === "LDPE_PHA_LOW_TEMP_FILM") {
    return (
      `${source} provides relatively broad film-forming tolerance and stable extrusion behaviour under continuous pouch production, whereas ${target} introduces greater sensitivity in melt stability, crystallisation-driven flow response, and low-temperature flex behaviour. ` +
      `Under ${app} conditions, this mismatch is most likely to emerge as instability in film formation, seal-area consistency, and extended-run output control rather than as a purely thermal limitation. ` +
      `As a result, production consistency, yield rate, and operational efficiency may deteriorate when flow stability is not tightly maintained.`
    );
  }

  if (spec === "LDPE_BIO_HIGH_SPEED_FILM") {
    return (
      `${source} exhibits broader film-processing tolerance and more stable rheological behaviour under continuous blown-film conversion, whereas ${target} operates within a narrower window shaped by melt stability sensitivity, structure-development effects, and extended-run control limitations. ` +
      `Under ${app} conditions, this mismatch is most likely to appear as instability in gauge control, seal-area consistency, and output uniformity as line speed and run length increase. ` +
      `This directly constrains production consistency, yield stability, and overall operational efficiency.`
    );
  }

  if (spec === "PP_PLA_THERMAL_STRESS") {
    return (
      `${source} maintains broader tolerance to elevated processing and use-phase heat exposure, whereas ${target} operates within a narrower thermal stability range governed by earlier softening and degradation onset sensitivity. ` +
      `Under ${app} conditions, this material gap becomes critical because repeated or sustained thermal loading directly affects shape retention, stiffness retention, and structural reliability after molding. ` +
      `This mismatch therefore manifests primarily as thermal instability under processing and downstream application conditions.`
    );
  }

  if (spec === "PET_PLA_THERMAL_STRESS") {
    return (
      `${source} retains a wider thermal processing margin and stronger dimensional retention under heat-exposed rigid packaging conditions, whereas ${target} enters a narrower stability range with earlier softening and heat-induced property decline. ` +
      `Under ${app} conditions, this difference is likely to emerge as reduced dimensional reliability, local deformation risk, and lower retention of structural precision once thermal demand approaches the upper boundary of the qualified range. ` +
      `The transition is therefore primarily constrained by thermal stability rather than by baseline molding capability.`
    );
  }

  return (
    `${source} exhibits broader thermal and rheological tolerance under standard processing conditions, whereas ${target} introduces a narrower operational window governed by crystallisation kinetics and degradation onset sensitivity. ` +
    `Under ${app} conditions, this property mismatch generates instability in ${constraint.factor}, causing ${constraint.impact} to fall outside commercially acceptable limits.`
  );
}
// ══════════════════════════════════════════════════════════════
// § 8  RISK STRUCTURE
// ══════════════════════════════════════════════════════════════

function generateRisk(scores, constraintArch, input, context) {
  const primary = constraintArch.primary_constraint;
  const mat = safe(input.material, "the source material");
  const bio = safe(input.bio_material, "the target biodegradable material");
  const app = safe(input.application, "the specified processing application");

  let primaryText = "";
  if (primary.score < 55) {
    primaryText =
      `Critical instability in ${primary.factor} (${primary.score}/100) is expected to prevent commercially stable production under the declared operating conditions. ` +
      `This directly compromises ${primary.impact} and creates a high probability of failure, scrap escalation, and non-compliant output.`;
  } else {
    primaryText =
      `Variability in ${primary.factor} (${primary.score}/100) constitutes the primary operational risk for this material transition. ` +
      `This directly impacts ${primary.impact} and must be managed through rigorous control of ${primary.control}. ` +
      `Risk exposure increases as production duration, throughput, or application stress move toward the boundary of the qualified operating range.`;
  }

  let secondaryText = "";
  let mechanismText = "";

  // ─────────────────────────────────────────────
  // A) PE → PHA / blown-film family
  // ─────────────────────────────────────────────
  if (
    context.material_class === "POLYOLEFIN_PE" &&
    context.target_material_class === "PHA_BASED" &&
    context.process_family === "BLOWN_FILM"
  ) {
    secondaryText =
      `Thermal sensitivity (${scores.thermal}/100) interacts with mechanical consistency (${scores.mechanical}/100), creating downstream process-level effects once flow stability begins to drift. ` +
      `In blown-film production, this interaction is most likely to appear as widening gauge variation, localized seal-area inconsistency, and progressive loss of output uniformity during extended runs.`;

    mechanismText =
      `${mat} provides relatively broad film-forming tolerance and stable extrusion behaviour under continuous blown-film production, whereas ${bio} introduces greater sensitivity in melt stability, crystallisation-driven flow response, and long-run uniformity control. ` +
      `Under ${app} conditions, this mismatch is most likely to appear as instability in bubble behaviour, cross-web thickness control, seal-area consistency, and extended-run output stability rather than as a purely thermal limitation. ` +
      `As a result, production consistency, yield rate, and operational efficiency may deteriorate when flow stability is not tightly maintained.`;

    return {
      primary: primaryText,
      secondary: secondaryText,
      mechanism: mechanismText,
    };
  }

  // ─────────────────────────────────────────────
  // B) PP → PLA / thermal-stress family
  // ─────────────────────────────────────────────
  if (
    context.material_class === "POLYOLEFIN_PP" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    secondaryText =
      `Flow sensitivity (${scores.flow}/100) interacts with mechanical consistency (${scores.mechanical}/100) at the boundary of the qualified thermal envelope, creating downstream process-level effects once thermal load begins to influence part retention. ` +
      `Even where molding output remains visually stable, local softening, seal-area deformation, or shape relaxation may progressively amplify functional variability beyond the primary thermal constraint alone.`;

    mechanismText =
      `${mat} maintains broader tolerance to elevated processing and use-phase thermal exposure, whereas ${bio} operates within a narrower thermal stability range governed by earlier softening and heat-induced property decline. ` +
      `Under ${app} conditions, this material gap becomes critical because repeated heating affects not only dimensional retention but also localized rigidity, seal stability, and structural consistency after conversion. ` +
      `The transition is therefore constrained primarily by thermal instability rather than by baseline melt flow uniformity or initial part formation capability.`;

    return {
      primary: primaryText,
      secondary: secondaryText,
      mechanism: mechanismText,
    };
  }

  // ─────────────────────────────────────────────
  // C) PET → PLA / thermal-stress family
  // ─────────────────────────────────────────────
  if (
    context.material_class === "PET" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    secondaryText =
      `Flow sensitivity (${scores.flow}/100) interacts with mechanical consistency (${scores.mechanical}/100) at the boundary of the qualified thermal envelope, creating downstream process-level effects once heat exposure begins to influence dimensional retention. ` +
      `Even where the molded article is initially formed within visual and dimensional acceptance, localized relaxation, edge distortion, or geometry drift may progressively amplify functional variability beyond the primary thermal constraint alone.`;

    mechanismText =
      `${mat} provides a wider thermal processing margin and stronger dimensional retention under precision rigid-packaging conditions, whereas ${bio} enters a narrower stability range with earlier softening and heat-induced property decline. ` +
      `Under ${app} conditions, this difference becomes critical because tolerance-sensitive geometry must remain stable not only immediately after molding, but also during downstream handling and thermal exposure. ` +
      `The transition is therefore constrained primarily by thermal-driven dimensional instability rather than by baseline melt flow uniformity or initial cavity filling performance.`;

    return {
      primary: primaryText,
      secondary: secondaryText,
      mechanism: mechanismText,
    };
  }

  // ─────────────────────────────────────────────
  // Generic fallback
  // ─────────────────────────────────────────────
  if (primary.type === "FLOW") {
    secondaryText =
      `Thermal sensitivity (${scores.thermal}/100) interacts with mechanical consistency (${scores.mechanical}/100), creating downstream process-level effects once flow stability begins to drift. ` +
      `Where melt behaviour moves toward the boundary of the qualified operating range, structural performance and output uniformity may deteriorate beyond the influence of the primary constraint alone.`;
  } else if (primary.type === "THERMAL") {
    secondaryText =
      `Flow sensitivity (${scores.flow}/100) interacts with mechanical consistency (${scores.mechanical}/100), creating downstream process-level effects across the production system. ` +
      `Where thermal conditions move toward the boundary of the qualified operating range, mechanical performance may be conditionally affected, resulting in compounded output variation beyond the influence of the primary constraint alone.`;
  } else {
    secondaryText =
      `Thermal sensitivity (${scores.thermal}/100) interacts with flow stability (${scores.flow}/100), increasing the effect of the structural limitation at the edge of the qualified operating range. ` +
      `As process conditions drift, both dimensional reliability and production consistency may deteriorate together.`;
  }

  mechanismText =
    `${mat} exhibits broader thermal and rheological tolerance under standard processing conditions, whereas ${bio} introduces a narrower operational window governed by crystallisation kinetics and degradation onset sensitivity. ` +
    `Under ${app} conditions, this property mismatch generates instability in ${primary.factor}, causing ${primary.impact} to fall outside commercially acceptable limits.`;

  return {
    primary: primaryText,
    secondary: secondaryText,
    mechanism: mechanismText,
  };
}
// ══════════════════════════════════════════════════════════════
// § 9  PROCESSING SECTION
// ══════════════════════════════════════════════════════════════

function generateProcessing(scores, constraint) {
  let processingWindow;
  if (constraint.score < 55) {
    processingWindow =
      `The processing window is critically narrow and operationally unstable. ` +
      `The ${constraint.type} constraint (${constraint.score}/100) restricts the usable parameter ` +
      `range to conditions incompatible with continuous commercial production. ` +
      `Significant process control intervention and probable equipment modification are required ` +
      `before validation activity can be initiated.`;
  } else if (constraint.score < 75) {
    processingWindow =
      `The processing window is operable but restricted by ${constraint.factor} ` +
      `(${constraint.score}/100). Sustained production requires tightly validated operating parameters; ` +
      `deviations outside the qualified range will generate measurable output instability ` +
      `and elevated scrap rates.`;
  } else {
    processingWindow =
      `The processing window is broad and fully compatible with standard operating parameters. ` +
      `${constraint.factor.charAt(0).toUpperCase() + constraint.factor.slice(1)} ` +
      `(${constraint.score}/100) does not impose critical operational restrictions ` +
      `under normal production conditions.`;
  }

  let thermalBehavior;
  if (scores.thermal >= 75) {
    thermalBehavior =
      `Thermally stable — operating within the defined safe thermal band with acceptable ` +
      `degradation margin (Thermal: ${scores.thermal}/100). Temperature control requirements ` +
      `are consistent with standard biodegradable polymer processing protocol.`;
  } else if (scores.thermal >= 55) {
    thermalBehavior =
      `Thermally constrained — processing temperature approaches the material degradation threshold ` +
      `(Thermal: ${scores.thermal}/100). Zone-by-zone temperature monitoring is required to ` +
      `prevent degradation onset during extended production runs.`;
  } else {
    thermalBehavior =
      `Thermally unstable — the operating thermal window is incompatible with stable ` +
      `biodegradable polymer processing (Thermal: ${scores.thermal}/100). ` +
      `Degradation risk under standard processing temperatures is high; ` +
      `thermal profile redesign is required prior to pilot validation.`;
  }

  let flowCharacteristics;
  if (scores.flow >= 75) {
    flowCharacteristics =
      `Operationally stable — melt rheology within the qualified processing range ` +
      `(Flow: ${scores.flow}/100). Standard screw configuration and pressure settings ` +
      `are confirmed to maintain melt uniformity across production runs ` +
      `without active process intervention.`;
  } else if (scores.flow >= 55) {
    flowCharacteristics =
      `Variable — melt flow requires active stabilisation (Flow: ${scores.flow}/100). ` +
      `Pressure fluctuation risk during extended extrusion cycles necessitates real-time monitoring, ` +
      `screw speed adjustment, and reduced throughput targets during the validation phase.`;
  } else {
    flowCharacteristics =
      `Critically unstable — melt behaviour is incompatible with continuous commercial production ` +
      `(Flow: ${scores.flow}/100). Significant flow instability is anticipated, resulting in ` +
      `unacceptable gauge variation, potential line stoppages, and elevated off-specification output rates.`;
  }

  return { processingWindow, thermalBehavior, flowCharacteristics };
}

// ══════════════════════════════════════════════════════════════
// § 10  PRODUCT SECTION
// ══════════════════════════════════════════════════════════════

function generateProduct(scores) {
  const mechanical =
    scores.mechanical >= 75
      ? `Structural integrity of the finished product is attainable under standard processing conditions ` +
        `(Mechanical: ${scores.mechanical}/100). Mechanical performance meets commercial specification ` +
        `without formulation adjustment.`
      : scores.mechanical >= 55
        ? `Mechanical performance is conditionally adequate, subject to process consistency ` +
          `(Mechanical: ${scores.mechanical}/100). Inter-batch property variation is anticipated ` +
          `without active control measures.`
        : `Mechanical performance falls below the commercial acceptance threshold ` +
          `(Mechanical: ${scores.mechanical}/100). Structural integrity compliance cannot be assured ` +
          `without material reformulation or process redesign.`;

  const surface =
    scores.flow >= 75
      ? `Surface finish conforms to specification. Operationally stable melt flow ` +
        `(Flow: ${scores.flow}/100) supports uniform surface formation under standard die ` +
        `and cooling conditions.`
      : scores.flow >= 55
        ? `Surface quality is conditionally acceptable. Flow variability (Flow: ${scores.flow}/100) ` +
          `directly introduces surface non-uniformities, particularly during die start-up ` +
          `and extended high-speed production runs.`
        : `Surface quality is unreliable under current process parameters (Flow: ${scores.flow}/100). ` +
          `Melt instability directly generates streaking, pitting, and non-uniform gloss ` +
          `at commercial production speeds.`;

  const structural =
    scores.total >= 75
      ? `Structural consistency is attainable within the defined processing envelope. ` +
        `Dimensional stability and wall thickness uniformity conform to ` +
        `pilot validation acceptance criteria.`
      : scores.total >= 55
        ? `Structural consistency is conditional on process parameter control ` +
          `(Composite: ${scores.total}/100). Dimensional variation is anticipated at the margins ` +
          `of the processing window; tooling and cooling parameter adjustments are required.`
        : `Structural consistency is unattainable under the current process conditions ` +
          `(Composite: ${scores.total}/100). Dimensional variance and structural non-compliance ` +
          `exceed commercial tolerance limits without process redesign.`;

  return { mechanical, surface, structural };
}

// ══════════════════════════════════════════════════════════════
// § 11  QUALITY SECTION
// ══════════════════════════════════════════════════════════════

function generateQuality(scores) {
  const minScore = Math.min(scores.thermal, scores.flow, scores.mechanical);

  const stability = minScore >= 75 ? "High" : minScore >= 55 ? "Moderate" : "Low";
  const stabilityNote =
    minScore >= 75
      ? `Process stability index: ${minScore}/100. Compliant with commercial deployment ` +
        `under standard quality control protocol.`
      : minScore >= 55
        ? `Process stability index: ${minScore}/100. Conditionally acceptable — enhanced ` +
          `in-line monitoring and statistical process control (SPC) are required.`
        : `Process stability index: ${minScore}/100. Below the commercial acceptance threshold. ` +
          `Process redesign is required prior to deployment.`;

  const consistency = scores.flow >= 75 ? "High" : scores.flow >= 55 ? "Moderate" : "Low";
  const consistencyNote =
    scores.flow >= 75
      ? `Flow consistency index: ${scores.flow}/100. Production consistency is attainable ` +
        `within standard parameter tolerance limits.`
      : scores.flow >= 55
        ? `Flow consistency index: ${scores.flow}/100. Closed-loop pressure control is ` +
          `recommended to restrict inter-batch variability to acceptable levels.`
        : `Flow consistency index: ${scores.flow}/100. High inter-batch variability is anticipated. ` +
          `Output consistency cannot be assured without active flow stabilisation measures.`;

  return { stability, stabilityNote, consistency, consistencyNote };
}

// ══════════════════════════════════════════════════════════════
// § 12  EXPECTED DEVIATIONS
// ══════════════════════════════════════════════════════════════

function generateExpectedDeviations(input, scores, context, constraintArch) {
  const spec = getNarrativeSpecialization(context);
  let items = [];

  if (spec === "LDPE_PHA_LOW_TEMP_FILM") {
    items = [
      `Local film stiffness variation may reduce pouch-forming consistency under low-temperature handling conditions`,
      `Seal-area thickness imbalance may emerge where melt stability shifts during extended extrusion runs`,
      `Cold-chain flex performance may vary across production output when flow uniformity deteriorates over time`,
    ];
  } else if (spec === "LDPE_BIO_HIGH_SPEED_FILM") {
    items = [
      `Cross-web gauge drift may increase as melt stability moves toward the boundary of the qualified operating range`,
      `Local seal-area non-uniformity may emerge where thickness balance and melt stability shift during extended high-speed runs`,
      `Extended-run output may show progressive variation in film uniformity, winding consistency, and off-specification zone frequency`,
    ];
  } else if (spec === "PP_PLA_THERMAL_STRESS") {
    items = [
      `Heat-induced deformation may emerge where thermal retention is insufficient for the intended application`,
      `Local loss of stiffness or structural stability may appear under repeated thermal exposure`,
      `Material response may become inconsistent when thermal load approaches the upper limit of the qualified operating window`,
    ];
  } else if (spec === "PET_PLA_THERMAL_STRESS") {
    items = [
      `Dimensional drift may increase at precision edges where thermal exposure approaches the qualified limit`,
      `Local wall-section distortion may appear after repeated heat loading or elevated-temperature use cycles`,
      `Container geometry retention may vary between cycles where thermal stability is insufficient for the required service condition`,
    ];
  } else if (context.process_family === "INJECTION") {
    const dimRange = scores.mechanical < 65 ? "±0.3–0.8mm" : "±0.1–0.3mm";
    items = [
      `Dimensional deviation ${dimRange} on critical part features under process parameter fluctuation`,
      `Warpage or local sink behaviour may appear where cooling balance shifts across the molded section`,
      `Surface or geometry retention may vary when material response approaches the boundary of the qualified processing window`,
    ];
  } else if (constraintArch.primary_constraint.type === "FLOW") {
    items = [
      `Output consistency variation may appear during extended production runs where melt uniformity drifts outside the qualified range`,
      `Surface or profile non-uniformity may increase under pressure fluctuation during steady-state conversion`,
      `Production stability may decline as line conditions move toward the edge of the validated flow envelope`,
    ];
  } else if (constraintArch.primary_constraint.type === "THERMAL") {
    items = [
      `Heat-induced deformation may emerge where thermal retention is insufficient for the intended application`,
      `Local loss of stiffness or structural stability may appear under repeated thermal exposure`,
      `Material response may become inconsistent when thermal load approaches the upper limit of the qualified operating window`,
    ];
  } else {
    items = [
      `Mechanical property variation may affect structural consistency across production output`,
      `Dimensional deviation may appear on critical features under fluctuating process conditions`,
      `Further deviation characterisation is required under full-scale production conditions prior to commercial acceptance`,
    ];
  }

  return items.map((item) => `<li>${item}</li>`).join("\n");
}
// ══════════════════════════════════════════════════════════════
// § 13  APPLICATION IMPLICATION
// ══════════════════════════════════════════════════════════════

function generateApplicationImplication(decision, input) {
  const app = safe(input.application, "this application");

  if (decision.level === "HIGH") {
    return (
      `${app} is technically feasible for commercial deployment. ` +
      `The material transition is compatible with the current processing framework. ` +
      `Standard monitoring protocols apply during the initial production ramp-up phase.`
    );
  }
  if (decision.level === "MODERATE") {
    return (
      `${app} is technically feasible subject to process optimisation. ` +
      `Pilot-scale validation is required and must be successfully completed prior to any commercial commitment. ` +
      `Constraint control measures must be implemented and verified before full-scale deployment.`
    );
  }
  return (
    `${app} is not recommended for commercial deployment at the current feasibility level. ` +
    `Material reformulation or application redesign is required prior to re-evaluation.`
  );
}

function generateApplicationImplicationV2(decisionBand, context, constraintArch, input) {
  const app = safe(input.application, "this application");
  const primary = constraintArch.primary_constraint;

  if (decisionBand.level === "LOW") {
    return (
      `${app} is not suitable for commercial deployment under the declared configuration. ` +
      `The primary blocker is ${primary.factor}, and the current material transition path does not provide sufficient margin for reliable implementation.`
    );
  }

  // A) PE → PHA / blown film
  if (
    context.material_class === "POLYOLEFIN_PE" &&
    context.target_material_class === "PHA_BASED" &&
    context.process_family === "BLOWN_FILM"
  ) {
    return (
      `${app} is technically feasible only under controlled process optimisation. ` +
      `Pilot-scale validation must confirm that flow stability, gauge control, and downstream film consistency can be maintained over extended runs before full-scale commercial deployment is considered.`
    );
  }

  // B) PP → PLA / thermal-stress
  if (
    context.material_class === "POLYOLEFIN_PP" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    return (
      `${app} is technically feasible subject to tightly controlled process optimisation. ` +
      `Pilot-scale validation is required before commercial commitment, with particular emphasis on thermal margin, post-heating structural reliability, and repeated heat-exposure performance.`
    );
  }

  // C) PET → PLA / thermal-stress
  if (
    context.material_class === "PET" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    return (
      `${app} is technically feasible subject to tightly controlled process optimisation. ` +
      `Pilot-scale validation is required before commercial commitment, with particular emphasis on dimensional reliability, tolerance retention, and post-molding geometry stability under thermal exposure.`
    );
  }

  if (decisionBand.level === "MODERATE" && context.use_condition_family === "THERMAL_STRESS") {
    return (
      `${app} is technically feasible subject to tightly controlled process optimisation. ` +
      `Pilot-scale validation is required before commercial commitment, with particular emphasis on maintaining thermal margin and downstream dimensional reliability.`
    );
  }

  if (decisionBand.level === "MODERATE" && context.process_family === "BLOWN_FILM") {
    return (
      `${app} is technically feasible subject to process optimisation. ` +
      `Pilot-scale validation is required and must verify flow stability, output uniformity, and application-level consistency before full-scale deployment.`
    );
  }

  return (
    `${app} is technically feasible subject to process optimisation. ` +
    `Pilot-scale validation is required and must be successfully completed prior to commercial commitment.`
  );
}
// ══════════════════════════════════════════════════════════════
// § 14  NEXT STEPS
// ══════════════════════════════════════════════════════════════

function generateNextStep(decision, constraint, scores) {
  if (decision.level === "HIGH") {
    return (
      `Based on the HIGH feasibility determination (Composite: ${scores.total}/100), ` +
      `the system is qualified for controlled pilot deployment.\n\n` +
      `Initiate pilot production with continuous monitoring focused on ${constraint.factor}. ` +
      `Verify yield stability and product conformance under sustained production conditions ` +
      `prior to committing to full commercial scale-up. ` +
      `Document all validated process parameters as the baseline reference for ongoing quality management.`
    );
  }

  if (decision.level === "MODERATE") {
    const targetingPhrase =
      constraint.type === "THERMAL"
        ? "thermal stability control"
        : constraint.type === "FLOW"
          ? "flow stability control"
          : "mechanical performance stability";

    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), ` +
      `engineering validation targeting ${targetingPhrase} ` +
      `is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Implement control measures for ${constraint.control}. ` +
      `Execute structured parameter trials to define the qualified processing envelope. ` +
      `Re-assess system stability following confirmation of stabilisation controls, ` +
      `then proceed to pilot validation against defined acceptance criteria.`
    );
  }

  return (
    `Based on the LOW feasibility determination (Composite: ${scores.total}/100), ` +
    `commercial transition under the current configuration is not recommended.\n\n` +
    `Suspend transition activities and evaluate alternative material grades ` +
    `or process architecture modifications. ` +
    `Address the critical constraint identified in ${constraint.factor}. ` +
    `A revised evaluation submission is required following validation ` +
    `of design modifications at laboratory scale.`
  );
}

function generateNextStepV2(decisionBand, constraintArch, context, scores, input) {
  const primary = constraintArch.primary_constraint;

  if (decisionBand.level === "LOW") {
    return (
      `Based on the LOW feasibility determination (Composite: ${scores.total}/100), the current transition path is not recommended for pilot approval.\n\n` +
      `Suspend deployment planning and review either an alternative grade or a modified process architecture that can address ${primary.factor}. ` +
      `Re-submission should follow only after a revised material or processing path has been technically screened at laboratory level.`
    );
  }

  // A) PE → PHA / blown film
  if (
    context.material_class === "POLYOLEFIN_PE" &&
    context.target_material_class === "PHA_BASED" &&
    context.process_family === "BLOWN_FILM"
  ) {
    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting flow stability control is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Validation should focus on confirming stable melt uniformity, pressure balance, gauge consistency, and extended-run output control under representative operating conditions. ` +
      `Structured pilot trials should define the qualified production envelope for long-run film manufacture, after which system stability, yield reliability, and downstream converting consistency should be reassessed against commercial acceptance criteria.`
    );
  }

  // B) PP → PLA / thermal-stress
  if (
    context.material_class === "POLYOLEFIN_PP" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting thermal stability control is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Validation should focus on heat-retention margin, post-heating dimensional retention, and structural reliability after repeated thermal exposure. ` +
      `Execute structured pilot trials to define the qualified processing and downstream-use envelope, then re-assess system stability before proceeding to commercial-scale deployment.`
    );
  }

  // C) PET → PLA / thermal-stress
  if (
    context.material_class === "PET" &&
    context.target_material_class === "PLA_BASED" &&
    context.use_condition_family === "THERMAL_STRESS"
  ) {
    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting thermal stability control is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Validation should focus on post-molding dimensional retention, tolerance stability at critical features, and structural consistency after realistic heat-exposure conditions. ` +
      `Execute structured pilot trials to define the qualified thermal and dimensional acceptance envelope, then re-assess system stability before proceeding to commercial-scale deployment.`
    );
  }

  if (primary.type === "FLOW") {
    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting flow stability control is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Implement control measures for ${primary.control}. Execute structured parameter trials to define the qualified processing envelope. Re-assess system stability following confirmation of stabilisation controls, then proceed to pilot validation against defined acceptance criteria.`
    );
  }

  if (primary.type === "THERMAL") {
    return (
      `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting thermal stability control is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
      `Implement control measures for ${primary.control}. Execute structured parameter trials to define the qualified processing envelope. Re-assess system stability following confirmation of stabilisation controls, then proceed to pilot validation against defined acceptance criteria.`
    );
  }

  return (
    `Based on the MODERATE feasibility determination (Composite: ${scores.total}/100), engineering validation targeting structural performance stability is required prior to pilot approval and must be completed before any commercial commitment.\n\n` +
    `Implement control measures for ${primary.control}. Execute structured validation trials, then proceed to pilot review against defined structural acceptance criteria.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 15  HTML INJECTION
// ══════════════════════════════════════════════════════════════

function injectHtml(template, data) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const val = data[key];
    if (val === undefined || val === null) return "—";
    return String(val);
  });
}

// ══════════════════════════════════════════════════════════════
// § 16  DYNAMIC OVERLAY
// ══════════════════════════════════════════════════════════════

function generateOverlay(scores) {
  const angle = -90 + scores.total * 1.8;

  function getAmplitude(score) {
    if (score >= 85) return 1.6;
    if (score >= 80) return 3;
    if (score >= 70) return 5;
    if (score >= 60) return 9;
    return 13;
  }

  const ampLeft = getAmplitude(scores.thermal);
  const ampRight = getAmplitude(scores.flow);

  return `
  <div style="position:absolute;top:40px;left:140px;text-align:center;z-index:3;">
    <div style="font-size:28px;color:#2f3a44;">230°C</div>
    <div style="font-size:16px;color:#5b6770;">${scores.thermal}</div>
  </div>

  <div style="position:absolute;top:40px;right:140px;text-align:center;z-index:3;">
    <div style="font-size:28px;color:#d62c2c;">180°C</div>
    <div style="font-size:16px;color:#d62c2c;">${scores.flow}</div>
  </div>

  <svg style="position:absolute;left:280px;bottom:85px;z-index:2;" width="90" height="35">
    <path d="M0 18 C15 ${18 - ampLeft}, 30 ${18 + ampLeft}, 45 18 C60 ${18 - ampLeft}, 75 ${18 + ampLeft}, 90 18"
      fill="none" stroke="#4f7c8a" stroke-width="1.8" opacity="0.85"/>
  </svg>

  <svg style="position:absolute;left:420px;bottom:85px;z-index:2;" width="90" height="35">
    <path d="M0 18 C15 ${18 - ampRight}, 30 ${18 + ampRight}, 45 18 C60 ${18 - ampRight}, 75 ${18 + ampRight}, 90 18"
      fill="none" stroke="#d62c2c" stroke-width="1.8" opacity="0.85"/>
  </svg>

  <svg style="position:absolute;right:40px;bottom:10px;z-index:3;" viewBox="0 0 200 120" width="140" height="90">
    <defs>
      <linearGradient id="g">
        <stop offset="0%" stop-color="#22c55e"/>
        <stop offset="50%" stop-color="#fde047"/>
        <stop offset="100%" stop-color="#ef4444"/>
      </linearGradient>
    </defs>
    <path d="M20 100 A80 80 0 0 1 180 100 L100 100 Z" fill="url(#g)"/>
    <g transform="rotate(${angle} 100 100)">
      <line x1="100" y1="100" x2="100" y2="30" stroke="#111" stroke-width="3"/>
    </g>
    <circle cx="100" cy="100" r="4" fill="#111"/>
  </svg>`;
}

// ══════════════════════════════════════════════════════════════
// § 16b  CLAUDE NARRATIVE API
// ══════════════════════════════════════════════════════════════

const NARRATIVE_USER_TEMPLATE = `You are a JSON generation module embedded inside a production system.
You are NOT an assistant.
You are NOT allowed to think freely.
You are NOT allowed to explain anything.
Your output will be directly parsed by a backend system.
If you break the format, the system will fail.

SYSTEM ROLE (FIXED)
- You ONLY generate structured JSON
- You DO NOT modify system logic
- You DO NOT modify scores
- You DO NOT generate HTML
- You DO NOT generate markdown
- You DO NOT generate explanation text

CRITICAL OUTPUT RULES (MANDATORY)
1. Output must be valid JSON
2. No text before JSON
3. No text after JSON
4. No markdown (no backtick blocks)
5. No comments
6. No trailing commas
7. No missing quotes
8. No additional keys
9. No line breaks outside JSON
10. All keys must exist
11. All values must be strings
12. Do not include null or undefined
13. Do not escape structure
If ANY of these rules are violated, the system will fail.

STRICT PROHIBITIONS
You MUST NOT:
- Suggest processing parameters (temperature, speed, etc.)
- Suggest suppliers or materials
- Change technical conclusions beyond given scores
- Introduce new variables or assumptions
- Output anything outside JSON

INPUT DATA (READ ONLY)
Application: {{application}}
Material: {{material}}
Target Bio Material: {{bio_material}}
Scores:
Thermal: {{thermal}}
Flow: {{flow}}
Mechanical: {{mechanical}}
Total: {{total}}
Constraint: {{constraint}}

INTERPRETATION RULES
- LOW (<55): not viable → HOLD
- MODERATE (55-74): conditional → requires validation
- HIGH (75+): viable → proceed
- Primary risk = lowest score dimension
- Secondary risk = interaction of remaining two dimensions
- Mechanism = explain mismatch between material and process
- No speculation beyond input

OUTPUT FORMAT (STRICT JSON ONLY)
{
  "executive_summary": "",
  "risk_primary": "",
  "risk_secondary": "",
  "mechanism": "",
  "processing_window_note": "",
  "application_implication": "",
  "next_step": ""
}`;

async function callClaudeForNarrative(input, scores, constraint) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const userContent = NARRATIVE_USER_TEMPLATE
    .replace("{{application}}", safe(input.application, "Not specified"))
    .replace("{{material}}", safe(input.material, "Not specified"))
    .replace("{{bio_material}}", safe(input.bio_material, "Not specified"))
    .replace("{{thermal}}", String(scores.thermal))
    .replace("{{flow}}", String(scores.flow))
    .replace("{{mechanical}}", String(scores.mechanical))
    .replace("{{total}}", String(scores.total))
    .replace("{{constraint}}", constraint.type);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const data = await res.json();

  const raw = Array.isArray(data.content)
    ? data.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()
    : "";

  if (!raw) throw new Error("Empty Claude response");

  const parsed = safeParseJSON(raw);
  const result = validateNarrative(parsed);

  console.log("[Claude OK] narrative generated successfully");
  return result;
}

// ══════════════════════════════════════════════════════════════
// § 16c  CLAUDE MECHANISM API
// ══════════════════════════════════════════════════════════════

const MECHANISM_USER_TEMPLATE = `You are a professional materials and processing consultant specializing in biodegradable polymers.
Your role is to refine specific sections of a technical feasibility report to achieve a high-end, consulting-grade output.

CRITICAL RULES
- Do NOT change any scores or evaluation logic.
- Do NOT introduce new assumptions beyond the provided data.
- Do NOT provide processing parameters, formulations, or supplier recommendations.
- Keep explanations technical, precise, and professional.
- Output must be valid JSON only.
- Each field must be concise (2-4 sentences max).

TASK
Refine ONLY the following two sections:
1. Mechanism
2. Expected Deviations

INPUT DATA
Current Material: {{material}}
Target Material: {{bio_material}}
Scores:
- Thermal: {{thermal}}
- Flow: {{flow}}
- Mechanical: {{mechanical}}
Primary Constraint: {{constraint}}
Application: {{application}}
Processing Method: {{equipment}}
Known Issues: {{concern}}

INSTRUCTIONS

Mechanism
- Clearly explain the fundamental material difference between current and target materials.
- Focus on: thermal stability, rheology, degradation sensitivity.
- Must directly connect to the PRIMARY CONSTRAINT.
- Avoid generic phrasing.
- Make it sound like expert-level material science reasoning.

Expected Deviations
- Generate 3 bullet points.
- Each must reflect: real processing risks, material-specific behavior.
- Must align with: the constraint, the application.
- Avoid generic "process variability" phrases.
- Be specific to material behavior (e.g. degradation, deformation, instability patterns).
- If the target material is PLA-based: consider hydrolytic degradation sensitivity and lower thermal resistance compared to polyolefins.

OUTPUT FORMAT (STRICT JSON ONLY — no text before or after)
{
  "mechanism": "...",
  "expected_deviations": ["...", "...", "..."]
}`;

async function callClaudeForMechanism(input, scores, constraint) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const userContent = MECHANISM_USER_TEMPLATE
    .replace("{{material}}", safe(input.material, "Not specified"))
    .replace("{{bio_material}}", safe(input.bio_material, "Not specified"))
    .replace("{{thermal}}", String(scores.thermal))
    .replace("{{flow}}", String(scores.flow))
    .replace("{{mechanical}}", String(scores.mechanical))
    .replace("{{constraint}}", constraint.type)
    .replace("{{application}}", safe(input.application, "Not specified"))
    .replace("{{equipment}}", safe(input.equipment, "Not specified"))
    .replace("{{concern}}", safe(input.concern, "None noted"));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!res.ok) throw new Error(`Claude API error (mechanism): ${res.status}`);

  const data = await res.json();

  const raw = Array.isArray(data.content)
    ? data.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()
    : "";

  if (!raw) throw new Error("Empty Claude response (mechanism)");

  const parsed = safeParseJSON(raw);
  const result = validateMechanism(parsed);

  console.log("[Claude OK] mechanism refined successfully");
  return result;
}

// ══════════════════════════════════════════════════════════════
// § 17  MAIN ROUTE
// ══════════════════════════════════════════════════════════════

app.post("/generate-report", (req, res) => {
  queue.add(() => handleReport(req, res)).catch((err) => {
    console.error("[Queue error]", err.message);
  });
});

async function handleReport(req, res) {
  try {
    const input = normalizeInput(req.body);

    const context = interpretInputContext(input);
    const scores = calculateScores(input, context);
    const constraint = getConstraint(scores);
    const decision = determineDecision(scores.total);
    const decisionBand = determineDecisionBand(scores.total, scores, context);
    const economic = calculateEconomic(scores.total);
    const constraintArch = buildConstraintArchitecture(scores, context);

    const risk = generateRisk(scores, constraintArch, input, context);
    const processing = generateProcessing(scores, constraint);
    const product = generateProduct(scores);
    const quality = generateQuality(scores);

    let narrative = null;
    let mechanismData = null;

    try {
      narrative = await callClaudeForNarrative(input, scores, constraint);
    } catch (e) {
      if (e.name === "AbortError") console.warn("[Claude TIMEOUT] narrative");
      else console.warn("[Claude ERROR] narrative:", e.message);
    }

    try {
      mechanismData = await callClaudeForMechanism(input, scores, constraint);
    } catch (e) {
      if (e.name === "AbortError") console.warn("[Claude TIMEOUT] mechanism");
      else console.warn("[Claude ERROR] mechanism:", e.message);
    }

    let exec_summary =
      narrative?.executive_summary || generateExecutive(scores, decision, economic, constraint);

    if (decision.level === "MODERATE") {
      exec_summary = exec_summary.replace(
        /Deployment Decision:\s*CONDITIONAL GO.*/i,
        "Deployment Decision: CONDITIONAL GO — Controlled pilot validation required prior to commercial commitment"
      );
    }

    const primary_risk_body = narrative?.risk_primary || risk.primary;
    const secondary_risk_body = narrative?.risk_secondary || risk.secondary;
    const deterministic_mechanism = generateMechanism(input, constraint, context);
const deterministic_deviations = generateExpectedDeviations(input, scores, context, constraintArch);
const mechanism_body = shouldForceDeterministicMechanism(context)
  ? deterministic_mechanism
  : (mechanismData?.mechanism || deterministic_mechanism);
const expected_devs_raw = mechanismData?.expected_deviations;
const expected_devs_html = shouldForceDeterministicDeviations(context)
  ? deterministic_deviations
  : (
      Array.isArray(expected_devs_raw)
        ? expected_devs_raw
            .filter(Boolean)
            .map((d) => `<li>${String(d).trim().slice(0, 220)}</li>`)
            .join("\n")
        : deterministic_deviations
    );
    const proc_window_note = narrative?.processing_window_note || processing.processingWindow;
    const app_implication =
      narrative?.application_implication || generateApplicationImplicationV2(decisionBand, context, constraintArch, input);
    const next_step_body =
  narrative?.next_step || generateNextStepV2(decisionBand, constraintArch, context, scores, input);
    const htmlData = {
      assessment_type: "Technical Hypothesis",
      application: safe(input.application),
      material_transition: safe(input.bio_material),
      report_date: new Date().toISOString().split("T")[0],

      subtitle_note:
        "For manufacturers evaluating biodegradable material transition using existing processing equipment." +
        "<br>This report enables early-stage decision-making without requiring immediate engineering trials.",

      compatibility_level: decision.level,
      executive_summary: exec_summary,
      key_risk: primary_risk_body,

      processing_window: proc_window_note,
      thermal_behavior: processing.thermalBehavior,
      flow_characteristics: processing.flowCharacteristics,

      mechanical_behavior: product.mechanical,
      surface_quality: product.surface,
      structural_consistency: product.structural,
      application_implication: app_implication,

      primary_risk_title: getPrimaryRiskTitle(constraint),
      primary_risk: primary_risk_body,
      secondary_risk_title: "Process Interaction Risk",
      secondary_risk: secondary_risk_body,
      mechanism: mechanism_body,

      stability: quality.stability,
      stability_note: quality.stabilityNote,
      consistency: quality.consistency,
      consistency_note: quality.consistencyNote,
      expected_deviations: expected_devs_html,

      pha_score: scores.total,

      base_image: "https://ilnautico.github.io/visual-base.png",
      dynamic_overlay: `<div style="position:relative;width:700px;height:240px;margin:0 auto;">
  <img src="https://ilnautico.github.io/visual-base.png"
       style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;" />
  ${generateOverlay(scores)}
</div>`,

      next_step: next_step_body,
      decision: decision.decision,
      economic_impact: economic,

      call_to_action:
        "Request a Technical Screening Report (Equivalent: $200) — Delivered within 48 hours",
    };

    const html = injectHtml(htmlTemplate, htmlData);

    const pdf = await Promise.race([
      renderPdf(html),
      globalTimeout(45000),
    ]);

    latestPdfBuffer = pdf;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=fairvia-report.pdf");
    res.setHeader("Content-Length", pdf.length);
    res.send(pdf);
  } catch (err) {
    console.error("[PDF ERROR]", {
      message: err.message,
      stack: err.stack,
      input: req.body,
    });
    res.status(500).json({ error: "PDF generation failed", detail: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
// PDF renderer — page lifecycle only; browser singleton is retained
// ══════════════════════════════════════════════════════════════

async function renderPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  if (!page) throw new Error("Puppeteer page creation failed");

  let closed = false;

  const safeClose = async () => {
    if (!closed) {
      closed = true;
      await page.close().catch(() => {});
    }
  };

  page.on("error", safeClose);
  page.on("pageerror", safeClose);

  try {
    await page
      .setContent(html, { waitUntil: "networkidle0", timeout: 30000 })
      .catch(() => {
        throw new Error("HTML render timeout — networkidle0 not reached within 30s");
      });

    await page.evaluate(async () => await document.fonts.ready);

    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await safeClose();
  }
}

// ══════════════════════════════════════════════════════════════
// AUXILIARY ROUTES
// ══════════════════════════════════════════════════════════════

let latestPdfBuffer = null;

app.get("/latest-pdf", (_req, res) => {
  if (!latestPdfBuffer) {
    return res.status(404).send("No PDF generated yet.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=fairvia-report.pdf");
  res.send(latestPdfBuffer);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[FairVia] Server running on port ${PORT}`);
});　
const html_3man =`;
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>FairVia Report</title>
</head>

<body>
<h1>{{client_name}}</h1>
<p>{{client_company}}</p>
<p>{{client_country}}</p>

<h2>Feasibility: {{feasibility_level}}</h2>

<p>{{executive_summary_overview}}</p>
<p>{{executive_summary_findings}}</p>
<p>{{executive_summary_conclusion}}</p>
Editing server.js file contents

</body>
</html>
;
const html = 
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FairVia™ Technical Screening Report</title>
<style>

/* ── Reset ── */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* ── Page setup ── */
@page {
  size: A4;
  margin: 0;
}

html {
  width: 210mm;
  background: #ffffff;
}

body {
  width: 210mm;
  background: #ffffff;
  font-family: Georgia, "Times New Roman", serif;
  color: #2c2c2c;
  font-size: 10pt;
  line-height: 1.6;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  margin: 0;
}

/* ── Page container ── */
.page {
  display: flex;
  flex-direction: column;
  width: 210mm;
  height: 297mm;
  box-sizing: border-box;
  page-break-after: always;
  background: #ffffff;
  position: relative;
}

.page:last-child {
  page-break-after: auto;
}

/* ── Page body grows to push footer down ── */
.page-body {
  flex: 1;
  min-height: 0;
  padding: 8mm 14mm 14mm;
}

/* ── Page footer: always at bottom ── */
.page-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  background: #17263c;
}

.page-footer-gold {
  height: 1px;
  background: #b4965a;
  opacity: 0.6;
}

.page-footer-inner {
  padding: 3mm 14mm;
  display: flex;
  justify-content: space-between;
}

.page-footer-left {
  font-size: 6.5pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.06em;
}

.page-footer-right {
  font-size: 6.5pt;
  color: #b4965a;
}

/* ═══════════════════════════════════════════
   COVER PAGE
═══════════════════════════════════════════ */

.cover {
  background: #17263c;
}

.cover-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.cover-header {
  padding: 10mm 14mm 0;
  display: block;
}

.cover-brand {
  font-family: Georgia, serif;
  font-size: 8pt;
  color: #b4965a;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 1mm;
}

.cover-service {
  font-size: 7pt;
  color: rgba(255,255,255,0.5);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
}

.cover-gold-rule {
  margin: 8mm 14mm 0;
  height: 1px;
  background: #b4965a;
  opacity: 0.4;
}

.cover-main {
  padding: 16mm 14mm 0;
  display: block;
  flex: 1;
}

.cover-report-type {
  font-size: 7.5pt;
  color: #b4965a;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 5mm;
}

.cover-title {
  font-family: Georgia, serif;
  font-size: 28pt;
  font-weight: normal;
  color: #ffffff;
  line-height: 1.15;
  display: block;
  margin-bottom: 3mm;
}

.cover-subtitle {
  font-family: Georgia, serif;
  font-size: 13pt;
  font-weight: normal;
  color: #b4965a;
  letter-spacing: 0.03em;
  display: block;
  margin-bottom: 12mm;
}

.cover-divider {
  width: 20mm;
  height: 2px;
  background: #b4965a;
  display: block;
  margin-bottom: 10mm;
}

.cover-client-box {
  background: rgba(180, 150, 90, 0.12);
  border-left: 3px solid #b4965a;
  padding: 6mm 8mm;
  display: block;
  margin-bottom: 12mm;
}

.cover-client-label {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.cover-client-name {
  font-size: 13pt;
  color: #ffffff;
  font-weight: normal;
  display: block;
  margin-bottom: 1.5mm;
}

.cover-client-detail {
  font-size: 8.5pt;
  color: rgba(255,255,255,0.6);
  display: block;
  margin-bottom: 0.8mm;
}

.cover-meta-grid {
  display: block;
}

.cover-meta-row {
  padding: 2.5mm 0;
  border-top: 1px solid rgba(180,150,90,0.25);
  display: block;
  overflow: hidden;
}

.cover-meta-row:last-child {
  border-bottom: 1px solid rgba(180,150,90,0.25);
}

.cover-meta-label {
  font-size: 7pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  float: left;
  width: 38mm;
  display: inline-block;
}

.cover-meta-value {
  font-size: 8.5pt;
  color: rgba(255,255,255,0.85);
  display: inline-block;
}

.cover-badge-area {
  padding: 10mm 14mm 0;
  display: block;
}

.cover-badge-label {
  font-size: 7pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 3mm;
}

.cover-badge {
  display: inline-block;
  padding: 3mm 8mm;
  border: 1.5px solid #b4965a;
  font-size: 11pt;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.cover-badge.level-low      { color: #6db07a; border-color: #6db07a; }
.cover-badge.level-moderate { color: #c4963e; border-color: #c4963e; }
.cover-badge.level-high     { color: #c0614a; border-color: #c0614a; }

/* Cover footer */
.cover-footer {
  background: #17263c;
  border-top: 1px solid rgba(180,150,90,0.25);
  padding: 5mm 14mm;
  display: flex;
  justify-content: space-between;
  flex-shrink: 0;
}

.cover-footer-left {
  font-size: 7pt;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.08em;
}

.cover-footer-right {
  font-size: 7pt;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.08em;
}

/* ═══════════════════════════════════════════
   CONTENT PAGES — header strip
═══════════════════════════════════════════ */

.page-header {
  background: #17263c;
  padding: 4mm 14mm;
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  overflow: hidden;
}

.page-header-left {
  font-size: 6.5pt;
  color: rgba(255,255,255,0.55);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  line-height: 1.4;
}

.page-header-right {
  font-size: 6.5pt;
  color: #b4965a;
  letter-spacing: 0.08em;
  line-height: 1.4;
}

.page-header-gold {
  height: 1.5px;
  background: #b4965a;
  flex-shrink: 0;
}

/* ── Section elements ── */

.section {
  break-inside: avoid;
  page-break-inside: avoid;
  margin-bottom: 7mm;
  display: block;
}

.section-label {
  font-size: 6.5pt;
  color: #b4965a;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 1mm;
}

.section-title {
  font-family: Georgia, serif;
  font-size: 14pt;
  font-weight: normal;
  color: #17263c;
  display: block;
  margin-bottom: 1.5mm;
}

.section-rule-full {
  height: 1px;
  background: #b4965a;
  display: block;
  margin-bottom: 5mm;
}

/* ── Body text ── */
.body-text {
  font-size: 9.5pt;
  color: #2c2c2c;
  line-height: 1.65;
  text-align: justify;
  display: block;
  margin-bottom: 3mm;
}

/* ── Info table ── */
.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
  margin-bottom: 4mm;
}

.info-table tr:nth-child(odd) td  { background: #f5f3ee; }
.info-table tr:nth-child(even) td { background: #ffffff; }

.info-table td {
  padding: 2.5mm 4mm;
  vertical-align: top;
  border-bottom: 0.5px solid #ddd6c8;
}

.info-table td:first-child {
  width: 44mm;
  font-size: 8pt;
  font-weight: bold;
  color: #17263c;
  white-space: nowrap;
}

.info-table td:last-child { color: #2c2c2c; }

.info-table tr:last-child td { border-bottom: 1.5px solid #b4965a; }

/* ── Executive Summary blocks ── */
.summary-block {
  border-left: 3px solid #b4965a;
  padding-left: 4mm;
  margin-bottom: 4mm;
}

.summary-heading {
  display: block;
  font-size: 8pt;
  font-weight: bold;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #b4965a;
  margin-bottom: 1.5mm;
}

/* ── Feasibility scale ── */
.feasibility-scale {
  display: block;
  margin-bottom: 4mm;
}

.feasibility-scale-label {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.feasibility-row {
  display: block;
  width: 72mm;
  padding: 2mm 4mm;
  margin-bottom: 1.2mm;
  border-radius: 2px;
  font-size: 9pt;
  overflow: hidden;
}

.feasibility-row.inactive {
  background: #f5f3ee;
  border: 0.5px solid #ddd6c8;
  color: #9a9088;
}

.feasibility-row.active {
  background: #17263c;
  border: 1px solid #b4965a;
  color: #ffffff;
}

.feasibility-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 3mm;
  vertical-align: middle;
  position: relative;
  top: -1px;
}

.feasibility-row.active   .feasibility-dot { background: #b4965a; }
.feasibility-row.inactive .feasibility-dot { background: transparent; border: 1px solid #c8bfb0; }

.feasibility-text {
  font-size: 8.5pt;
  letter-spacing: 0.06em;
  vertical-align: middle;
}

.feasibility-row.active   .feasibility-text { font-weight: bold; }
.feasibility-row.inactive .feasibility-text { font-weight: normal; }

/* ── Risk indicator cards ── */
.risk-grid {
  display: block;
  overflow: hidden;
  margin-bottom: 4mm;
  clear: both;
}

.risk-card {
  float: left;
  width: 58mm;
  margin-right: 3mm;
  border-radius: 2px;
  overflow: hidden;
  break-inside: avoid;
  page-break-inside: avoid;
}

.risk-card:last-child { margin-right: 0; }

.risk-card-accent { height: 3px; display: block; }

.risk-card-body { padding: 3mm 3.5mm; }

.risk-card-aspect {
  font-size: 6.5pt;
  font-weight: bold;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.risk-badge {
  display: inline-block;
  padding: 1mm 3mm;
  border-radius: 2px;
  font-size: 7pt;
  font-weight: bold;
  color: #ffffff;
  letter-spacing: 0.06em;
  margin-bottom: 2mm;
}

.risk-note { font-size: 7pt; line-height: 1.45; display: block; }

.risk-high .risk-card-accent  { background: #8b2500; }
.risk-high .risk-card-body    { background: #fff3f0; }
.risk-high .risk-card-aspect  { color: #8b2500; }
.risk-high .risk-badge        { background: #8b2500; }
.risk-high .risk-note         { color: #6b3028; }

.risk-moderate .risk-card-accent { background: #8a6800; }
.risk-moderate .risk-card-body   { background: #fffbee; }
.risk-moderate .risk-card-aspect { color: #8a6800; }
.risk-moderate .risk-badge       { background: #8a6800; }
.risk-moderate .risk-note        { color: #6b5420; }

.risk-low .risk-card-accent  { background: #2e7d52; }
.risk-low .risk-card-body    { background: #f2faf5; }
.risk-low .risk-card-aspect  { color: #2e7d52; }
.risk-low .risk-badge        { background: #2e7d52; }
.risk-low .risk-note         { color: #245c3c; }

/* ── Score table ── */
.score-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
  margin-bottom: 4mm;
}

.score-table th {
  background: #17263c;
  color: #b4965a;
  font-size: 7pt;
  font-weight: bold;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 2.5mm 4mm;
  text-align: left;
}

.score-table td {
  padding: 2.5mm 4mm;
  border-bottom: 0.5px solid #ddd6c8;
  vertical-align: top;
}

.score-table tr:nth-child(odd) td  { background: #f5f3ee; }
.score-table tr:nth-child(even) td { background: #ffffff; }
.score-table tr:last-child td      { border-bottom: 1.5px solid #b4965a; }

.score-pill {
  display: inline-block;
  padding: 0.5mm 3mm;
  border-radius: 2px;
  font-size: 7.5pt;
  font-weight: bold;
  color: #ffffff;
}

.score-pill.high     { background: #8b2500; }
.score-pill.moderate { background: #8a6800; }
.score-pill.low      { background: #2e7d52; }
.score-pill.na       { background: #7a8a9a; }

/* ── Considerations ── */
.consideration {
  break-inside: avoid;
  page-break-inside: avoid;
  margin-bottom: 4mm;
  padding-bottom: 4mm;
  border-bottom: 0.5px solid #ddd6c8;
  display: block;
}

.consideration:last-child { border-bottom: none; margin-bottom: 0; }

.consideration-number {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.1em;
  font-weight: bold;
  display: block;
  margin-bottom: 0.5mm;
}

.consideration-title {
  font-size: 10pt;
  font-weight: bold;
  color: #17263c;
  display: block;
  margin-bottom: 1.5mm;
}

.consideration-body {
  font-size: 9pt;
  color: #2c2c2c;
  line-height: 1.6;
  text-align: justify;
  display: block;
}

/* ── Recommendation box ── */
.recommendation-box {
  background: #f5f3ee;
  border-left: 3px solid #b4965a;
  padding: 5mm 6mm;
  display: block;
  margin-bottom: 4mm;
  break-inside: avoid;
  page-break-inside: avoid;
}

.recommendation-text {
  font-size: 9.5pt;
  color: #2c2c2c;
  line-height: 1.65;
  text-align: justify;
  display: block;
}

/* ── Disclaimer ── */
.disclaimer-box {
  background: #f5f3ee;
  border: 0.5px solid #ddd6c8;
  padding: 4mm 5mm;
  display: block;
}

.disclaimer-text {
  font-size: 7.5pt;
  color: #7a8070;
  line-height: 1.55;
  font-style: italic;
  text-align: justify;
  display: block;
}

/* ── Signature block ── */
.sig-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 5mm;
}

.sig-table td {
  width: 33.33%;
  padding: 2.5mm 4mm;
  border: 0.5px solid #ddd6c8;
}

.sig-table .sig-header td {
  background: #f5f3ee;
  font-size: 6.5pt;
  color: #9a9088;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border-bottom: 1px solid #b4965a;
}

.sig-table .sig-values td {
  background: #ffffff;
  font-size: 8.5pt;
  font-weight: bold;
  color: #17263c;
}

.sig-table .sig-values .gold-text { color: #b4965a; }

/* ── Utility ── */
.clearfix::after { content: ''; display: table; clear: both; }
.gold-text  { color: #b4965a; }
.navy-text  { color: #17263c; }
.muted-text { color: #9a9088; }

</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════════════
     PAGE 1 — COVER
═══════════════════════════════════════════════════════ -->
<div class="page cover">

  <div class="cover-inner">
    <div class="cover-header">
      <span class="cover-brand">FairVia™</span>
      <span class="cover-service">Technical Advisory Services &nbsp;|&nbsp; Il Nautico Co., Ltd.</span>
    </div>
    <div class="cover-gold-rule"></div>

    <div class="cover-main">
      <span class="cover-report-type">Material Feasibility Screening Report</span>
      <span class="cover-title">Material &amp; Processing<br>Feasibility Screening</span>
      <span class="cover-subtitle">Material Transition Decision Brief</span>
      <span class="cover-divider"></span>

      <div class="cover-client-box">
        <span class="cover-client-label">Prepared for</span>
        <span class="cover-client-name">{{client_name}}</span>
        <span class="cover-client-detail"><strong>Company:</strong> {{client_company}}</span>
        <span class="cover-client-detail"><strong>Country:</strong> {{client_country}}</span>
      </div>

      <div class="cover-meta-grid">
        <div class="cover-meta-row">
          <span class="cover-meta-label">Report No.</span>
          <span class="cover-meta-value">{{report_id}}</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Date Issued</span>
          <span class="cover-meta-value">{{report_date}}</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Document Type</span>
          <span class="cover-meta-value">Preliminary Screening — Strategic Advisory</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Classification</span>
          <span class="cover-meta-value">Strictly Confidential</span>
        </div>
      </div>
    </div>

    <div class="cover-badge-area">
      <span class="cover-badge-label">Overall Feasibility Assessment</span>
      <span class="cover-badge {{feasibility_class}}">&#11044;&nbsp; {{feasibility_level}}</span>
    </div>
  </div><!-- /cover-inner -->

  <div class="cover-footer">
    <span class="cover-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory</span>
    <span class="cover-footer-right">Page 1</span>
  </div>

</div>

<!-- ═══════════════════════════════════════════════════════
     PAGE 2 — CLIENT INFORMATION + EXECUTIVE SUMMARY
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 1</span>
        <span class="section-title">Client Information &amp; Application Overview</span>
        <div class="section-rule-full"></div>
        <table class="info-table">
          <tr><td>Application</td>          <td>{{application}}</td></tr>
          <tr><td>Current Material</td>     <td>{{current_material}}</td></tr>
          <tr><td>Processing Method</td>    <td>{{processing_method}}</td></tr>
          <tr><td>Target Material</td>      <td>{{bio_material}}</td></tr>
          <tr><td>Processing Equipment</td> <td>{{equipment}}</td></tr>
          <tr><td>Production Scale</td>     <td>{{production_scale}}</td></tr>
          <tr><td>Project Objective</td>    <td>{{project_stage}}</td></tr>
          <tr><td>Submission Reference</td> <td>{{submission_reference}}</td></tr>
        </table>
      </div>

      <div class="section">
        <span class="section-label">Section 2</span>
        <span class="section-title">Executive Summary</span>
        <div class="section-rule-full"></div>
        <div class="summary-block">
          <span class="summary-heading">Overview</span>
          <p class="body-text">{{executive_summary_overview}}</p>
        </div>
        <div class="summary-block">
          <span class="summary-heading">Key Findings</span>
          <p class="body-text">{{executive_summary_findings}}</p>
        </div>
        <div class="summary-block">
          <span class="summary-heading">Assessment Conclusion</span>
          <p class="body-text">{{executive_summary_conclusion}}</p>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 3</span>
        <span class="section-title">Feasibility Level</span>
        <div class="section-rule-full"></div>
        <div class="feasibility-scale">
          <span class="feasibility-scale-label">Feasibility Level</span>
          <div class="feasibility-row inactive">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">LOW</span>
          </div>
          <div class="feasibility-row active">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">{{feasibility_level}}</span>
          </div>
          <div class="feasibility-row inactive">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">HIGH</span>
          </div>
        </div>
        <p class="body-text">{{feasibility_explanation}}</p>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 2</span>
    </div>
  </div>

</div>

<!-- ═══════════════════════════════════════════════════════
     PAGE 3 — RISK INDICATOR + SCORE TABLE
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Technical Risk Indicator</span>
        <span class="section-title">Risk Profile Summary</span>
        <div class="section-rule-full"></div>
        <div class="risk-grid clearfix">
          <div class="risk-card {{thermal_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Thermal Stability</span>
              <span class="risk-badge">{{thermal_risk}}</span>
              <span class="risk-note">{{thermal_note}}</span>
            </div>
          </div>
          <div class="risk-card {{processing_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Processing Behaviour</span>
              <span class="risk-badge">{{processing_risk}}</span>
              <span class="risk-note">{{processing_note}}</span>
            </div>
          </div>
          <div class="risk-card {{equipment_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Equipment Compatibility</span>
              <span class="risk-badge">{{equipment_risk}}</span>
              <span class="risk-note">{{equipment_note}}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 4</span>
        <span class="section-title">Risk Band &amp; Score Summary</span>
        <div class="section-rule-full"></div>
        <table class="score-table">
          <thead>
            <tr>
              <th>Evaluation Area</th>
              <th>Assessment</th>
              <th>Risk Level</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Thermal Stability</td>
              <td>{{score_thermal_assessment}}</td>
              <td><span class="score-pill {{score_thermal_class}}">{{score_thermal_level}}</span></td>
              <td>{{score_thermal_note}}</td>
            </tr>
            <tr>
              <td>Processing Behaviour</td>
              <td>{{score_processing_assessment}}</td>
              <td><span class="score-pill {{score_processing_class}}">{{score_processing_level}}</span></td>
              <td>{{score_processing_note}}</td>
            </tr>
            <tr>
              <td>Equipment Compatibility</td>
              <td>{{score_equipment_assessment}}</td>
              <td><span class="score-pill {{score_equipment_class}}">{{score_equipment_level}}</span></td>
              <td>{{score_equipment_note}}</td>
            </tr>
            <tr>
              <td>Material Certification</td>
              <td>{{score_cert_assessment}}</td>
              <td><span class="score-pill {{score_cert_class}}">{{score_cert_level}}</span></td>
              <td>{{score_cert_note}}</td>
            </tr>
            <tr>
              <td>End-of-Life Compliance</td>
              <td>{{score_eol_assessment}}</td>
              <td><span class="score-pill {{score_eol_class}}">{{score_eol_level}}</span></td>
              <td>{{score_eol_note}}</td>
            </tr>
          </tbody>
        </table>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 3</span>
    </div>
  </div>

</div>

<!-- ═══════════════════════════════════════════════════════
     PAGE 4 — TECHNICAL OBSERVATIONS + POTENTIAL RISKS
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 5</span>
        <span class="section-title">Key Technical Observations</span>
        <div class="section-rule-full"></div>
        <div class="consideration">
          <span class="consideration-number">01</span>
          <span class="consideration-title">{{obs_1_title}}</span>
          <span class="consideration-body">{{obs_1_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">02</span>
          <span class="consideration-title">{{obs_2_title}}</span>
          <span class="consideration-body">{{obs_2_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">03</span>
          <span class="consideration-title">{{obs_3_title}}</span>
          <span class="consideration-body">{{obs_3_body}}</span>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 6</span>
        <span class="section-title">Potential Risks</span>
        <div class="section-rule-full"></div>
        <div class="consideration">
          <span class="consideration-number">Risk 01</span>
          <span class="consideration-title">{{risk_1_title}}</span>
          <span class="consideration-body">{{risk_1_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">Risk 02</span>
          <span class="consideration-title">{{risk_2_title}}</span>
          <span class="consideration-body">{{risk_2_body}}</span>
        </div>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 4</span>
    </div>
  </div>

</div>

<!-- ═══════════════════════════════════════════════════════
     PAGE 5 — RECOMMENDATION + DISCLAIMER
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 7</span>
        <span class="section-title">Suggested Next Step</span>
        <div class="section-rule-full"></div>
        <div class="recommendation-box">
          <p class="recommendation-text">{{strategic_recommendation}}</p>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 8</span>
        <span class="section-title">Professional Disclaimer</span>
        <div class="section-rule-full"></div>
        <div class="disclaimer-box">
          <p class="disclaimer-text">{{disclaimer}}</p>
        </div>
      </div>

      <table class="sig-table">
        <tr class="sig-header">
          <td>Prepared by</td>
          <td>Report Status</td>
          <td>Date Issued</td>
        </tr>
        <tr class="sig-values">
          <td>FairVia™ Technical Advisory</td>
          <td class="gold-text">Preliminary — For Client Review</td>
          <td>{{report_date}}</td>
        </tr>
      </table>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 5</span>
    </div>
  </div>

</div>

</body>
</html>
`;

// =========================
// メイン
// =========================
app.post("/generate-report", async (req, res) => {
  console.log("🔥 REQUEST HIT");

  try {
    const fields = Array.isArray(req.body)
      ? req.body
      : req.body?.fields || req.body?.data?.fields || [];

    const email =
      fields.find((f) => f.type === "INPUT_EMAIL")?.value ||
      req.body?.email ||
      "";

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");

    const clientName = getValue(fields, "client name");
    const company = getValue(fields, "company name");
    const country = getValue(fields, "country");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const submissionReference = "Auto-generated";

    const text = [
      processing,
      currentMaterial,
      bioMaterial,
      projectStage
    ].join(" ").toLowerCase();

    // =========================
    // 判定（確定ロジック）
    // =========================
    const isInjection = text.includes("injection");
    const isPP = text.includes("pp");
    const isBio = text.includes("pla") || text.includes("bio");

    let finalFeasibility = "MODERATE";

    if (isInjection && isPP && isBio) {
      finalFeasibility = "LOW";
    }

    console.log("RESULT:", finalFeasibility);

    // =========================
    // Riskロジック
    // =========================
    const isLow = finalFeasibility === "LOW";

    const thermalRisk = isLow ? "HIGH RISK" : "MODERATE";
    const thermalNote = isLow
      ? "Thermal behaviour requires careful validation under controlled conditions prior to implementation."
      : "Thermal behaviour should be validated under controlled conditions prior to implementation.";

    const processingRisk = isLow ? "HIGH RISK" : "MODERATE";
    const processingNote = isLow
      ? "Processing stability risk is elevated under the proposed transition scenario and should be carefully validated."
      : "Processing stability remains subject to confirmation through pilot evaluation.";

    const equipmentRisk = isLow ? "HIGH RISK" : "MODERATE";
    const equipmentNote = isLow
      ? "Existing equipment may require adjustment before stable conversion can be reliably achieved."
      : "Equipment suitability should be confirmed prior to any production commitment.";

    // =========================
    // Score
    // =========================
    const scoreThermalAssessment = isLow
      ? "Critical review required"
      : "Conditional review required";
    const scoreThermalLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreThermalNote = isLow
      ? "Thermal mismatch may materially affect process stability."
      : "Thermal response remains dependent on confirmed process conditions.";

    const scoreProcessingAssessment = isLow
      ? "High transition sensitivity"
      : "Moderate transition sensitivity";
    const scoreProcessingLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreProcessingNote = isLow
      ? "Process consistency may deteriorate under current assumptions."
      : "Process consistency remains to be confirmed in controlled validation.";

    const scoreEquipmentAssessment = isLow
      ? "Compatibility gap likely"
      : "Compatibility to be confirmed";
    const scoreEquipmentLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreEquipmentNote = isLow
      ? "Equipment readiness may be insufficient without adjustment."
      : "Equipment capability should be reviewed before scale-up.";

    const html = injectHtml(htmlTemplate, {
      client_name: clientName || "",
      client_company: company || "",
      client_country: country || "",

      application: processing || "",
      current_material: currentMaterial || "",
      processing_method: processing || "",
      bio_material: bioMaterial || "",
      equipment: equipment || "",
      production_scale: productionScale || "",
      project_stage: projectStage || "",
      submission_reference: submissionReference,

      feasibility_level: finalFeasibility,
      FEASIBILITY_LEVEL: finalFeasibility,
　　　　score_cert_assessment: "To be confirmed",
　　　　score_cert_level: "MODERATE",
　　　　score_cert_note: "Material certification status should be verified prior to implementation.",

score_eol_assessment: "To be confirmed",
score_eol_level: "MODERATE",
score_eol_note: "End-of-life compliance should be evaluated based on regional regulatory requirements.",
      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now(),

      executive_summary_overview: SUMMARY_OVERVIEW,
      executive_summary_findings: SUMMARY_FINDINGS,
      executive_summary_conclusion: SUMMARY_CONCLUSION,

      feasibility_explanation: FEASIBILITY_EXPLANATION,

      thermal_risk: thermalRisk,
      thermal_note: thermalNote,
      processing_risk: processingRisk,
      processing_note: processingNote,
      equipment_risk: equipmentRisk,
      equipment_note: equipmentNote,

      score_thermal_assessment: scoreThermalAssessment,
      score_thermal_level: scoreThermalLevel,
      score_thermal_note: scoreThermalNote,

      score_processing_assessment: scoreProcessingAssessment,
      score_processing_level: scoreProcessingLevel,
      score_processing_note: scoreProcessingNote,

      score_equipment_assessment: scoreEquipmentAssessment,
      score_equipment_level: scoreEquipmentLevel,
      score_equipment_note: scoreEquipmentNote,

      obs_1_title: OBS_1_TITLE,
      obs_1_body: OBS_1_BODY,
      obs_2_title: OBS_2_TITLE,
      obs_2_body: OBS_2_BODY,
      obs_3_title: OBS_3_TITLE,
      obs_3_body: OBS_3_BODY,

      risk_1_title: RISK_1_TITLE,
      risk_1_body: RISK_1_BODY,
      risk_2_title: RISK_2_TITLE,
      risk_2_body: RISK_2_BODY,

      strategic_recommendation: STRATEGIC_RECOMMENDATION,
      disclaimer: DISCLAIMER
    });

    const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu"
  ]
});
    
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
  format: "A4",
  printBackground: true
});

fs.writeFileSync("/tmp/latest.pdf", pdf);

await browser.close();

    if (!email) {
      console.log("⚠️ NO EMAIL");
      return res.json({ success: false });
    }

    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
     html: `<p>Your report result: <b>${finalFeasibility}</b></p>`,
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64"),
          encoding: "base64"
        }
      ]
    });

    console.log("✅ MAIL SENT");

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/generate-tier2", async (req, res) => {
  try {
    console.log("🔥 TIER2 REQUEST HIT");

    const fields =req.body.answers
    ? mapTallyToFields(req.body.answers)
    : req.body.data?.fields || [];

    const application = getValue(fields, "application");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");
    const processing = getValue(fields, "processing");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const technicalConcern = getValue(fields, "concern");

    const claudeReport = await generateClaudeHypothesis({
      application,
      material: currentMaterial,
      bioMaterial,
      processing,
      equipment,
      scale: productionScale,
      stage: projectStage,
      concern: technicalConcern
    });

    console.log("✅ CLAUDE GENERATED");

    res.json({
      success: true,
      report: claudeReport
    });

  } catch (err) {
    console.error("❌ TIER2 ERROR:", err);
    res.status(500).json({ error: "Tier2 generation failed" });
  }
});
app.get("/generate-pdf", async (req, res) => {
  try {
    res.send("PDF route working");
  } catch (err) {
    res.status(500).send("error");
  }
});
