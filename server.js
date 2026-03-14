const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log("Server started");
});
