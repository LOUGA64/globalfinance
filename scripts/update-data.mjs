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
const HOST_LIMIT = { 'www.boursorama.com': 3, 'news.google.com': 3, 'query1.finance.yahoo.com': 3, 'query2.finance.yahoo.com': 3, 'www.google.com': 3, 'www.sec.gov': 2 };
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
    if (c.status === 429) yahoo.blocked = true; // IP des serveurs GitHub bloquée par Yahoo : inutile d'insister
    yahoo.session = `cookie:${yahoo.cookie ? 'oui' : 'non'} crumb:${yahoo.crumb ? 'oui' : 'HTTP ' + c.status}`;
  } catch (e) { yahoo.session = 'échec ' + (e.message || e); }
}
async function fetchYahoo(url) {
  if (yahoo.blocked) return null;
  for (const host of ['query1.', 'query2.']) {
    if (yahoo.blocked) return null;
    let u = url.replace('query1.', host);
    if (yahoo.crumb) u += '&crumb=' + encodeURIComponent(yahoo.crumb);
    try {
      const r = await withHost(u, () => fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(yahoo.cookie ? { Cookie: yahoo.cookie } : {}) }, signal: AbortSignal.timeout(15000) }));
      yahoo.status[r.status] = (yahoo.status[r.status] || 0) + 1;
      if (!r.ok) { if (r.status === 429 && (yahoo.status[429] || 0) >= 6) yahoo.blocked = true; continue; }
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

// ── CNBC (testé OK depuis GitHub le 12/10/2026) : cours, clôture veille, dividende annuel, rendement ──
const CNBC_X = { PA: 'FR', AS: 'NL', MI: 'IT', OL: 'NO', HE: 'FI', L: 'GB', DE: 'DE', MC: 'ES', SW: 'CH', CO: 'DK' };
const CNBC_OVERRIDE = { 'NOVO-B.CO': 'NOVOB-DK' };
export function cnbcCode(t) { if (CNBC_OVERRIDE[t]) return CNBC_OVERRIDE[t]; const [c, x] = t.split('.'); return x ? `${c}-${CNBC_X[x] || x}` : c; }
const cnbc = { status: {}, unresolved: [] };
const n2 = v => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[,%+\s]/g, '')); return isFinite(n) ? n : null; };
export function cnbcToChart(q) {
  const last = n2(q.last); if (last == null) return null;
  const prev = n2(q.previous_day_closing);
  let cur = q.currencyCode || 'EUR'; if (cur === 'GBp' || cur === 'GBX') cur = 'GBp';
  const ts = Date.parse(q.last_time) ; 
  return { chart: { result: [{ meta: { symbol: q.symbol, currency: cur, regularMarketPrice: last, regularMarketTime: isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000),
    chartPreviousClose: prev, source: 'cnbc', annualDividend: n2(q.dividend), dividendYield: n2(q.dividendyield), pe: n2(q.pe),
    yearHigh: n2(q.yrhiprice), yearLow: n2(q.yrloprice) }, indicators: { quote: [{ close: prev != null ? [prev, last] : [last] }] } }] } };
}
async function fetchCNBC(tickers) {
  const out = new Map();
  for (let i = 0; i < tickers.length; i += 10) {
    const grp = tickers.slice(i, i + 10), codes = grp.map(cnbcCode);
    const u = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' + encodeURIComponent(codes.join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      cnbc.status[r.status] = (cnbc.status[r.status] || 0) + 1;
      if (!r.ok) continue;
      const list = JSON.parse(await r.text())?.FormattedQuoteResult?.FormattedQuote || [];
      const bySym = new Map(list.map(q => [q.symbol, q]));
      grp.forEach((t, k) => { const q = bySym.get(codes[k]); const c = q && String(q.code) === '0' ? cnbcToChart(q) : null; if (c) out.set(t, c); else cnbc.unresolved.push(t + '→' + codes[k]); });
    } catch (e) { cnbc.status.err = (cnbc.status.err || 0) + 1; }
  }
  return out;
}
// ── Boursorama (secours, valeurs de Paris) : cours + variation absolue du jour ──
async function fetchBourso(t) {
  if (!t.endsWith('.PA')) return null;
  const u = `https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=1rP${encodeURIComponent(t.slice(0, -3))}&period=-1`;
  try {
    const r = await withHost(u, () => fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }));
    if (!r.ok) return null;
    const d = JSON.parse(await r.text())?.d?.[0]; if (!d || d.c == null) return null;
    const prev = d.var != null ? +(d.c - d.var).toFixed(4) : null;
    return { chart: { result: [{ meta: { currency: 'EUR', regularMarketPrice: d.c, regularMarketTime: Math.floor(Date.now() / 1000), chartPreviousClose: prev, source: 'boursorama' },
      indicators: { quote: [{ close: prev != null ? [prev, d.c] : [d.c] }] } }] } };
  } catch { return null; }
}


