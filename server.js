import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";

const app = express();
app.use(express.json());

// =========================
// util
// =========================
function injectHtml(template, data) {
  let output = template;
  Object.keys(data).forEach((key) => {
    output = output.replace(new RegExp(`{{${key}}}`, "g"), data[key] || "");
  });
  return output;
}

// =========================
// ★ ここに3万円テンプレ（1個だけ）
// =========================
const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>FairVia Report</title>
</head>

<body>
<h1>{{client_name}}</h1>
<p>{{client_company}}</p>
<p>{{client_country}}</p>

<h2>Feasibility: {{feasibility_level}}</h2>

<p>{{executive_summary_overview}}</p>
<p>{{executive_summary_findings}}</p>
<p>{{executive_summary_conclusion}}</p>

</body>
</html>
`;

// =========================
// PDF生成（GETテスト）
// =========================
app.get("/generate-report", async (req, res) => {
  console.log("🔥 GENERATE REPORT");

  try {
    const finalHtml = injectHtml(html, {
      client_name: "Test Client",
      client_company: "Test Company",
      client_country: "Japan",
      feasibility_level: "MODERATE",
      executive_summary_overview: "Overview placeholder",
      executive_summary_findings: "Findings placeholder",
      executive_summary_conclusion: "Conclusion placeholder"
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    await page.setContent(finalHtml, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    fs.writeFileSync("./latest.pdf", pdf);

    console.log("✅ PDF SAVED");

    res.send("PDF generated");

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).send("error");
  }
});

// =========================
// PDF取得
// =========================
app.get("/latest-pdf", (req, res) => {
  console.log("📥 PDF REQUEST");

  const filePath = process.cwd() + "/latest.pdf";

  if (!fs.existsSync(filePath)) {
    console.log("❌ PDF NOT FOUND");
    return res.status(404).send("PDF not found");
  }

  const file = fs.readFileSync(filePath);
  res.setHeader("Content-Type", "application/pdf");
  res.send(file);
});

// =========================
// 起動
// =========================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
