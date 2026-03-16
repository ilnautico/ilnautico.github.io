import express from "express";
import OpenAI from "openai";
import { Resend } from "resend";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/generate-report", async (req, res) => {
  try {
    const payload = req.body;

    console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

    let email = null;

    if (
      payload &&
      payload.data &&
      payload.data.fields &&
      Array.isArray(payload.data.fields)
    ) {
      const emailField = payload.data.fields.find(
        (f) => f && f.type === "INPUT_EMAIL"
      );

      if (emailField && typeof emailField.value === "string") {
        email = emailField.value;
      }
    }

    console.log("EMAIL FOUND:", email);

    if (!email) {
      return res.status(400).json({
        error: "EMAIL NOT FOUND"
      });
    }

    const prompt = `
You are a polymer materials consultant.

Generate a short biodegradable material screening report.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You are a polymer materials consultant."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const report =
      completion?.choices?.[0]?.message?.content || "No report generated.";

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 40px;
      line-height: 1.6;
      color: #222;
    }
    h1 {
      color: #17263c;
      border-bottom: 3px solid #b4965a;
      padding-bottom: 10px;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <h1>FairVia Screening Report</h1>
  <div>${String(report).replace(/\n/g, "<br>")}</div>
</body>
</html>
`;

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",   // ← ここを変更
      to: email,
      subject: "FairVia Screening Report",
      text: "Your screening report is attached.",
      attachments: [
        {
          filename: "fairvia_report.pdf",
          content: pdf.toString("base64")
        }
      ]
    });

    console.log("MAIL SENT:", email);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);
  } catch (err) {
    console.error("ERROR:", err);

    res.status(500).json({
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
