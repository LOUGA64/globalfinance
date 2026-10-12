// GlobalFinance — pré-chargement serveur des flux RSS et des cours Yahoo Finance.
// Exécuté par GitHub Actions (.github/workflows/update-data.yml) toutes les 15 min en semaine.
// Produit data/feeds.json, data/yahoo.json et data/meta.json, servis par GitHub Pages à côté de index.html.
// Node 20+, aucune dépendance.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);
const PREV_BASE = process.env.PREV_BASE || 'https://louga64.github.io/globalfinance/data/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_ITEMS = 40, MAX_AGE_DAYS = 8, MAX_NEW_TRANSLATIONS = 300;
const t0 = Date.now();

// ── 1. Lire la configuration directement dans index.html (source unique) ──
export function readConfig(html) {
  const a = html.indexOf('/*@@CONFIG-START@@');
  const b = html.indexOf('/*@@CONFIG-END@@*/');
  if (a < 0 || b < 0) throw new Error('Bloc CONFIG introuvable dans index.html');
  const code = html.slice(html.indexOf('*/', a) + 2, b);
  return new vm.Script(code + '\n;({feeds:ALL_FEEDS(), yahoo:ALL_YAHOO(), tickers:ALL_TICKERS()})').runInNewContext({});
}

// ── 2. Parseur RSS/Atom (identique à celui de la page) ──
export function isFeed(xml) { return typeof xml === 'string' && /<(rss|feed|rdf:RDF)[\s>]/i.test(xml); }
export function parseRSS(xml) {
  const items = [];
  if (!isFeed(xml)) return items;
  const getTag = (s, tag) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim() : '';
  };
  for (const e of xml.split(/<item[\s>]|<entry[\s>]/i).slice(1)) {
    const title = getTag(e, 'title');
    const link = (e.match(/<link[^>]*href="([^"]+)"/i) || e.match(/<link[^>]*>([^<]+)/i) || [])[1] || '';
    const desc = getTag(e, 'description') || getTag(e, 'summary') || getTag(e, 'content');
    const date = getTag(e, 'pubDate') || getTag(e, 'published') || getTag(e, 'updated') || getTag(e, 'dc:date');
    const publisher = getTag(e, 'source');
    let t = title; if (publisher && t.endsWith(' - ' + publisher)) t = t.slice(0, -(publisher.length + 3));
    let d = desc; if (/news\.google\./.test(link)) d = publisher ? 'Source : ' + publisher : '';
    if (t.length > 5) items.push({ title: t, link: link.trim(), description: d.slice(0, 280), pubDate: date, publisher });
  }
  return items;
}

