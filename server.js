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

// 起動時チェック — Claude API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY not set — Claude narrative disabled, fallback mode active");
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
    setTimeout(() => reject(new Error(`Global PDF timeout after ${ms}ms`)), ms)
  );

// ══════════════════════════════════════════════════════════════
// BROWSER SINGLETON  — reuse across requests; restart on crash
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
  _browser.on("disconnected", () => { _browser = null; }); // クラッシュ時にリセット
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
    if (!match) throw new Error("No JSON found");
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
      throw new Error(`Invalid narrative structure — missing key: ${k}`);
    }
  }
  return obj;
}

// ══════════════════════════════════════════════════════════════
// § 2  INPUT NORMALIZATION  (no recursion, no self-call)
// ══════════════════════════════════════════════════════════════

function normalizeInput(raw) {
  if (!raw) return {};

  // Label-based extraction for Make.com / webhook payloads
  if (raw.data && Array.isArray(raw.data.fields)) {
    const parsed = {};
    raw.data.fields.forEach((f) => {
      const label = (f.label || "").toLowerCase();
      const value = Array.isArray(f.value) ? f.value.join(", ") : (f.value || "");
      if (label.includes("application")) parsed.application = value;
      if (label.includes("material") && !label.includes("bio") && !label.includes("target"))
        parsed.material = value;
      if (label.includes("bio") || label.includes("target"))
        parsed.bio_material = value;
      if (label.includes("processing")) parsed.processing = value;
      if (label.includes("equipment"))  parsed.equipment   = value;
      if (label.includes("scale"))      parsed.scale        = value;
      if (label.includes("stage"))      parsed.project_stage = value;
      if (label.includes("issue"))      parsed.issues       = value;
      if (label.includes("concern"))    parsed.concern      = value;
      if (label.includes("note"))       parsed.notes        = value;
    });
    return parsed;
  }

  // Direct JSON body (from Claude artifact / API test)
  return raw;
}

// ══════════════════════════════════════════════════════════════
// § 3  SCORING ENGINE
// ══════════════════════════════════════════════════════════════

function calculateScores(input) {
  let thermal   = 85;
  let flow       = 85;
  let mechanical = 85;

  const mat = (input.material    || "").toUpperCase();
  const bio = (input.bio_material || "").toUpperCase();
  const app = (input.application  || "").toUpperCase();

  // Material adjustments
  if ((mat.includes("CPP") || mat.includes("PP")) && !mat.includes("PET")) thermal -= 10;
  if (mat.includes("PE") && !mat.includes("PET")) thermal -= 5;
  if (mat.includes("PET")) thermal -= 25;

  // Biomaterial adjustments
  if (bio.includes("PLA")) thermal -= 10;
  if (bio.includes("PHA") || bio.includes("PHB")) flow -= 10;

  // Application adjustments
  const appTokens   = app.split(/\W+/);
  const isFilm =
    app.includes("FILM") ||
    appTokens.includes("FILM");

  const isInjection =
    app.includes("INJECT") ||
    app.includes("MOLD")   ||
    app.includes("MOULD")  ||
    appTokens.includes("IM");

  if (isFilm)      flow       -= 15;
  if (isInjection) mechanical -= 10;

  thermal   = clamp(thermal);
  flow       = clamp(flow);
  mechanical = clamp(mechanical);

  const bottleneck = Math.min(thermal, flow, mechanical);
  const avg        = (thermal + flow + mechanical) / 3;
  const total      = Math.round(bottleneck * 0.7 + avg * 0.3);

  return { thermal, flow, mechanical, total, tokens: appTokens };
}

// ══════════════════════════════════════════════════════════════
// § 4  CONSTRAINT LOGIC  — tie-breaking: Flow > Thermal > Mechanical
// ══════════════════════════════════════════════════════════════

function getConstraint(scores) {
  const min = Math.min(scores.thermal, scores.flow, scores.mechanical);

  if (scores.flow === min) {
    return {
      type:    "FLOW",
      score:   scores.flow,
      factor:  "flow consistency during extended production runs",
      impact:  "production consistency, yield rate, and operational efficiency",
      control: "pressure stability, melt uniformity, and extrusion flow balance",
    };
  }

  if (scores.thermal === min) {
    return {
      type:    "THERMAL",
      score:   scores.thermal,
      factor:  "thermal stability under processing conditions",
      impact:  "material degradation risk and process reliability",
      control: "temperature control precision and thermal distribution",
    };
  }

  return {
    type:    "MECHANICAL",
    score:   scores.mechanical,
    factor:  "mechanical integrity under load conditions",
    impact:  "product strength and structural performance",
    control: "material strength consistency and structural reliability",
  };
}

