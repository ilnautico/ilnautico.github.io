import express from "express";
import { Resend } from "resend";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "2mb" }));

const resend = new Resend(process.env.RESEND_API_KEY);

/* =========================
   Utility
========================= */

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeValue(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    return v.label || v.value || "";
  }
  return "";
}

function matchField(f, keyword) {
  const label = (f.label || "").toLowerCase();
  const key = (f.key || "").toLowerCase();
  return label.includes(keyword) || key.includes(keyword);
}

function getValue(fields, keyword) {
  const f = fields.find(f => matchField(f, keyword));
  if (!f) return "";
  return normalizeValue(f.value).trim();
}

function inferApplication(text) {
  const t = text.toLowerCase();
  if (t.includes("film")) return "Flexible Packaging Film";
  if (t.includes("mulch")) return "Agricultural Film";
  if (t.includes("rigid")) return "Rigid Packaging";
  if (t.includes("injection")) return "Injection Molded Product";
  if (t.includes("blow")) return "Blow Molded Product";
  return "General Plastic Application";
}

/* =========================
   HTMLテンプレ（簡易）
========================= */

const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial; padding: 20px; }
h1 { color: #17263c; }
</style>
</head>
<body>

<h1>FairVia Report</h1>

<p><strong>Name:</strong> {{client_name}}</p>
<p><strong>Company:</strong> {{client_company}}</p>
<p><strong>Country:</strong> {{client_country}}</p>

<p><strong>Application:</strong> {{application}}</p>
<p><strong>Material:</strong> {{current_material}}</p>
<p><strong>Processing:</strong> {{processing_method}}</p>

</body>
</html>
`;

function injectHtml(template, data) {
  let html = template;
  Object.keys(data).forEach(key => {
    html = html.replace(
      new RegExp(`{{\\s*${key}\\s*}}`, "g"),
      escapeHtml(String(data[key] || ""))
    );
  });
  return html;
}

/* =========================
   MAIN
========================= */

app.post("/generate-report", async (req, res) => {
  try {

    console.log("===== REQUEST =====");
    console.log(JSON.stringify(req.body, null, 2));

    const fields = req.body?.data?.fields || [];

    const emailField = fields.find(f => f.type === "INPUT_EMAIL");
    const email = normalizeValue(emailField?.value);

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    const clientName = getValue(fields, "name") || "—";
    const clientCompany = getValue(fields, "company") || "—";
    const clientCountry = getValue(fields, "country") || "—";

    const rawText = fields
      .map(f => normalizeValue(f.value).toLowerCase())
      .join(" ");

    const data = {
      client_name: clientName,
      client_company: clientCompany,
      client_country: clientCountry,
      application: inferApplication(rawText),
      current_material: getValue(fields, "material"),
      processing_method: getValue(fields, "processing")
    };

    const html = injectHtml(htmlTemplate, data);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html);

    const pdf = await page.pdf({ format: "A4" });

    await browser.close();

    await resend.emails.send({
      from: "info@ilnautico.com",
      to: email,
      subject: "Report",
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64")
        }
      ]
    });

    res.send("OK");

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => console.log("Server running"));
