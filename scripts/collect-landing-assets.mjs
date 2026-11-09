#!/usr/bin/env node
/** Collect only media URLs actually present in a cached public landing-page HTML document. */
import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const htmlPath=path.resolve(option('--html','/private/tmp/monogram-public-landing-source.html'));
const sourcePageUrl=option('--source-url','https://www.matterbase.com/');
const sourceBytes=await readFile(htmlPath),html=sourceBytes.toString('utf8');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=value=>value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/gi,entity=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&#39;':"'",'&#x27;':"'"}[entity.toLowerCase()]||entity)).replace(/&#(\d+);/g,(_match,number)=>String.fromCodePoint(Number(number)));
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match=>[match[1].toLowerCase(),decode(match[2]??match[3]??match[4]??'')]));
function canonicalUrl(value){
  try{
    let url=new URL(decode(value),sourcePageUrl);
    // The underlying CDN URL is explicitly embedded in Next's observed image URL.
    if(url.pathname==='/_next/image'&&url.searchParams.has('url'))url=new URL(url.searchParams.get('url'),sourcePageUrl);
    return url.protocol==='https:'&&url.hostname==='public-cdn.matterbase.com'&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}
const observed=new Map();
function observe(value,evidence){
  const url=canonicalUrl(value);if(!url)return;
  const previous=observed.get(url);if(previous){previous.occurrences++;if(!previous.alt&&evidence.alt)previous.alt=evidence.alt;return;}
  observed.set(url,{sourceUrl:url,alt:evidence.alt||'',occurrences:1,evidence:{...evidence,observedValue:value}});
}
for(const match of html.matchAll(/<(img|video|source)\b([^>]*)>/gi)){
  const attributes=attrs(match[2]);
  for(const attribute of ['src','poster','data-src'])if(attributes[attribute])observe(attributes[attribute],{tag:match[1].toLowerCase(),attribute,alt:attributes.alt||''});
  if(attributes.srcset)for(const candidate of attributes.srcset.split(','))observe(candidate.trim().split(/\s+/)[0],{tag:match[1].toLowerCase(),attribute:'srcset',alt:attributes.alt||''});
}
for(const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))for(const match of style[1].matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*))\s*\)/g))observe(match[1]??match[2]??match[3]??'',{tag:'style',attribute:'url()',alt:''});

