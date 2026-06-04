'use strict';

/**
 * FairVia™ Advanced Technical Screening Server
 * @file   server_advanced.js
 * @version 1.0.8
 *
 * IMPORTANT:
 * - Test console code has been removed.
 * - Production endpoints only:
 *   POST /advanced-webhook
 *   GET  /latest-advanced-pdf
 *   GET  /advanced-access
 *   GET  /advanced-access-demo?key=...
 *   POST /generate-advanced-demo-report
 *   GET  /download-advanced-report/:reportId
 *   GET  /health
 * - Confidence output from fairvia-scoring-engine.js is passed to template_advanced.html.
 */

const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const express   = require('express');
const puppeteer = require('puppeteer');

const scoringEngine = require('./fairvia-scoring-engine');


const {
  calculateFoodContactRisk,
  calculateMedicalHealthcareRisk,
  ENGINE_VERSION,
} = scoringEngine;

const SERVER_VERSION    = '1.0.8';
const PDF_OUTPUT_PATH   = process.env.PDF_OUTPUT_PATH ?? '/tmp/latest-advanced.pdf';
const ADVANCED_PORT     = Number(process.env.PORT ?? process.env.ADVANCED_PORT ?? 3001);
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 28000);
const AI_ENABLED        = process.env.ENABLE_AI_NARRATIVE !== 'false';
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
const PUPPETEER_ARGS    = (process.env.PUPPETEER_ARGS ?? '--no-sandbox --disable-setuid-sandbox')
  .split(' ')
  .filter(Boolean);

const TEMPLATE_PATH = path.join(__dirname, 'template_advanced.html');

// ══════════════════════════════════════════════════════════════
// EMAIL DELIVERY / DEMO ACCESS CONFIG
// ══════════════════════════════════════════════════════════════

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const FROM_EMAIL     = process.env.FROM_EMAIL ?? 'FairVia <info@ilnautico.com>';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL ?? '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL ?? '')
  .replace(/^PUBLIC_BASE_URL=/, '')
  .trim();
const TEST_ROUTE_KEY = process.env.TEST_ROUTE_KEY ?? process.env.ADVANCED_TEST_ROUTE_KEY ?? 'fairvia-test-2026';

if (!RESEND_API_KEY) {
  console.warn('[server_advanced] RESEND_API_KEY not set — result email delivery disabled.');
}

const advancedReportStore = new Map();
const ADVANCED_REPORT_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

function cleanupExpiredAdvancedReports() {
  const now = Date.now();
  for (const [reportId, item] of advancedReportStore.entries()) {
    if (!item?.createdAt || now - item.createdAt > ADVANCED_REPORT_TTL_MS) {
      advancedReportStore.delete(reportId);
    }
  }
}


function validateEnvironment() {
  if (AI_ENABLED && !process.env.ANTHROPIC_API_KEY) {
    console.warn('[server_advanced] ANTHROPIC_API_KEY is missing. AI narrative will be skipped and deterministic fallback narrative will be used.');
  }

  if (!AI_ENABLED) {
    console.warn('[server_advanced] AI narrative disabled by ENABLE_AI_NARRATIVE=false.');
  }

  console.log('[server_advanced] Starting with configuration:', {
    port:            ADVANCED_PORT,
    model:           CLAUDE_MODEL,
    aiEnabled:       AI_ENABLED && !!process.env.ANTHROPIC_API_KEY,
    claudeTimeoutMs: CLAUDE_TIMEOUT_MS,
    pdfOutputPath:   PDF_OUTPUT_PATH,
    signatureVerify: !!process.env.TALLY_WEBHOOK_SECRET,
    puppeteerArgs:   PUPPETEER_ARGS,
    engineVersion:   ENGINE_VERSION,
    emailEnabled:    !!RESEND_API_KEY,
    publicBaseUrl:   PUBLIC_BASE_URL || '(request host fallback)',
  });
}

const REPORT_DISCLAIMER =
  'This report constitutes an initial technical risk screening only. It is produced by an ' +
  'automated system combining deterministic risk scoring with AI-assisted technical narrative ' +
  'generation. It does not constitute a regulatory compliance determination, food contact ' +
  'safety assessment, biocompatibility evaluation, product approval, or certification of any ' +
  'kind. No regulatory body has reviewed or endorsed the contents of this report. The client ' +
  'is solely responsible for ensuring compliance with all applicable regulations in their ' +
  'target markets. Engagement of qualified specialists in materials science, regulatory ' +
  'affairs, and — where applicable — toxicology is required before any commercial use of a ' +
  'material transition. FairVia™ / Il Nautico Co., Ltd. accepts no liability for decisions ' +
  'made on the basis of this screening report without appropriate specialist validation.';

const BURDEN_LEVEL_DISPLAY = {
  low_medium: 'Low–Medium',
  medium:     'Medium',
  high:       'High',
  very_high:  'Very High',
  critical:   'Critical — Specialist Reassessment Required',
};

const ROUTE_LABEL = {
  food:    'Food Contact / Food Packaging',
  medical: 'Medical / Healthcare',
};

const MARKET_LABEL = {
  japan:       'Japan',
  eu:          'European Union',
  uk:          'United Kingdom',
  us:          'United States',
  canada:      'Canada',
  middle_east: 'Middle East',
  gcc:         'GCC / Middle East',
  china:       'China',
  india:       'India',
  anz:         'Australia / New Zealand',
  sea:         'Southeast Asia',
  asean:       'ASEAN',
  other:       'Other markets',
  other_market:'Other / Not Decided Yet',
};

const FOOD_FRAMEWORK = {
  japan:       'MHLW Notification 370',
  eu:          'EU Regulation 10/2011',
  uk:          'UK Food Contact Materials Regulations',
  us:          'FDA 21 CFR (food contact)',
  canada:      'Health Canada / Canadian food packaging framework',
  middle_east: 'National framework (country-dependent)',
  gcc:         'GSO / national GCC food-contact frameworks (country-dependent)',
  china:       'GB 4806 series',
  india:       'FSSAI food-contact packaging framework',
  anz:         'FSANZ / Australia-New Zealand food packaging framework',
  sea:         'National frameworks (vary by country)',
  asean:       'ASEAN national food-contact frameworks (country-dependent)',
  other:       'Applicable national framework (to be confirmed)',
  other_market:'Applicable national framework (to be confirmed)',
};

const MEDICAL_FRAMEWORK = {
  japan:       'PMDA / MHLW',
  eu:          'EU MDR 2017/745',
  uk:          'MHRA (UK MDR 2002 as amended)',
  us:          'FDA 21 CFR Part 820 / 510(k) / PMA',
  canada:      'Health Canada medical-device framework',
  middle_east: 'National regulatory framework (country-dependent)',
  gcc:         'GCC national medical-device frameworks (country-dependent)',
  china:       'NMPA',
  india:       'CDSCO medical-device framework',
  anz:         'TGA / Medsafe medical-device frameworks',
  sea:         'National frameworks (vary by country)',
  asean:       'ASEAN national medical-device frameworks (country-dependent)',
  other:       'Applicable national framework (to be confirmed)',
  other_market:'Applicable national framework (to be confirmed)',
};

const PROHIBITED_PATTERNS = [
  /\bapproved?\b(?!\s+(?:laboratory|body|protocol|method|supplier))/gi,
  /\bis\s+compliant\b/gi,
  /\bare\s+compliant\b/gi,
  /\bfully\s+compliant\b/gi,
  /\bfood[- ]safe\b/gi,
  /\bis\s+biocompatible\b/gi,
  /\bare\s+biocompatible\b/gi,
  /\bconfirmed\s+(?:as\s+)?biocompatible\b/gi,
  /\bsafe\s+for\s+(?:medical|patient|clinical|consumer|food|human)\b/gi,
  /\bmedically\s+safe\b/gi,
  /\bno\s+(?:migration|toxicity|safety|contamination)\s+risk\b/gi,
  /\bsuitable\s+for\s+(?:direct\s+)?(?:food|patient|medical|clinical|consumer)\s+contact\b/gi,
  /\bmeets?\s+(?:the\s+)?(?:requirements?|limits?|standards?|specifications?)\b/gi,
  /\bhas\s+been\s+validated\s+for\b/gi,
  /\bvalidated\s+(?:material|grade|product|packaging|resin)\b/gi,
  /\bcertified\s+(?:material|grade|polymer|resin|product)\b(?!\s+(?:compostable|by|under|to))/gi,
  /\bno\s+safety\s+(?:concerns?|issues?|risks?)\b/gi,
];

function generateReportId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const hex  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `FVA-${date}-${hex}`;
}

function formatDateDisplay(date) {
  return date.toLocaleDateString('en-GB', {
    day:   '2-digit',
    month: 'long',
    year:  'numeric',
  });
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success:   false,
    error:     code,
    message,
    timestamp: new Date().toISOString(),
  });
}

function verifyTallySignature(req) {
  const secret = process.env.TALLY_WEBHOOK_SECRET;
  if (!secret) return true;

  const signature = req.headers['tally-signature'];
  if (!signature) return false;

  try {
    const computed = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(computed, 'hex')
    );
  } catch {
    return false;
  }
}

function normalizeTallyPayload(raw) {
  if (!raw?.data?.fields || !Array.isArray(raw.data.fields)) {
    const err = new Error('Missing data.fields array in Tally webhook body.');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }

  const fieldMap = {};
  for (const field of raw.data.fields) {
    if (field.key) fieldMap[field.key] = field.value ?? null;
  }

  const str = (key, fallback = null) => {
    const v = fieldMap[key];
    return (typeof v === 'string' && v.trim()) ? v.trim().toLowerCase() : fallback;
  };

  const strAny = (keys, fallback = null) => {
    for (const key of keys) {
      const v = fieldMap[key];
      if (typeof v === 'string' && v.trim()) {
        return v.trim().toLowerCase();
      }
    }
    return fallback;
  };

  const rawStr = (key) => {
    const v = fieldMap[key];
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
  };

  const arr = (key) => {
    const v = fieldMap[key];
    if (!v) return [];
    return (Array.isArray(v) ? v : [v])
      .map(s => (typeof s === 'string' ? s.trim().toLowerCase() : s))
      .filter(Boolean);
  };

  const hasFile = (key) => {
    const v = fieldMap[key];
    return Array.isArray(v) ? v.length > 0 : !!v;
  };

  const route = str('route');
  if (!['food', 'medical'].includes(route)) {
    const err = new Error(`route field is "${route ?? 'missing'}". Expected "food" or "medical".`);
    err.code = 'INVALID_ROUTE';
    throw err;
  }

  const targetMarkets     = arr('target_markets');
  const candidateMaterial = arr('candidate_material');

  const input = {
    route,
    company_name:       rawStr('company_name'),
    contact_person:     rawStr('contact_person'),
    email:              rawStr('email'),
    access_token:       rawStr('access_token'),
    project_name:       rawStr('project_name'),
    product_format:     str('product_format'),
    transition_reason:  str('transition_reason'),
    target_markets:     targetMarkets,
    n_markets:          targetMarkets.length,
    timeline:           str('timeline'),
    current_material:   str('current_material'),
    current_compliance: arr('current_compliance'),
    shelf_life:         str('shelf_life'),
    distribution_temp:  str('distribution_temp'),
    candidate_material: candidateMaterial,
    tds_available:      str('tds_available'),
    supplier_data:      str('supplier_data'),
    eol_claim:          str('eol_claim', 'none'),
    eol_cert:           str('eol_cert', 'unknown'),
    internal_ra:        str('internal_ra'),
    regulator_dialogue: str('regulator_dialogue'),
    validation_budget:  str('validation_budget'),
    additional_context: rawStr('additional_context'),
    report_language:    str('report_language', 'en'),
    uploads: {
      tds:       hasFile('upload_tds'),
      decl:      hasFile('upload_decl'),
      migration: hasFile('upload_migration'),
      iso_10993: hasFile('upload_iso'),
      spec:      hasFile('upload_spec'),
    },
    food:    null,
    medical: null,
  };

  if (route === 'food') {
    input.food = {
      food_type:        str('food_type'),
      contact_temp:     str('contact_temp'),
      contact_duration: str('contact_duration'),
      inpack_process:   strAny([
        'inpack_process',
        'in_pack_process',
        'inpackProcess',
        'inpack_processing',
        'in_pack_processing',
        'food_inpack_process',
        'food_in_pack_process',
        'food_inpack_processing',
        'food_in_pack_processing',
        'inpack_process_food',
        'in_pack_process_food',
      ], 'unknown'),
      seal_temp:        str('seal_temp'),
      barrier_layer:    arr('barrier_layer'),
    };
  }

  if (route === 'medical') {
    input.medical = {
      device_type:            str('device_type'),
      patient_contact:        str('patient_contact'),
      contact_duration_med:   str('contact_duration_med'),
      device_class:           str('device_class', 'unknown'),
      sterilisation_medical:  str('sterilisation_medical'),
      body_fluid_contact:     str('body_fluid_contact'),
      medical_grade_supplier: str('medical_grade_supplier'),
      iso_13485_supplier:     str('iso_13485_supplier'),
    };
  }

  return input;
}