// ══════════════════════════════════════════════════════════════
// § 5  DECISION ENGINE
// ══════════════════════════════════════════════════════════════

function determineDecision(total) {
  if (total >= 75) return { decision: "GO",            level: "HIGH"     };
  if (total >= 55) return { decision: "CONDITIONAL GO", level: "MODERATE" };
  return              { decision: "HOLD",           level: "LOW"      };
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
// § 7  EXECUTIVE SUMMARY  (9-branch: LOW / MODERATE×3 / HIGH×1)
//       LOW ×1, MODERATE×FLOW, MODERATE×THERMAL, MODERATE×MECHANICAL,
//       HIGH ×1  → 5 primary branches; nuance layered by scores inside each
// ══════════════════════════════════════════════════════════════

function generateExecutive(scores, decision, economic, constraint) {
  const { thermal, flow, mechanical, total } = scores;
  const scoreBlock = `Thermal (${thermal}) / Flow (${flow}) / Mechanical (${mechanical}) / Composite: ${total}`;

  // ── LOW ────────────────────────────────────────────────────
  if (decision.level === "LOW") {
    return (
      `This assessment indicates LOW feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is critically constrained by instability in ${constraint.factor} (score: ${constraint.score}/100). ` +
      `This constraint is expected to severely impact ${constraint.impact}, making stable production unsustainable under existing conditions. ` +
      `Observed instability levels indicate high risk of operational failure, excessive scrap generation, and unacceptable output variability.\n\n` +
      `Material cost variance is projected at ${economic}, reflecting the re-engineering requirements implied by the current configuration.\n\n` +
      `Deployment Decision: HOLD — Commercial-scale deployment is not recommended. ` +
      `A fundamental reassessment of material compatibility or processing architecture is required before further validation proceeds.`
    );
  }

  // ── MODERATE / FLOW ────────────────────────────────────────
  if (decision.level === "MODERATE" && constraint.type === "FLOW") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable but constrained by flow-related instability. ` +
      `Variability in ${constraint.factor} (score: ${constraint.score}/100) may impact ${constraint.impact}, ` +
      `particularly under extended production cycles and high line-speed conditions. ` +
      `Melt behaviour management represents the primary challenge for achieving stable commercial operation.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `A controlled pilot validation phase is recommended with specific focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── MODERATE / THERMAL ─────────────────────────────────────
  if (decision.level === "MODERATE" && constraint.type === "THERMAL") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable but thermally sensitive. ` +
      `Instability in ${constraint.factor} (score: ${constraint.score}/100) may influence ${constraint.impact}, ` +
      `particularly under elevated or variable processing temperatures. ` +
      `The target biodegradable material's narrow thermal window requires precision temperature control to prevent degradation onset during sustained production.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with emphasis on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── MODERATE / MECHANICAL ──────────────────────────────────
  if (decision.level === "MODERATE") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is viable but exhibits structural sensitivity under load conditions. ` +
      `Limitations in ${constraint.factor} (score: ${constraint.score}/100) may affect ${constraint.impact}, ` +
      `particularly in demanding application environments. ` +
      `Product performance consistency must be validated through controlled mechanical testing before commercial commitment.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── HIGH ───────────────────────────────────────────────────
  return (
    `This assessment indicates HIGH feasibility for the evaluated material transition within the current processing framework.\n\n` +
    `${scoreBlock}\n\n` +
    `The system demonstrates strong compatibility across all key processing parameters. ` +
    `Minor sensitivity to ${constraint.factor} (score: ${constraint.score}/100) may exist, ` +
    `but does not significantly impact ${constraint.impact} under standard operating conditions. ` +
    `Stable production is achievable with standard process controls and no fundamental redesign requirement.\n\n` +
    `Material cost variance is projected at ${economic}.\n\n` +
    `Deployment Decision: GO — Proceed to controlled pilot validation and gradual scale-up.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 8  RISK STRUCTURE  (Primary / Secondary / Mechanism)
// ══════════════════════════════════════════════════════════════

function generateRisk(scores, constraint, input) {
  const mat = safe(input.material,    "the source material");
  const bio = safe(input.bio_material, "the target biodegradable material");
  const app = safe(input.application,  "the current processing application");

  // ── Primary — constraint dimension only ────────────────────
  const primary = constraint.score < 55
    ? `Critical instability in ${constraint.factor} (${constraint.score}/100) is expected to cause production failure, ` +
      `excessive scrap generation, and uncontrolled output variability under continuous operating conditions. ` +
      `This risk alone is sufficient to prevent commercial deployment without fundamental process redesign.`
    : `Variability in ${constraint.factor} (${constraint.score}/100) is the primary operational risk for this transition. ` +
      `This directly affects ${constraint.impact} and must be managed through rigorous control of ${constraint.control}. ` +
      `Risk exposure increases proportionally under extended production cycles and elevated throughput conditions.`;

  // ── Secondary — interaction between the TWO non-constraint dimensions ──
  let dimA, scoreA, dimB, scoreB;
  if (constraint.type === "FLOW") {
    dimA = "thermal";    scoreA = scores.thermal;
    dimB = "mechanical"; scoreB = scores.mechanical;
  } else if (constraint.type === "THERMAL") {
    dimA = "flow";       scoreA = scores.flow;
    dimB = "mechanical"; scoreB = scores.mechanical;
  } else {
    dimA = "thermal";    scoreA = scores.thermal;
    dimB = "flow";       scoreB = scores.flow;
  }

  const secondary =
    `${dimA.charAt(0).toUpperCase() + dimA.slice(1)} variability (${scoreA}/100) interacts with ` +
    `${dimB} performance (${scoreB}/100), amplifying instability in process consistency under continuous ` +
    `production conditions. If ${dimA} parameters drift outside the validated tolerance window, ` +
    `${dimB} behaviour is expected to degrade in tandem — compounding output variability beyond ` +
    `what the primary constraint alone predicts.`;

  // ── Mechanism — physicochemical origin ─────────────────────
  const mechanism =
    `${mat} exhibits broader thermal and rheological tolerance under standard processing conditions, ` +
    `while ${bio} introduces a narrower operating window driven by crystallisation kinetics and degradation ` +
    `onset sensitivity. Under ${app} conditions, this property mismatch generates instability in ` +
    `${constraint.factor}, causing ${constraint.impact} to fall outside commercially acceptable ranges.`;

  return { primary, secondary, mechanism };
}

// ══════════════════════════════════════════════════════════════
// § 9  PROCESSING SECTION  (correct score dependencies enforced)
// ══════════════════════════════════════════════════════════════

function generateProcessing(scores, constraint) {
  // Processing window — constraint score dependent
  let processingWindow;
  if (constraint.score < 55) {
    processingWindow =
      `Processing window is critically narrow and unstable. The ${constraint.type} constraint ` +
      `(${constraint.score}/100) limits usable parameters to conditions incompatible with continuous ` +
      `commercial production. Significant control intervention and likely equipment modification are required.`;
  } else if (constraint.score < 75) {
    processingWindow =
      `Processing window is operable but restricted by ${constraint.factor} (${constraint.score}/100). ` +
      `Sustained production requires tightly validated parameters; deviations outside the established range ` +
      `will cause measurable output instability and increased scrap rates.`;
  } else {
    processingWindow =
      `Processing window is broad and compatible with standard operating parameters. ` +
      `${constraint.factor.charAt(0).toUpperCase() + constraint.factor.slice(1)} ` +
      `(${constraint.score}/100) does not impose critical restrictions under normal production conditions.`;
  }

  // Thermal behaviour — MUST use scores.thermal
  let thermalBehavior;
  if (scores.thermal >= 75) {
    thermalBehavior =
      `Stable — operating within safe thermal band with acceptable degradation margin (Thermal: ${scores.thermal}/100). ` +
      `Temperature control requirements are consistent with standard biodegradable polymer processing protocol.`;
  } else if (scores.thermal >= 55) {
    thermalBehavior =
      `Marginal — processing temperature is near the material's degradation threshold (Thermal: ${scores.thermal}/100). ` +
      `Active zone-by-zone temperature monitoring is required to prevent thermal degradation onset ` +
      `during extended production runs.`;
  } else {
    thermalBehavior =
      `Unstable — thermal window is incompatible with stable biodegradable processing (Thermal: ${scores.thermal}/100). ` +
      `Degradation risk under standard operating temperature is high; ` +
      `thermal profile redesign is required before pilot validation.`;
  }

  // Flow characteristics — MUST use scores.flow
  let flowCharacteristics;
  if (scores.flow >= 75) {
    flowCharacteristics =
      `Consistent — melt rheology within acceptable processing range (Flow: ${scores.flow}/100). ` +
      `Standard screw configuration and pressure settings are expected to maintain melt uniformity ` +
      `across production runs without active intervention.`;
  } else if (scores.flow >= 55) {
    flowCharacteristics =
      `Variable — melt flow requires active stabilisation (Flow: ${scores.flow}/100). ` +
      `Pressure fluctuation risk during extended extrusion cycles necessitates real-time monitoring, ` +
      `screw speed adjustment, and reduced throughput during the validation phase.`;
  } else {
    flowCharacteristics =
      `Unstable — melt behaviour is incompatible with continuous production (Flow: ${scores.flow}/100). ` +
      `Significant flow instability is expected, resulting in unacceptable gauge variation, ` +
      `potential line shutdowns, and high off-specification output rates.`;
  }

  return { processingWindow, thermalBehavior, flowCharacteristics };
}

// ══════════════════════════════════════════════════════════════
// § 10  PRODUCT SECTION
// ══════════════════════════════════════════════════════════════

function generateProduct(scores) {
  // Mechanical behaviour — scores.mechanical
  const mechanical = scores.mechanical >= 75
    ? `Structural integrity of the final product is achievable under standard processing conditions (${scores.mechanical}/100). ` +
      `Mechanical performance meets commercial specification without formulation adjustment.`
    : scores.mechanical >= 55
    ? `Mechanical performance is adequate but sensitive to process consistency (${scores.mechanical}/100). ` +
      `Property variation between production batches is expected without active control measures.`
    : `Mechanical performance is below commercial threshold (${scores.mechanical}/100). ` +
      `Structural integrity risk is high; product specification compliance cannot be guaranteed ` +
      `without material reformulation or process redesign.`;

  // Surface quality — scores.flow
  const surface = scores.flow >= 75
    ? `Surface finish is expected to meet specification. Consistent melt flow (${scores.flow}/100) ` +
      `supports uniform surface formation under standard die and cooling conditions.`
    : scores.flow >= 55
    ? `Surface quality is conditionally acceptable. Flow variability (${scores.flow}/100) may introduce ` +
      `surface inconsistencies, particularly during die start-up and extended high-speed runs.`
    : `Surface quality is unreliable under current parameters (${scores.flow}/100). Melt instability ` +
      `is expected to generate streaking, pitting, and uneven gloss at commercial production speeds.`;

  // Structural consistency — scores.total
  const structural = scores.total >= 75
    ? `Structural consistency is achievable within the defined processing envelope. Dimensional stability ` +
      `and wall thickness uniformity are expected to meet pilot validation targets.`
    : scores.total >= 55
    ? `Structural consistency is conditional on parameter control (Total: ${scores.total}/100). ` +
      `Dimensional variation is expected at the margins of the processing window; ` +
      `tooling and cooling adjustments may be required.`
    : `Structural consistency is not achievable under current conditions (Total: ${scores.total}/100). ` +
      `Dimensional variance and structural failure risk exceed commercial tolerance without process redesign.`;

  return { mechanical, surface, structural };
}

// ══════════════════════════════════════════════════════════════
// § 11  QUALITY SECTION
// ══════════════════════════════════════════════════════════════

function generateQuality(scores) {
  const minScore = Math.min(scores.thermal, scores.flow, scores.mechanical);

  // Stability — bottleneck (min) score
  const stability     = minScore >= 75 ? "High" : minScore >= 55 ? "Moderate" : "Low";
  const stabilityNote = minScore >= 75
    ? `Process stability index: ${minScore}/100. Acceptable for commercial deployment under standard QC protocol.`
    : minScore >= 55
    ? `Process stability index: ${minScore}/100. Conditional acceptance — enhanced in-line monitoring and SPC required.`
    : `Process stability index: ${minScore}/100. Below commercial threshold. Redesign required before deployment.`;

  // Consistency — Flow score
  const consistency     = scores.flow >= 75 ? "High" : scores.flow >= 55 ? "Moderate" : "Low";
  const consistencyNote = scores.flow >= 75
    ? `Flow consistency index: ${scores.flow}/100. Production consistency achievable within standard parameter tolerance.`
    : scores.flow >= 55
    ? `Flow consistency index: ${scores.flow}/100. Closed-loop pressure control recommended to limit batch-to-batch variability.`
    : `Flow consistency index: ${scores.flow}/100. High variability expected. Output consistency cannot be assured without flow stabilisation.`;

  return { stability, stabilityNote, consistency, consistencyNote };
}

// ══════════════════════════════════════════════════════════════
// § 12  EXPECTED DEVIATIONS  (Film / Injection / Low / Default)
//        Returns HTML <li> string for direct injection into <ul>
// ══════════════════════════════════════════════════════════════

function generateExpectedDeviations(input, scores) {
  const app = (input.application || "").toUpperCase();
  let items;

  const tokens      = scores.tokens || app.split(/\W+/);

  const isFilm =
    app.includes("FILM") ||
    tokens.includes("FILM");

  const isInjection =
    app.includes("INJECT") ||
    app.includes("MOLD")   ||
    app.includes("MOULD")  ||
    tokens.includes("IM");

  if (isFilm && isInjection) {
    items = [
      `Combined process instability affecting both film formation and injection precision simultaneously`,
      `Cross-process variability leading to inconsistent material behaviour across dual-mode production runs`,
      `Dual-mode processing risk requiring separate, independent validation protocols for each conversion method`,
    ];
  } else if (isFilm) {
    const gaugeRange = scores.flow < 65 ? "15–25" : "8–12";
    items = [
      `Film gauge variation ±${gaugeRange}% across web width under steady-state production conditions`,
      `Longitudinal thickness inconsistency correlated with melt pressure fluctuation during extended extrusion runs`,
      `Flow instability events during die heating and cooling transitions producing off-specification material zones`,
    ];
  } else if (isInjection) {
    const dimRange = scores.mechanical < 65 ? "0.3–0.8" : "0.1–0.3";
    items = [
      `Dimensional variation ±${dimRange}mm on critical part features under process parameter fluctuation`,
      `Warpage and sink marks on thick-wall sections due to differential cooling rate distribution across the mould`,
      `Surface gloss inconsistency and sink mark formation correlated with gate seal timing variation`,
    ];
  } else if (scores.total < 55) {
    items = [
      `Critical instability across all processing dimensions — output quality cannot be controlled under current parameters`,
      `High variability in product dimensions, surface finish, and mechanical properties expected across production batches`,
      `Material degradation events anticipated during standard operating conditions; off-specification output rate will be significant`,
    ];
  } else {
    items = [
      `Moderate process variability expected during initial production runs and parameter optimisation phase`,
      `Potential output inconsistency at the boundary of the validated processing window under fluctuating ambient conditions`,
      `Further deviation characterisation required under real-scale production environment before commercial acceptance`,
    ];
  }

  return items.map((item) => `<li>${item}</li>`).join("\n");
}

// ══════════════════════════════════════════════════════════════
// § 12b  PRIMARY RISK TITLE  (constraint-aware)
// ══════════════════════════════════════════════════════════════

function getPrimaryRiskTitle(constraint) {
  if (constraint.type === "THERMAL")   return "Thermal Instability";
  if (constraint.type === "FLOW")      return "Process Variability";
  return "Mechanical Limitation";
}

// ══════════════════════════════════════════════════════════════
// § 13  APPLICATION IMPLICATION
// ══════════════════════════════════════════════════════════════

function generateApplicationImplication(decision, input) {
  const app = safe(input.application, "this application");
  if (decision.level === "HIGH") {
    return (
      `${app} is viable for commercial deployment. The material transition is technically feasible ` +
      `within the current processing framework. Standard monitoring protocols apply during initial production ramp-up.`
    );
  }
  if (decision.level === "MODERATE") {
    return (
      `${app} is viable subject to process optimisation. Pilot-scale validation is required before ` +
      `commercial commitment. Constraint control measures must be implemented and verified prior to full deployment.`
    );
  }
  return (
    `${app} is not recommended for commercial deployment at the current feasibility level. ` +
    `Material reformulation or application redesign is required before re-evaluation.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 14  NEXT STEPS  (decision + constraint aware)
// ══════════════════════════════════════════════════════════════

function generateNextStep(decision, constraint, scores) {
  if (decision.level === "HIGH") {
    return (
      `Based on the HIGH feasibility assessment (Total: ${scores.total}/100), the system is ready for controlled pilot deployment.\n\n` +
      `Initiate pilot production with monitoring focused on ${constraint.factor}. ` +
      `Validate yield stability and product consistency under continuous production conditions ` +
      `before committing to full commercial scale-up. ` +
      `Document validated process parameters as the baseline for ongoing quality control.`
    );
  }

  if (decision.level === "MODERATE") {
    return (
      `Based on the MODERATE feasibility assessment (Total: ${scores.total}/100), ` +
      `engineering validation targeting ${constraint.type.toLowerCase()} performance is required before pilot approval.\n\n` +
      `Implement control measures for ${constraint.control}. ` +
      `Execute structured parameter trials to characterise the usable processing window. ` +
      `Re-evaluate system stability after stabilisation controls are confirmed, ` +
      `then proceed to pilot validation with defined acceptance criteria.`
    );
  }

  return (
    `Based on the LOW feasibility assessment (Total: ${scores.total}/100), ` +
    `commercial transition under the current configuration is not recommended.\n\n` +
    `Suspend transition planning and evaluate alternative material grades or process architecture modifications. ` +
    `Address the critical constraint in ${constraint.factor} specifically. ` +
    `A revised evaluation should be submitted after design modifications are validated at laboratory scale.`
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
// § 16  DYNAMIC OVERLAY  (UNCHANGED from original spec)
//        Generates overlay elements only; base image handled by template
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

  const ampLeft  = getAmplitude(scores.thermal);
  const ampRight = getAmplitude(scores.flow);
return `
<!-- 左温度 -->
<div style="position:absolute;top:40px;left:140px;text-align:center;z-index:3;">
  <div style="font-size:28px;color:#2f3a44;">230°C</div>
  <div style="font-size:16px;color:#5b6770;">${scores.thermal}</div>
</div>

<!-- 右温度 -->
<div style="position:absolute;top:40px;right:140px;text-align:center;z-index:3;">
  <div style="font-size:28px;color:#d62c2c;">180°C</div>
  <div style="font-size:16px;color:#d62c2c;">${scores.flow}</div>
</div>

<!-- 青波（左） -->
<svg style="position:absolute;left:230px;bottom:65px;z-index:3;" width="140" height="40">
  <path d="M0 20 
           C40 ${20 - ampLeft}, 80 ${20 + ampLeft}, 120 20"
    fill="none"
    stroke="#4f7c8a"
    stroke-width="2"
    opacity="0.95"/>
</svg>

<!-- 赤波（右） -->
<svg style="position:absolute;left:350px;bottom:65px;z-index:3;" width="160" height="40">
  <path d="M0 20 
           C40 ${20 - ampRight}, 80 ${20 + ampRight}, 140 20"
    fill="none"
    stroke="#d62c2c"
    stroke-width="2"
    opacity="0.95"/>
</svg>

<!-- メーター -->
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
</svg>
`;}
// ══════════════════════════════════════════════════════════════
// § 16b  CLAUDE NARRATIVE API  — structured JSON text generation
//         Fills 7 narrative fields via Anthropic API.
//         Falls back to deterministic generators on any failure.
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
If ANY of these rules are violated, the system will break.

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
    .replace("{{application}}",  safe(input.application,    "Not specified"))
    .replace("{{material}}",     safe(input.material,       "Not specified"))
    .replace("{{bio_material}}", safe(input.bio_material,   "Not specified"))
    .replace("{{thermal}}",      String(scores.thermal))
    .replace("{{flow}}",         String(scores.flow))
    .replace("{{mechanical}}",   String(scores.mechanical))
    .replace("{{total}}",        String(scores.total))
    .replace("{{constraint}}",   constraint.type);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 8000);

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:       "claude-opus-4-5",
      max_tokens:  1024,
      temperature: 0,
      messages:    [{ role: "user", content: userContent }],
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const data = await res.json();

  const raw = Array.isArray(data.content)
    ? data.content.map(b => b.type === "text" ? b.text : "").join("").trim()
    : "";

  if (!raw) throw new Error("Empty Claude response");

  const parsed = safeParseJSON(raw);
  const result = validateNarrative(parsed);

  console.log("[Claude OK] narrative generated successfully");
  return result;
}

// ══════════════════════════════════════════════════════════════
// § 17  MAIN ROUTE
// ══════════════════════════════════════════════════════════════

app.post("/generate-report", (req, res) => {
  queue.add(() => handleReport(req, res)).catch(err => {
    console.error("[Queue error]", err.message);
  });
});

async function handleReport(req, res) {
  try {
    const input = normalizeInput(req.body);

    // --- Deterministic engine ---
    const scores     = calculateScores(input);
    const constraint = getConstraint(scores);
    const decision   = determineDecision(scores.total);
    const economic   = calculateEconomic(scores.total);

    // --- Text generators (deterministic baseline) ---
    const risk       = generateRisk(scores, constraint, input);
    const processing = generateProcessing(scores, constraint);
    const product    = generateProduct(scores);
    const quality    = generateQuality(scores);

    // --- Claude narrative API (AI-enhanced; falls back to deterministic on failure) ---
    let narrative = null;
    try {
      narrative = await callClaudeForNarrative(input, scores, constraint);
    } catch (e) {
      if (e.name === "AbortError") {
        console.warn("[Claude TIMEOUT]");
      } else {
        console.warn("[Claude ERROR]", e.message);
      }
    }

    const exec_summary        = narrative?.executive_summary        || generateExecutive(scores, decision, economic, constraint);
    const primary_risk_body   = narrative?.risk_primary             || risk.primary;
    const secondary_risk_body = narrative?.risk_secondary           || risk.secondary;
    const mechanism_body      = narrative?.mechanism                || risk.mechanism;
    const proc_window_note    = narrative?.processing_window_note   || processing.processingWindow;
    const app_implication     = narrative?.application_implication  || generateApplicationImplication(decision, input);
    const next_step_body      = narrative?.next_step                || generateNextStep(decision, constraint, scores);

    // --- Template data map ---
    const htmlData = {
      assessment_type:    "Technical Hypothesis",
      application:         safe(input.application),
      material_transition: safe(input.bio_material),
      report_date:         new Date().toISOString().split("T")[0],

      compatibility_level: decision.level,
      executive_summary:   exec_summary,
      key_risk:            primary_risk_body,

      processing_window:    proc_window_note,
      thermal_behavior:     processing.thermalBehavior,
      flow_characteristics: processing.flowCharacteristics,

      mechanical_behavior:     product.mechanical,
      surface_quality:          product.surface,
      structural_consistency:   product.structural,
      application_implication:  app_implication,

      primary_risk_title:   getPrimaryRiskTitle(constraint),
      primary_risk:          primary_risk_body,
      secondary_risk_title: "Dimensional Interaction Risk",
      secondary_risk:        secondary_risk_body,
      mechanism:             mechanism_body,

      stability:           quality.stability,
      stability_note:      quality.stabilityNote,
      consistency:         quality.consistency,
      consistency_note:    quality.consistencyNote,
      expected_deviations: generateExpectedDeviations(input, scores),

      pha_score: scores.total,

      base_image: "https://ilnautico.github.io/visual-base.png",
      dynamic_overlay:generateOverlay(scores),

      next_step:       next_step_body,
      decision:        decision.decision,
      economic_impact: economic,
    };

    const html = injectHtml(htmlTemplate, htmlData);

    // --- PDF generation wrapped in global timeout ---
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
      stack:   err.stack,
      input:   req.body,
    });
    res.status(500).json({ error: "PDF generation failed", detail: err.message });
  }
}

// --- PDF renderer — page lifecycle only (browser is reused) ---
async function renderPdf(html) {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  if (!page) throw new Error("Puppeteer page creation failed");

  let closed = false;

  const safeClose = async () => {
    if (!closed) {
      closed = true;
      await page.close().catch(() => {});
    }
  };

  page.on("error",     safeClose);
  page.on("pageerror", safeClose);

  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 })
      .catch(() => { throw new Error("HTML render timeout — networkidle0 not reached within 30s"); });

    await page.evaluate(async () => await document.fonts.ready);

    return await page.pdf({ format: "A4", printBackground: true });

  } finally {
    await safeClose();
  }
}

// ══════════════════════════════════════════════════════════════
// AUXILIARY ROUTES
// ══════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
let latestPdfBuffer = null;

app.get("/latest-pdf", (req, res) => {
  if (!latestPdfBuffer) {
    return res.status(404).send("No PDF generated yet");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.send(latestPdfBuffer);
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
