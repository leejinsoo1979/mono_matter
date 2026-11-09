const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Three-way field merge. Numeric arrays are vectors; string arrays are memberships. */
export function threeWayMerge<T>(base:T,local:T,remote:T):T {
  if(equal(base,local))return structuredClone(remote);
  if(equal(base,remote))return structuredClone(local);
  if(Array.isArray(base)&&Array.isArray(local)&&Array.isArray(remote)){
    const all:unknown[]=[...base,...local,...remote];
    if(all.every(x=>typeof x==='string')){
      const b=new Set(base),l=new Set(local),r=new Set(remote);
      return [...new Set([...local,...remote])].filter(v=>!b.has(v)||(l.has(v)&&r.has(v))) as T;
    }
    const key=all.every(x=>x!==null&&typeof x==='object'&&'id' in (x as object))?'id':all.every(x=>x!==null&&typeof x==='object'&&'email' in (x as object))?'email':null;
    if(key){
      const b=new Map(base.map(x=>[x[key],x])),l=new Map(local.map(x=>[x[key],x])),r=new Map(remote.map(x=>[x[key],x]));
      const order=equal(base.map(x=>x[key]),local.map(x=>x[key]))?remote.map(x=>x[key]):local.map(x=>x[key]);
      const ids=[...new Set([...order,...remote.map(x=>x[key]),...local.map(x=>x[key])])];
      return ids.flatMap(id=>{
        if(b.has(id)&&!l.has(id))return [];
        if(b.has(id)&&!r.has(id)&&equal(b.get(id),l.get(id)))return [];
        if(!l.has(id))return r.has(id)?[r.get(id)]:[];
        if(!r.has(id))return [l.get(id)];
        return [threeWayMerge(b.get(id),l.get(id),r.get(id))];
      }) as T;
    }
    return structuredClone(local);
  }
  if(base&&local&&remote&&typeof base==='object'&&typeof local==='object'&&typeof remote==='object'){
    const b=base as Record<string,unknown>,l=local as Record<string,unknown>,r=remote as Record<string,unknown>,out:Record<string,unknown>={};
    for(const k of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){
      if(k in b&&!(k in l))continue;
      if(k in b&&!(k in r)&&equal(b[k],l[k]))continue;
      out[k]=threeWayMerge(b[k],l[k],r[k]);
    }
    return out as T;
  }
  return structuredClone(local===undefined?remote:local);
}