function clonePlainObject(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mapValue(value, map) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => mapValue(v, map));
  return map[value] ?? value;
}

function normalizeInputForScoring(input) {
  const out = clonePlainObject(input);

  out.supplier_data = mapValue(out.supplier_data ?? 'unknown', {
    complete: 'decl_compliance',
    available: 'decl_compliance',
    partial: 'test_data',
    none: 'none',
    unknown: 'unknown',
  });

  out.eol_claim = mapValue(out.eol_claim ?? 'none', {
    industrial_compostable: 'industrial_compost',
    home_compostable: 'home_compost',
    soil_biodegradable: 'biodegradable',
    marine_biodegradable: 'biodegradable',
    not_sure: 'tbd',
    none: 'none',
  });

  out.eol_cert = mapValue(out.eol_cert ?? 'unknown', {
    available: 'other_cert',
    planned: 'unknown',
    none: 'no',
    no: 'no',
    unknown: 'unknown',
  });

  out.internal_ra = mapValue(out.internal_ra ?? 'unknown', {
    available: 'dedicated',
    yes: 'dedicated',
    partial: 'parttime',
    limited: 'parttime',
    no: 'none',
    none: 'none',
    unknown: 'unknown',
  });

  out.regulator_dialogue = mapValue(out.regulator_dialogue ?? 'none', {
    active: 'formal',
    already_started: 'formal',
    yes: 'formal',
    informal: 'informal',
    none: 'none',
    no: 'none',
    unknown: 'none',
  });

  if (out.route === 'food' && out.food) {
    out.food.contact_temp = mapValue(out.food.contact_temp ?? 'unknown', {
      frozen: 'lt_5c',
      chilled: 'lt_5c',
      ambient: 'lt_25c',
      room_temp: 'lt_25c',
      '40_70c': '40_70c',
      above_70c: 'above_70',
      above_70: 'above_70',
      microwave: 'microwave',
      unknown: 'unknown',
    });

    out.food.contact_duration = mapValue(out.food.contact_duration ?? 'unknown', {
      short: 'lt_24h',
      lt_24h: 'lt_24h',
      '1_7_days': '1_7d',
      '1_7d': '1_7d',
      '7_30_days': '7_30d',
      '7_30d': '7_30d',
      over_30_days: '1_6m',
      '1_6m': '1_6m',
      gt_6m: 'gt_6m',
      unknown: 'unknown',
    });

    out.food.inpack_process = mapValue(out.food.inpack_process ?? 'unknown', {
      none: 'none',
      hot_fill: 'pasteurise',
      pasteurisation: 'pasteurise',
      pasteurization: 'pasteurise',
      pasteurise: 'pasteurise',
      retort: 'retort',
      microwave: 'retort',
      hpp: 'hpp',
      map: 'map',
      unknown: 'unknown',
    });

    out.food.seal_temp = mapValue(out.food.seal_temp ?? 'unknown', {
      below_100c: 'lt_120',
      '100_120c': 'lt_120',
      '120_140c': '120_140',
      above_140c: '140_160',
      '140_160c': '140_160',
      '160_180c': '160_180',
      above_180c: 'gt_180',
      unknown: 'unknown',
    });
  }

  if (out.route === 'medical' && out.medical) {
    out.medical.patient_contact = mapValue(out.medical.patient_contact ?? 'unknown', {
      none: 'none',
      skin: 'surface_intact',
      mucosal: 'mucosal',
      blood_or_fluid_path: 'blood_path',
      blood_path: 'blood_path',
      implant_contact: 'implant_contact',
      unknown: 'unknown',
    });

    out.medical.contact_duration_med = mapValue(out.medical.contact_duration_med ?? 'unknown', {
      limited: 'lt_24h',
      prolonged: '24h_30d',
      long_term: 'gt_30d',
      unknown: 'unknown',
    });

    out.medical.sterilisation_medical = mapValue(out.medical.sterilisation_medical ?? 'tbd', {
      none: 'none_required',
      eto: 'eo',
      eo: 'eo',
      gamma: 'gamma',
      e_beam: 'ebeam',
      steam: 'steam',
      unknown: 'tbd',
    });

    out.medical.medical_grade_supplier = mapValue(out.medical.medical_grade_supplier ?? 'unknown', {
      yes: 'yes',
      confirmed: 'yes',
      partial: 'unknown',
      no: 'no',
      unknown: 'unknown',
    });

    out.medical.iso_13485_supplier = mapValue(out.medical.iso_13485_supplier ?? 'unknown', {
      yes: 'yes',
      confirmed: 'yes',
      partial: 'unknown',
      no: 'no',
      unknown: 'unknown',
    });
  }

  return out;
}

const DISPLAY_LABELS = {
  target_markets: MARKET_LABEL,
  food_type: {
    dry: 'dry food',
    aqueous: 'aqueous food',
    acidic: 'acidic food',
    fatty: 'fatty food contact',
    alcoholic: 'alcoholic contact',
    mixed: 'mixed / unspecified food contact',
  },
  contact_temp: {
    lt_5c: 'chilled / refrigerated',
    lt_25c: 'ambient',
    lt_40c: 'elevated ambient',
    above_70: 'above 70°C',
    microwave: 'microwave heating',
    frozen: 'frozen',
    chilled: 'chilled',
    ambient: 'ambient',
    '40_70c': '40–70°C',
    'above_70c': 'above 70°C',
  },
  contact_duration: {
    lt_24h: 'short contact',
    '1_7d': '1–7 days',
    '7_30d': '7–30 days',
    '1_6m': '1–6 months',
    gt_6m: 'over 6 months',
    short: 'short contact',
    '1_7_days': '1–7 days',
    '7_30_days': '7–30 days',
    'over_30_days': 'over 30 days',
  },
  inpack_process: {
    pasteurise: 'pasteurisation / hot fill',
    unknown: 'unknown',
    hpp: 'high pressure processing',
    map: 'modified atmosphere packaging',
    none: 'none',
    pasteurisation: 'pasteurisation',
    hot_fill: 'hot fill',
    retort: 'retort',
    microwave: 'microwave heating',
  },
  seal_temp: {
    lt_120: 'below 120°C',
    '120_140': '120–140°C',
    '140_160': '140–160°C',
    '160_180': '160–180°C',
    gt_180: 'above 180°C',
    'below_100c': 'below 100°C',
    '100_120c': '100–120°C',
    '120_140c': '120–140°C',
    'above_140c': 'above 140°C',
    unknown: 'unknown',
  },
  barrier_layer: {
    none: 'none',
    evoh: 'EVOH',
    aluminium: 'aluminium / metallised layer',
    coating: 'functional coating',
    unknown: 'unknown',
  },
  candidate_material: {
    pla: 'PLA',
    pha: 'PHA',
    pbat: 'PBAT blend',
    starch_blend: 'starch blend',
    unknown: 'not yet specified',
  },
  current_material: {
    pe: 'PE / LDPE / HDPE',
    pp: 'PP',
    pet: 'PET',
    ps: 'PS',
    pvc: 'PVC',
    multilayer: 'multilayer structure',
    unknown: 'unknown',
  },
  supplier_data: {
    decl_compliance: 'declaration / compliance evidence available',
    test_data: 'test data available',
    complete: 'complete',
    partial: 'partially available',
    none: 'not available',
    unknown: 'unknown',
  },
  eol_claim: {
    industrial_compost: 'industrial compostability claim',
    home_compost: 'home compostability claim',
    biodegradable: 'biodegradation claim',
    tbd: 'not yet defined',
    none: 'no end-of-life claim',
    industrial_compostable: 'industrial compostability claim',
    home_compostable: 'home compostability claim',
    soil_biodegradable: 'soil biodegradation claim',
    marine_biodegradable: 'marine biodegradation claim',
    not_sure: 'not yet defined',
  },
  eol_cert: {
    no: 'not available',
    other_cert: 'available',
    available: 'available',
    planned: 'planned',
    none: 'not available',
    unknown: 'unknown',
    tuv_austria: 'TÜV Austria certification',
    din_certco: 'DIN CERTCO certification',
    bpi: 'BPI certification',
  },
  device_type: {
    packaging_non_sterile: 'non-sterile healthcare packaging',
    sterile_barrier_packaging: 'sterile barrier packaging',
    external_device_component: 'external device component',
    fluid_path_component: 'fluid-path component',
    implantable: 'implantable / long-term internal contact',
  },
  patient_contact: {
    none: 'no patient contact',
    surface_intact: 'skin contact',
    skin: 'skin contact',
    mucosal: 'mucosal contact',
    blood_path: 'blood / fluid-path contact',
    blood_or_fluid_path: 'blood / fluid-path contact',
    implant_contact: 'implant contact',
  },
  contact_duration_med: {
    lt_24h: 'limited contact duration',
    '24h_30d': 'prolonged contact duration',
    gt_30d: 'long-term contact duration',
    limited: 'limited contact duration',
    prolonged: 'prolonged contact duration',
    long_term: 'long-term contact duration',
  },
  sterilisation_medical: {
    none_required: 'none',
    none: 'none',
    eo: 'EtO sterilisation',
    eto: 'EtO sterilisation',
    gamma: 'gamma irradiation',
    ebeam: 'e-beam sterilisation',
    e_beam: 'e-beam sterilisation',
    steam: 'steam / autoclave sterilisation',
    tbd: 'unknown',
    unknown: 'unknown',
  },
};

function displayValue(field, value) {
  if (value === null || value === undefined || value === '') return 'unspecified';

  if (Array.isArray(value)) {
    const mapped = value
      .filter(v => v !== null && v !== undefined && v !== '')
      .map(v => displayValue(field, v));
    return mapped.length ? mapped.join(', ') : 'unspecified';
  }

  const raw = String(value);
  return DISPLAY_LABELS[field]?.[raw] ?? raw
    .replace(/_/g, ' ')
    .replace(/\b([a-z])/g, m => m.toUpperCase());
}

