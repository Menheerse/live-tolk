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
 *   DEEPL_KEY       (Secret)  optioneel: DeepL API-sleutel; dan vertaalt /translate via DeepL
 *   GLOSSARY_URL    (Text)    optioneel: adres van de woordenlijst (standaard woordenlijst.json in de app-repository)
 *
 * Routes:
 *   POST /           zinnen opslaan in GitHub
 *   POST /translate  {text, source, target} -> {text} via DeepL
 *   GET  /room/CODE  websocket naar de gespreksruimte (Durable Object 'Room') voor 'Op afstand'
 *
 * Deze Worker wordt automatisch vanuit GitHub gepubliceerd via Cloudflare Builds (zie wrangler.jsonc in deze map).
 */

/* DeepL wil bij sommige doeltalen een variant */
const DEEPL_TARGET = { en: "EN-GB", pt: "PT-PT", zh: "ZH-HANS" };
const GLOSSARY_URL = "https://raw.githubusercontent.com/Menheerse/live-tolk/main/woordenlijst.json";
const GLOSSARY_REFRESH = 10 * 60 * 1000; // woordenlijst elke 10 minuten opnieuw controleren

const deeplHost = key => key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
const deeplHeaders = key => ({ "Authorization": `DeepL-Auth-Key ${key.trim()}`, "Content-Type": "application/json", "User-Agent": "live-tolk-worker" });

/* ---- bouwwoordenlijst -> DeepL-woordenlijst (glossary) ----
   Leest woordenlijst.json, maakt per talenpaar een woordenboek en zet dat als één meertalige
   DeepL-woordenlijst klaar. Bij een gewijzigde lijst komt er een nieuwe (naam bevat een hash)
   en worden oude Live Tolk-lijsten opgeruimd. Lukt dit niet, dan wordt gewoon zonder vertaald. */
let gl = { checked: 0, hash: "", id: null, pairs: new Set(), busy: null };

