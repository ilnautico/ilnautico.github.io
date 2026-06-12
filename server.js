import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// IMPORTANT: Stripe webhook raw-body support is intentionally not included in this emergency restore.
// v0.1 production flow: Stripe payment confirmed manually -> admin creates access key -> customer receives URL.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ACCESS_KEY_SECRET = process.env.ACCESS_KEY_SECRET || "fairvia_access_credit_2026_private_secret_v1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "FairVia <info@ilnautico.com>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!hasSupabase) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — using temporary memory access mode");
}
if (!RESEND_API_KEY) {
  console.warn("⚠️ RESEND_API_KEY not set — email delivery disabled");
}
if (!ADMIN_TOKEN) {
  console.warn("⚠️ ADMIN_TOKEN not set — admin key creation API disabled");
}

// -----------------------------------------------------------------------------
// Template assets
// -----------------------------------------------------------------------------
const templatePath = path.join(__dirname, "template.html");
const htmlTemplate = fs.existsSync(templatePath)
  ? fs.readFileSync(templatePath, "utf8")
  : "";

const visualBasePath = path.join(__dirname, "visual-base.png");
const visualBaseDataUri = fs.existsSync(visualBasePath)
  ? `data:image/png;base64,${fs.readFileSync(visualBasePath).toString("base64")}`
  : "";

// -----------------------------------------------------------------------------
// Temporary fallback store for emergency use only
// -----------------------------------------------------------------------------
const memoryKeys = new Map();
[
  ["FVE-ILN-202606-EQ01", 1],
  ["FVE-ILN-202606-EQ02", 1],
  ["FVE-ILN-202606-EQ03", 1],
  ["FVE-ILN-202606-EQ04", 1],
  ["FVE-ILN-202606-EQ05", 1],
  ["FVE-ILN-202606-EQ06", 1],
  ["FVE-ILN-202606-EQ07", 1],
  ["FVE-ILN-202606-EQ08", 1],
  ["FVE-ILN-202606-EQ09", 1],
  ["FVE-ILN-202606-EQ10", 1],
  ["FVE-ILN-202606-FB01", 1],
  ["FVE-ILN-202606-FB02", 1],
  ["FVE-ILN-202606-FB03", 1],
].forEach(([key, maxUses]) => {
  memoryKeys.set(key, {
    key,
    organisation_name: "Temporary Demo",
    organisation_type: "single_company",
    plan_type: key.includes("FB") ? "feedback_bonus" : "introductory_pre_pilot_assessment",
    max_uses: maxUses,
    used_count: 0,
    status: "active",
  });
});

const latest = { pdf: null };
const reportStore = new Map();
const REPORT_TTL_MS = 1000 * 60 * 60 * 24;

