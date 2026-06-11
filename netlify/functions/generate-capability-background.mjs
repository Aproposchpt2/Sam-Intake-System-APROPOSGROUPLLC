// ============================================================================
//  FlowDesk Pro — generate-capability  (delivery brick)
//  POST a mapped record -> fill HTML template -> render PDF
//      -> email the PDF via Resend -> log the job in Supabase.
//
//  PDF renderer: Chromium (default, self-contained, no credentials) OR Adobe
//  (set PDF_RENDERER=adobe + the two Adobe vars). Deps load dynamically per choice.
//
//  Env vars:
//    SAM/Resend/Supabase already on the site:
//    RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_TO_EMAIL    (Resend; TO = business copy)
//    SUPABASE_URL, SUPABASE_SERVICE_KEY                    (Supabase)
//    Optional Adobe path: PDF_RENDERER=adobe, PDF_SERVICES_CLIENT_ID, PDF_SERVICES_CLIENT_SECRET
// ============================================================================

const json = (s, o) => ({
  statusCode: s,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(o),
});
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- HTML template (same design as the proven generator) ------------------
function buildHtml(r) {
  const badges = (r.socioeconomic || []).map(c =>
    `<div class="badge ${c.key ? "key" : ""}">${esc(c.label)}</div>`).join("");
  const comps = (r.competencies || []).map(c =>
    `<div class="comp"><span class="t">${esc(c.title)}</span><div class="d">${esc(c.desc)}</div></div>`).join("");
  const diffs = (r.differentiators || []).map(d => `<li>${esc(d)}</li>`).join("");
  const naics = (r.naics || []).map(n =>
    `<div class="row"><span class="code ${n.primary ? "pri" : ""}">${esc(n.code)}</span><span class="desc">${esc(n.title)}${n.primary ? ' <span class="pri">(Primary)</span>' : ""}</span></div>`).join("");
  const c = r.contact || {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page{size:letter;margin:0}*{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#1a2332;font-size:9.3px;line-height:1.4}
  .page{width:8.5in;min-height:11in;padding:.45in .5in .4in;display:flex;flex-direction:column}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0A1A3A;padding-bottom:11px}
  .brand{display:flex;align-items:center;gap:12px}.logo{width:46px;height:46px;background:#0A1A3A;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;border-radius:4px}
  .brand h1{font-size:20px;color:#0A1A3A;line-height:1.05}.brand .sub{font-size:9px;color:#51607a;margin-top:3px;letter-spacing:.5px;text-transform:uppercase;font-weight:600}
  .header-right{text-align:right;font-size:8.6px;color:#51607a;line-height:1.55}.header-right .tag{color:#b5762a;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:.6px}
  .tagline{background:#0A1A3A;color:#fff;padding:7px 12px;margin-top:11px;font-size:11px;font-weight:600;border-radius:3px}.tagline span{color:#d9a45b}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}.badge{font-size:9px;font-weight:700;padding:4px 10px;border-radius:20px;background:#fbf2e6;color:#b5762a;border:1px solid #ecd7b3}.badge.key{background:#0A1A3A;color:#fff;border-color:#0A1A3A}
  .body{display:flex;gap:16px;margin-top:13px;flex:1}.col-left{flex:1.55}.col-right{flex:1}
  h2{font-size:10px;color:#0A1A3A;text-transform:uppercase;letter-spacing:.9px;border-bottom:1.5px solid #d9a45b;padding-bottom:3px;margin-bottom:7px;font-weight:700}.section{margin-bottom:13px}
  .comp{margin-bottom:7px}.comp .t{font-weight:700;color:#0A1A3A;font-size:9.4px}.comp .d{color:#43506a;font-size:8.9px}
  ul.diff{list-style:none}ul.diff li{position:relative;padding-left:12px;margin-bottom:4.5px;color:#2b3852;font-size:8.9px}ul.diff li::before{content:"\\25B8";position:absolute;left:0;color:#b5762a;font-size:8px;top:.5px}
  .data{background:#f3f5f9;border:1px solid #dfe4ee;border-radius:4px;padding:9px 11px;margin-bottom:12px}.data .row{display:flex;justify-content:space-between;padding:2.6px 0;border-bottom:1px dotted #cfd6e4;font-size:8.7px}.data .row:last-child{border-bottom:none}
  .data .k{color:#51607a;font-weight:600}.data .v{color:#0A1A3A;font-weight:700;text-align:right}.data .v.ok{color:#1d7a4d}
  .naics .row{display:flex;gap:7px;padding:3.2px 0;border-bottom:1px dotted #cfd6e4}.naics .row:last-child{border-bottom:none}.naics .code{font-weight:700;color:#0A1A3A;font-size:9px;min-width:44px}.naics .desc{color:#43506a;font-size:8.5px}.naics .pri{color:#b5762a;font-weight:700}
  .footer{border-top:2px solid #0A1A3A;margin-top:10px;padding-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:8.6px}.footer .poc{color:#0A1A3A}.footer .poc b{font-size:9.3px}.footer .contact{text-align:right;color:#43506a;line-height:1.5}.footer .contact b{color:#0A1A3A}
  .engine{text-align:center;font-size:6.6px;color:#aeb7c7;margin-top:7px;letter-spacing:.3px}
  </style></head><body><div class="page">
    <div class="header"><div class="brand"><div class="logo">${esc(r.logo_text || "AG")}</div>
      <div><h1>${esc(r.legal_name)}</h1><div class="sub">Federal Contractor &middot; ${esc(r.address)}</div></div></div>
      <div class="header-right"><div class="tag">Capability Statement</div><div>SAM.gov ${esc(r.sam_status)} &middot; ${esc(r.size)}</div><div>${esc(c.website)}</div></div></div>
    <div class="tagline">${esc(r.tagline_pre)} <span>${esc(r.tagline_em)}</span></div>
    ${badges ? `<div class="badges">${badges}</div>` : ""}
    <div class="body"><div class="col-left">
      <div class="section"><h2>Core Competencies</h2>${comps}</div>
      <div class="section"><h2>Differentiators</h2><ul class="diff">${diffs}</ul></div>
    </div><div class="col-right">
      <div class="section"><h2>Company Data</h2><div class="data">
        <div class="row"><span class="k">UEI</span><span class="v">${esc(r.uei)}</span></div>
        <div class="row"><span class="k">CAGE Code</span><span class="v">${esc(r.cage)}</span></div>
        <div class="row"><span class="k">SAM.gov</span><span class="v ok">${esc(r.sam_status)}</span></div>
        <div class="row"><span class="k">Business Type</span><span class="v">${esc(r.size)}</span></div>
        <div class="row"><span class="k">Location</span><span class="v">${esc(r.address)}</span></div></div></div>
      <div class="section"><h2>NAICS Codes</h2><div class="data naics">${naics}</div></div>
    </div></div>
    <div class="footer"><div class="poc"><b>${esc(c.name)}</b> &nbsp;|&nbsp; ${esc(c.title)}</div>
      <div class="contact"><b>${esc(c.phone)}</b> &middot; ${esc(c.email)}<br>${esc(c.website)} &middot; UEI ${esc(r.uei)} &middot; CAGE ${esc(r.cage)}</div></div>
    <div class="engine">Generated by CapGen Â· AI4 Businesses</div>
  </div></body></html>`;
}

// ---- PDF render: Adobe only (PDF_RENDERER=adobe is set in netlify.toml) ----
async function renderPdf(html) {
  return renderViaAdobe(html);
}

// Optional vendor path (Adobe HTML->PDF). Only used if PDF_RENDERER=adobe.
async function renderViaAdobe(html) {
  const AdmZip = (await import("adm-zip")).default;
  const id = process.env.PDF_SERVICES_CLIENT_ID, secret = process.env.PDF_SERVICES_CLIENT_SECRET;
  const base = "https://pdf-services.adobe.io";
  const tok = await (await fetch(base + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret }),
  })).json();
  const auth = { Authorization: `Bearer ${tok.access_token}`, "x-api-key": id };
  const asset = await (await fetch(base + "/assets", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaType: "application/zip" }),
  })).json();
  const zip = new AdmZip(); zip.addFile("index.html", Buffer.from(html, "utf8"));
  await fetch(asset.uploadUri, { method: "PUT", headers: { "Content-Type": "application/zip" }, body: zip.toBuffer() });
  const job = await fetch(base + "/operation/htmltopdf", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ assetID: asset.assetID, pageLayout: { pageWidth: 8.5, pageHeight: 11 } }),
  });
  const poll = job.headers.get("location");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await (await fetch(poll, { headers: auth })).json();
    if (st.status === "done") return Buffer.from(await (await fetch(st.asset.downloadUri)).arrayBuffer());
    if (st.status === "failed") throw new Error("Adobe job failed: " + JSON.stringify(st));
  }
  throw new Error("Adobe job timed out");
}

// ---- Resend (with attachment) + Supabase ----------------------------------
async function emailPdf(to, name, pdfBuf) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [to, ...(process.env.RESEND_TO_EMAIL ? [process.env.RESEND_TO_EMAIL] : [])],
      subject: "Your capability statement — FlowDesk Pro",
      html: `<div style="font-family:Arial,sans-serif"><p>Hi ${esc(name) || "there"},</p><p>Your branded capability statement is attached as a PDF. It pulls your verified SAM.gov details and is ready to send to contracting officers and prime contractors.</p><p style="color:#5a687f">— FlowDesk Pro</p></div>`,
      attachments: [{ filename: "Capability_Statement.pdf", content: pdfBuf.toString("base64") }],
    }),
  });
  if (!res.ok) throw new Error("Resend " + res.status + ": " + (await res.text()).slice(0, 200));
}

async function logJob(rec) {
  if (!process.env.SUPABASE_URL) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/capability_jobs`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      uei: rec.uei, legal_name: rec.legal_name, cage: rec.cage,
      sent_to: (rec.contact || {}).email, record: rec, created_at: new Date().toISOString(),
    }),
  }).catch(e => console.error("Supabase", e.message));
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let rec; try { rec = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }
  const to = (rec.contact || {}).email;
  if (!rec.legal_name || !to) return json(422, { error: "legal_name and contact.email required" });
  try {
    const html = buildHtml(rec);
    const pdf = await renderPdf(html);
    await emailPdf(to, (rec.contact || {}).name, pdf);
    await logJob(rec);
    return json(200, { ok: true });
  } catch (err) {
    console.error(err.message);
    return json(502, { error: "generation failed", detail: err.message });
  }
};

export { buildHtml };
