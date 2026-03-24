const regex = new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g");
    html = html.replace(regex, data[key] || "");
  });

  return html;
}

// =========================
// 値取得（ID対応済み）
// =========================
function getValue(fields, keyword) {
  const field = fields.find(f =>
    (f.label || "").toLowerCase().includes(keyword.toLowerCase())
  );

  if (!field) return "";

  if (Array.isArray(field.value) && Array.isArray(field.options)) {
    const selected = field.options.find(opt =>
      field.value.includes(opt.id)
    );
    if (selected?.text) return selected.text.toLowerCase();
  }

  if (typeof field.value === "string") {
    return field.value.toLowerCase();
  }

  return "";
}

// =========================
// 🔥 コメント（完全固定：無難版復元）
// ==========