function cleanupExpiredReports() {
  const now = Date.now();
  for (const [id, item] of reportStore.entries()) {
    if (!item?.createdAt || now - item.createdAt > REPORT_TTL_MS) {
      reportStore.delete(id);
    }
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function safe(value, fallback = "—") {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function clamp(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

function keyHash(plainKey) {
  return crypto
    .createHmac("sha256", ACCESS_KEY_SECRET)
    .update(String(plainKey || "").trim())
    .digest("hex");
}

function planMaxUses(planType) {
  if (planType === "customer_adoption_pack") return 3;
  if (planType === "partner_member_pilot") return 5;
  return 1;
}

function accessKeyPrefix(plainKey) {
  const key = String(plainKey || "").trim();
  if (!key) return "";
  const parts = key.split("-");
  if (parts.length >= 3) return `${parts[0]}-${parts[1]}-${parts[2]}`;
  return key.slice(0, 8);
}

function extractAccessKey(req) {
  const direct =
    req.query?.token ||
    req.query?.access_key ||
    req.body?.access_key ||
    req.body?.token ||
    req.headers?.["x-access-key"] ||
    req.headers?.["x-demo-token"];

  if (direct) return String(direct).trim();

  const referer = req.headers?.referer || req.headers?.referrer || "";
  if (referer) {
    try {
      const url = new URL(referer);
      return String(url.searchParams.get("token") || url.searchParams.get("access_key") || "").trim();
    } catch (_) {
      return "";
    }
  }

  return "";
}

function isInternalAutofillTest(req) {
  const referer = req.headers?.referer || req.headers?.referrer || "";
  try {
    const url = new URL(referer);
    return Boolean(url.searchParams.get("test"));
  } catch (_) {
    return false;
  }
}

async function supabaseRpc(functionName, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Supabase RPC ${functionName} failed: ${res.status} ${text}`);
  }

  return Array.isArray(data) ? data[0] : data;
}

async function supabaseInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }

  return Array.isArray(data) ? data[0] : data;
}

async function verifyAccessKey(plainKey) {
  if (!plainKey) {
    return { valid: false, status: "invalid", message: "Invalid access key." };
  }

  if (hasSupabase) {
    return supabaseRpc("verify_assessment_access_key", {
      p_access_key_hash: keyHash(plainKey),
    });
  }

  const rec = memoryKeys.get(plainKey);
  if (!rec) return { valid: false, status: "invalid", message: "Invalid access key." };
  if (rec.used_count >= rec.max_uses) {
    rec.status = "used_up";
    return { valid: false, ...rec, remaining_uses: 0, message: "This access key has reached its assessment limit." };
  }
  return {
    valid: true,
    ...rec,
    remaining_uses: Math.max(rec.max_uses - rec.used_count, 0),
    message: "Access confirmed.",
  };
}

async function consumeAccessKey(plainKey, req) {
  // Internal &test=1..5 URLs should not consume customer credits.
  if (isInternalAutofillTest(req)) {
    return { ok: true, skipped: true, message: "Internal test mode; credit not consumed." };
  }

  if (!plainKey) {
    return { ok: false, status: "invalid", message: "Invalid access key." };
  }

  if (hasSupabase) {
    return supabaseRpc("consume_assessment_credit", {
      p_access_key_hash: keyHash(plainKey),
    });
  }

  const rec = memoryKeys.get(plainKey);
  if (!rec) return { ok: false, status: "invalid", message: "Invalid access key." };
  if (rec.used_count >= rec.max_uses) {
    rec.status = "used_up";
    return { ok: false, ...rec, remaining_uses: 0, message: "This access key has reached its assessment limit." };
  }
  rec.used_count += 1;
  if (rec.used_count >= rec.max_uses) rec.status = "used_up";
  return {
    ok: true,
    ...rec,
    remaining_uses: Math.max(rec.max_uses - rec.used_count, 0),
    message: "Credit consumed successfully.",
  };
}

function normalizeInput(raw = {}) {
  const input = { ...raw };
  const get = (...keys) => {
    for (const k of keys) {
      const v = input[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };

  return {
    company_name: get("company_name", "company", "organisation_name", "organization_name"),
    contact_person: get("contact_person", "name", "contact_name"),
    email: get("email", "contact_email"),
    project_stage: get("project_stage", "stage"),
    product_type: get("product_type", "product"),
    application: get("application", "product_application") || get("product_type") || "Specified application",
    material: get("material", "current_material"),
    processing: get("processing", "processing_method", "process"),
    equipment: get("equipment", "equipment_type"),
    bio_material: get("bio_material", "target_material", "target_biodegradable_material"),
    transition_goal: get("transition_goal", "reason"),
    concern: get("concern", "main_technical_concern", "critical_area"),
    issues: get("issues", "known_issues"),
    notes: get("notes", "additional_notes"),
    screw_diameter: get("screw_diameter"),
    ld_ratio: get("ld_ratio"),
    die_mold: get("die_mold", "die_mold_information"),
    customer_or_member_name: get("customer_or_member_name", "member_company_name", "customer_company_name"),
    customer_or_member_use_case: get("customer_or_member_use_case", "intended_product_application"),
    access_key: get("access_key", "token"),
  };
}

function upper(text) {
  return String(text || "").toUpperCase();
}

function calculateScores(input) {
  const all = upper([
    input.application,
    input.product_type,
    input.material,
    input.bio_material,
    input.processing,
    input.equipment,
    input.concern,
    input.issues,
    input.notes,
  ].join(" | "));

  let thermal = 85;
  let flow = 85;
  let mechanical = 85;

  if (all.includes("PLA")) thermal -= 10;
  if (all.includes("PHA") || all.includes("PHB")) {
    thermal -= 8;
    flow -= 10;
  }
  if (all.includes("PBAT")) flow -= 3;
  if (all.includes("PET")) thermal -= 12;
  if (all.includes("PP")) thermal -= 5;
  if (all.includes("LDPE") || all.includes("LLDPE") || all.includes("PE")) thermal -= 3;

  if (all.includes("BLOWN FILM") || all.includes("FILM") || all.includes("POUCH") || all.includes("BAG")) flow -= 12;
  if (all.includes("INJECTION")) mechanical -= 10;
  if (all.includes("HOT-FILL") || all.includes("HOT FILL") || all.includes("STERIL")) thermal -= 25;
  if (all.includes("MEDICAL") || all.includes("REGULATORY") || all.includes("STERILE BARRIER")) thermal -= 12;
  if (all.includes("HIGH-SPEED") || all.includes("HIGH SPEED")) flow -= 10;
  if (all.includes("NO EQUIPMENT MODIFICATION") || all.includes("NO MODIFICATION")) {
    thermal -= 5;
    flow -= 5;
  }
  if (all.includes("THICKNESS VARIATION") || all.includes("GAUGE") || all.includes("OUTPUT CONSISTENCY") || all.includes("BUBBLE")) flow -= 15;
  if (all.includes("SEAL")) flow -= 7;
  if (all.includes("WARPAGE") || all.includes("BRITTLE") || all.includes("IMPACT") || all.includes("DIMENSIONAL")) mechanical -= 8;

  thermal = clamp(thermal);
  flow = clamp(flow);
  mechanical = clamp(mechanical);
  const bottleneck = Math.min(thermal, flow, mechanical);
  const avg = (thermal + flow + mechanical) / 3;
  const total = Math.round(bottleneck * 0.7 + avg * 0.3);

  return { thermal, flow, mechanical, total };
}

function decisionFromScore(total) {
  if (total >= 75) return { level: "HIGH", decision: "GO" };
  if (total >= 55) return { level: "MODERATE", decision: "CONDITIONAL GO" };
  return { level: "LOW", decision: "HOLD" };
}

function constraintFromScores(scores) {
  const min = Math.min(scores.thermal, scores.flow, scores.mechanical);
  if (scores.thermal === min) {
    return {
      type: "THERMAL",
      title: "Thermal Processing Constraint",
      factor: "thermal stability under processing conditions",
      control: "temperature control precision and thermal distribution",
      impact: "material degradation risk and process reliability",
    };
  }
  if (scores.flow === min) {
    return {
      type: "FLOW",
      title: "Process Flow Variability",
      factor: "flow consistency during extended production runs",
      control: "pressure stability, melt uniformity, and extrusion flow balance",
      impact: "production consistency, yield rate, and operational efficiency",
    };
  }
  return {
    type: "MECHANICAL",
    title: "Mechanical Performance Limitation",
    factor: "mechanical integrity under load conditions",
    control: "material strength consistency and structural reliability",
    impact: "product strength and structural performance",
  };
}

function riskLevel(score) {
  if (score >= 75) return "High";
  if (score >= 55) return "Moderate";
  return "Low";
}

function expectedDeviations(input, scores) {
  const text = upper([input.processing, input.application, input.product_type].join(" "));
  if (text.includes("INJECTION")) {
    return `
      <li>Dimensional variation may appear on critical features where filling balance or shrinkage behaviour changes.</li>
      <li>Warpage, sink marks, or incomplete filling may occur where gate freeze timing or cooling distribution differs from the incumbent resin.</li>
      <li>Surface quality may become unstable if melt temperature, injection speed, and holding pressure are not re-qualified.</li>
    `;
  }
  return `
    <li>Gauge or thickness variation may appear across the web width where melt pressure or draw stability drifts outside the qualified range.</li>
    <li>Seal-window instability may occur if melt temperature, cooling rate, or blend morphology changes during extended production runs.</li>
    <li>Output consistency may decline during long runs if drying, residence time, and extrusion pressure are not controlled as validated parameters.</li>
  `;
}

function generateOverlay() {
  return "";
}

function injectHtml(template, data) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null || value === "") return "—";
    return String(value);
  });
}

function buildFallbackHtml(data) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page{size:A4;margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#102033;background:#fff}.page{padding:36px 42px}.top{display:flex;justify-content:space-between;color:#8a9aaa;font-size:12px;letter-spacing:.08em}.title{margin-top:44px;font-size:38px;line-height:1.12;font-weight:650;color:#14345f}.sub{color:#8492a6;margin-top:12px}.grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #dce7f0;border-radius:14px;overflow:hidden;margin-top:34px}.cell{padding:20px 24px;border-right:1px solid #dce7f0;border-bottom:1px solid #dce7f0}.cell:nth-child(2n){border-right:0}.label{font-size:11px;color:#91a0b4;letter-spacing:.18em;text-transform:uppercase;margin-bottom:9px}.val{font-size:15px;font-weight:650}.section{margin-top:42px}.section h2{font-size:18px;letter-spacing:.08em;text-transform:uppercase}.card{border:1px solid #cfe0ee;background:#f5faff;border-radius:14px;padding:24px;margin-top:16px}.badge{display:inline-block;border:1px solid #bdd0e2;border-radius:8px;padding:8px 14px;font-weight:800}.risk{border-left:4px solid #d8a72f;background:#fffdf6;padding:16px 20px;margin-top:22px;border-radius:8px}.cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}.mini{border:1px solid #dce7f0;border-radius:12px;padding:16px}.score{font-size:28px;font-weight:800;color:#14345f}.footer{margin-top:60px;color:#8a9aaa;font-size:12px}</style></head>
<body><main class="page">
<div class="top"><div>FAIRVIA™</div><div>CONFIDENTIAL</div></div>
<div class="title">FairVia™ Technical<br>Hypothesis Report</div>
<div class="sub">Material feasibility assessment for pre-commercial transition planning</div>
<div class="grid">
<div class="cell"><div class="label">Application</div><div class="val">${data.application}</div></div>
<div class="cell"><div class="label">Material Transition</div><div class="val">${data.material_transition}</div></div>
<div class="cell"><div class="label">Assessment Type</div><div class="val">Technical Hypothesis</div></div>
<div class="cell"><div class="label">Date</div><div class="val">${data.report_date}</div></div>
</div>
<section class="section"><h2>01 Executive Summary</h2><div class="card"><div class="label">Compatibility Level</div><div class="badge">${data.compatibility_level}</div><p>${data.executive_summary}</p><div class="risk"><strong>KEY RISK</strong><br>${data.key_risk}</div></div></section>
<section class="section"><h2>Parameter Profile</h2><div class="cols"><div class="mini"><div class="label">Thermal</div><div class="score">${data.thermal_score}</div></div><div class="mini"><div class="label">Flow</div><div class="score">${data.flow_score}</div></div><div class="mini"><div class="label">Mechanical</div><div class="score">${data.mechanical_score}</div></div></div></section>
<section class="section"><h2>Recommended Next Step</h2><p>${data.next_step}</p></section>
<div class="footer">FairVia™ · Il Nautico Co., Ltd. · Pre-Commercial Assessment</div>
</main></body></html>`;
}

function buildHtml(input, scores, decision, constraint) {
  const app = safe(input.application, "Specified application");
  const target = safe(input.bio_material, "Target biodegradable material");
  const economic = scores.total >= 75 ? "+5–15%" : scores.total >= 55 ? "+15–30%" : "+30%+";

  const executive =
    `This assessment indicates ${decision.level} feasibility for the evaluated material transition within the current processing framework. ` +
    `Thermal (${scores.thermal}) / Flow (${scores.flow}) / Mechanical (${scores.mechanical}) / Composite: ${scores.total}. ` +
    `The system is ${decision.level === "LOW" ? "critically constrained" : "operationally viable but requires controlled validation"}. ` +
    `Material cost variance is projected at ${economic}. Deployment Decision: ${decision.decision}.`;

  const keyRisk =
    `${constraint.title}: variability in ${constraint.factor} may affect ${constraint.impact}. ` +
    `Validation should focus on ${constraint.control}.`;

  const next = decision.level === "LOW"
    ? `Commercial transition under the current configuration is not recommended. Reassess material grade, application requirements, or processing architecture before pilot approval.`
    : `Proceed to structured engineering validation before commercial commitment. Confirm supplier evidence, define acceptable machine settings, and validate start-up, steady-state, and extended-run stability.`;

  const data = {
    assessment_type: "Technical Hypothesis",
    application: app,
    current_material_label: safe(input.material, "Current material").toUpperCase(),
    target_material_label: target,
    conceptual_note: "Illustrative comparison only. Temperature values and scores are conceptual indicators of relative processing tolerance, not recommended operating conditions.",
    material_transition: target,
    report_date: new Date().toISOString().slice(0, 10),
    subtitle_note: "For manufacturers evaluating biodegradable material transition using existing processing equipment.",
    compatibility_level: decision.level,
    executive_summary: executive,
    key_risk: keyRisk,
    processing_window: `${constraint.type} constraint identified. Controlled validation is required to define the usable processing window.`,
    thermal_behavior: `Thermal score: ${scores.thermal}/100. Temperature control and material stability should be validated.`,
    flow_characteristics: `Flow score: ${scores.flow}/100. Pressure stability, melt uniformity, and output consistency should be validated.`,
    mechanical_behavior: `Mechanical score: ${scores.mechanical}/100. Application-level performance should be confirmed through trials.`,
    surface_quality: scores.flow >= 55 ? "Surface quality is conditionally acceptable under controlled parameters." : "Surface quality is unreliable without process stabilisation.",
    structural_consistency: `Structural consistency is conditional on parameter control. Composite score: ${scores.total}/100.`,
    application_implication: `${app} is ${decision.level === "LOW" ? "not recommended for commercial deployment at the current feasibility level" : "viable subject to process optimisation and pilot validation"}.`,
    primary_risk_title: constraint.title,
    primary_risk: keyRisk,
    secondary_risk_title: "Process Interaction Risk",
    secondary_risk: `Interaction among thermal, flow, and mechanical behaviour may compound output variability when process conditions drift outside the validated range.`,
    mechanism: `${safe(input.material, "The current material")} and ${target} differ in thermal stability, rheology, and process tolerance. Under ${app} conditions, this mismatch concentrates around ${constraint.factor}.`,
    stability: riskLevel(Math.min(scores.thermal, scores.flow, scores.mechanical)),
    stability_note: `Process stability index: ${Math.min(scores.thermal, scores.flow, scores.mechanical)}/100.`,
    consistency: riskLevel(scores.flow),
    consistency_note: `Flow consistency index: ${scores.flow}/100.`,
    expected_deviations: expectedDeviations(input, scores),
    pha_score: scores.total,
    thermal_score: scores.thermal,
    flow_score: scores.flow,
    mechanical_score: scores.mechanical,
    base_image: visualBaseDataUri,
    dynamic_overlay: generateOverlay(scores),
    next_step: next,
    decision: decision.decision,
    economic_impact: economic,
    call_to_action: "Request engineering compatibility review and pilot validation planning.",
  };

  if (htmlTemplate) {
    return injectHtml(htmlTemplate, data);
  }
  return buildFallbackHtml(data);
}

async function renderPdf(html) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function sendResendEmail(payload) {
  if (!RESEND_API_KEY) return { skipped: true };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error: ${res.status} ${detail}`);
  }

  return res.json().catch(() => ({}));
}

async function sendReportEmails({ pdf, input, scores, decision, reportId }) {
  const email = safe(input.email, "");
  if (!email.includes("@")) return;

  const downloadUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/download-report/${reportId}` : "";

  const text = `Dear ${safe(input.contact_person, "Client")},\n\nYour FairVia™ Technical Hypothesis Report has been generated.\n\nCompatibility Level: ${decision.level}\nComposite Score: ${scores.total}/100\n\n${downloadUrl ? `Download URL: ${downloadUrl}\n\n` : ""}Best regards,\nFairVia™ Technical Assessment Team`;

  await sendResendEmail({
    from: FROM_EMAIL,
    to: email,
    subject: "FairVia™ Technical Hypothesis Report",
    text,
    attachments: [
      {
        filename: "FairVia-Technical-Hypothesis-Report.pdf",
        content: Buffer.from(pdf).toString("base64"),
      },
    ],
  });

  if (ADMIN_EMAIL && ADMIN_EMAIL.includes("@")) {
    await sendResendEmail({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: "New FairVia™ Report Generated",
      text: `Company: ${safe(input.company_name)}\nEmail: ${email}\nLevel: ${decision.level}\nScore: ${scores.total}`,
      attachments: [
        {
          filename: "FairVia-Technical-Hypothesis-Report.pdf",
          content: Buffer.from(pdf).toString("base64"),
        },
      ],
    });
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "fairvia-equipment", supabase: hasSupabase, timestamp: new Date().toISOString() });
});

app.get("/equipment-access", async (req, res) => {
  const token = extractAccessKey(req);
  const verification = await verifyAccessKey(token).catch((err) => ({ valid: false, message: err.message }));

  if (!verification.valid) {
    return res.status(403).send(`<!doctype html><html><head><meta charset="utf-8"><title>Demo access required</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f9fb;color:#102033;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #dbe4ea;border-radius:20px;padding:32px;max-width:520px;box-shadow:0 20px 60px rgba(16,32,51,.08)}h1{margin:0 0 10px}.muted{color:#6b7a88}</style></head><body><main class="card"><h1>Demo access required</h1><p class="muted">${safe(verification.message, "Please request a valid assessment access link.")}</p></main></body></html>`);
  }

  const formPath = path.join(__dirname, "public", "equipment-access.html");
  if (!fs.existsSync(formPath)) {
    return res.status(404).send("equipment-access.html not found");
  }

  let html = fs.readFileSync(formPath, "utf8");
  const hidden = `<input type="hidden" name="access_key" value="${token.replace(/"/g, "&quot;")}" />`;
  if (!html.includes('name="access_key"')) {
    html = html.replace("</form>", `${hidden}\n</form>`);
  }
  html = html.replace("</body>", `<script>window.FAIRVIA_ACCESS_INFO=${JSON.stringify({
    plan_type: verification.plan_type,
    organisation_name: verification.organisation_name,
    max_uses: verification.max_uses,
    used_count: verification.used_count,
    remaining_uses: verification.remaining_uses,
  })};</script></body>`);

  return res.setHeader("Content-Type", "text/html; charset=utf-8").send(html);
});

app.post("/api/access/verify", async (req, res) => {
  try {
    const accessKey = req.body?.access_key || req.body?.token || "";
    const result = await verifyAccessKey(accessKey);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ valid: false, error: "verify_failed", detail: err.message });
  }
});

