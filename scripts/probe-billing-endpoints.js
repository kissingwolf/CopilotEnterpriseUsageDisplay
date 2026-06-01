/**
 * Probe GitHub Enterprise Copilot billing endpoints to find which one
 * actually returns model-level SKUs (e.g. "Claude Sonnet 4.6") rather
 * than product-level SKUs ("Copilot Premium Request" / "Copilot Business").
 *
 * Bypasses ETag cache and prints the first 5 usageItems for each endpoint.
 */
require("dotenv").config();

const ENT = process.env.ENTERPRISE_SLUG;
const TOKEN = process.env.GITHUB_TOKEN;
const API = process.env.GITHUB_API_BASE || "https://api.github.com";
const VERSION = process.env.GITHUB_API_VERSION || "2026-03-10";

if (!ENT || !TOKEN) {
  console.error("Missing ENTERPRISE_SLUG or GITHUB_TOKEN in .env");
  process.exit(1);
}

const year = process.argv[2] || "2026";
const month = process.argv[3] || "5";

const candidates = [
  // standard enhanced billing (AI Credits-aware)
  `/enterprises/${encodeURIComponent(ENT)}/settings/billing/usage`,
  // legacy premium request
  `/enterprises/${encodeURIComponent(ENT)}/settings/billing/premium_request/usage`,
  // explicit ai_credit family
  `/enterprises/${encodeURIComponent(ENT)}/settings/billing/ai_credit/usage`,
  // hypothetical /usage/report (unverified)
  `/enterprises/${encodeURIComponent(ENT)}/settings/billing/usage/report`,
  // summary endpoint
  `/enterprises/${encodeURIComponent(ENT)}/settings/billing/usage/summary`,
];

async function probe(pathname, extraQuery = "") {
  const url = `${API}${pathname}?year=${year}&month=${month}${extraQuery}`;
  const t0 = Date.now();
  let resp, text;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${TOKEN}`,
        "X-GitHub-Api-Version": VERSION,
      },
    });
    text = await resp.text();
  } catch (err) {
    console.log(`\n=== ${pathname}${extraQuery} ===`);
    console.log(`  ERROR: ${err.message}`);
    return;
  }
  const elapsed = Date.now() - t0;
  console.log(`\n=== ${pathname}${extraQuery} ===`);
  console.log(`  status: ${resp.status} ${resp.statusText}  (${elapsed}ms)`);

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }

  if (!resp.ok) {
    console.log(`  body: ${typeof data === "object" ? JSON.stringify(data).slice(0, 300) : String(data).slice(0, 300)}`);
    return;
  }

  const items = Array.isArray(data?.usageItems) ? data.usageItems : (Array.isArray(data) ? data : []);
  console.log(`  usageItems count: ${items.length}`);
  if (items.length === 0) {
    console.log(`  top-level keys: ${Object.keys(data || {}).join(", ")}`);
    if (data && !Array.isArray(data)) {
      console.log(`  sample: ${JSON.stringify(data).slice(0, 400)}`);
    }
    return;
  }

  const skuSet = new Set();
  const productSet = new Set();
  for (const it of items) {
    if (it?.sku) skuSet.add(String(it.sku));
    if (it?.product) productSet.add(String(it.product));
  }
  console.log(`  distinct products: [${Array.from(productSet).join(", ")}]`);
  console.log(`  distinct SKUs (${skuSet.size}):`);
  for (const sku of Array.from(skuSet).slice(0, 25)) console.log(`    - ${sku}`);
  console.log(`  first item: ${JSON.stringify(items[0])}`);
}

(async () => {
  console.log(`Probing for ENTERPRISE=${ENT}, year=${year}, month=${month}`);
  for (const path of candidates) {
    await probe(path);
  }
  // also try /usage with product=copilot filter
  await probe(`/enterprises/${encodeURIComponent(ENT)}/settings/billing/usage`, `&product=copilot`);
})();
