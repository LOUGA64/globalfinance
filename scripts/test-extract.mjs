import { writeFile } from 'node:fs/promises';
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const dec=s=>s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&#x27;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(n)).replace(/\s+/g,' ').trim();
function extract(html){
  html=html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi,'');
  const art=(html.match(/<article[\s\S]*?<\/article>/gi)||[]).sort((a,b)=>b.length-a.length)[0]||html;
  return [...art.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map(m=>dec(m[0])).filter(t=>t.length>60&&!/cookie|newsletter|subscribe|abonn/i.test(t));
}
async function ld(html){ // JSON-LD articleBody
  for(const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){try{const j=JSON.parse(m[1]);const arr=[].concat(j['@graph']||j);for(const x of arr)if(x&&x.articleBody)return x.articleBody.length;}catch{}}
  return 0;
}
const feeds=await (await fetch('https://louga64.github.io/globalfinance/data/feeds.json?v='+Date.now())).json();
const byDom=new Map();
for(const items of Object.values(feeds.feeds))for(const a of items){if(!a.titleFr||/news\.google/.test(a.link))continue;let h;try{h=new URL(a.link).hostname.replace(/^www\./,'')}catch{continue}
 if(!byDom.has(h))byDom.set(h,{n:0,link:a.link});byDom.get(h).n++;}
const doms=[...byDom.entries()].sort((a,b)=>b[1].n-a[1].n).slice(0,60);
const out=[];
await Promise.all(doms.map(async([h,{n,link}])=>{
  try{const r=await fetch(link,{headers:{'User-Agent':UA,'Accept-Language':'en,fr;q=0.8'},redirect:'follow',signal:AbortSignal.timeout(15000)});
    const html=await r.text();const p=extract(html);
    out.push({h,n,status:r.status,paras:p.length,chars:p.join(' ').length,ld:await ld(html),sample:(p[0]||'').slice(0,90)});
  }catch(e){out.push({h,n,status:'ERR '+String(e.message).slice(0,40),paras:0,chars:0,ld:0});}
}));
out.sort((a,b)=>b.n-a.n);
await writeFile('test-result.json',JSON.stringify(out,null,1));
