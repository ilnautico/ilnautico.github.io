import express from "express";
import OpenAI from "openai";
import { Resend } from "resend";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/generate-report", async (req, res) => {
  try {

    const answers = req.body.data.fields;

    let email = null;

    for (const field of answers) {
      if (field.type === "INPUT_EMAIL") {
        email = field.value;
      }
    }

    console.log("EMAIL FOUND:", email);

    if (!email) {
      return res.status(400).send("EMAIL NOT FOUND");
    }

    const prompt = JSON.stringify(answers);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Create a professional analysis report."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const report = completion.choices[0].message.content;

    await resend.emails.send({
      from: "AI Report <onboarding@resend.dev>",
      to: email,
      subject: "Your AI Generated Report",
      html: `<pre>${report}</pre>`
    });

    res.send("REPORT SENT");

  } catch (error) {
    console.error(error);
    res.status(500).send("ERROR");
  }
});

app.listen(3000, () => {
  console.log("Server running");
});
