const express = require("express");
const OpenAI = require("openai").default;
const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transporter = nodemailer.createTransport({
  host: "smtppro.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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

    /* EMAIL */

    let email = null;

    if (
      payload.data &&
      payload.data.fields &&
      Array.isArray(payload.data.fields)
    ) {

      const emailField = payload.data.fields.find(
        f => f.type === "INPUT_EMAIL"
      );

      if (emailField) {
        email = emailField.value;
      }

    }

    console.log("EMAIL FOUND:", email);

    /* AI */

    const completion = await openai.chat.completions.create({

      model: "gpt-4.1-mini",

      messages: [
        {
          role: "system",
          content: "You are a polymer materials consultant."
        },
        {
          role: "user",
          content: "Generate a short biodegradable material screening report."
        }
      ]

    });

    const report = completion.choices[0].message.content;

    /* PDF */

    const html = `
    <html>
      <body style="font-family:Arial;padding:40px">
        <h1>FairVia Screening Report</h1>
        <p>${report}</p>
      </body>
    </html>
    `;

    const browser = await puppeteer.launch({
      args: ["--no-sandbox","--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4"
    });

    await browser.close();

    /* MAIL */

    if (email) {

      await transporter.sendMail({

        from: process.env.EMAIL_USER,

        to: email,

        subject: "FairVia Screening Report",

        text: "Your screening report is attached.",

        attachments: [
          {
            filename: "fairvia_report.pdf",
            content: pdf
          }
        ]

      });

      console.log("MAIL SENT:", email);

    } else {

      console.log("EMAIL NOT FOUND");

    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);

  }

  catch (err) {

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