function beautifyTechnicalText(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(beautifyTechnicalText);
  if (typeof value !== 'string') return value;

  return value
    .replace(/"7_30_days"/g, '"7–30 days"')
    .replace(/"1_7_days"/g, '"1–7 days"')
    .replace(/"120_140c"/g, '"120–140°C"')
    .replace(/"100_120c"/g, '"100–120°C"')
    .replace(/"below_100c"/g, '"below 100°C"')
    .replace(/"above_140c"/g, '"above 140°C"')
    .replace(/"40_70c"/g, '"40–70°C"')
    .replace(/"lt_5c"/g, '"chilled / refrigerated"')
    .replace(/"lt_25c"/g, '"ambient"')
    .replace(/"lt_40c"/g, '"elevated ambient"')
    .replace(/"above_70"/g, '"above 70°C"')
    .replace(/"lt_24h"/g, '"short contact"')
    .replace(/"1_7d"/g, '"1–7 days"')
    .replace(/"7_30d"/g, '"7–30 days"')
    .replace(/"1_6m"/g, '"1–6 months"')
    .replace(/"gt_6m"/g, '"over 6 months"')
    .replace(/"lt_120"/g, '"below 120°C"')
    .replace(/"120_140"/g, '"120–140°C"')
    .replace(/"140_160"/g, '"140–160°C"')
    .replace(/"160_180"/g, '"160–180°C"')
    .replace(/"gt_180"/g, '"above 180°C"')
    .replace(/\bevoh\b/g, 'EVOH')
    .replace(/\bpla\b/g, 'PLA')
    .replace(/\bpha\b/g, 'PHA')
    .replace(/\bpbat\b/g, 'PBAT')
    .replace(/TDS status "partial"/g, 'TDS status "partially available"')
    .replace(/Supplier compliance status "partial"/g, 'Supplier compliance status "partially available"')
    .replace(/Supplier data status "partial"/g, 'Supplier data status "partially available"')
    .replace(/Sterilisation method "none"/g, 'Sterilisation method "none specified"')
    .replace(/Sterilisation method "eo"/g, 'Sterilisation method "EtO sterilisation"');
}


function cleanDisplayText(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(cleanDisplayText);
  if (typeof value !== 'string') return value;

  return value
    .replace(/Complex barrier system present\s*\(\s*\)\s*— equivalent biopolymer performance is uncertain/g,
      'Barrier information is incomplete — barrier performance should be confirmed if required')
    .replace(/Complex barrier system present\s*\(\s*\)/g,
      'Barrier information is incomplete');
}

function beautifyRiskDriver(driver) {
  if (!driver || typeof driver !== 'object') return driver;
  return {
    ...driver,
    label: cleanDisplayText(beautifyTechnicalText(driver.label)),
    contributingFactors: (driver.contributingFactors ?? []).map(v => cleanDisplayText(beautifyTechnicalText(v))),
  };
}

const SYSTEM_PROMPT = `You are a senior materials and processing consultant specialising in biodegradable polymer transitions for regulated food contact and medical/healthcare applications. You generate technical screening report narrative sections based on structured scoring data.

TASK
You will receive a JSON object called scoring_data. Generate exactly the seven narrative sections specified below. Return only a valid JSON object — no markdown fences, no preamble, no text outside the JSON object.

SCORING DATA CONTRACT
- finalScore: deterministic risk score (0-100). Do not dispute or modify.
- decisionBand: decision classification. Do not modify.
- decisionLabel: display string for the decision band.
- hardTriggers: active technical review flags. Reproduce their technical substance accurately. Do not add or remove triggers.
- categoryScores: per-category scoring breakdown. Use to calibrate analytical depth per dimension.
- topRiskFactors: ranked contributing risk factors. Use as primary narrative anchors.
- validationBurden: estimated test programme scope and complexity level.
- formInputs: typed form field values. Use only these — do not invent additional parameters.

REQUIRED OUTPUT — return a JSON object with exactly these keys:

"exec_summary": 80-140 words. Open with the decisionLabel and finalScore. Name the top 1-2 risk drivers. State the immediate recommended action.
"application_analysis": 120-200 words. Analyse the contact scenario or device application. Reference the relevant regulatory framework by name. Do not assert compliance or non-compliance.
"processing_behaviour": 120-200 words. Describe processing compatibility risk indicators for the candidate material class. Reference specific scoring dimensions. Where data is absent, describe the absence.
"risk_analysis": 150-250 words. Analyse the primary and secondary risk drivers. If hardTriggers are active, explain their technical basis in context. Do not characterise any material as safe, biocompatible, or suitable for contact.
"regulatory_burden": 80-150 words. Describe regulatory pathway complexity based on target markets and application class. Name applicable frameworks. Do not state compliance status.
"validation_summary": 80-150 words. Describe the indicated test programme scope based on validationBurden. Use "indicated" or "recommended" language. Reference specific test categories from estimatedTestCategories.
"recommended_next_step": 90-160 words. State specific bounded next actions as a paid technical review plan. Include 3-5 practical actions such as supplier evidence collection, test scope definition, processing compatibility checks, seal/barrier or sterilisation validation as applicable, and a pilot-readiness decision gate. Reference technical review flag conditions to be resolved first. End with specialist disciplines to be engaged.

ABSOLUTE PROHIBITIONS:
approved / food-safe / is biocompatible / are biocompatible / safe for medical use / safe for patient contact / medically safe / no migration risk / no toxicity risk / no safety concerns / is compliant / are compliant / fully compliant / meets requirements / has been validated for / validated material / validated grade / certified material / certified grade / suitable for food contact / suitable for patient contact / no safety issues

PROHIBITED INVENTIONS:
Do not generate specific material grades, trade names, supplier names, processing parameters, regulatory approval numbers, migration test results, biocompatibility results, or certification numbers not present in formInputs. If a field is null or absent, describe the absence.`;

function buildClaudePrompt(scoringResult) {
  const n = scoringResult.aiNarrativeInputs;

  const payload = {
    scoring_data: {
      route:              n.route,
      finalScore:         n.finalScore,
      decisionBand:       n.decisionBand,
      decisionLabel:      n.decisionLabel,
      hardTriggerCount:   n.hardTriggerCount,
      activeHardTriggers: n.activeHardTriggers,
      categoryScores:     n.categoryScores,
      topRiskFactors:     n.topRiskFactors,
      validationBurden: {
        level:                   scoringResult.validationBurden.level,
        estimatedTestCategories: refineValidationBurdenForApplication(scoringResult.validationBurden, scoringResult.aiNarrativeInputs?.formInputs ?? {}).estimatedTestCategories,
        specialistRequired:      scoringResult.validationBurden.specialistRequired,
      },
      formInputs: n.formInputs,
    },
  };

  return {
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload, null, 2),
  };
}

