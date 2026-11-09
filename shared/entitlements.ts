import type {WorkspaceState} from './types.ts';
export function planLimits(plan:WorkspaceState['plan'],verified=false){return{projects:plan==='Free'?1:plan==='Starter'?3:null,libraries:!verified&&(plan==='Free'||plan==='Starter')?1:null,savedAssets:plan==='Free'?30:null,cleanExports:plan==='Plus'||plan==='Studio'};}
export function workspaceUsage(state:WorkspaceState){
  const saved=new Set<string>();
  for(const product of state.products)if(product.custom)saved.add(`product:${product.id}`);
  for(const id of state.favorites)saved.add(`product:${id}`);
  for(const library of state.libraries)for(const id of library.productIds)saved.add(`product:${id}`);
  for(const project of state.projects){for(const id of project.drawer)saved.add(`product:${id}`);for(const board of project.boards)for(const item of board.items){if(item.productId)saved.add(`product:${item.productId}`);if(item.kind==='image'&&item.image)saved.add(`image:${item.image}`);}for(const schedule of project.schedules)for(const row of schedule.rows)if(row.productId)saved.add(`product:${row.productId}`);}
  return{projects:state.projects.filter(project=>!project.archived).length,libraries:state.libraries.length,savedAssets:saved.size};
}
