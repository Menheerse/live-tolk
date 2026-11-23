/*
 * Live Tolk – tussenstation (Cloudflare Worker)
 *
 * Ontvangt zinnen van de app en zet ze als JSON-bestand in de privé GitHub-repository.
 * De GitHub-sleutel staat alleen hier, als geheime instelling, en nooit in de app.
 * Deze Worker kan uitsluitend NIEUWE bestanden toevoegen; lezen of wissen kan niet.
 *
 * Instellingen in Cloudflare (Settings → Variables and Secrets):
 *   GITHUB_TOKEN    (Secret)  fijnmazige sleutel met Contents: Read and write op de data-repository
 *   REPO            (Text)    bijv. Menheerse/live-tolk-data
 *   ALLOWED_ORIGIN  (Text)    bijv. https://menheerse.github.io
 */

const MAX_BODY = 200_000;   // bytes per verzending
const MAX_ITEMS = 200;      // zinnen per verzending
const FIELDS = ["tijd", "modus", "spreker", "van", "naar", "gesproken", "vertaling", "vertaaldienst", "herkenning", "ms"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : (allowed[0] || ""),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (status, obj) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return reply(200, { ok: true, dienst: "Live Tolk tussenstation" });
    if (request.method !== "POST") return reply(405, { fout: "Alleen POST" });
    if (!okOrigin) return reply(403, { fout: "Niet toegestaan vanaf deze website" });
    if (!env.GITHUB_TOKEN || !env.REPO) return reply(500, { fout: "Worker is niet ingesteld (GITHUB_TOKEN/REPO)" });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { fout: "Te groot" });

    let data;
    try { data = JSON.parse(raw); } catch { return reply(400, { fout: "Geen geldige JSON" }); }
    const items = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
    if (!items.length) return reply(400, { fout: "Geen zinnen" });

    // Alleen bekende velden doorlaten, en teksten inkorten
    const clean = items.map(it => {
      const o = {};
      for (const f of FIELDS) {
        if (it == null || it[f] == null) continue;
        o[f] = typeof it[f] === "number" ? it[f] : String(it[f]).slice(0, 2000);
      }
      return o;
    });

    const device = String(data.device || "onbekend").replace(/[^a-z0-9]/gi, "").slice(0, 12) || "onbekend";
    const now = new Date();
    const rnd = Math.random().toString(36).slice(2, 6);
    const path = `teksten/${now.toISOString().slice(0, 10)}/${now.toISOString().slice(11, 19).replace(/:/g, "")}-${device}-${rnd}.json`;

    const bytes = new TextEncoder().encode(JSON.stringify(clean, null, 1));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));

    const gh = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "live-tolk-worker",
      },
      body: JSON.stringify({ message: `Live Tolk: ${clean.length} zinnen (${device})`, content: btoa(bin) }),
    });

    if (!gh.ok) return reply(502, { fout: "GitHub weigerde", status: gh.status });
    return reply(200, { ok: true, aantal: clean.length });
  },
};
