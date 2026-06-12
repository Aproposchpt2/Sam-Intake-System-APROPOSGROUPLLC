// ============================================================================
//  FlowDesk Pro — SAM.gov Connector
//  Turns a business NAME into a confirmed, mapped capability-statement record.
//
//  Two modes (called by the confirm-picker front-end):
//    GET ...?mode=search&name=Acme&state=NV   -> candidate matches for the picker
//    GET ...?mode=entity&uei=ABC123...        -> full record, mapped for the engine
//
//  Robustness: SAM returns a *Desc field beside every *Code field, so we read the
//  human-readable descriptions instead of hardcoding a fragile code table.
//  Dependency-free. SAM_API_KEY comes from the environment.
// ============================================================================

const SAM_ENTITY_URL = "https://api.sam.gov/entity-information/v3/entities";

const json = (status, obj) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(obj),
});

// SBA certifications we surface as prominent ("key") badges when active.
const KEY_CERT = [
  "8(a)", "hubzone", "women owned", "economically disadvantaged women",
  "service-disabled veteran", "service disabled veteran", "veteran owned",
];

function isActiveCert(c) {
  const exit = c.certificationExitDate || c.exitDate;
  if (!exit) return true;                 // no exit date = active
  return new Date(exit) > new Date();     // exit in the future = still active
}

function isKey(desc) {
  const d = (desc || "").toLowerCase();
  return KEY_CERT.some((k) => d.includes(k));
}

async function samFetch(params) {
  const url = new URL(SAM_ENTITY_URL);
  url.searchParams.set("api_key", process.env.SAM_API_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SAM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- Mode: search by name -> lightweight candidates for the "is this you?" card
async function searchByName(name, state) {
  const data = await samFetch({
    legalBusinessName: name,                        // name-specific search
    registrationStatus: "A",                        // active registrations only
    stateProvince: state || undefined,
    includeSections: "entityRegistration,coreData",
  });
  const rows = data.entityData || [];
  const candidates = rows.map((e) => {
    const reg = e.entityRegistration || {};
    const addr = (e.coreData && e.coreData.physicalAddress) || {};
    return {
      uei: reg.ueiSAM,
      legal_name: reg.legalBusinessName,
      cage: reg.cageCode || null,
      city: addr.city || null,
      state: addr.stateOrProvinceCode || null,
    };
  }).filter((c) => c.uei);
  return { total: data.totalRecords || candidates.length, candidates };
}

// ---- Mode: full entity by UEI -> mapped record the generator consumes
function mapEntityToRecord(e) {
  const reg = e.entityRegistration || {};
  const core = e.coreData || {};
  const addr = core.physicalAddress || {};
  const bt = core.businessTypes || {};
  const gs = (e.assertions && e.assertions.goodsAndServices) || {};

  // NAICS — flag primary via isPrimary ("Y") or the primaryNaics field.
  const primary = gs.primaryNaics;
  const naics = (gs.naicsList || []).map((n) => ({
    code: n.naicsCode,
    title: n.naicsDescription || "",
    primary: n.isPrimary === "Y" || n.naicsCode === primary,
  }));
  // Ensure exactly one primary if the data only gave us primaryNaics.
  if (primary && !naics.some((n) => n.primary)) {
    const m = naics.find((n) => n.code === primary);
    if (m) m.primary = true;
  }

  // Socio-economic — SBA-certified types first (verified), as key badges.
  const certs = (bt.sbaBusinessTypeList || [])
    .filter(isActiveCert)
    .map((c) => ({ label: c.sbaBusinessTypeDesc || c.sbaBusinessTypeDescription, key: true }))
    .filter((c) => c.label);

  // Small-business status derived from NAICS size flags.
  const isSmall = (gs.naicsList || []).some((n) => n.sbaSmallBusiness === "Y");
  const socioeconomic = [...certs];
  if (isSmall) socioeconomic.push({ label: "Small Business", key: false });

  return {
    legal_name: reg.legalBusinessName || "",
    logo_text: (reg.legalBusinessName || "??").replace(/[^A-Za-z ]/g, "")
      .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "AG",
    uei: reg.ueiSAM || "",
    cage: reg.cageCode || "—",
    sam_status: reg.registrationStatus === "A" ? "Active" : (reg.registrationStatus || "Unknown"),
    size: isSmall ? "Small Business" : "Business",
    address: [addr.city, addr.stateOrProvinceCode].filter(Boolean).join(", "),
    naics,
    socioeconomic,
    // Not in SAM — filled by the soft-field intake or an AI draft, then edited:
    tagline_pre: "", tagline_em: "",
    competencies: [], differentiators: [],
    contact: { name: "", title: "", phone: "", email: "", website: "" },
  };
}

async function getEntity(uei) {
  const data = await samFetch({
    ueiSAM: uei,
    includeSections: "entityRegistration,coreData,assertions",
  });
  const e = (data.entityData || [])[0];
  if (!e) return null;
  return mapEntityToRecord(e);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
  if (!process.env.SAM_API_KEY) return json(500, { error: "SAM_API_KEY not set" });
  const q = event.queryStringParameters || {};
  const mode = q.mode || "search";
  try {
    if (mode === "search") {
      const name = q.name;
      if (!name) return json(400, { error: "name required" });
      return json(200, await searchByName(name, q.state));
    }
    if (mode === "entity") {
      const uei = q.uei;
      if (!uei) return json(400, { error: "uei required" });
      const rec = await getEntity(uei);
      return rec ? json(200, { record: rec }) : json(404, { error: "entity not found" });
    }
    return json(400, { error: "unknown mode" });
  } catch (err) {
    console.error(err.message);
    return json(502, { error: "SAM lookup failed", detail: err.message });
  }
};

export { searchByName, getEntity, mapEntityToRecord };
