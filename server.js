import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("FairVia server running");
});

app.post("/generate-report",(req,res)=>{

  const data = req.body;

  const html = `
  <html>
  <body>
  <h1>FairVia Screening Report</h1>

  <p><b>Application:</b> ${data.application}</p>
  <p><b>Material:</b> ${data.material}</p>
  <p><b>Bio material:</b> ${data.bio_material}</p>
  <p><b>Equipment:</b> ${data.equipment}</p>

  </body>
  </html>
  `;

  res.send(html);

});

app.listen(process.env.PORT || 3000,()=>{
  console.log("server started");
});
