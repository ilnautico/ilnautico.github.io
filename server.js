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
<body style="font-family:Arial;padding:40px">

<h1>FairVia Screening Report</h1>

<h3>Application</h3>
<p>${data.application}</p>

<h3>Current Material</h3>
<p>${data.material}</p>

<h3>Biodegradable Material</h3>
<p>${data.bio_material}</p>

<h3>Equipment</h3>
<p>${data.equipment}</p>

<h3>AI Technical Assessment</h3>

<p>
Based on the provided information, the transition to biodegradable material may require evaluation of thermal stability and processing compatibility. Equipment conditions and processing temperatures should be validated to ensure material integrity and manufacturing feasibility.
</p>

</body>
</html>
`;

res.send(html);

});

app.listen(process.env.PORT || 3000,()=>{
console.log("server started");
});