async function callClaudeApi(prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 2048,
        system:     prompt.system,
        messages:   [{ role: 'user', content: prompt.user }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

const REQUIRED_NARRATIVE_KEYS = [
  'exec_summary',
  'application_analysis',
  'processing_behaviour',
  'risk_analysis',
  'regulatory_burden',
  'validation_summary',
  'recommended_next_step',
];

function validateNarrativeSections(sections) {
  if (!sections || typeof sections !== 'object') return ['sections is not an object'];

  const violations = [];

  for (const key of REQUIRED_NARRATIVE_KEYS) {
    if (typeof sections[key] !== 'string' || !sections[key].trim()) {
      violations.push(`missing or empty section: ${key}`);
    }
  }

  for (const [key, text] of Object.entries(sections)) {
    if (typeof text !== 'string') continue;
    for (const pattern of PROHIBITED_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        violations.push(`prohibited phrase in "${key}": "${match[0]}"`);
      }
    }
  }

  return violations;
}

const DECISION_OPENERS = {
  proceed_controlled_validation:
    'The technical risk profile of this material transition is assessed as manageable under structured pilot conditions.',
  conditional_technical_review:
    'The technical risk profile of this material transition indicates one or more dimensions requiring resolution before pilot testing can be responsibly initiated.',
  hold_for_material_evidence:
    'The technical risk profile of this material transition indicates critical data gaps or conflicting technical parameters that prevent responsible pilot design at this stage.',
  not_recommended_reformulation:
    'The application conditions described exceed the current technical performance envelope of the candidate material class under review.',
  proceed_specialist_review:
    'The technical risk profile of this material transition does not indicate fundamental incompatibilities with the candidate material class at this stage.',
  proceed_regulatory_caution:
    'The technical risk profile of this material transition indicates elevated risk dimensions requiring specialist review before any validation activity begins.',
  not_recommended_specialist_reassessment:
    'The described application presents conditions that are not compatible with the candidate material class, or critical safety-relevant information is absent.',
};

const BURDEN_NARRATIVE = {
  low_medium:
    'The indicated validation programme is estimated to be of low-to-medium complexity. A targeted test programme addressing the specific contact scenario and material class characteristics should be designed by a qualified specialist.',
  medium:
    'The indicated validation programme is estimated to be of medium complexity. A structured programme covering migration or extractables characterisation, processing compatibility assessment, and applicable regulatory framework requirements is indicated.',
  high:
    'The indicated validation programme is estimated to be of high complexity. A comprehensive programme requiring third-party laboratory engagement, regulatory specialist input, and formal compliance pathway design is indicated before commercial use.',
  very_high:
    'The indicated validation programme is estimated to be of very high complexity. Material reformulation or alternative selection, comprehensive analytical testing, formal regulatory engagement, and supplier qualification are all indicated before this transition can be advanced.',
  critical:
    'The validation complexity for this application is assessed as critical. A specialist reassessment of the material selection and application design is required before any validation programme can be responsibly structured.',
};

function buildFallbackExecSummary(decision, scoring, riskProfile, hardTriggers) {
  const opener = DECISION_OPENERS[decision.band] ?? 'The material transition risk profile has been assessed.';
  const scoreStatement =
    ` This initial technical screening assigned a risk score of ${scoring.finalScore} out of 100, ` +
    `placing this project in the "${decision.label}" category.`;
  const floorNote = scoring.floorApplied
    ? ` The weighted score of ${scoring.rawScore} was elevated to ${scoring.finalScore} by an active technical review flag.`
    : '';
  const primaryDriver = riskProfile.primaryRiskDriver
    ? ` The primary risk contributor is ${String(riskProfile.primaryRiskDriver.label).toLowerCase()}, ` +
      `scoring ${riskProfile.primaryRiskDriver.score} of ${riskProfile.primaryRiskDriver.maxScore} available points.`
    : '';
  const triggerNote = hardTriggers.length > 0
    ? ` ${hardTriggers.length} technical review flag${hardTriggers.length > 1 ? 's are' : ' is'} active and should be reviewed before this transition proceeds.`
    : ' No technical review flags were activated during this screening.';

  return opener + scoreStatement + floorNote + primaryDriver + triggerNote +
    ` Recommended immediate action: ${decision.immediateAction}`;
}

function buildFallbackApplicationAnalysis(route, formInputs, targetMarkets) {
  const mktList = (targetMarkets ?? []).map(m => MARKET_LABEL[m] ?? m).join(', ') || 'the specified target market(s)';

  if (route === 'food') {
    const fwList = (targetMarkets ?? []).map(m => FOOD_FRAMEWORK[m]).filter(Boolean).join('; ') ||
      'the applicable regulatory framework(s)';
    return (
      `The packaging application involves direct food contact with "${displayValue('food_type', formInputs.food_type)}" ` +
      `at a maximum contact temperature of "${displayValue('contact_temp', formInputs.contact_temp)}" and an expected contact duration ` +
      `of "${displayValue('contact_duration', formInputs.contact_duration)}". This combination determines the applicable food simulant class ` +
      `and migration test conditions under the relevant regulatory frameworks. ` +
      `The target markets — ${mktList} — indicate the following frameworks apply: ${fwList}. ` +
      `Each jurisdiction defines overall migration limits and substance-specific migration limits against which the candidate material must be characterised.`
    );
  }

  if (route === 'medical') {
    const fwList = (targetMarkets ?? []).map(m => MEDICAL_FRAMEWORK[m]).filter(Boolean).join('; ') ||
      'the applicable regulatory framework(s)';
    return (
      `The described application involves a "${displayValue('device_type', formInputs.device_type)}" with ` +
      `patient contact classified as "${displayValue('patient_contact', formInputs.patient_contact)}" and a contact duration of ` +
      `"${displayValue('contact_duration_med', formInputs.contact_duration_med)}". Under ISO 109109-1, this combination determines the applicable biological evaluation category. ` +
      `The target markets — ${mktList} — indicate the following regulatory frameworks apply: ${fwList}. A qualified regulatory affairs specialist is required to confirm the appropriate pathway.`
    ).replace('ISO 109109-1', 'ISO 10993-1');
  }

  return 'Application analysis could not be generated for the specified route.';
}

function buildFallbackProcessingBehaviour(route, formInputs, candidateMaterial) {
  const matList = displayValue('candidate_material', candidateMaterial ?? []) || 'the candidate material class';

  if (route === 'food') {
    const barriers = (formInputs.barrier_layer ?? [])
      .filter(b => b !== 'none' && b !== 'unknown')
      .map(b => displayValue('barrier_layer', b))
      .join(', ') || 'no complex barrier layers';

    return (
      `The current process operates with a heat-seal temperature range of "${displayValue('seal_temp', formInputs.seal_temp)}" ` +
      `and an in-pack process of "${displayValue('inpack_process', formInputs.inpack_process)}". For the candidate material class (${matList}), ` +
      `compatibility with the available processing window is a key transition risk. The current barrier system includes: ${barriers}. ` +
      `Processing compatibility must be characterised on production-representative equipment before pilot validation is designed.`
    );
  }

  if (route === 'medical') {
    const steril = formInputs.sterilisation_medical;
    if (steril === 'none_required' || steril === 'none' || !steril) {
      return (
        `No sterilisation method is specified for the described healthcare application. ` +
        `For the candidate material class (${matList}), the primary processing review should focus on material identification, dimensional stability, supplier evidence, and performance under the intended storage and handling conditions.`
      );
    }

    return (
      `The intended sterilisation method is "${displayValue('sterilisation_medical', formInputs.sterilisation_medical)}". ` +
      `For the candidate material class (${matList}), sterilisation compatibility is a critical transition risk dimension. ` +
      `Dimensional stability, aging, and material performance under the described contact conditions should be reviewed before validation planning.`
    );
  }

  return 'Processing behaviour assessment could not be generated for the specified route.';
}

function buildFallbackRiskAnalysis(riskProfile, hardTriggers, scoring) {
  const parts = [];

  if (riskProfile.primaryRiskDriver) {
    const pd = riskProfile.primaryRiskDriver;
    parts.push(`The primary risk contributor in this screening is ${beautifyTechnicalText(pd.label).toLowerCase()}, scoring ${pd.score} out of a maximum ${pd.maxScore} points in this dimension.`);
    if (pd.contributingFactors?.length) {
      parts.push(`Contributing factors in this dimension: ${pd.contributingFactors.map(beautifyTechnicalText).join('; ')}.`);
    }
  }

  if (riskProfile.secondaryRiskDriver) {
    const sd = riskProfile.secondaryRiskDriver;
    parts.push(`The secondary risk contributor is ${beautifyTechnicalText(sd.label).toLowerCase()}, contributing ${sd.score} of ${sd.maxScore} points.`);
    if (sd.contributingFactors?.length) {
      parts.push(beautifyTechnicalText(sd.contributingFactors[0]));
    }
  }

  if (hardTriggers.length > 0) {
    parts.push(`The following technical review ${hardTriggers.length > 1 ? 'flags were' : 'flag was'} activated:`);
    for (const t of hardTriggers) {
      parts.push(`[${String(t.severity).toUpperCase()} — ${t.label ?? t.id}] ${t.description}`);
    }
  }

  if (scoring.floorApplied && scoring.floorReason) {
    parts.push(`The final score of ${scoring.finalScore} reflects an upward adjustment from the weighted score of ${scoring.rawScore}, applied because the active technical review flag "${scoring.floorReason}" imposes a minimum score floor for this application type.`);
  } else if (hardTriggers.length === 0) {
    parts.push('No technical review flags were activated during this screening. The risk score reflects the aggregate of weighted category contributions only.');
  }

  return parts.join(' ');
}

function buildFallbackRegulatoryBurden(formInputs, route, targetMarkets, nMarkets) {
  const frameworkMap = route === 'food' ? FOOD_FRAMEWORK : MEDICAL_FRAMEWORK;
  const mktItems = (targetMarkets ?? []).map(m => {
    const fw = frameworkMap[m];
    return fw ? `${MARKET_LABEL[m] ?? m} (${fw})` : (MARKET_LABEL[m] ?? m);
  });

  const mktSentence = mktItems.length > 0
    ? `The target market scope covers ${nMarkets} jurisdiction${nMarkets !== 1 ? 's' : ''}: ${mktItems.join('; ')}.`
    : 'The target market scope has not been fully defined.';

  const complexityNote = nMarkets >= 4
    ? ' A multi-jurisdictional compliance programme requires parallel engagement across frameworks with materially different positive list status, submission requirements, and timelines.'
    : nMarkets >= 2
    ? ' A multi-market programme requires careful sequencing of regulatory activities, as positive list status for biodegradable materials and submission timelines vary by jurisdiction.'
    : ' A single-market compliance programme has a more bounded regulatory scope, though specialist input is required to confirm the documentation pathway.';

  const classNote = (route === 'medical' && formInputs.device_class && formInputs.device_class !== 'unknown')
    ? ` The indicated device classification (${String(formInputs.device_class).toUpperCase().replace('_', ' ')}) determines the material change assessment pathway and submission requirements under each applicable framework.`
    : '';

  return mktSentence + complexityNote + classNote +
    ' Regulatory affairs specialist input is required before validation activities begin.';
}


function isMedicalNonSterileLowExposure(input) {
  if (input?.route !== 'medical') return false;
  const med = input.medical ?? {};
  const steril = med.sterilisation_medical ?? '';
  const device = med.device_type ?? '';
  const patient = med.patient_contact ?? '';
  return (
    device === 'packaging_non_sterile' &&
    (steril === 'none_required' || steril === 'none' || steril === '') &&
    (patient === 'none' || patient === 'unknown')
  );
}

function refineValidationBurdenForApplication(validationBurden, input) {
  const refined = {
    ...(validationBurden ?? {}),
    estimatedTestCategories: [...((validationBurden?.estimatedTestCategories) ?? [])],
  };

  if (!isMedicalNonSterileLowExposure(input)) return refined;

  refined.estimatedTestCategories = refined.estimatedTestCategories
    .filter(item => {
      const s = String(item).toLowerCase();
      if (s.includes('sterile barrier')) return false;
      if (s.includes('sterilisation compatibility')) return false;
      if (s.includes('sterilization compatibility')) return false;
      if (s.includes('sterilisation validation')) return false;
      if (s.includes('sterilization validation')) return false;
      if (s.includes('accelerated aging study') || s.includes('accelerated ageing study')) return false;
      return true;
    });

  if (!refined.estimatedTestCategories.length) {
    refined.estimatedTestCategories = [
      'Supplier evidence and material characterisation review',
      'ISO 10993-1 applicability screening based on no-patient-contact use',
      'Processing compatibility and dimensional stability check under intended use conditions',
      'Packaging performance review against customer and distribution requirements',
    ];
  }

  return refined;
}

function buildFallbackValidationSummary(validationBurden) {
  const levelText = BURDEN_NARRATIVE[validationBurden.level] ?? 'The validation programme scope has not been determined.';
  const tests = (validationBurden.estimatedTestCategories ?? []).slice(0, 5);
  const testStr = tests.length > 0 ? ` Indicated test categories include: ${tests.join('; ')}.` : '';
  const spNote  = validationBurden.specialistRequired
    ? ' A qualified specialist is indicated before this programme is designed.'
    : '';

  return levelText + testStr + spNote;
}


function buildNonSterileMedicalValidationSummary(validationBurden) {
  const tests = (validationBurden.estimatedTestCategories ?? []).slice(0, 5);
  const testStr = tests.length > 0 ? ` Indicated review categories include: ${tests.join('; ')}.` : '';

  return (
    'For this non-sterile, no-patient-contact healthcare packaging scenario, the indicated validation scope is bounded. ' +
    'The review should focus on supplier evidence, ISO 10993-1 applicability screening, material characterisation, processing compatibility, and packaging performance under intended storage and handling conditions.' +
    testStr +
    ' A qualified medical-material and regulatory specialist should confirm the final scope before customer submission or validation planning.'
  );
}

function buildNonSterileMedicalNextStep(decision, validationBurden) {
  const specialists = [];
  if (validationBurden.specialistRequired)                 specialists.push('materials and processing specialist');
  if (validationBurden.regulatorySpecialistRequired)       specialists.push('regulatory affairs specialist');
  if (validationBurden.biocompatibilitySpecialistRequired) specialists.push('biocompatibility toxicologist');

  const spNote = specialists.length > 0
    ? ` Specialist disciplines to be engaged: ${specialists.join('; ')}.`
    : '';

  return (
    `${decision.immediateAction} ` +
    `For this non-sterile, no-patient-contact healthcare packaging use, the next paid technical work package should be bounded and evidence-focused: ` +
    `1) confirm supplier TDS, composition disclosure status, material identification, and quality-system evidence; ` +
    `2) confirm the ISO 10993-1 applicability rationale for no-patient-contact use and determine whether any limited extractables/leachables review is needed; ` +
    `3) review processing compatibility, dimensional stability, and packaging performance under intended storage and handling conditions; ` +
    `4) confirm customer, distribution, and documentation requirements before any validation activity is initiated; ` +
    `5) issue a specialist review decision gate identifying whether the project can proceed to targeted validation, requires additional supplier evidence, or should remain at screening stage.` +
    spNote
  );
}

function buildFallbackNextStep(decision, hardTriggers, validationBurden) {
  const activeReviewFlags = hardTriggers
    .filter(t => t.floorScore !== null)
    .map(t => t.label ?? t.id)
    .join('; ');

  const flagNote = activeReviewFlags
    ? ` First, resolve the active technical review flag condition(s): ${activeReviewFlags}.`
    : '';

  const specialists = [];
  if (validationBurden.specialistRequired)                 specialists.push('materials and processing specialist');
  if (validationBurden.regulatorySpecialistRequired)       specialists.push('regulatory affairs specialist');
  if (validationBurden.biocompatibilitySpecialistRequired) specialists.push('biocompatibility toxicologist');

  const spNote = specialists.length > 0
    ? ` Specialist disciplines to be engaged: ${specialists.join('; ')}.`
    : '';

  const testScope = (validationBurden.estimatedTestCategories ?? []).slice(0, 4).join('; ');

  return (
    `${decision.immediateAction}${flagNote} ` +
    `For a commercial-grade transition review, the next step should be structured as a paid technical work package: ` +
    `1) collect and screen final supplier evidence, including TDS, composition disclosure status, declarations, and available test data; ` +
    `2) define the validation scope against the declared application and target market(s)` +
    (testScope ? `, including ${testScope}` : '') + `; ` +
    `3) review processing compatibility and identify the minimum pilot conditions required to avoid premature scale-up; ` +
    `4) issue a pilot-readiness decision gate identifying whether the project should proceed, pause for evidence, or require material/process redesign.` +
    spNote
  );
}

function deterministicFallbackNarrative(scoringResult) {
  const { decision, scoring, hardTriggers, riskProfile, validationBurden, aiNarrativeInputs } = scoringResult;
  const { formInputs, route } = aiNarrativeInputs;
  const targetMarkets = formInputs.target_markets ?? [];
  const nMarkets = formInputs.n_markets ?? 0;
  const refinedValidationBurden = refineValidationBurdenForApplication(validationBurden, formInputs);

  return {
    source: 'fallback',
    sections: {
      exec_summary:          buildFallbackExecSummary(decision, scoring, riskProfile, hardTriggers),
      application_analysis:  buildFallbackApplicationAnalysis(route, formInputs, targetMarkets),
      processing_behaviour:  buildFallbackProcessingBehaviour(route, formInputs, formInputs.candidate_material),
      risk_analysis:         buildFallbackRiskAnalysis(riskProfile, hardTriggers, scoring),
      regulatory_burden:     buildFallbackRegulatoryBurden(formInputs, route, targetMarkets, nMarkets),
      validation_summary:    buildFallbackValidationSummary(refinedValidationBurden),
      recommended_next_step: buildFallbackNextStep(decision, hardTriggers, refinedValidationBurden),
    },
  };
}

async function tryClaudeNarrative(scoringResult) {
  if (!AI_ENABLED || !process.env.ANTHROPIC_API_KEY) {
    console.log('[server_advanced] AI narrative unavailable — using deterministic fallback.');
    return deterministicFallbackNarrative(scoringResult);
  }

  const prompt = buildClaudePrompt(scoringResult);

  try {
    const sections = await callClaudeApi(prompt, CLAUDE_TIMEOUT_MS);
    const violations = validateNarrativeSections(sections);

    if (violations.length > 0) {
      console.warn('[server_advanced] Claude narrative validation failed:', violations, '— using fallback.');
      return deterministicFallbackNarrative(scoringResult);
    }

    console.log('[server_advanced] Claude narrative accepted.');
    return { source: 'claude', sections };

  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.warn(`[server_advanced] Claude narrative failed (${reason}) — using deterministic fallback.`);
    return deterministicFallbackNarrative(scoringResult);
  }
}

function levelFromScore(score, thresholds) {
  if (score >= thresholds.high) return 'High';
  if (score >= thresholds.structured) return 'Structured';
  if (score >= thresholds.conditional) return 'Conditional';
  return 'Low';
}

function buildEvidenceMeta(scoringResult) {
  const c = scoringResult.confidence ?? {};
  const b = c.breakdown ?? {};

  const evidence = Number.isFinite(b.evidence) ? b.evidence : 75;
  const clarity = Number.isFinite(b.clarity) ? b.clarity : 75;
  const assumption = Number.isFinite(b.assumptionDependency) ? b.assumptionDependency : 25;

  const dataCompletenessScore = Math.round((0.60 * evidence) + (0.40 * clarity));
  const evidenceStrengthScore = Math.round(evidence);
  const assumptionRelianceScore = Math.round(assumption);

  let assumptionLevel = 'Low';
  if (assumptionRelianceScore >= 70) assumptionLevel = 'Very High';
  else if (assumptionRelianceScore >= 45) assumptionLevel = 'High';
  else if (assumptionRelianceScore >= 20) assumptionLevel = 'Moderate';

  const dataLevel = levelFromScore(dataCompletenessScore, { high: 85, structured: 70, conditional: 50 });
  const evidenceLevel = levelFromScore(evidenceStrengthScore, { high: 85, structured: 70, conditional: 50 });

  const missingDrivers = [];
  if (evidenceStrengthScore < 85) missingDrivers.push('supplier / material evidence');
  if (clarity < 85) missingDrivers.push('application or processing clarity');
  if (assumptionRelianceScore >= 20) missingDrivers.push('unresolved assumptions');

  return {
    dataCompleteness: {
      score: dataCompletenessScore,
      level: dataLevel,
      basis: 'Derived from material evidence availability and application / processing clarity.',
    },
    evidenceStrength: {
      score: evidenceStrengthScore,
      level: evidenceLevel,
      basis: 'Derived from TDS availability, supplier data status, and route-specific supplier quality indicators.',
    },
    assumptionReliance: {
      score: assumptionRelianceScore,
      level: assumptionLevel,
      basis: missingDrivers.length
        ? `Main dependency: ${missingDrivers.join(', ')}.`
        : 'No material assumption dependency was identified from the submitted fields.',
    },
  };
}

function buildIndustryPathway(input, scoringResult) {
  const fmt = input.product_format ?? 'unspecified';
  const route = input.route;

  const pathwayMap = {
    film_flexible_packaging: 'Flexible Packaging Pathway',
    flexible_packaging: 'Flexible Packaging Pathway',
    film: 'Flexible Packaging Pathway',
    rigid_packaging: 'Rigid Packaging Pathway',
    sheet_thermoforming: 'Sheet / Thermoforming Pathway',
    injection_moulding: 'Injection Moulding Pathway',
    injection_molding: 'Injection Moulding Pathway',
    agricultural_film: 'Agricultural Film Pathway',
    medical_packaging: 'Medical Packaging Pathway',
    sterile_barrier_packaging: 'Medical Sterile Packaging Pathway',
    device_component: 'Medical Device Component Pathway',
  };

  let label = pathwayMap[fmt] ?? (route === 'medical' ? 'Medical / Healthcare Pathway' : 'Food Packaging Pathway');
  if (route === 'medical' && input.medical?.device_type === 'sterile_barrier_packaging') {
    label = 'Medical Sterile Packaging Pathway';
  }
  if (route === 'food' && (fmt === 'film' || fmt === 'film_flexible_packaging' || fmt === 'flexible_packaging')) {
    label = 'Flexible Food Packaging Pathway';
  }

  const burdenLevel = scoringResult.validationBurden?.level;
  const burden = BURDEN_LEVEL_DISPLAY[burdenLevel] ?? scoringResult.validationBurden?.levelDisplay ?? burdenLevel ?? 'to be confirmed';
  const primary = scoringResult.riskProfile?.primaryRiskDriver?.label ?? 'application-specific transition risk';

  return {
    label,
    productFormat: displayValue('product_format', fmt),
    implementationBurden: burden,
    primaryConstraint: beautifyTechnicalText(primary),
    nextGate: scoringResult.decision?.immediateAction ?? 'Define evidence package and validation gate before pilot planning.',
  };
}

function buildStandardsLinkage(input, scoringResult) {
  const rows = [];

  if (input.route === 'food') {
    const food = input.food ?? {};
    const markets = input.target_markets ?? [];

    const migrationRefs = [];
    if (markets.includes('eu')) migrationRefs.push('EU Regulation 10/2011');
    if (markets.includes('us')) migrationRefs.push('FDA 21 CFR food contact framework');
    if (markets.includes('uk')) migrationRefs.push('UK Food Contact Materials Regulations');
    if (markets.includes('canada')) migrationRefs.push('Health Canada / Canadian food packaging framework');
    if (markets.includes('japan')) migrationRefs.push('MHLW Notification 370');
    if (markets.includes('china')) migrationRefs.push('GB 4806 series');
    if (markets.includes('india')) migrationRefs.push('FSSAI food-contact packaging framework');
    if (markets.includes('anz')) migrationRefs.push('FSANZ / Australia-New Zealand food packaging framework');
    if (markets.includes('asean') || markets.includes('sea')) migrationRefs.push('ASEAN national food-contact frameworks');
    if (markets.includes('gcc') || markets.includes('middle_east')) migrationRefs.push('GSO / national GCC food-contact frameworks');

    rows.push({
      condition: `Food contact scenario: ${displayValue('food_type', food.food_type)} / ${displayValue('contact_temp', food.contact_temp)} / ${displayValue('contact_duration', food.contact_duration)}`,
      validationCategory: 'Overall and specific migration test scope',
      reference: migrationRefs.length ? migrationRefs.join('; ') : 'Target-market food-contact framework to be confirmed',
      reason: 'Food type, contact temperature, and contact duration determine simulant selection and worst-case migration conditions.',
    });

    if (food.seal_temp || food.inpack_process) {
      rows.push({
        condition: `Processing window: seal ${displayValue('seal_temp', food.seal_temp)}; in-pack process ${displayValue('inpack_process', food.inpack_process)}`,
        validationCategory: 'Seal strength, hot-tack, thermal stability, and process-window verification',
        reference: 'ASTM F88 / ASTM F2029 / internal process validation protocol',
        reason: 'Biopolymer transitions are sensitive to heat-seal temperature, thermal history, and line-speed conditions.',
      });
    }

    const barriers = Array.isArray(food.barrier_layer) ? food.barrier_layer.filter(b => !['none', 'unknown'].includes(b)) : [];
    if (barriers.length) {
      rows.push({
        condition: `Barrier structure: ${displayValue('barrier_layer', barriers)}`,
        validationCategory: 'OTR / WVTR and barrier retention after processing',
        reference: 'ASTM D3985 / ASTM F1249 / ISO 15106 as applicable',
        reason: 'Barrier layers must be validated against shelf-life and distribution conditions after material substitution.',
      });
    }

    if (input.eol_claim && !['none', 'tbd', 'not_sure'].includes(input.eol_claim)) {
      rows.push({
        condition: `End-of-life claim: ${displayValue('eol_claim', input.eol_claim)}`,
        validationCategory: 'Compostability / biodegradation claim substantiation',
        reference: 'EN 13432 / ISO 17088 / ASTM D6400 / OECD biodegradation methods as applicable',
        reason: 'Environmental claims require a recognised test route and certification basis before commercial communication.',
      });
    }

    return rows;
  }

  const medical = input.medical ?? {};
  rows.push({
    condition: `Patient contact: ${displayValue('patient_contact', medical.patient_contact)} / ${displayValue('contact_duration_med', medical.contact_duration_med)}`,
    validationCategory: 'Biological evaluation planning',
    reference: 'ISO 10993-1 / ISO 10993-18 / ISO 10993-17 as applicable',
    reason: 'Patient-contact nature and duration define the biological evaluation category and extractables/leachables scope.',
  });

  if (medical.sterilisation_medical && !['none', 'none_required'].includes(medical.sterilisation_medical)) {
    rows.push({
      condition: `Sterilisation method: ${displayValue('sterilisation_medical', medical.sterilisation_medical)}`,
      validationCategory: 'Sterilisation compatibility and validation pathway',
      reference: 'ISO 11135 / ISO 11137 / ISO 17665 as applicable',
      reason: 'Sterilisation can change polymer chemistry, mechanical retention, extractables profile, and sterile barrier performance.',
    });
  }

  if (medical.device_type === 'sterile_barrier_packaging') {
    rows.push({
      condition: 'Sterile barrier packaging application',
      validationCategory: 'Sterile barrier integrity, seal characterisation, aging, and distribution simulation',
      reference: 'ISO 11607 / ASTM F1980 / ASTM F88 / ASTM D4169 as applicable',
      reason: 'Sterile barrier systems must retain package integrity through sterilisation, aging, distribution, and handling.',
    });
  }

  return rows;
}

function buildExecutiveSnapshot(scoringResult, input) {
  const primary = scoringResult.riskProfile?.primaryRiskDriver?.label || 'Application-specific transition risk';
  const secondary = scoringResult.riskProfile?.secondaryRiskDriver?.label || 'evidence and validation planning';
  const decision = scoringResult.decision?.label || 'Decision pending';
  const burden = BURDEN_LEVEL_DISPLAY[scoringResult.validationBurden?.level] ?? scoringResult.validationBurden?.level ?? 'To be confirmed';
  const evidence = scoringResult.confidence?.breakdown?.evidence;

  const nextEvidence = evidence !== undefined && evidence < 85
    ? 'Supplier evidence, TDS, declarations, and applicable test data should be assembled before pilot planning.'
    : 'Existing evidence is sufficient for screening, but final supplier documentation and validation scope should still be confirmed.';

  if (input.route === 'food') {
    const keyOpportunity = 'The project can be evaluated through a bounded food-contact transition pathway using contact scenario, processing window, material evidence, and claim-position checks.';
    const keyLimitation = `${primary} is the main limitation identified by the deterministic engine.`;
    const implementationBurden = `${burden}. Implementation burden is mainly linked to ${String(secondary).toLowerCase()}.`;
    const decisionRecommendation = `${decision}: ${scoringResult.decision?.immediateAction ?? 'Define validation gate before pilot planning.'}`;

    return {
      keyOpportunity,
      keyLimitation,
      implementationBurden,
      decisionRecommendation,
      requiredNextEvidence: nextEvidence,
      primaryOpportunity: keyOpportunity,
      coreConstraint: keyLimitation,
      implementationRisk: implementationBurden,
    };
  }

  const keyOpportunity = 'The project can be advanced as a specialist healthcare material review if the application boundary, supplier quality position, and validation pathway are clearly defined.';
  const keyLimitation = `${primary} is the main limitation identified by the deterministic engine and should be reviewed with medical-material and regulatory specialist oversight.`;
  const implementationBurden = `${burden}. Implementation burden is mainly linked to ${String(secondary).toLowerCase()}.`;
  const decisionRecommendation = `${decision}: ${scoringResult.decision?.immediateAction ?? 'Define specialist review gate before validation planning.'}`;

  return {
    keyOpportunity,
    keyLimitation,
    implementationBurden,
    decisionRecommendation,
    requiredNextEvidence: nextEvidence,
    primaryOpportunity: keyOpportunity,
    coreConstraint: keyLimitation,
    implementationRisk: implementationBurden,
  };
}

function buildStandardsReferences(input) {
  if (input.route === 'food') {
    const refs = [];
    const markets = input.target_markets ?? [];
    if (markets.includes('eu')) refs.push('EU Regulation 10/2011');
    if (markets.includes('uk')) refs.push('UK Food Contact Materials Regulations');
    if (markets.includes('us')) refs.push('FDA 21 CFR food contact framework');
    if (markets.includes('canada')) refs.push('Health Canada / Canadian food packaging framework');
    if (markets.includes('japan')) refs.push('MHLW Notification 370');
    if (markets.includes('china')) refs.push('GB 4806 series');
    if (markets.includes('india')) refs.push('FSSAI food-contact packaging framework');
    if (markets.includes('anz')) refs.push('FSANZ / Australia-New Zealand food packaging framework');
    if (markets.includes('asean') || markets.includes('sea')) refs.push('ASEAN national food-contact frameworks');
    if (markets.includes('gcc') || markets.includes('middle_east')) refs.push('GSO / national GCC food-contact frameworks');
    if (input.food?.barrier_layer?.some?.(b => !['none', 'unknown'].includes(b))) {
      refs.push('ASTM D3985 / ASTM F1249 / ISO 15106 — barrier performance references');
    }
    if (input.food?.seal_temp || input.food?.inpack_process) {
      refs.push('ASTM F88 / ASTM F2029 — seal strength and hot-tack references');
    }
    if (input.eol_claim && !['none', 'tbd', 'not_sure'].includes(input.eol_claim)) {
      refs.push('EN 13432 / ISO 17088 / ASTM D6400 — compostability claim references');
    }
    return refs.length ? refs : ['Food contact migration framework — target market dependent'];
  }

  const refs = ['ISO 10993-1 / ISO 10993-18 / ISO 10993-17 — biological evaluation and toxicological risk framework'];
  const steril = input.medical?.sterilisation_medical ?? '';
  if (!['none_required', 'none', ''].includes(steril)) {
    refs.push('ISO 11135 / ISO 11137 / ISO 17665 — sterilisation pathway as applicable');
  }
  if (input.medical?.device_type === 'sterile_barrier_packaging') {
    refs.push('ISO 11607 / ASTM F1980 / ASTM F88 / ASTM D4169 — sterile barrier, aging, seal, and distribution references');
  } else if (!isMedicalNonSterileLowExposure(input)) {
    refs.push('ISO 11607 — sterile barrier packaging where applicable');
  }
  return refs;
}

function buildPdfDataObject(scoringResult, narrativeResult, input) {
  const now = new Date();
  const reportId = generateReportId();

  const categoryArray = Object.entries(scoringResult.scoring.categoryBreakdown).map(([key, val]) => ({
    key,
    label:               cleanDisplayText(beautifyTechnicalText(val.label)),
    score:               val.score,
    maxScore:            val.maxScore,
    contributingFactors: (val.contributingFactors ?? []).map(v => cleanDisplayText(beautifyTechnicalText(v))),
  }));

  const executiveSnapshot = scoringResult.executive ?? buildExecutiveSnapshot(scoringResult, input);
  const standardsReferences = scoringResult.standards ?? buildStandardsReferences(input);
  const evidenceMeta = buildEvidenceMeta(scoringResult);
  const standardsLinkage = buildStandardsLinkage(input, scoringResult);
  const industryPathway = buildIndustryPathway(input, scoringResult);
  const refinedValidationBurden = refineValidationBurdenForApplication(scoringResult.validationBurden, input);
  const isNonSterileLowExposureMedical = isMedicalNonSterileLowExposure(input);

  return {
    reportMeta: {
      reportId,
      reportDate:        now.toISOString().split('T')[0],
      reportDateDisplay: formatDateDisplay(now),
      reportVersion:     SERVER_VERSION,
      engineVersion:     ENGINE_VERSION,
      route:             input.route,
      routeLabel:        ROUTE_LABEL[input.route] ?? input.route,
      companyName:       input.company_name ?? 'Confidential',
      projectName:       input.project_name ?? 'Unspecified Project',
      narrativeSource:   narrativeResult.source,
      targetMarkets:     (input.target_markets ?? []).map(m => MARKET_LABEL[m] ?? m),
      reportLanguage:    input.report_language ?? 'en',
    },

    scoring: {
      finalScore:    scoringResult.scoring.finalScore,
      rawScore:      scoringResult.scoring.rawScore,
      baselineScore: scoringResult.scoring.baselineScore,
      floorApplied:  scoringResult.scoring.floorApplied,
      floorReason:   scoringResult.scoring.floorReason,
      categoryArray,
      scoreBarWidth: `${scoringResult.scoring.finalScore}%`,
    },

    decision: {
      band:            scoringResult.decision.band,
      label:           scoringResult.decision.label,
      color:           scoringResult.decision.color,
      immediateAction: scoringResult.decision.immediateAction,
      badgeClass:      `decision-${scoringResult.decision.color}`,
    },

    confidence: scoringResult.confidence ?? {
      score: 75,
      level: 'Moderate',
      rationale: 'Confidence is estimated from the available input evidence and declared application clarity.',
      breakdown: {},
    },

    hardTriggers: scoringResult.hardTriggers.map(t => ({
      ...t,
      label:       cleanDisplayText(beautifyTechnicalText(t.label)),
      description: cleanDisplayText(beautifyTechnicalText(t.description)),
    })),
    hasHardTriggers: scoringResult.hardTriggers.length > 0,

    riskProfile: {
      primaryRiskDriver:   beautifyRiskDriver(scoringResult.riskProfile.primaryRiskDriver),
      secondaryRiskDriver: beautifyRiskDriver(scoringResult.riskProfile.secondaryRiskDriver),
      topRiskFactors:      (scoringResult.riskProfile.topRiskFactors ?? []).map(v => cleanDisplayText(beautifyTechnicalText(v))),
    },

    validationBurden: {
      level:                              scoringResult.validationBurden.level,
      levelDisplay:                       BURDEN_LEVEL_DISPLAY[scoringResult.validationBurden.level] ?? scoringResult.validationBurden.level,
      estimatedTestCategories:            (refinedValidationBurden.estimatedTestCategories ?? []).map(v => cleanDisplayText(beautifyTechnicalText(v))),
      specialistRequired:                 scoringResult.validationBurden.specialistRequired,
      regulatorySpecialistRequired:       scoringResult.validationBurden.regulatorySpecialistRequired ?? false,
      biocompatibilitySpecialistRequired: scoringResult.validationBurden.biocompatibilitySpecialistRequired ?? false,
    },

    narrative: {
      exec_summary:          cleanDisplayText(beautifyTechnicalText(narrativeResult.sections.exec_summary)),
      application_analysis:  cleanDisplayText(beautifyTechnicalText(narrativeResult.sections.application_analysis)),
      processing_behaviour:  cleanDisplayText(beautifyTechnicalText(narrativeResult.sections.processing_behaviour)),
      risk_analysis:         cleanDisplayText(beautifyTechnicalText(narrativeResult.sections.risk_analysis)),
      regulatory_burden:     cleanDisplayText(beautifyTechnicalText(narrativeResult.sections.regulatory_burden)),
      validation_summary:    cleanDisplayText(beautifyTechnicalText(
        isNonSterileLowExposureMedical
          ? buildNonSterileMedicalValidationSummary(refinedValidationBurden)
          : narrativeResult.sections.validation_summary
      )),
      recommended_next_step: cleanDisplayText(beautifyTechnicalText(
        isNonSterileLowExposureMedical
          ? buildNonSterileMedicalNextStep(scoringResult.decision, refinedValidationBurden)
          : narrativeResult.sections.recommended_next_step
      )),
    },

    sections: {
      showImplantStop:  false,
      showHardTriggers: scoringResult.hardTriggers.length > 0,
      showFloorNote:    scoringResult.scoring.floorApplied,
      isFoodRoute:      input.route === 'food',
      isMedicalRoute:   input.route === 'medical',
    },

    executive: executiveSnapshot,
    evidenceMeta,
    standards: standardsReferences,
    standardsLinkage,
    industryPathway,
    disclaimer: REPORT_DISCLAIMER,
  };
}

function injectDataIntoTemplate(pdfData) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const jsonStr = JSON.stringify(pdfData).replace(/<\/script>/gi, '<\\/script>');
  const injection = `<script type="application/json" id="fv-report-data">${jsonStr}</script>`;

  const result = template.replace('<!-- REPORT_DATA_INJECTION -->', injection);

  if (result === template) {
    throw new Error('template_advanced.html is missing the required <!-- REPORT_DATA_INJECTION --> placeholder.');
  }

  return result;
}