// ── 3. Téléchargement avec limite de concurrence par hôte ──
const hostQueues = new Map();
const HOST_LIMIT = { 'news.google.com': 3, 'query1.finance.yahoo.com': 3, 'query2.finance.yahoo.com': 3, 'www.google.com': 3, 'www.sec.gov': 2 };
async function withHost(url, fn) {
  const h = new URL(url).hostname, lim = HOST_LIMIT[h] || 6;
  let q = hostQueues.get(h); if (!q) { q = { n: 0, w: [] }; hostQueues.set(h, q); }
  if (q.n >= lim) await new Promise(r => q.w.push(r));
  q.n++;
  try { return await fn(); } finally { q.n--; const nx = q.w.shift(); if (nx) setTimeout(nx, h === 'news.google.com' ? 250 : 0); }
}
// La SEC exige un User-Agent déclaré (nom d'application + contact), sinon 403
const SEC_UA = 'GlobalFinance personal dashboard github.com/LOUGA64/globalfinance';
async function get(url, { tries = 2, timeout = 15000, accept = '*/*', headers = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ua = url.includes('sec.gov') ? SEC_UA : UA;
      const r = await withHost(url, () => fetch(url, { headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'follow' }));
      if (r.ok) return await r.text();
      last = new Error('HTTP ' + r.status);
      if (r.status === 404 || r.status === 403 || r.status === 400) break;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}
async function getPrev(file) {
  try { const r = await fetch(PREV_BASE + file + '?v=' + Date.now(), { signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// ── 4. Traduction des titres (Google Translate gtx), avec réutilisation des traductions précédentes ──
async function translateBatch(titles) {
  const text = titles.map(t => t.replace(/\n/g, ' ')).join('\n');
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=fr&dt=t&q=' + encodeURIComponent(text);
  const data = JSON.parse(await get(url, { tries: 2, timeout: 12000 }));
  const out = (data?.[0] || []).map(x => x?.[0] || '').join('').split('\n').map(s => s.trim());
  if (out.length !== titles.length) throw new Error(`lignes ${out.length}/${titles.length}`);
  return out;
}

// ── 5. Allègement des réponses Yahoo (on ne garde que ce que la page utilise) ──
export function slimYahoo(json, url) {
  const r = json?.chart?.result?.[0];
  if (!r?.meta || r.meta.regularMarketPrice == null) return null;
  const m = r.meta;
  const slim = { meta: { symbol: m.symbol, currency: m.currency, regularMarketPrice: m.regularMarketPrice, regularMarketTime: m.regularMarketTime,
    chartPreviousClose: m.chartPreviousClose, exchangeName: m.exchangeName } };
  if (url.includes('range=5d')) slim.indicators = { quote: [{ close: (r.indicators?.quote?.[0]?.close || []) }] };
  if (r.events?.dividends) slim.events = { dividends: r.events.dividends };
  return { chart: { result: [slim] } };
}

export // ── Yahoo : session (cookie + crumb), indispensable depuis les serveurs cloud ──
const yahoo = { cookie: '', crumb: '', status: {} };
async function yahooSession() {
  try {
    const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    yahoo.cookie = sc.map(c => c.split(';')[0]).filter(Boolean).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: yahoo.cookie }, signal: AbortSignal.timeout(10000) });
    yahoo.crumb = c.ok ? (await c.text()).trim() : '';
    yahoo.session = `cookie:${yahoo.cookie ? 'oui' : 'non'} crumb:${yahoo.crumb ? 'oui' : 'HTTP ' + c.status}`;
  } catch (e) { yahoo.session = 'échec ' + (e.message || e); }
}
async function fetchYahoo(url) {
  for (const host of ['query1.', 'query2.']) {
    let u = url.replace('query1.', host);
    if (yahoo.crumb) u += '&crumb=' + encodeURIComponent(yahoo.crumb);
    try {
      const r = await withHost(u, () => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(yahoo.cookie ? { Cookie: yahoo.cookie } : {}) }, signal: AbortSignal.timeout(15000) }));
      yahoo.status[r.status] = (yahoo.status[r.status] || 0) + 1;
      if (!r.ok) { if (r.status === 429) await new Promise(z => setTimeout(z, 1500)); continue; }
      const s = slimYahoo(JSON.parse(await r.text()), url);
      if (s) return s;
    } catch (e) { yahoo.status.err = (yahoo.status.err || 0) + 1; }
  }
  return null;
}
// ── Google Finance (page publique) : cours + clôture veille, mis au format Yahoo pour la page ──
const gfin = { status: {} };
const num = v => { const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
export function parseGoogleFinance(html) {
  const price = num((html.match(/data-last-price="([^"]+)"/) || [])[1]);
  if (price == null) return null;
  let cur = (html.match(/data-currency-code="([A-Z]{3})"/) || [])[1] || 'EUR';
  const ts = parseInt((html.match(/data-last-normal-market-timestamp="(\d+)"/) || [])[1] || '0', 10);
  const pcBlock = (html.match(/Previous close[\s\S]{0,400}/i) || [''])[0].replace(/<[^>]*>/g, ' ');
  const prev = num((pcBlock.match(/[$€£]?\s?\d[\d,]*\.?\d*/g) || []).find(x => /\d/.test(x)));
  let p = price, pv = prev;
  if (cur === 'GBX') cur = 'GBp';
  return { meta: { currency: cur, regularMarketPrice: p, regularMarketTime: ts || Math.floor(Date.now() / 1000), chartPreviousClose: pv, source: 'google' },
    indicators: { quote: [{ close: pv != null ? [pv, p] : [p] }] } };
}
async function fetchGoogle(code) {
  const u = `https://www.google.com/finance/quote/${code}?hl=en`;
  try {
    const r = await withHost(u, () => fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb' }, signal: AbortSignal.timeout(15000) }));
    gfin.status[r.status] = (gfin.status[r.status] || 0) + 1;
    if (!r.ok) return null;
    const g = parseGoogleFinance(await r.text());
    if (!g) gfin.status.parse = (gfin.status.parse || 0) + 1;
    return g ? { chart: { result: [g] } } : null;
  } catch { gfin.status.err = (gfin.status.err || 0) + 1; return null; }
}

// ── Diagnostic : teste plusieurs sources de cours depuis le serveur (résultat dans meta.diag) ──
async function probe(name, url, headers = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', ...headers }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    const body = await r.text();
    const pick = re => { const m = body.match(re); return m ? m[0].slice(0, 220) : null; };
    return { name, status: r.status, ms: Date.now() - t, len: body.length, finalUrl: r.url.slice(0, 120),
      title: (body.match(/<title>([^<]{0,120})/i) || [])[1] || null, head: body.slice(0, 160).replace(/\s+/g, ' '),
      hits: { lastPrice: pick(/data-last-price[^>]{0,150}/), prevClose: pick(/Previous close[\s\S]{0,200}/i), consent: /consent\.google|before you continue|avant d'accéder/i.test(body),
        ftValue: pick(/mod-ui-data-list__value[^<]{0,40}<?[^<]{0,40}/), json: pick(/"(c|close|last|regularMarketPrice)"\s*:\s*[\d.]+/) } };
  } catch (e) { return { name, error: String(e.message || e).slice(0, 100), ms: Date.now() - t }; }
}
async function diagnostics() {
  const out = [];
  const raw = async (name, url) => { try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }); const t = await r.text(); out.push({ name, status: r.status, body: t.slice(0, 2500) }); } catch (e) { out.push({ name, error: String(e) }); } };
  await raw('cnbc-multi', 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' + encodeURIComponent('BNP-FR|ELISA-FI|AKRBP-NO|ISP-IT|HAVAS-NL|CAN-GB|CHMI|SFL|COFA-FR|ALHF-FR') + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json');
  await raw('bourso-COFA', 'https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=1rPCOFA&period=-1');
  await raw('bourso-ALHF', 'https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=1rPALHF&period=-1');
  await raw('bourso-ISP', 'https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=1gISP&period=-1');
  await raw('bourso-GLE-5d', 'https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=1rPGLE&period=0');
  return out;
}