app.post("/api/access/create-admin", async (req, res) => {
  try {
    if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      return res.status(401).json({ ok: false, error: "admin_unauthorized" });
    }

    if (!hasSupabase) {
      return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    const planType = req.body?.plan_type || "introductory_pre_pilot_assessment";
    const plainKey = req.body?.access_key || `FV-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const maxUses = Number(req.body?.max_uses || planMaxUses(planType));
    const expiresAt = req.body?.expires_at || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    const row = await supabaseInsert("assessment_access_keys", {
      access_key_hash: keyHash(plainKey),
      access_key_prefix: accessKeyPrefix(plainKey),
      organisation_name: req.body?.organisation_name || "",
      contact_email: req.body?.contact_email || "",
      organisation_type: req.body?.organisation_type || "single_company",
      plan_type: planType,
      max_uses: maxUses,
      expires_at: expiresAt,
      status: "active",
      stripe_product_id: req.body?.stripe_product_id || null,
      stripe_price_id: req.body?.stripe_price_id || null,
      stripe_checkout_session_id: req.body?.stripe_checkout_session_id || null,
      stripe_payment_intent_id: req.body?.stripe_payment_intent_id || null,
      metadata: req.body?.metadata || {},
    });

    return res.json({
      ok: true,
      access_key: plainKey,
      access_url: `${PUBLIC_BASE_URL || ""}/equipment-access?token=${encodeURIComponent(plainKey)}`,
      row,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "admin_create_failed", detail: err.message });
  }
});

app.post("/generate-report", async (req, res) => {
  try {
    const accessKey = extractAccessKey(req);
    const verification = await verifyAccessKey(accessKey);

    if (!verification.valid) {
      return res.status(403).json({ error: "access_denied", detail: verification.message });
    }

    const input = normalizeInput({ ...req.body, access_key: accessKey });
    const scores = calculateScores(input);
    const decision = decisionFromScore(scores.total);
    const constraint = constraintFromScores(scores);
    const html = buildHtml(input, scores, decision, constraint);
    const pdf = await renderPdf(html);

    // Credit is consumed only after successful PDF generation.
    const consume = await consumeAccessKey(accessKey, req);
    if (!consume.ok) {
      return res.status(409).json({ error: "credit_consume_failed", detail: consume.message });
    }

    latest.pdf = pdf;
    cleanupExpiredReports();
    const reportId = crypto.randomUUID();
    reportStore.set(reportId, { pdf, input, scores, decision, createdAt: Date.now() });

    sendReportEmails({ pdf, input, scores, decision, reportId }).catch((err) => {
      console.warn("[Email delivery failed]", err.message);
    });

    if (req.query.delivery === "email") {
      return res.json({
        ok: true,
        report_id: reportId,
        compatibility_level: decision.level,
        composite_score: scores.total,
        remaining_uses: consume.remaining_uses,
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=FairVia-Technical-Hypothesis-Report.pdf");
    res.setHeader("Content-Length", pdf.length);
    return res.send(pdf);
  } catch (err) {
    console.error("[PDF ERROR]", err);
    return res.status(500).json({ error: "PDF generation failed", detail: err.message });
  }
});

app.get("/latest-pdf", (_req, res) => {
  if (!latest.pdf) return res.status(404).send("No PDF generated yet.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=FairVia-Technical-Hypothesis-Report.pdf");
  return res.send(latest.pdf);
});

app.get("/download-report/:reportId", (req, res) => {
  cleanupExpiredReports();
  const item = reportStore.get(req.params.reportId);
  if (!item?.pdf) return res.status(404).send("Report not found or expired.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=FairVia-Technical-Hypothesis-Report.pdf");
  return res.send(item.pdf);
});

app.get("/report-ready", (_req, res) => {
  const reportReadyPath = path.join(__dirname, "public", "report-ready.html");
  if (fs.existsSync(reportReadyPath)) return res.sendFile(reportReadyPath);
  return res.send("Report generated.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[FairVia] Server running on port ${PORT}`);
});