const featureNames=new Map([
  ['board_hero_poster.webp','Board hero poster'],['board.webp','Board'],
  ['living_room_with_concrete.webp','Living Room with Concrete'],['wooden_living_room_poster.webp','Wooden living room poster'],
  ['schedule.webp','Schedule'],['paper.webp','Paper'],['paper_bar.webp','Paper Generation Bar'],['browse-catalog.webp','Library browsed on a laptop'],
]);
const backgroundNames=new Map([['dot_background.webp','Dot background'],['atmos2.webp','Atmosphere background'],['end_slogan_background.webp','End slogan background']]);
const manifest={version:1,sourcePageUrl,hero:[],features:[],backgrounds:[],observedGaps:{requestedHeroCount:36,observedHeroCount:0,collaborationScreenshot:'No separate collaboration screenshot URL was present in this cached HTML.',videoSources:'The observed video elements did not contain src attributes or source children.'}};
const selected=[],excluded=[];
for(const entry of observed.values()){
  const filename=path.basename(new URL(entry.sourceUrl).pathname),key=filename.replace(/\.[^.]+$/,'').replace(/_/g,'-');
  let group,name,brand='';
  if(new URL(entry.sourceUrl).pathname.includes('/hero/floating_products/')){group='hero';const parts=entry.alt.split(/\s+—\s+/);name=parts[0]||key;brand=parts.slice(1).join(' — ');}
  else if(featureNames.has(filename)){group='features';name=featureNames.get(filename);}
  else if(backgroundNames.has(filename)){group='backgrounds';name=backgroundNames.get(filename);}
  else{excluded.push({sourceUrl:entry.sourceUrl,reason:new URL(entry.sourceUrl).pathname.includes('/used_by_logos/')?'Third-party studio/customer logo; not evidence of monogram customers.':'Outside the requested product and feature media selection.'});continue;}
  const src=`/landing-assets/${group}/${filename}`,item={key,name,...(group==='hero'?{brand}:{}),src,sourceUrl:entry.sourceUrl,...(group==='features'?{sourceApplication:'Matterbase',preferredUse:'Reference only; prefer local monogram screenshots for product previews.'}:{})};
  manifest[group].push(item);selected.push({...entry,group,item,filename});
}
manifest.observedGaps.observedHeroCount=manifest.hero.length;
if(args.includes('--dry-run')){console.log(JSON.stringify({hero:manifest.hero.map(item=>item.key),features:manifest.features.map(item=>item.key),backgrounds:manifest.backgrounds.map(item=>item.key),observedGaps:manifest.observedGaps},null,2));process.exit(0);}
const provenance={version:1,sourcePageUrl,sourceHtml:{path:htmlPath,sha256:sha256(sourceBytes),bytes:sourceBytes.length},collectedAt:new Date().toISOString(),method:'Observed img/src/srcset, video/poster, source/src, and inline CSS url() only. No authenticated API, cookies, guessed files, company logos, or testimonials.',assets:[],excluded,observedGaps:manifest.observedGaps};
await Promise.all(['data','ref','public/landing-assets/hero','public/landing-assets/features','public/landing-assets/backgrounds'].map(directory=>mkdir(path.join(root,directory),{recursive:true})));
function dimensions(bytes){
  if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw new Error('Downloaded asset is not WebP.');
  const kind=bytes.toString('ascii',12,16);
  if(kind==='VP8X')return{width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)};
  if(kind==='VP8 ')return{width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
  if(kind==='VP8L')return{width:1+(bytes[21]|(bytes[22]&63)<<8),height:1+((bytes[22]>>6)|bytes[23]<<2|(bytes[24]&15)<<10)};
  return{};
}
let cursor=0;
async function worker(){
  while(cursor<selected.length){
    const entry=selected[cursor++],destination=path.join(root,'public',entry.item.src),temporary=`${destination}.download`;
    try{
      const {stdout}=await run('curl',['--disable','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','60','--retry','2','--output',temporary,'--write-out','%{content_type}\n%{http_code}\n%{url_effective}',entry.sourceUrl],{maxBuffer:100000});
      const [contentType,status,finalUrl]=stdout.trim().split('\n'),bytes=await readFile(temporary);if(!contentType.startsWith('image/')||Number(status)!==200||bytes.length<30)throw new Error('Unexpected media response.');
      const size=dimensions(bytes);await rename(temporary,destination);Object.assign(entry.item,size);
      provenance.assets.push({key:entry.item.key,group:entry.group,src:entry.item.src,sourceUrl:entry.sourceUrl,finalUrl,httpStatus:Number(status),contentType,bytes:bytes.length,sha256:sha256(bytes),...size,occurrencesInHtml:entry.occurrences,evidence:entry.evidence});
    }catch(error){await rm(temporary,{force:true});throw new Error(`Could not collect observed asset ${entry.item.key}: ${error.message}`);}
  }
}
await Promise.all(Array.from({length:Math.min(6,selected.length)},()=>worker()));
const order=new Map(selected.map((entry,index)=>[entry.item.key,index]));provenance.assets.sort((left,right)=>order.get(left.key)-order.get(right.key));
await writeFile(path.join(root,'data/landing-assets.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(root,'reference/landing-assets-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const total=provenance.assets.reduce((sum,asset)=>sum+asset.bytes,0);console.log(JSON.stringify({hero:manifest.hero.length,features:manifest.features.length,backgrounds:manifest.backgrounds.length,downloaded:provenance.assets.length,bytes:total,sourceHtmlSha256:provenance.sourceHtml.sha256,manifest:'data/landing-assets.json',provenance:'reference/landing-assets-provenance.json'}));
