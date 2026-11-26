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
 *   POST /ui         {texts[], target} -> {texts[]}: app-teksten vertalen (DeepL, anders Google), 30 dagen bewaard
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

/* Lijst teksten in één keer (DeepL max. 50 per verzoek); {0}, {1} … blijven staan */
async function deeplBatch(env, texts, target) {
  const key = env.DEEPL_KEY, out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const r = await fetch(`${deeplHost(key)}/v2/translate`, { method: "POST", headers: deeplHeaders(key),
      body: JSON.stringify({ text: texts.slice(i, i + 50), source_lang: "NL", target_lang: DEEPL_TARGET[target] || target.toUpperCase(), preserve_formatting: true, tag_handling: "html" }) });
    if (!r.ok) return null;                                   // bijv. taal niet ondersteund -> Google
    out.push(...(await r.json()).translations.map(t => t.text));
  }
  return out;
}
async function googleBatch(texts, target) {
  const out = [];
  for (let i = 0; i < texts.length; i += 40) {                // enkele verzoeken, regels gescheiden
    const part = texts.slice(i, i + 40);
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=nl&tl=${target}&dt=t`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "q=" + encodeURIComponent(part.join("\n")) });
    if (!r.ok) return null;
    const lines = (await r.json())[0].map(x => x[0]).join("").split("\n");
    if (lines.length !== part.length) return null;
    out.push(...lines.map(l => l.trim()));
  }
  return out;
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

    /* ---- app-teksten (knoppen, uitleg, meldingen) in de taal van de gebruiker ---- */
    if (new URL(request.url).pathname.replace(/\/+$/, "") === "/ui") {
      let q;
      try { q = JSON.parse(await request.text()); } catch { return reply(400, { fout: "Geen geldige JSON" }); }
      const texts = (Array.isArray(q.texts) ? q.texts : []).slice(0, 400).map(t => String(t).slice(0, 1500));
      const target = String(q.target || "").replace(/[^a-z]/gi, "").slice(0, 3).toLowerCase();
      if (!texts.length || !target) return reply(400, { fout: "texts en target zijn verplicht" });
      if (target === "nl") return reply(200, { texts });
      // gedeelde opslag: zelfde teksten + taal worden maar één keer vertaald
      const key = new Request(`https://cache.live-tolk/ui/${target}/${await sha(JSON.stringify(texts))}`);
      const cache = caches.default;
      const hit = await cache.match(key);
      if (hit) return reply(200, await hit.json());
      let out = null, dienst = "deepl";
      if (env.DEEPL_KEY) out = await deeplBatch(env, texts, target).catch(() => null);
      if (!out) { dienst = "google"; out = await googleBatch(texts, target).catch(() => null); }
      if (!out) return reply(502, { fout: "Vertalen mislukt" });
      const body = { texts: out, dienst };
      await cache.put(key, new Response(JSON.stringify(body), { headers: { "Cache-Control": "public, max-age=2592000" } }));
      return reply(200, body);
    }

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
   ongewijzigd naar de ander; de ruimte bewaart geen berichten, alleen tot wanneer de code geldig is.
   Binnen die tijd kan ieder (ook na het sluiten van de app) met dezelfde code terugkomen. */
const GELDIG = { dag: "dag", "24u": 24 * 3600e3, week: 7 * 24 * 3600e3 };
function endOfDayAmsterdam(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(x => [x.type, +x.value]));
  return now + ((23 - p.hour) * 3600 + (59 - p.minute) * 60 + (60 - p.second)) * 1000;
}
export class Room {
  /* Twee soorten ruimtes:
     - gesprek:   één 'maker' en één 'deelnemer'; alles wat de één stuurt gaat naar de ander.
     - toespraak: één 'spreker' en tot 300 'luisteraars'; alleen de spreker stuurt, naar alle luisteraars.
       De spreker krijgt steeds door hoeveel luisteraars er zijn, per taal. */
  constructor(state) {
    this.state = state;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch(request) {
    const url = new URL(request.url);
    const ROLES = ["maker", "deelnemer", "spreker", "luisteraar"];
    const role = ROLES.includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "deelnemer";
    const creator = role === "maker" || role === "spreker";
    const type = role === "spreker" || role === "luisteraar" ? "toespraak" : "gesprek";
    const sid = (url.searchParams.get("id") || "").replace(/[^a-z0-9]/gi, "").slice(0, 16) || "x";
    const lang = (url.searchParams.get("lang") || "").replace(/[^a-z-]/gi, "").slice(0, 8);
    const nieuw = url.searchParams.get("nieuw") === "1";
    const geldig = GELDIG[url.searchParams.get("geldig")] ? url.searchParams.get("geldig") : "dag";
    const [client, server] = Object.values(new WebSocketPair());
    const now = Date.now();

    let meta = await this.state.storage.get("meta");
    if (meta && meta.expires < now) { meta = null; await this.state.storage.delete("meta"); }

    const refuse = err => {
      server.accept();
      server.send(JSON.stringify({ t: "_sys", ev: "error", reden: err }));
      server.close(4000, err);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (nieuw && creator) {
      if (meta) return refuse("in-gebruik");          // code bestaat al: app kiest een andere
      meta = { expires: geldig === "dag" ? endOfDayAmsterdam(now) : now + GELDIG[geldig], geldig, type };
      await this.state.storage.put("meta", meta);
    }
    if (!meta) return refuse(nieuw ? "in-gebruik" : "niet-gevonden");   // onbekend of verlopen
    if ((meta.type || "gesprek") !== type) return refuse(type === "toespraak" ? "geen-toespraak" : "is-toespraak");

    const tags = ws => this.state.getTags(ws);
    let sockets = this.state.getWebSockets();
    // zelfde toestel komt terug: oude verbinding opruimen
    for (const ws of sockets) if (tags(ws).includes("id:" + sid)) { try { ws.close(4001, "vervangen"); } catch {} }
    sockets = sockets.filter(ws => !tags(ws).includes("id:" + sid));
    if (role === "luisteraar") {
      if (sockets.filter(ws => tags(ws).includes("luisteraar")).length >= 300) return refuse("vol");
    } else if (sockets.some(ws => tags(ws).includes(role))) return refuse(creator ? "in-gebruik" : "vol");

    this.state.acceptWebSocket(server, [role, "id:" + sid, "lang:" + lang]);
    if (type === "toespraak") {
      const speaker = sockets.some(ws => tags(ws).includes("spreker"));
      server.send(JSON.stringify({ t: "_sys", ev: "joined", peers: role === "spreker" ? 0 : (speaker ? 1 : 0), expires: meta.expires }));
      if (role === "luisteraar") this.notify("spreker", { t: "_sys", ev: "peer-joined" }, server);
      else this.notify("luisteraar", { t: "_sys", ev: "peer-joined" }, server);
      this.listeners();
    } else {
      server.send(JSON.stringify({ t: "_sys", ev: "joined", peers: sockets.length, expires: meta.expires }));
      for (const ws of sockets) { try { ws.send(JSON.stringify({ t: "_sys", ev: "peer-joined" })); } catch {} }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  notify(role, obj, except) {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) if (ws !== except && this.state.getTags(ws).includes(role)) { try { ws.send(msg); } catch {} }
  }
  /* spreker op de hoogte houden: aantal luisteraars per taal */
  listeners(except) {
    const talen = {};
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const t = this.state.getTags(ws);
      if (!t.includes("luisteraar")) continue;
      const l = (t.find(x => x.startsWith("lang:")) || "lang:").slice(5) || "?";
      talen[l] = (talen[l] || 0) + 1;
    }
    this.notify("spreker", { t: "_sys", ev: "luisteraars", talen }, except);
  }
  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 1000000 || msg === "ping") return;   // ruim genoeg voor een verkleinde foto
    const t = this.state.getTags(ws);
    if (t.includes("luisteraar")) return;                         // luisteraars sturen niets door
    if (t.includes("spreker")) return this.broadcast(msg, ws);
    for (const other of this.state.getWebSockets()) if (other !== ws) { try { other.send(msg); } catch {} }
  }
  broadcast(msg, except) {
    for (const ws of this.state.getWebSockets()) if (ws !== except && this.state.getTags(ws).includes("luisteraar")) { try { ws.send(msg); } catch {} }
  }
  webSocketClose(ws, code, reason) {
    const t = this.state.getTags(ws);
    if (code !== 4001) {
      if (t.includes("luisteraar")) this.listeners(ws);
      else if (t.includes("spreker")) this.notify("luisteraar", { t: "_sys", ev: "peer-left" }, ws);
      else for (const other of this.state.getWebSockets()) if (other !== ws) { try { other.send(JSON.stringify({ t: "_sys", ev: "peer-left" })); } catch {} }
    }
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011, "fout"); }
}
