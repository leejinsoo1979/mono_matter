import type {Express,RequestHandler,Response} from 'express';
import type {Product,WorkspaceState} from '../shared/types.ts';
import {HttpError,type Store} from './store.ts';

const publicFactKeys:(keyof Product)[]=['id','name','brand','category','type','image','color','price','description','specs','variants','images','variantIds','modelSize','sampleKind','texture','model','material','shape','sourceUrl','files'];
type Dependencies={store:Store;requireContext:RequestHandler;getContext:(res:Response)=>{workspaceId:string};broadcast:(id:string,state:WorkspaceState)=>void};

/** Explicit recovery never guesses whether a legacy missing record was an intentional deletion. */
export function registerCatalogRoutes(app:Express,{store,requireContext,getContext,broadcast}:Dependencies){
  app.post('/api/catalog/sync',requireContext,(req,res)=>{
    if(req.body?.mode!=='restore-public-catalog')throw new HttpError(400,'Choose the original catalog restore action.');
    const {workspaceId}=getContext(res);store.get(workspaceId); // Reload a changed catalog file before taking its snapshot.
    const catalog=store.products.filter(product=>!product.custom);if(!catalog.length)throw new HttpError(503,'The original catalog is not available. Your workspace has not been changed.');
    let added=0,refreshed=0,preservedCustom=0;
    const result=store.mutate(workspaceId,state=>{
      preservedCustom=state.products.filter(product=>product.custom).length;
      for(const source of catalog){
        const index=state.products.findIndex(product=>product.id===source.id);
        if(index<0){state.products.push(structuredClone(source));added++;continue;}
        const current=state.products[index];if(current.custom)continue;
        const restored={...current};for(const key of publicFactKeys)delete(restored as unknown as Record<string,unknown>)[key];
        Object.assign(restored,structuredClone(source));
        // Favorite state and unknown local annotations are workspace-owned rather than source facts.
        if(current.favorite!==undefined)restored.favorite=current.favorite;else delete restored.favorite;
        if(current.custom!==undefined)restored.custom=current.custom;else delete restored.custom;
        if(JSON.stringify(restored)!==JSON.stringify(current)){state.products[index]=restored;refreshed++;}
      }
      store.db.prepare('INSERT OR REPLACE INTO workspace_catalog(workspace_id,seed) VALUES(?,?)').run(workspaceId,JSON.stringify(catalog));
    });
    broadcast(workspaceId,result.state);res.json({state:result.state,added,refreshed,preservedCustom,catalogCount:catalog.length,message:'Original catalog restored. Custom products, favorites, projects, libraries, and account details were kept.'});
  });
}
