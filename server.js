const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
