const express = require("express");
const OpenAI = require("openai").default;

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* -----------------------------
   BASIC TEST ROUTES
------------------------------ */

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -----------------------------
   AI REPORT GENERATION
------------------------------ */

app.post("/generate-report", async (req, res) => {
  try {
    const data = req.body;

    const prompt = `
You are a biodegradable materials consultant.

Generate a short technical screening report based on:

Application: ${data.application}
Current Material: ${data.material}
Bio Material: ${data.bio_material}
Equipment: ${data.equipment}
Concern: ${data.concern}
Stage: ${data.stage}
Notes: ${data.notes}

Return a structured professional evaluation.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a polymer materials expert." },
        { role: "user", content: prompt }
      ]
    });

    res.json({
      report: completion.choices[0].message.content
    });

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({
      error: "AI generation failed",
      details: error.message
    });
  }
});

/* -----------------------------
   SERVER START
------------------------------ */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