export async function main() {
  const html = await readFile(new URL('index.html', ROOT), 'utf8');
  const cfg = readConfig(html);
  console.log(`Config : ${cfg.feeds.length} flux, ${cfg.yahoo.length} cours`);
  const [prevFeeds, prevYahoo] = await Promise.all([getPrev('feeds.json'), getPrev('yahoo.json')]);

  // Flux
  const lim = Date.now() - MAX_AGE_DAYS * 864e5;
  const feeds = {}, failures = []; let feedsOk = 0, feedsStale = 0;
  await Promise.all(cfg.feeds.map(async f => {
    try {
      const xml = await get(f.url, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' });
      if (!isFeed(xml)) throw new Error('réponse non-RSS : ' + xml.slice(0, 60).replace(/\s+/g, ' '));
      let items = parseRSS(xml);   // 0 article = flux valide mais vide (conservé tel quel)
      items = items.filter(a => { const t = new Date(a.pubDate).getTime(); return isNaN(t) || t > lim; }).slice(0, MAX_ITEMS);
      feeds[f.url] = items; feedsOk++;
    } catch (e) {
      const old = prevFeeds?.feeds?.[f.url];
      if (old?.length) { feeds[f.url] = old; feedsStale++; }
      failures.push({ url: f.url, error: String(e.message || e).slice(0, 120), reusedPrevious: !!old?.length });
    }
  }));

  // Traductions (titres des flux non francophones)
  const prevTr = new Map();
  for (const items of Object.values(prevFeeds?.feeds || {})) for (const a of items) if (a.titleFr) prevTr.set(a.title, a.titleFr);
  const toTr = [];
  for (const f of cfg.feeds) {
    if (f.lang === 'fr' || !feeds[f.url]) continue;
    for (const a of feeds[f.url]) {
      if (a.titleFr) continue;
      if (prevTr.has(a.title)) a.titleFr = prevTr.get(a.title); else toTr.push(a);
    }
  }
  const uniq = [...new Set(toTr.map(a => a.title))].slice(0, MAX_NEW_TRANSLATIONS);
  const trMap = new Map(); let trFail = 0;
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    try { (await translateBatch(batch)).forEach((t, k) => { if (t) trMap.set(batch[k], t); }); }
    catch { trFail += batch.length; }
  }
  for (const a of toTr) if (trMap.has(a.title)) a.titleFr = trMap.get(a.title);

  // Cours : Yahoo (session) → Google Finance (cours du jour, sans historique de dividendes) → valeur précédente
  const diag = await diagnostics();
  await yahooSession();
  const gcode = new Map(cfg.tickers.map(x => [x.t, x.g]));
  const charts = {}; let yahooOk = 0, yahooStale = 0, googleOk = 0;
  await Promise.all(cfg.yahoo.map(async url => {
    const t = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    let s = await fetchYahoo(url);
    if (s) { charts[url] = s; yahooOk++; return; }
    if (url.includes('range=5d')) {
      s = await fetchGoogle(gcode.get(t));
      if (s) { charts[url] = s; googleOk++; return; }
    }
    const old = prevYahoo?.charts?.[url];
    if (old) { charts[url] = old; yahooStale++; }
    failures.push({ url, error: `cours indisponible (${t} / ${gcode.get(t)})`, reusedPrevious: !!old });
  }));

  const generated = new Date().toISOString();
  const meta = { generated, feedsTotal: cfg.feeds.length, feedsOk, feedsStale, yahooTotal: cfg.yahoo.length, yahooOk: yahooOk + googleOk, yahooStale,
    diag,
    prices: { yahoo: yahooOk, google: googleOk, yahooSession: yahoo.session, yahooHttp: yahoo.status, googleHttp: gfin.status },
    translated: trMap.size, translationsReused: prevTr.size, translationFailed: trFail,
    durationMs: Date.now() - t0, failures };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/feeds.json', ROOT), JSON.stringify({ generated, feeds }));
  await writeFile(new URL('data/yahoo.json', ROOT), JSON.stringify({ generated, charts }));
  await writeFile(new URL('data/meta.json', ROOT), JSON.stringify(meta, null, 1));
  console.log(`Flux ${feedsOk}/${cfg.feeds.length} (+${feedsStale} repris) · Cours Yahoo ${yahooOk} + Google ${googleOk} /${cfg.yahoo.length} (+${yahooStale} repris) · ${trMap.size} titres traduits · ${meta.durationMs} ms`);
  console.log('Yahoo', yahoo.session, JSON.stringify(yahoo.status), '· Google', JSON.stringify(gfin.status));
  for (const f of failures.slice(0, 40)) console.log('  ✗', f.error, f.url.slice(0, 110));
  // Échec total = ne pas déployer (on garde la version précédente en ligne)
  if (feedsOk === 0 && yahooOk + googleOk === 0) { console.error('Aucune source joignable : déploiement annulé'); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
