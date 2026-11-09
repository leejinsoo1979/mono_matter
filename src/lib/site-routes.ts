export const sitePages = {
  '/material-board': 'board', '/schedule': 'schedule', '/material-samples': 'samples',
  '/virtual-samples': 'samples', '/pricing': 'pricing', '/virtual-showroom': 'suppliers',
  '/about': 'about', '/request-demo': 'demo', '/articles': 'articles',
  '/privacy': 'privacy', '/privacy-statement': 'privacy', '/terms': 'terms', '/terms-of-use': 'terms',
} as const;
export type SitePage = typeof sitePages[keyof typeof sitePages];
export const isMarketingPath = (path:string) => path==='/'||path==='/landing'||Object.hasOwn(sitePages,path);
export const sitePageFor = (path:string):SitePage|undefined => sitePages[path as keyof typeof sitePages];
/** Carry a workspace destination through sign-in without accepting external redirects. */
export function safeWorkspacePath(value:string|null|undefined){
  if(!value?.startsWith('/')||value.startsWith('//'))return '/catalog';
  try{
    const url=new URL(value,'http://monogram.local');
    if(url.origin!=='http://monogram.local'||!/^\/(?:catalog(?:\/[^/]+)?|products|app|library|projects|project\/[^/]+|file\/(?:board|schedule)\/[^/]+|supplier|clip)$/.test(url.pathname))return '/catalog';
    return url.pathname+url.search;
  }catch{return '/catalog';}
}
export function catalogLocation(route:string){
  const url=new URL(route,'http://monogram.local');
  const type=url.pathname.startsWith('/catalog/')?url.pathname.split('/')[2]:url.searchParams.get('type');
  const types:Record<string,string>={material:'Material',materials:'Material',furniture:'Furniture',lighting:'Lighting',hardware:'Hardware',homeware:'Homeware'};
  return {query:url.searchParams.get('q')||'',type:types[(type||'').toLowerCase()]||'',productId:url.searchParams.get('product')||'',settings:url.searchParams.get('settings')||''};
}