// ── Boursorama (page publique de chaque valeur de Paris) : dernier dividende + date, rendement estimé ──
// Page lourde (~1 Mo) : rafraîchie au plus toutes les 6 h par valeur, sinon reprise du résultat précédent.
export function parseBoursoDiv(html) {
  const txt = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ');
  const out = {};
  const d = txt.match(/dernier dividende.{0,160}?(\d[\d ]*,\d+)\s*(EUR|USD|GBX|GBP|NOK|CHF)\s*\((\d{2})\/(\d{2})\/(\d{2})\)/i);
  if (d) { out.lastAmount = parseFloat(d[1].replace(/ /g, '').replace(',', '.')); out.lastCurrency = d[2]; out.lastDate = `20${d[5]}-${d[4]}-${d[3]}`; }
  const r = txt.match(/rendement estimé (\d{4})\s*(-?\d+,\d+)\s*%/i);
  if (r) { out.estYear = +r[1]; out.estYield = parseFloat(r[2].replace(',', '.')); }
  const f = txt.match(/Dividende par action\s+(\d[\d ]*,\d+|-)\s*(?:EUR)?\s+(\d[\d ]*,\d+|-)\s*(?:EUR)?\s+(\d[\d ]*,\d+|-)/i);
  if (f) out.dpsFactSet = f.slice(1, 4).map(x => x === '-' ? null : parseFloat(x.replace(/ /g, '').replace(',', '.')));
  return Object.keys(out).length ? out : null;
}
// Codes Boursorama hors Paris : préfixe de place inconnu → essais sur l'API légère UpdateCharts,
// validés par le cours (écart < 4 % avec CNBC) pour ne pas confondre deux titres. Résultat mémorisé.
const BOURSO_PREFIXES = ['1rA', '1rB', '1rL', '1rO', '1rI', '1g', '1z', '1zX', '1q', '1n', '1u', '1v', '1h', '1f', '1x', '1y', '1t', '1w', '1e', '1d', '1c', '1b', '1a', '1i', '1j', '1k', '1l', '1m', '1o', '1p', '1s', '1rN', '1rF', '1rS', '1rC', '1rD', '1rE', '1rH', '1rM'];
async function boursoQuote(sym) {
  const u = `https://www.boursorama.com/bourse/action/graph/ws/UpdateCharts?symbol=${encodeURIComponent(sym)}&period=-1`;
  try { const r = await withHost(u, () => fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })); if (!r.ok) return null;
    const d = JSON.parse(await r.text())?.d?.[0]; return d && d.c != null ? d.c : null; } catch { return null; }
}
async function resolveBoursoSym(t, refPrice) {
  if (t.endsWith('.PA')) return `1rP${t.slice(0, -3)}`;
  if (refPrice == null) return null;
  const code = t.split('.')[0];
  for (const p of BOURSO_PREFIXES) {
    const c = await boursoQuote(p + code);
    if (c != null && Math.abs(c / refPrice - 1) < 0.04) return p + code;
  }
  return null;
}
async function fetchBoursoDivs(tickers, prev, refPrices) {
  const res = {}, stat = { fresh: 0, reused: 0, fail: 0, resolved: [], unresolved: [] };
  const now = Date.now();
  await Promise.all(tickers.map(async t => {
    const old = prev?.[t];
    if (old && old.sym && now - old.ts < 6 * 3600e3) { res[t] = old; stat.reused++; return; }
    // symbole déjà trouvé (gardé 30 jours) ou nouvelle recherche ; échec mémorisé 7 jours pour ne pas réessayer à chaque passage
    let sym = old?.sym;
    if (!sym && old?.noSym && now - old.noSymTs < 7 * 864e5) { res[t] = old; stat.reused++; return; }
    if (!sym) sym = await resolveBoursoSym(t, refPrices.get(t));
    if (!sym) { res[t] = { noSym: true, noSymTs: now }; stat.unresolved.push(t); return; }
    if (!t.endsWith('.PA') && !old?.sym) stat.resolved.push(t + '→' + sym);
    const u = `https://www.boursorama.com/cours/${encodeURIComponent(sym)}/`;
    try {
      const html = await get(u, { tries: 2, timeout: 20000, accept: 'text/html' });
      const p = parseBoursoDiv(html);
      if (p) { res[t] = { ...p, ts: now, url: u, sym }; stat.fresh++; return; }
      throw new Error('non trouvé');
    } catch { if (old?.lastDate || old?.estYield != null) { res[t] = old; stat.reused++; } else { res[t] = { sym, ts: now, url: u }; stat.fail++; } }
  }));
  return { res, stat };
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
  await yahooSession();
  const allT = [...new Set(cfg.yahoo.map(u => decodeURIComponent(u.split('/chart/')[1].split('?')[0])))];
  const cnbcMap = await fetchCNBC(allT);
  const gcode = new Map(cfg.tickers.map(x => [x.t, x.g]));
  const charts = {}; let yahooOk = 0, yahooStale = 0, googleOk = 0, cnbcOk = 0, boursoOk = 0;
  await Promise.all(cfg.yahoo.map(async url => {
    const t = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    let s = await fetchYahoo(url);
    if (s) { charts[url] = s; yahooOk++; return; }
    s = cnbcMap.get(t);
    if (s) { charts[url] = s; cnbcOk++; return; }
    s = await fetchBourso(t);
    if (s) { charts[url] = s; boursoOk++; return; }
    if (url.includes('range=5d')) {
      s = await fetchGoogle(gcode.get(t));
      if (s) { charts[url] = s; googleOk++; return; }
    }
    const old = prevYahoo?.charts?.[url];
    if (old) { charts[url] = old; yahooStale++; }
    failures.push({ url, error: `cours indisponible (${t} / ${gcode.get(t)})`, reusedPrevious: !!old });
  }));

  // Dividendes Boursorama
  const prevDiv = await getPrev('divinfo.json');
  const refPrices = new Map([...cnbcMap].map(([t, c]) => [t, c.chart.result[0].meta.regularMarketPrice]));
  const { res: divinfo, stat: divStat } = await fetchBoursoDivs(allT, prevDiv?.items, refPrices);
  const generated = new Date().toISOString();
  const meta = { generated, feedsTotal: cfg.feeds.length, feedsOk, feedsStale, yahooTotal: cfg.yahoo.length, yahooOk: yahooOk + googleOk + cnbcOk + boursoOk, yahooStale,
    boursoDiv: divStat,
    prices: { cnbc: cnbcOk, boursorama: boursoOk, cnbcHttp: cnbc.status, cnbcUnresolved: cnbc.unresolved, yahoo: yahooOk, google: googleOk, yahooSession: yahoo.session, yahooHttp: yahoo.status, googleHttp: gfin.status },
    translated: trMap.size, translationsReused: prevTr.size, translationFailed: trFail,
    durationMs: Date.now() - t0, failures };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/feeds.json', ROOT), JSON.stringify({ generated, feeds }));
  await writeFile(new URL('data/yahoo.json', ROOT), JSON.stringify({ generated, charts }));
  await writeFile(new URL('data/divinfo.json', ROOT), JSON.stringify({ generated, items: divinfo }));
  await writeFile(new URL('data/meta.json', ROOT), JSON.stringify(meta, null, 1));
  console.log(`Flux ${feedsOk}/${cfg.feeds.length} (+${feedsStale} repris) · Cours CNBC ${cnbcOk} + Boursorama ${boursoOk} + Yahoo ${yahooOk} + Google ${googleOk} /${cfg.yahoo.length} (+${yahooStale} repris) · ${trMap.size} titres traduits · ${meta.durationMs} ms`);
  console.log('Yahoo', yahoo.session, JSON.stringify(yahoo.status), '· Google', JSON.stringify(gfin.status));
  for (const f of failures.slice(0, 40)) console.log('  ✗', f.error, f.url.slice(0, 110));
  // Échec total = ne pas déployer (on garde la version précédente en ligne)
  if (feedsOk === 0 && yahooOk + googleOk + cnbcOk + boursoOk === 0) { console.error('Aucune source joignable : déploiement annulé'); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