async function renderHtmlToPdf(html) {
  let browser = null;

  try {
    browser = await puppeteer.launch({ args: PUPPETEER_ARGS });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    return await page.pdf({
      format:          'A4',
      printBackground: true,
      margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
    });
  } finally {
    if (browser) await browser.close();
  }
}

async function renderPdfFromTemplate(pdfData) {
  return renderHtmlToPdf(injectDataIntoTemplate(pdfData));
}

function generateImplantReferralHtml(scoringResult, input) {
  const reportId = generateReportId();
  const dateStr  = formatDateDisplay(new Date());
  const company  = input.company_name ?? 'Confidential';
  const project  = input.project_name ?? 'Unspecified Project';
  const msg      = scoringResult.referralMessage ?? '';

  const medical = input.medical ?? {};
  const markets = Array.isArray(input.target_markets) && input.target_markets.length
    ? input.target_markets.map(m => displayValue('target_markets', m)).join(', ')
    : 'unspecified';

  const candidate = displayValue('candidate_material', input.candidate_material ?? []);
  const current   = displayValue('current_material', input.current_material);
  const device    = displayValue('device_type', medical.device_type);
  const contact   = displayValue('patient_contact', medical.patient_contact);
  const duration  = displayValue('contact_duration_med', medical.contact_duration_med);
  const steril    = displayValue('sterilisation_medical', medical.sterilisation_medical);
  const medGrade  = displayValue('medical_grade_supplier', medical.medical_grade_supplier);
  const iso13485  = displayValue('iso_13485_supplier', medical.iso_13485_supplier);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; color: #10233f; background: #fff; line-height: 1.55; }
  .page { width: 210mm; min-height: 297mm; padding: 22mm 23mm 18mm; page-break-after: always; position: relative; }
  .page:last-child { page-break-after: auto; }
  .cover { background: linear-gradient(135deg, rgba(42,87,135,.96), rgba(10,33,59,.98)); color: #fff; padding: 20mm 23mm 18mm; }
  .cover-kicker { font-size: 8.5pt; letter-spacing: .22em; text-transform: uppercase; color: rgba(255,255,255,.64); margin-bottom: 18mm; }
  .cover-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 18mm; align-items: end; border-bottom: 2px solid rgba(255,255,255,.28); padding-bottom: 18mm; }
  .brand { font-size: 33pt; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .report-title { margin-top: 7mm; font-size: 15pt; color: rgba(255,255,255,.78); font-weight: 400; }
  .meta { text-align: right; font-size: 10pt; color: rgba(255,255,255,.78); line-height: 1.8; }
  .meta strong { display: block; color: #fff; font-size: 11pt; }
  .notice-card { margin-top: 18mm; background: rgba(255,255,255,.96); color: #10233f; border-left: 5px solid #b8392f; box-shadow: 0 14px 38px rgba(5,20,40,.22); padding: 12mm; }
  .notice-label { font-size: 8pt; letter-spacing: .18em; text-transform: uppercase; color: #b8392f; font-weight: 800; margin-bottom: 4mm; }
  .notice-title { font-size: 19pt; line-height: 1.22; color: #7f1d1d; font-weight: 800; margin-bottom: 6mm; }
  .notice-body { font-size: 11.2pt; line-height: 1.7; color: #1d2d48; }
  .section-head { display: flex; align-items: center; gap: 8mm; margin-bottom: 8mm; padding-bottom: 4mm; border-bottom: 1.5px solid #c8d4e3; }
  .num { width: 11mm; height: 11mm; border-radius: 3mm; background: linear-gradient(135deg, #315f94, #0c2949); color: #e5bd50; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 9pt; }
  h2 { font-size: 14pt; letter-spacing: .14em; text-transform: uppercase; color: #0c223e; }
  h3 { font-size: 11.5pt; margin: 7mm 0 3mm; color: #14365f; }
  p { margin-bottom: 4mm; }
  .box { border: 1px solid #d2ddea; background: linear-gradient(180deg, #fbfdff, #f7faff); padding: 7mm; margin: 5mm 0; }
  .risk-box { border: 1.5px solid #d8a33a; border-left: 5px solid #b8392f; background: #fffaf0; padding: 7mm; margin: 6mm 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
  .kv { border: 1px solid #d7e0ec; background: #f7faff; padding: 4.5mm; }
  .kv-label { font-size: 7.3pt; letter-spacing: .16em; text-transform: uppercase; color: #7183a0; margin-bottom: 1.5mm; font-weight: 800; }
  .kv-value { font-size: 10.2pt; font-weight: 700; color: #10233f; }
  .step-list { counter-reset: step; margin-top: 4mm; }
  .step { counter-increment: step; display: grid; grid-template-columns: 12mm 1fr; gap: 4mm; margin: 4mm 0; align-items: start; }
  .step::before { content: counter(step, decimal-leading-zero); font-weight: 800; color: #315f94; letter-spacing: .08em; }
  .footer { position: absolute; left: 23mm; right: 23mm; bottom: 11mm; border-top: 1px solid #dce4ef; padding-top: 3mm; color: #7a8ca7; font-size: 8pt; display: flex; justify-content: space-between; }
  .disclaimer { font-size: 8.4pt; color: #5a6880; line-height: 1.55; background: #f7faff; border-left: 4px solid #315f94; padding: 6mm; margin-top: 6mm; }
  .emphasis { color: #7f1d1d; font-weight: 800; }
</style>
</head>
<body>
<section class="page cover">
  <div class="cover-kicker">IL NAUTICO CO., LTD. · ADVANCED TECHNICAL SCREENING</div>
  <div class="cover-grid">
    <div><div class="brand">FairVia&#8482;</div><div class="report-title">Medical Material Referral Report</div></div>
    <div class="meta"><strong>${reportId}</strong><div>${company}</div><div>${project}</div><div>${dateStr}</div><div>Engine v${ENGINE_VERSION}</div></div>
  </div>
  <div class="notice-card"><div class="notice-label">Specialist referral required</div><div class="notice-title">Outside Automated Screening Scope — Implantable Application</div><div class="notice-body">This request has been identified as involving an implantable, absorbable, or long-term internal-contact medical application. The case has therefore been stopped before ordinary scoring. This is a controlled safety outcome: the project requires specialist medical-material, biological evaluation, and regulatory review before any validation, design, or commercial planning activity is initiated.</div></div>
</section>
<section class="page">
  <div class="section-head"><div class="num">01</div><h2>Referral Decision Summary</h2></div>
  <div class="risk-box"><h3>Decision</h3><p class="emphasis">This project is outside the scope of the automated FairVia&#8482; Advanced Technical Screening workflow.</p><p>${msg}</p></div>
  <div class="grid">
    <div class="kv"><div class="kv-label">Application type</div><div class="kv-value">${device}</div></div>
    <div class="kv"><div class="kv-label">Patient contact</div><div class="kv-value">${contact}</div></div>
    <div class="kv"><div class="kv-label">Contact duration</div><div class="kv-value">${duration}</div></div>
    <div class="kv"><div class="kv-label">Target markets</div><div class="kv-value">${markets}</div></div>
    <div class="kv"><div class="kv-label">Current material</div><div class="kv-value">${current}</div></div>
    <div class="kv"><div class="kv-label">Candidate material</div><div class="kv-value">${candidate}</div></div>
  </div>
  <div class="box"><h3>Why the ordinary score is intentionally not shown</h3><p>For implantable or long-term internal-contact applications, a numerical transition score may create a false impression that material feasibility can be compared using ordinary processing, supplier, or documentation indicators. These factors require a specialist pathway rather than an automated score.</p></div>
  <div class="footer"><span>FairVia&#8482; · Il Nautico Co., Ltd.</span><span>${reportId}</span></div>
</section>
<section class="page">
  <div class="section-head"><div class="num">02</div><h2>Reason for Specialist Referral</h2></div>
  <div class="box"><h3>Technical basis</h3><p>The selected medical use case indicates implantable or long-term internal contact. This category is materially different from ordinary packaging, external device components, or non-patient-contact healthcare uses.</p><p>The submitted evidence status also indicates that medical-grade supplier confirmation and ISO 13485 alignment are incomplete or not fully confirmed.</p></div>
  <div class="grid">
    <div class="kv"><div class="kv-label">Sterilisation method</div><div class="kv-value">${steril}</div></div>
    <div class="kv"><div class="kv-label">Medical-grade supplier</div><div class="kv-value">${medGrade}</div></div>
    <div class="kv"><div class="kv-label">ISO 13485 supplier status</div><div class="kv-value">${iso13485}</div></div>
    <div class="kv"><div class="kv-label">Workflow result</div><div class="kv-value">Terminated before scoring</div></div>
  </div>
  <div class="risk-box"><h3>Implication for the client</h3><p>This output should be used as a formal screening result: the case has been routed to a higher-evidence pathway because the application category exceeds the safe boundary of automated initial screening.</p></div>
  <div class="footer"><span>Referral Report · Outside Automated Screening Scope</span><span>${dateStr}</span></div>
</section>
<section class="page">
  <div class="section-head"><div class="num">03</div><h2>Recommended Specialist Pathway</h2></div>
  <div class="box"><h3>Immediate next actions</h3><div class="step-list"><div class="step">Confirm whether the intended use is truly implantable, absorbable, or long-term internal contact, and define the patient-contact category under ISO 10993-1.</div><div class="step">Collect material-specific evidence: medical-grade history, composition disclosure, residuals/additives profile, degradation-product information, supplier quality-system documentation, and change-control policy.</div><div class="step">Define the biological evaluation and toxicological risk assessment pathway, including ISO 10993-1, ISO 10993-18, extractables/leachables, and degradation-product assessment where applicable.</div><div class="step">Review sterilisation compatibility, aging, mechanical retention, dimensional stability, and packaging or sterile-barrier implications before any prototype validation is planned.</div><div class="step">Decide whether the project should proceed as a specialist regulatory/material feasibility review, be redesigned for a non-implantable application, or be placed outside FairVia automated screening scope.</div></div></div>
  <div class="risk-box"><h3>Commercial pathway</h3><p>Recommended next service: <strong>Specialist Medical Material Feasibility Scoping</strong>. This should be handled as a separate specialist review, not as a standard automated compatibility assessment.</p></div>
  <div class="disclaimer">${REPORT_DISCLAIMER}</div>
  <div class="footer"><span>FairVia&#8482; / Il Nautico Co., Ltd.</span><span>${reportId} · ${dateStr}</span></div>
</section>
</body>
</html>`;
}


// ══════════════════════════════════════════════════════════════
// EMAIL HELPERS
// ══════════════════════════════════════════════════════════════

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function publicBaseUrlFromRequest(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return host ? `${proto}://${host}` : '';
}

function storeAdvancedReport(reportId, pdfBuffer, input) {
  cleanupExpiredAdvancedReports();
  advancedReportStore.set(reportId, {
    pdf: pdfBuffer,
    email: input?.email || '',
    company_name: input?.company_name || '',
    createdAt: Date.now(),
  });
}

async function sendResendEmail(payload) {
  if (!RESEND_API_KEY) {
    console.warn('[server_advanced] Email skipped — RESEND_API_KEY not configured.');
    return { skipped: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend API error: ${response.status} ${detail}`);
  }

  return response.json().catch(() => ({}));
}

async function sendAdvancedReportEmails({ req, pdfBuffer, input, pdfData, scoringResult, reportId }) {
  const userEmail = String(input?.email || '').trim();
  const contactName = input?.contact_person || input?.company_name || 'Client';
  const companyName = input?.company_name || 'Not specified';
  const routeLabel = ROUTE_LABEL[input?.route] || input?.route || 'Advanced Technical Screening';
  const score = scoringResult?.scoring?.finalScore ?? '—';
  const decisionLabel = scoringResult?.decision?.label || scoringResult?.decision?.band || '—';
  const confidence = pdfData?.confidence?.score ?? scoringResult?.confidence?.score ?? null;
  const baseUrl = publicBaseUrlFromRequest(req);
  const downloadUrl = baseUrl && reportId
    ? `${baseUrl}/download-advanced-report/${encodeURIComponent(reportId)}`
    : '';

  const attachment = {
    filename: `FairVia-Advanced-Technical-Screening-${reportId}.pdf`,
    content: Buffer.from(pdfBuffer).toString('base64'),
  };

  const subject = 'FairVia™ Advanced Technical Screening Report';

  const text = `Dear ${contactName},

Thank you for completing the FairVia™ Advanced Technical Screening form.

Your Advanced Technical Screening Report has been generated and is attached to this email as a PDF.

Assessment summary:
- Report ID: ${reportId}
- Route: ${routeLabel}
- Risk Score: ${score}/100
- Decision: ${decisionLabel}${confidence !== null ? `\n- Confidence: ${confidence}%` : ''}

${downloadUrl ? `You may also access the report using the secure download link below:\n${downloadUrl}\n\n` : ''}This report is an initial technical screening output. It does not constitute regulatory approval, product certification, or final compliance determination.

Best regards,
FairVia™ Technical Assessment Team
Il Nautico Co., Ltd.
info@ilnautico.com`;

  const html = `
<div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#173766;">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #dbe5f1;overflow:hidden;">
      <div style="padding:28px 32px;border-bottom:1px solid #e6edf5;">
        <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#2952a3;font-weight:700;">FairVia™ Advanced Technical Screening</div>
        <h1 style="margin:12px 0 0;font-size:24px;line-height:1.3;color:#173766;font-weight:600;">Your report is ready</h1>
      </div>
      <div style="padding:30px 32px;">
        <p style="margin:0 0 18px;font-size:15px;line-height:1.7;">Dear ${contactName},</p>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.7;">Thank you for completing the FairVia™ Advanced Technical Screening form. Your report has been generated and is attached to this email as a PDF.</p>
        <div style="margin:24px 0;padding:18px 20px;background:#f0f6fc;border:1px solid #d7e5f5;">
          <div style="font-size:13px;color:#748dad;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.08em;">Assessment summary</div>
          <div style="font-size:15px;line-height:1.8;color:#173766;">
            <strong>Report ID:</strong> ${reportId}<br>
            <strong>Route:</strong> ${routeLabel}<br>
            <strong>Risk Score:</strong> ${score}/100<br>
            <strong>Decision:</strong> ${decisionLabel}${confidence !== null ? `<br><strong>Confidence:</strong> ${confidence}%` : ''}
          </div>
        </div>
        ${downloadUrl ? `<p style="margin:0 0 10px;font-size:15px;line-height:1.7;">You may also access the report using the secure download link below:</p><p style="margin:0 0 22px;"><a href="${downloadUrl}" style="display:inline-block;padding:12px 18px;background:#2952a3;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Download report</a></p><p style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#748dad;word-break:break-all;">${downloadUrl}</p>` : ''}
        <p style="margin:0 0 18px;font-size:15px;line-height:1.7;">This report is intended to support early-stage technical decision-making before pilot validation, material procurement, or commercial production changes.</p>
        <div style="padding-top:20px;border-top:1px solid #e6edf5;font-size:14px;line-height:1.7;color:#425f82;">Best regards,<br><strong style="color:#173766;">FairVia™ Technical Assessment Team</strong><br>Il Nautico Co., Ltd.<br><a href="mailto:info@ilnautico.com" style="color:#2952a3;text-decoration:none;">info@ilnautico.com</a></div>
      </div>
    </div>
  </div>
</div>`;

  const jobs = [];

  if (isValidEmail(userEmail)) {
    jobs.push(sendResendEmail({
      from: FROM_EMAIL,
      to: userEmail,
      subject,
      text,
      html,
      attachments: [attachment],
    }));
  } else {
    console.warn('[server_advanced] Result email skipped — missing or invalid user email:', userEmail);
  }

  if (isValidEmail(ADMIN_EMAIL)) {
    const adminText = `New FairVia™ Advanced Technical Screening report generated.

Report ID: ${reportId}
Company: ${companyName}
Contact: ${contactName}
Email: ${userEmail || 'Not provided'}
Route: ${routeLabel}
Score: ${score}/100
Decision: ${decisionLabel}
${downloadUrl ? `Download URL: ${downloadUrl}` : ''}`;

    jobs.push(sendResendEmail({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `New FairVia™ Advanced Report — ${companyName}`,
      text: adminText,
      attachments: [attachment],
    }));
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[server_advanced] Email delivery error:', result.reason?.message || result.reason);
    }
  }
}

function extractAccessTokenFromPayload(raw) {
  const fields = raw?.data?.fields;
  if (!Array.isArray(fields)) return '';
  const found = fields.find(f => f?.key === 'access_token');
  return String(found?.value || '').trim();
}

function isDemoAccessAllowed(req) {
  const queryKey = String(req.query?.key || '').trim();
  const bodyKey = extractAccessTokenFromPayload(req.body);
  return queryKey === TEST_ROUTE_KEY || bodyKey === TEST_ROUTE_KEY;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/advanced-access', (_req, res) => {
  res.sendFile(path.join(__dirname, 'advanced-access.html'));
});

async function handleAdvancedWebhook(req, res) {
  if (!verifyTallySignature(req)) {
    console.warn('[server_advanced] Webhook signature verification failed.');
    return errorResponse(res, 401, 'UNAUTHORIZED', 'Webhook signature verification failed.');
  }

  let input;
  try {
    input = normalizeTallyPayload(req.body);
    input = normalizeInputForScoring(input);

  } catch (err) {
    const code = err.code ?? 'INVALID_PAYLOAD';
    console.warn(`[server_advanced] Payload normalisation error (${code}):`, err.message);
    return errorResponse(res, 400, code, err.message);
  }

  console.log(`[server_advanced] Webhook received — route: ${input.route}, company: ${input.company_name ?? 'unknown'}`);

  let scoringResult;
  try {
    scoringResult = input.route === 'food'
      ? calculateFoodContactRisk(input)
      : calculateMedicalHealthcareRisk(input);
  } catch (err) {
    console.error('[server_advanced] Scoring engine error:', err);
    return errorResponse(res, 500, 'SCORING_ERROR', 'Scoring engine encountered an unexpected error.');
  }

  if (scoringResult.workflowStatus === 'terminated') {
    console.log('[server_advanced] Implant application detected — generating referral PDF, skipping Claude.');
    const referralReportId = generateReportId();

    try {
      const referralHtml = generateImplantReferralHtml(scoringResult, input);
      const referralBuffer = await renderHtmlToPdf(referralHtml);
      fs.writeFileSync(PDF_OUTPUT_PATH, referralBuffer);
      storeAdvancedReport(referralReportId, referralBuffer, input);
      await sendAdvancedReportEmails({
        req,
        pdfBuffer: referralBuffer,
        input,
        pdfData: { confidence: null },
        scoringResult,
        reportId: referralReportId,
      }).catch(emailErr => console.warn('[server_advanced] Referral email delivery failed:', emailErr.message));
      console.log(`[server_advanced] Referral PDF saved to ${PDF_OUTPUT_PATH}`);
    } catch (pdfErr) {
      console.error('[server_advanced] Referral PDF generation failed:', pdfErr);
      return errorResponse(res, 500, 'PDF_ERROR', 'Referral PDF generation failed.');
    }

    return res.status(200).json({
      success:           true,
      workflowStatus:    'terminated',
      terminationReason: scoringResult.terminationReason,
      reportId:          referralReportId,
      timestamp:         new Date().toISOString(),
    });
  }

  const narrativeResult = await tryClaudeNarrative(scoringResult);
  const pdfData = buildPdfDataObject(scoringResult, narrativeResult, input);

  let pdfBuffer;
  try {
    pdfBuffer = await renderPdfFromTemplate(pdfData);
  } catch (renderErr) {
    console.error('[server_advanced] PDF render failed:', renderErr);
    return errorResponse(res, 500, 'PDF_ERROR', 'PDF rendering failed. Report has not been generated.');
  }

  try {
    fs.writeFileSync(PDF_OUTPUT_PATH, pdfBuffer);
    storeAdvancedReport(pdfData.reportMeta.reportId, pdfBuffer, input);
    await sendAdvancedReportEmails({
      req,
      pdfBuffer,
      input,
      pdfData,
      scoringResult,
      reportId: pdfData.reportMeta.reportId,
    }).catch(emailErr => console.warn('[server_advanced] Email delivery failed:', emailErr.message));
    console.log(`[server_advanced] PDF saved — reportId: ${pdfData.reportMeta.reportId}, score: ${pdfData.scoring.finalScore}, band: ${pdfData.decision.band}`);
  } catch (writeErr) {
    console.error('[server_advanced] PDF write failed:', writeErr);
    return errorResponse(res, 500, 'PDF_WRITE_ERROR', 'PDF was generated but could not be saved to disk.');
  }

  return res.status(200).json({
    success:          true,
    reportId:         pdfData.reportMeta.reportId,
    route:            input.route,
    finalScore:       scoringResult.scoring.finalScore,
    decisionBand:     scoringResult.decision.band,
    decisionLabel:    scoringResult.decision.label,
    confidence:       pdfData.confidence,
    hardTriggerCount: scoringResult.hardTriggers.length,
    narrativeSource:  narrativeResult.source,
    emailDelivery:    isValidEmail(input.email) && !!RESEND_API_KEY ? 'attempted' : 'skipped',
    workflowStatus:   'scored',
    timestamp:        new Date().toISOString(),
  });
}

app.post('/advanced-webhook', handleAdvancedWebhook);

app.get('/advanced-access-demo', (req, res) => {
  if (!isDemoAccessAllowed(req)) {
    return res.status(403).send('Advanced demo access denied.');
  }
  res.sendFile(path.join(__dirname, 'advanced-access.html'));
});

app.post('/generate-advanced-demo-report', async (req, res) => {
  if (!isDemoAccessAllowed(req)) {
    return res.status(403).json({ success: false, error: 'DEMO_ACCESS_DENIED', message: 'Invalid or missing demo access key.' });
  }
  req.query = { ...(req.query || {}), demo: 'true', delivery: 'email' };
  return handleAdvancedWebhook(req, res);
});

app.get('/latest-advanced-pdf', (_req, res) => {
  if (!fs.existsSync(PDF_OUTPUT_PATH)) {
    return res.status(404).json({
      success:   false,
      error:     'NOT_FOUND',
      message:   'No Advanced screening PDF has been generated yet.',
      timestamp: new Date().toISOString(),
    });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="fairvia-advanced-screening.pdf"');

  res.sendFile(path.resolve(PDF_OUTPUT_PATH), (err) => {
    if (err) {
      console.error('[server_advanced] PDF serve error:', err);
    }
  });
});


app.get('/download-advanced-report/:reportId', (req, res) => {
  cleanupExpiredAdvancedReports();

  const item = advancedReportStore.get(req.params.reportId);
  if (!item?.pdf) {
    return res.status(404).send('Advanced report not found or expired.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FairVia-Advanced-Technical-Screening-${req.params.reportId}.pdf"`);
  res.setHeader('Content-Length', item.pdf.length);
  return res.send(item.pdf);
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status:        'ok',
    service:       'fairvia-advanced',
    version:       SERVER_VERSION,
    engineVersion: ENGINE_VERSION,
    aiEnabled:     AI_ENABLED && !!process.env.ANTHROPIC_API_KEY,
    model:         CLAUDE_MODEL,
    timestamp:     new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({
    success:   false,
    error:     'NOT_FOUND',
    message:   `No route: ${req.method} ${req.path}`,
    timestamp: new Date().toISOString(),
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[server_advanced] Unhandled rejection:', reason);
});

try {
  validateEnvironment();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

app.listen(ADVANCED_PORT, () => {
  console.log(`[server_advanced] Listening on port ${ADVANCED_PORT}`);
  console.log(`  POST http://localhost:${ADVANCED_PORT}/advanced-webhook`);
  console.log(`  GET  http://localhost:${ADVANCED_PORT}/advanced-access`);
  console.log(`  GET  http://localhost:${ADVANCED_PORT}/advanced-access-demo?key=...`);
  console.log(`  POST http://localhost:${ADVANCED_PORT}/generate-advanced-demo-report`);
  console.log(`  GET  http://localhost:${ADVANCED_PORT}/latest-advanced-pdf`);
  console.log(`  GET  http://localhost:${ADVANCED_PORT}/download-advanced-report/:reportId`);
  console.log(`  GET  http://localhost:${ADVANCED_PORT}/health`);
});

module.exports = app;
