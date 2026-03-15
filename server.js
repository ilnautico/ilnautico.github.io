なく
    if (payload.email) {
      email = payload.email;
    }

    if (!email && payload.data && payload.data.fields) {
      const emailField = payload.data.fields.find(
        f => f.key === "email"
      );
      if (emailField) {
        email = emailField.value;
      }
    }

    /* -------------------------
    AI PROMPT
    ------------------------- */

    const prompt = `
You are a biodegradable materials consultant.

Generate a short technical screening report.

Application: ${payload.application || ""}
Current Material: ${payload.material || ""}
Bio Material: ${payload.bio_material || ""}
Equipment: ${payload.equipment || ""}
Concern: ${payload.concern || ""}
Stage: ${payload.stage || ""}
Notes: ${payload.notes || ""}

Return a structured professional evaluation.
`;

    /* -------------------------
    OPENAI
    ------------------------- */

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a polymer materials expert." },
        { role: "user", content: prompt }
      ]
    });

    const report = completion.choices[0].message.content;

    /* -------------------------
    HTML
    ------------------------- */

    const html = `
    <html>
    <head>
    <style>
    body{font-family:Arial;padding:40px;}
    h1{color:#2c7a7b;}
    </style>
    </head>
    <body>

    <h1>FairVia Screening Report</h1>

    <h3>AI Evaluation</h3>
    <p>${report}</p>

    </body>
    </html>
    `;

    /* -------------------------
    PDF
    ------------------------- */

    const browser = await puppeteer.launch({
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4"
    });

    await browser.close();

    /* -------------------------
    MAIL
    ------------------------- */

    if (email) {

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "FairVia Screening Report",
        text: "Your biodegradable material screening report is attached.",
        attachments: [
          {
            filename: "fairvia_report.pdf",
            content: pdf
          }
        ]
      });

      console.log("MAIL SENT:", email);

    } else {

      console.log("EMAIL NOT FOUND IN PAYLOAD");

    }

    /* -------------------------
    RESPONSE
    ------------------------- */

    res.set({
      "Content-Type":"application/pdf",
      "Content-Disposition":"attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "AI generation failed",
      details: error.message
    });

  }
});

/* -------------------------
SERVER
------------------------- */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
