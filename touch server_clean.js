import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/generate-ai", async (req, res) => {
  try {
    const { material, bio_material, equipment, concern } = req.body;

    const prompt = `Material: ${material}, Bio: ${bio_material}, Equipment: ${equipment}, Concern: ${concern}. Generate technical assessment.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const result = completion.choices[0].message.content;

    res.send({ result });

  } catch (error) {
    console.error(error);
    res.status(500).send("error");
  }
});

app.listen(8080, () => {
  console.log("🚀 running 8080");
});
