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
  return new vm.Script(code + '\n;({feeds:ALL_FEEDS(), yahoo:ALL_YAHOO()})').runInNewContext({});
}

// ── 2. Parseur RSS/Atom (identique à celui de la page) ──
export function parseRSS(xml) {
  const items = [];
  if (!xml || typeof xml !== 'string' || !/<(rss|feed|rdf)/i.test(xml)) return items;
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
const HOST_LIMIT = { 'news.google.com': 3, 'query1.finance.yahoo.com': 4, 'query2.finance.yahoo.com': 4 };
async function withHost(url, fn) {
  const h = new URL(url).hostname, lim = HOST_LIMIT[h] || 6;
  let q = hostQueues.get(h); if (!q) { q = { n: 0, w: [] }; hostQueues.set(h, q); }
  if (q.n >= lim) await new Promise(r => q.w.push(r));
  q.n++;
  try { return await fn(); } finally { q.n--; const nx = q.w.shift(); if (nx) setTimeout(nx, h === 'news.google.com' ? 250 : 0); }
}
async function get(url, { tries = 2, timeout = 15000, accept = '*/*' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await withHost(url, () => fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' }));
      if (r.ok) return await r.text();
      last = new Error('HTTP ' + r.status);
      if (r.status === 404 || r.status === 403) break;
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
      let items = parseRSS(await get(f.url, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' }));
      if (!items.length) throw new Error('flux vide ou non-RSS');
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

  // Cours Yahoo
  const charts = {}; let yahooOk = 0, yahooStale = 0;
  await Promise.all(cfg.yahoo.map(async url => {
    for (const u of [url, url.replace('query1.', 'query2.')]) {
      try { const s = slimYahoo(JSON.parse(await get(u, { accept: 'application/json' })), url); if (s) { charts[url] = s; yahooOk++; return; } }
      catch {}
    }
    const old = prevYahoo?.charts?.[url];
    if (old) { charts[url] = old; yahooStale++; }
    failures.push({ url, error: 'Yahoo indisponible', reusedPrevious: !!old });
  }));

  const generated = new Date().toISOString();
  const meta = { generated, feedsTotal: cfg.feeds.length, feedsOk, feedsStale, yahooTotal: cfg.yahoo.length, yahooOk, yahooStale,
    translated: trMap.size, translationsReused: prevTr.size, translationFailed: trFail,
    durationMs: Date.now() - t0, failures };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/feeds.json', ROOT), JSON.stringify({ generated, feeds }));
  await writeFile(new URL('data/yahoo.json', ROOT), JSON.stringify({ generated, charts }));
  await writeFile(new URL('data/meta.json', ROOT), JSON.stringify(meta, null, 1));
  console.log(`Flux ${feedsOk}/${cfg.feeds.length} (+${feedsStale} repris) · Cours ${yahooOk}/${cfg.yahoo.length} (+${yahooStale} repris) · ${trMap.size} titres traduits · ${meta.durationMs} ms`);
  for (const f of failures.slice(0, 40)) console.log('  ✗', f.error, f.url.slice(0, 110));
  // Échec total = ne pas déployer (on garde la version précédente en ligne)
  if (feedsOk === 0 && yahooOk === 0) { console.error('Aucune source joignable : déploiement annulé'); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });

