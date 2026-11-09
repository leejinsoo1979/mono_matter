/** Enrich only product IDs actually observed in the public reference catalog or named family responses.
 * No login, cookies, API keys, guessed IDs, or private endpoints are used.
 * Source prose is not copied: descriptions below are short summaries of factual fields.
 */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),catalogPath=path.join(root,'data/catalog.json');
const cacheDir=process.env.MONOGRAM_REFERENCE_CACHE||'/private/tmp/monogram-reference-enrichment';
const assetDir=path.join(root,'public/assets'),provenancePath=path.join(root,'reference/api-enrichment-provenance.json');
const apiBase='https://api.matterbase.com/api/v1/product';
const planOnly=process.argv.includes('--plan');
const cacheOnly=process.argv.includes('--cache-only');
const failures=[],assetRecords=new Map(),assetPromises=new Map();
const digest=value=>createHash('sha256').update(value).digest('hex');
const safeUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url:null;}catch{return null;}};
const color=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():undefined;
async function pool(values,concurrency,fn){const results=new Array(values.length);let next=0;await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async()=>{while(next<values.length){const index=next++;results[index]=await fn(values[index],index);}}));return results;}
async function fetchJson(endpoint,key){
 const file=path.join(cacheDir,`${key}.json`);let raw;
 try{raw=await readFile(file,'utf8');}catch{}
 if(!raw&&cacheOnly)throw new Error(`Missing cached source response: ${key}`);
 if(!raw){let last;for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(endpoint,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(25000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);raw=await response.text();const parsed=JSON.parse(raw);if(parsed.status===false||parsed.statusCode>=400)throw new Error(parsed.message||'Source API rejected request');await writeFile(file,raw);break;}catch(error){last=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));}}if(!raw)throw last;}
 const parsed=JSON.parse(raw);if(parsed.status===false||parsed.statusCode>=400)throw new Error(parsed.message||'Invalid source response');return{data:parsed.data,endpoint,sha256:digest(raw)};
}
async function single(id){try{return await fetchJson(`${apiBase}/single/${encodeURIComponent(id)}?extra=false&withModel=true`,`product-${id}`);}catch(error){failures.push({kind:'product-api',id,error:String(error)});return null;}}
async function family(id){try{return await fetchJson(`${apiBase}/variation-combo-list/${encodeURIComponent(id)}`,`family-${id}`);}catch(error){failures.push({kind:'family-api',id,error:String(error)});return null;}}
async function localAsset(source,role,productId){
 const url=safeUrl(source);if(!url)return undefined;
 if(!['cdn.matterbase.com','public-cdn.matterbase.com'].includes(url.hostname)){failures.push({kind:'external-asset-kept-as-link',productId,source:url.href,role});return url.href;}
 const key=url.href;
 if(assetRecords.has(key)){const entry=assetRecords.get(key);entry.productIds.add(productId);entry.roles.add(role);}
 if(assetPromises.has(key))return assetPromises.get(key);
 const promise=(async()=>{
  const originalExt=path.extname(decodeURIComponent(url.pathname)).toLowerCase();
  const ext=['.webp','.jpg','.jpeg','.png','.gif','.glb','.gltf','.pdf','.zip','.obj','.fbx','.skp','.rfa','.rvt','.dwg','.dxf','.3ds','.max'].includes(originalExt)?originalExt:'.bin';
  const filename=`api-${digest(key).slice(0,20)}${ext}`,file=path.join(assetDir,filename);
  const record={file:`public/assets/${filename}`,source:key,productIds:new Set([productId]),roles:new Set([role]),sha256:'',bytes:0};assetRecords.set(key,record);
  try{let buffer;try{await stat(file);buffer=await readFile(file);}catch{if(cacheOnly)throw new Error(`Missing cached source asset: ${filename}`);const response=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);const size=Number(response.headers.get('content-length')||0);if(size>100*1024*1024)throw new Error('Source asset exceeds 100 MB');buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>100*1024*1024)throw new Error('Source asset exceeds 100 MB');await writeFile(file,buffer);}record.sha256=digest(buffer);record.bytes=buffer.length;return`/assets/${filename}`;}
  catch(error){failures.push({kind:'asset-download',productId,source:key,role,error:String(error)});assetRecords.delete(key);return key;}
 })();assetPromises.set(key,promise);return promise;
}
function factualSpecs(data){
 const result={};
 for(const spec of data.technicalSpec||[]){if(!spec||typeof spec.name!=='string')continue;const values=(Array.isArray(spec.value)?spec.value:[spec.value]).filter(value=>['string','number'].includes(typeof value)).map(String);if(!values.length)continue;let value=values.join(', ');if(spec.unit&&!spec.name.toLowerCase().includes(String(spec.unit).toLowerCase())&&!value.toLowerCase().endsWith(String(spec.unit).toLowerCase()))value+=` ${spec.unit}`;result[spec.name]=value;}
 const certificationNames=(data.certifications||[]).map(c=>typeof c==='string'?c:c?.name||c?.certificationName).filter(Boolean);if(certificationNames.length)result.Certifications=certificationNames.join(', ');
 if(data.manufacturerCode)result['Manufacturer code']=String(data.manufacturerCode);
 if(data.variationName)result['Selected finish']=String(data.variationName).trim();
 return result;
}
const materialDefaults={roughness:1,metalness:0,ior:1.5,opacity:1,transmission:0,thickness:0,distance:0,attenuationColor:'#ffffff',normal:false,bumpScale:.08,textureWidth:1,textureHeight:1,textureRotation:0};
function mapTransform(value){return value&&['x','y','rotation'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))?{x:value.x,y:value.y,rotation:value.rotation}:undefined;}
async function enrich(data,existing,variants){
 const id=String(data.variationComboId||existing.id),model=data.model||{},values=model.materialValues||{};
 const image=await localAsset(data.keyImageUrl||existing.image,'product-image',id)||existing.image||'';
 const imageSources=[data.keyImageUrl,...(data.variationImageArr||[]).map(i=>i.imageUrl),...(data.productImageArr||[]).map(i=>i.imageUrl),...(data.productProjectImageArr||[]).map(i=>i.imageUrl)].filter(source=>safeUrl(source));
 const images=[...new Set(await pool([...new Set(imageSources)],4,source=>localAsset(source,'gallery-image',id)))].filter(Boolean);
 const diffuse=await localAsset(model.diffuseUrl,'diffuse-map',id),orm=await localAsset(model.ORMUrl,'orm-map',id),normal=await localAsset(model.normalUrl,'normal-map',id),transThick=await localAsset(model.transThickUrl,'transmission-thickness-map',id),modelUrl=await localAsset(model.modelUrl,'model',id);
 const mapTransforms=Object.fromEntries(Object.entries({diffuse:mapTransform(model.diffuseMapping),normal:mapTransform(model.normalMapping),orm:mapTransform(model.ORMMapping),transmissionThickness:mapTransform(model.transThickMapping)}).filter(([,value])=>value));
 const material={...materialDefaults,texture:diffuse,normal:!!normal,normalMap:normal,ormMap:orm,transmissionMap:transThick,thicknessMap:transThick,textureWidth:Number(model.diffuseMapping?.x)||1,textureHeight:Number(model.diffuseMapping?.y)||1,textureRotation:Number(model.diffuseMapping?.rotation)||0,mapTransforms};
 for(const key of ['roughness','metalness','ior','opacity','transmission','thickness','normalScale','bumpScale','sheen','sheenRoughness','clearcoat','clearcoatRoughness','specularIntensity','aoMapIntensity'])if(typeof values[key]==='number'&&Number.isFinite(values[key]))material[key]=values[key];
 if(typeof values.attenuationDistance==='number'&&Number.isFinite(values.attenuationDistance))material.distance=values.attenuationDistance;
 for(const key of ['attenuationColor','sheenColor','color'])if(color(values[key]))material[key]=color(values[key]);
 const mappedVariants=await pool(variants,5,async variant=>({name:String(variant.name||'').trim(),color:color(variant.colorHex)||existing.color||'#d5d0c8',image:await localAsset(variant.keyImageUrl||variant.thumbnailUrl,'variant-image',String(variant.variationComboId||id)),productId:String(variant.variationComboId)}));
 const currentVariant=variants.find(v=>String(v.variationComboId)===id),specs=factualSpecs(data),category=data.subCategoryName||data.category?.name||existing.category||'Material';
 const fileSources=[...(data.variationFileArr||[]),...(data.downloadsUrlArr||[])];
 const files=(await pool(fileSources,3,async file=>{const source=file.downloadUrl||file.fileUrl||file.url;const url=await localAsset(source,'download',id);if(!url)return null;return{name:String(file.downloadName||file.fileName||file.name||decodeURIComponent(new URL(source).pathname.split('/').at(-1))),url};})).filter(Boolean);
 const box=model.modelBoxSize,modelSize=box&&['x','y','z'].every(key=>typeof box[key]==='number'&&Number.isFinite(box[key]))?[box.x,box.y,box.z]:undefined;
 const type=typeof data.productTypeName==='string'?data.productTypeName[0].toUpperCase()+data.productTypeName.slice(1):existing.type||'Material';
 const descFacts=[`${category} by ${data.brandName||existing.brand}.`,specs['Indoor & Outdoor']?`Use: ${specs['Indoor & Outdoor']}.`:'',specs['Country of Origin']?`Origin: ${specs['Country of Origin']}.`:''].filter(Boolean).join(' ');
 return{...existing,id,name:data.productName||existing.name,brand:data.brandName||existing.brand,category,type,image,color:color(currentVariant?.colorHex)||existing.color||'#d5d0c8',price:typeof data.priceMin==='number'?data.priceMin:0,description:descFacts,specs,variants:mappedVariants,variantIds:variants.map(v=>String(v.variationComboId)),images,texture:diffuse,model:modelUrl,material,modelSize,sampleKind:model.isUseAlphaPlane?'alpha-plane':modelUrl?'model':'box',sourceUrl:`https://www.matterbase.com/p/${id}`,files};
}

