const express = require("express");
const OpenAI = require("openai").default;
const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* -----------------------------
   BASIC ROUTES
------------------------------ */

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -----------------------------
   REPORT GENERATION
------------------------------ */

app.post("/generate-report", async (req, res) => {

  try {

    const data = req.body;

    const prompt = `
You are a biodegradable materials consultant.

Generate a professional screening report.

Application: ${data.application}
Current Material: ${data.material}
Bio Material: ${data.bio_material}
Equipment: ${data.equipment}
Concern: ${data.concern}
Stage: ${data.stage}
Notes: ${data.notes}

Return sections:

Compatibility Level
Technical Observations
Potential Risks
Suggested Next Step
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a polymer materials expert." },
        { role: "user", content: prompt }
      ]
    });

    const report = completion.choices[0].message.content;

    /* -----------------------------
       HTML TEMPLATE
    ------------------------------ */

    const html = `
<html>
<head>
<meta charset="UTF-8">
<style>
body{
font-family:Arial;
padding:40px;
line-height:1.6;
}
h1{
color:#17263c;
}
.header{
border-bottom:3px solid #b4965a;
margin-bottom:30px;
padding-bottom:10px;
}
</style>
</head>

<body>

<div class="header">
<h1>FairVia™ Material Compatibility Screening</h1>
</div>

${report.replace(/\n/g,"<br>")}

</body>
</html>
`;

    /* -----------------------------
       PDF GENERATION
    ------------------------------ */

    const browser = await puppeteer.launch({
      args:["--no-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html);

    const pdf = await page.pdf({
      format:"A4",
      printBackground:true
    });

    await browser.close();

    /* -----------------------------
       EMAIL SEND
    ------------------------------ */

    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({

      from: `"FairVia Screening" <${process.env.EMAIL_USER}>`,

      to: data.email || process.env.EMAIL_USER,

      subject: "FairVia Material Screening Report",

      text: "Your screening report is attached.",

      attachments: [
        {
          filename: "fairvia_report.pdf",
          content: pdf
        }
      ]

    });

    res.json({
      status: "Report generated and email sent"
    });

  } catch(error) {

    console.error(error);

    res.status(500).json({
      error: "Report generation failed",
      message: error.message
    });

  }

});

/* -----------------------------
   SERVER START
------------------------------ */

const PORT = process.env.PORT || 8080;

app.listen(PORT,"0.0.0.0",()=>{

  console.log("FairVia server running on port " + PORT);

});

app.listen(PORT, "0.0.0.0", () => {
  console.log("FairVia server running on port " + PORT);
});
