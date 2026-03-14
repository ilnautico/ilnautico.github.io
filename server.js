import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("FairVia server running");
});

app.post("/generate-report", async (req,res)=>{

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
Based on the provided information, the transition to biodegradable material may require evaluation of thermal stability and processing compatibility.
</p>

</body>
</html>
`;

const browser = await puppeteer.launch({
args:["--no-sandbox"]
});

const page = await browser.newPage();

await page.setContent(html);

const pdf = await page.pdf({
format:"A4"
});

await browser.close();

res.set({
"Content-Type":"application/pdf",
"Content-Disposition":"attachment; filename=fairvia-report.pdf"
});

res.send(pdf);

});

app.listen(process.env.PORT || 3000,()=>{
console.log("server started");
});
