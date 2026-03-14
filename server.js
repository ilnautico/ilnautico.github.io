const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.post("/generate-report", async (req, res) => {
  try {
    res.json({
      status: "ok",
      message: "Report generation endpoint working"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