function buildDictionaries(data) {
  const langs = (data.talen || []).map(l => String(l).toLowerCase());
  const terms = Array.isArray(data.termen) ? data.termen : [];
  const clean = v => String(v || "").replace(/[\t\r\n]/g, " ").trim();
  const dicts = [];
  for (const a of langs) for (const b of langs) {
    if (a === b) continue;
    const seen = new Set(), lines = [];
    for (const t of terms) {
      const src = clean(t[a]), dst = clean(t[b]);
      if (!src || !dst) continue;
      if (a !== "nl" && b !== "nl") continue;               // alleen paren met Nederlands
      if (a !== "nl" && t.alleenVanuitNL) continue;          // dubbelzinnig: niet terugvertalen
      const k = src.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      lines.push(`${src}\t${dst}`);
    }
    if (lines.length) dicts.push({ source_lang: a, target_lang: b, entries: lines.join("\n"), entries_format: "tsv" });
  }
  return dicts;
}

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 6).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function refreshGlossary(env) {
  const key = env.DEEPL_KEY, host = deeplHost(key);
  const r = await fetch(env.GLOSSARY_URL || GLOSSARY_URL, { headers: { "User-Agent": "live-tolk-worker" }, cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error("woordenlijst niet gevonden");
  const raw = await r.text();
  const hash = await sha(raw);
  if (hash === gl.hash && gl.id) return;
  const dicts = buildDictionaries(JSON.parse(raw));
  const name = `live-tolk-${hash}`;

  const list = await fetch(`${host}/v3/glossaries`, { headers: deeplHeaders(key) });
  const existing = list.ok ? ((await list.json()).glossaries || []) : [];
  let id = existing.find(g => g.name === name)?.glossary_id;
  if (!id && dicts.length) {
    const c = await fetch(`${host}/v3/glossaries`, { method: "POST", headers: deeplHeaders(key), body: JSON.stringify({ name, dictionaries: dicts }) });
    if (!c.ok) throw new Error("woordenlijst aanmaken mislukt: " + c.status);
    id = (await c.json()).glossary_id;
  }
  // oude Live Tolk-woordenlijsten opruimen
  for (const g of existing) if (g.name?.startsWith("live-tolk-") && g.name !== name)
    await fetch(`${host}/v3/glossaries/${g.glossary_id}`, { method: "DELETE", headers: deeplHeaders(key) }).catch(() => {});
  gl = { ...gl, hash, id, pairs: new Set(dicts.map(d => `${d.source_lang}>${d.target_lang}`)) };
}

async function glossaryFor(env, source, target) {
  if (Date.now() - gl.checked > GLOSSARY_REFRESH) {
    gl.checked = Date.now();
    gl.busy = refreshGlossary(env).catch(e => { console.log("woordenlijst:", e.message); }).finally(() => { gl.busy = null; });
  }
  if (gl.busy && !gl.id) await gl.busy;           // eerste keer: even wachten op de lijst
  return gl.id && gl.pairs.has(`${source}>${target}`) ? gl.id : null;
}

async function deeplTranslate(env, text, source, target) {
  const key = env.DEEPL_KEY;
  const host = deeplHost(key);
  const body = { text: [text], target_lang: DEEPL_TARGET[target] || target.toUpperCase() };
  if (source) {
    body.source_lang = source.toUpperCase();
    const gid = await glossaryFor(env, source.toLowerCase(), target);
    if (gid) body.glossary_id = gid;
  }
  let r = await fetch(`${host}/v2/translate`, { method: "POST", headers: deeplHeaders(key), body: JSON.stringify(body) });
  if (!r.ok && body.glossary_id) {                 // woordenlijst geweigerd? dan zonder opnieuw
    delete body.glossary_id;
    r = await fetch(`${host}/v2/translate`, { method: "POST", headers: deeplHeaders(key), body: JSON.stringify(body) });
  }
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { status: 200, text: j.translations?.[0]?.text ?? "", woordenlijst: !!body.glossary_id };
}

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
    if (request.method === "GET" && request.headers.get("Upgrade") === "websocket") {
      if (!okOrigin) return new Response("Niet toegestaan", { status: 403 });
      const m = new URL(request.url).pathname.match(/^\/room\/([A-Z0-9]{6})\/?$/);
      if (!m) return new Response("Onbekende ruimte", { status: 404 });
      if (!env.ROOMS) return new Response("geen-ruimte", { status: 501 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
    }
    if (request.method === "GET") return reply(200, { ok: true, dienst: "Live Tolk tussenstation", ruimtes: !!env.ROOMS, deepl: !!env.DEEPL_KEY });
    if (request.method !== "POST") return reply(405, { fout: "Alleen POST" });
    if (!okOrigin) return reply(403, { fout: "Niet toegestaan vanaf deze website" });

    /* ---- vertalen via DeepL ---- */
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/translate") {
      if (!env.DEEPL_KEY) return reply(501, { fout: "DeepL niet ingesteld (DEEPL_KEY)" });
      let q;
      try { q = JSON.parse(await request.text()); } catch { return reply(400, { fout: "Geen geldige JSON" }); }
      const text = String(q.text || "").slice(0, 3000);
      const source = String(q.source || "").replace(/[^a-z]/gi, "").slice(0, 3);
      const target = String(q.target || "").replace(/[^a-z]/gi, "").slice(0, 3).toLowerCase();
      if (!text || !target) return reply(400, { fout: "text en target zijn verplicht" });
      const res = await deeplTranslate(env, text, source, target);
      if (res.status !== 200) return reply(res.status === 400 ? 422 : 502, { fout: "DeepL weigerde", status: res.status });
      return reply(200, { text: res.text, dienst: "deepl", woordenlijst: res.woordenlijst });
    }
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

/* ---- Gespreksruimte voor 'Op afstand' ----
   Eén ruimte per gesprekscode, voor één maker en één deelnemer. Berichten van de één gaan
   ongewijzigd naar de ander; de ruimte bewaart zelf niets. Toestellen die na een storing
   terugkomen (zelfde sessie-id) nemen hun plek weer in. */
export class Room {
  constructor(state) {
    this.state = state;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "maker" ? "maker" : "deelnemer";
    const sid = (url.searchParams.get("id") || "").replace(/[^a-z0-9]/gi, "").slice(0, 16) || "x";
    const [client, server] = Object.values(new WebSocketPair());
    const tags = ws => this.state.getTags(ws);
    let sockets = this.state.getWebSockets();

    // zelfde toestel komt terug: oude verbinding opruimen
    for (const ws of sockets) if (tags(ws).includes("id:" + sid)) { try { ws.close(4001, "vervangen"); } catch {} }
    sockets = sockets.filter(ws => !tags(ws).includes("id:" + sid));

    const makers = sockets.filter(ws => tags(ws).includes("maker"));
    const joiners = sockets.filter(ws => tags(ws).includes("deelnemer"));
    let err = null;
    if (role === "maker" && makers.length) err = "in-gebruik";
    if (role === "deelnemer" && !makers.length) err = "niet-gevonden";
    if (role === "deelnemer" && joiners.length) err = "vol";
    if (err) {
      server.accept();
      server.send(JSON.stringify({ t: "_sys", ev: "error", reden: err }));
      server.close(4000, err);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server, [role, "id:" + sid]);
    server.send(JSON.stringify({ t: "_sys", ev: "joined", peers: sockets.length }));
    for (const ws of sockets) { try { ws.send(JSON.stringify({ t: "_sys", ev: "peer-joined" })); } catch {} }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 20000 || msg === "ping") return;
    for (const other of this.state.getWebSockets()) if (other !== ws) { try { other.send(msg); } catch {} }
  }
  webSocketClose(ws, code, reason) {
    if (code !== 4001) for (const other of this.state.getWebSockets()) if (other !== ws) { try { other.send(JSON.stringify({ t: "_sys", ev: "peer-left" })); } catch {} }
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011, "fout"); }
}