await mkdir(cacheDir,{recursive:true});await mkdir(assetDir,{recursive:true});
const original=JSON.parse(await readFile(catalogPath,'utf8'));
let prior;try{prior=JSON.parse(await readFile(provenancePath,'utf8'));}catch{}
const observedIds=prior?.originalObservedProductIds||original.map(p=>p.id);
if(!observedIds.every(id=>/^\d+$/.test(String(id))))throw new Error('Only numeric IDs observed in the catalog may be requested.');
const originalsById=new Map(original.map(p=>[p.id,p]));
const knownResults=await pool(observedIds,4,single),knownData=knownResults.filter(Boolean);
const familyIds=[...new Set(knownData.map(result=>String(result.data?.productId)).filter(id=>/^\d+$/.test(id)))];
const familyResults=await pool(familyIds,4,family);
const familyById=new Map(familyIds.map((id,index)=>[id,familyResults[index]?.data||[]]));
const namedVariants=new Map();for(const result of familyResults){if(!Array.isArray(result?.data))continue;for(const variant of result.data)if(/^\d+$/.test(String(variant.variationComboId))&&typeof variant.name==='string'&&variant.name.trim())namedVariants.set(String(variant.variationComboId),variant);}
console.log(JSON.stringify({phase:'plan',originalObservedProducts:observedIds.length,knownResponses:knownData.length,families:familyIds.length,explicitlyNamedVariationIds:namedVariants.size,additionalNamedVariationRecords:[...namedVariants.keys()].filter(id=>!observedIds.includes(id)).length}));
if(planOnly)process.exit(0);
const additionalIds=[...namedVariants.keys()].filter(id=>!knownData.some(result=>String(result.data.variationComboId)===id));
const additionalResults=await pool(additionalIds,5,single),allResults=[...knownData,...additionalResults.filter(Boolean)];
const sourceById=new Map(allResults.filter(result=>result.data&&String(result.data.variationComboId)).map(result=>[String(result.data.variationComboId),result]));
let done=0;
const enriched=await pool([...sourceById.entries()],4,async([id,result])=>{
 const base=originalsById.get(id)||{id,color:color(namedVariants.get(id)?.colorHex)||'#d5d0c8'};
 const product=await enrich(result.data,base,familyById.get(String(result.data.productId))||[]);
 if(++done%25===0)console.log(JSON.stringify({phase:'enrichment',completed:done,total:sourceById.size,downloadedAssets:assetRecords.size}));return product;
});
const byId=new Map(enriched.map(p=>[p.id,p]));
const ordered=[...observedIds.map(id=>byId.get(id)||originalsById.get(id)).filter(Boolean),...enriched.filter(p=>!observedIds.includes(p.id))];
if(cacheOnly&&failures.length)throw new Error(`Cache-only generation aborted before writing: ${JSON.stringify(failures)}`);
await writeFile(catalogPath,JSON.stringify(ordered,null,2)+'\n');
const sourceRecords=[...knownData,...additionalResults.filter(Boolean)].map(result=>({id:String(result.data.variationComboId),familyId:String(result.data.productId),endpoint:result.endpoint,responseSha256:result.sha256,providedMaterialValues:result.data.model?.materialValues||{},providedMappings:{diffuse:result.data.model?.diffuseMapping,ORM:result.data.model?.ORMMapping,normal:result.data.model?.normalMapping,transmissionThickness:result.data.model?.transThickMapping},sourceModelUrl:result.data.model?.modelUrl||null,sourceIsUseAlphaPlane:result.data.model?.isUseAlphaPlane===true}));
const provenance={retrievedAt:cacheOnly&&prior?.retrievedAt?prior.retrievedAt:new Date().toISOString(),generatedAt:new Date().toISOString(),generationMode:cacheOnly?'cache-only':'public-api-with-cache',originalObservedProductIds:observedIds,completeSourceCatalog:false,discoveryRule:'Only the 47 observed catalog IDs and explicitly named variationComboIds returned by their public family endpoints. No guessed or enumerated IDs.',authentication:'None. No cookies, tokens or API keys.',descriptionPolicy:'Creative productDesc text is not copied. Product descriptions are short summaries assembled from category, brand, indoor/outdoor and country-of-origin facts.',shaderDefaults:'Only providedMaterialValues are source values. Unspecified shader settings use explicit local defaults. Each provided map repeat and rotation is preserved unchanged in material.mapTransforms. attenuationDistance maps to distance.',rotationPolicy:'Source mapping.rotation is degrees, confirmed by the public source applyMaterialV2 helper calling MathUtils.degToRad on mapping.rotation. Raw degree values are preserved in mapTransforms and the legacy textureRotation degree UI. Of 445 source products, only SKU460 normalMapping.rotation=1 is nonzero.',rotationEvidence:{sourcePage:'https://www.matterbase.com/p/460',sourceUrl:'https://www.matterbase.com/_next/static/chunks/2h1vcmtxvx5rk.js',sha256:'ac4f199ba0f302b8801c4d0049c7b1db455de9abaa7bd1043129784caef4e2ed',function:'applyMaterialV2 texture helper',excerpt:'i.rotation=t.MathUtils.degToRad(r.rotation)',textureCenter:[0.5,0.5],repeatRule:'Positive mapping.x and mapping.y are direct repeat factors; optional positive mapping.scale multiplies both.'},variantColorPolicy:'colorHex from the source family response where provided. Existing image-average fallback is retained only when the source provides no colorHex.',counts:{products:ordered.length,enriched:enriched.length,models:enriched.filter(p=>p.sampleKind==='model').length,alphaPlanes:enriched.filter(p=>p.sampleKind==='alpha-plane').length,boxes:enriched.filter(p=>p.sampleKind==='box').length,original47Models:enriched.filter(p=>observedIds.includes(p.id)&&p.sampleKind==='model').length,original47AlphaPlanes:enriched.filter(p=>observedIds.includes(p.id)&&p.sampleKind==='alpha-plane').length,assets:assetRecords.size,assetBytes:[...assetRecords.values()].reduce((sum,a)=>sum+a.bytes,0),families:familyIds.length},products:sourceRecords,families:familyResults.filter(Boolean).map(result=>({endpoint:result.endpoint,responseSha256:result.sha256,variationIds:result.data.map(v=>String(v.variationComboId))})),assets:[...assetRecords.values()].map(record=>({...record,productIds:[...record.productIds],roles:[...record.roles]})),failures};
await mkdir(path.dirname(provenancePath),{recursive:true});await writeFile(provenancePath,JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({phase:'complete',...provenance.counts,failures:failures.length,provenance:'reference/api-enrichment-provenance.json'}));
