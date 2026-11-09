import type {Product} from './types';

export type SupplierProfile={businessName:string;slug:string;description:string;website:string;location:string;logo:string;cover:string;contactName:string;contactEmail:string;phone:string;internalNotes:string;published:boolean};
export type SupplierProduct=Product&{published:boolean;privateNotes:string;createdAt:string;updatedAt:string};
export type SupplierCollection={id:string;name:string;description:string;cover:string;productIds:string[];published:boolean};
export type SupplierGalleryItem={id:string;title:string;description:string;image:string;productIds:string[];published:boolean};
export type SupplierLeadStatus='new'|'contacted'|'qualified'|'quoted'|'won'|'closed';
export type SupplierLeadReply={id:string;message:string;createdAt:string;delivery:'internal'|'recorded'};
export type SupplierLead={id:string;type:'quote'|'sample'|'general';name:string;email:string;company:string;phone:string;message:string;productIds:string[];status:SupplierLeadStatus;notes:string;followUpAt:string;source:'showroom'|'manual';replies:SupplierLeadReply[];createdAt:string;updatedAt:string};
export type SupplierState={revision:number;profile:SupplierProfile|null;products:SupplierProduct[];collections:SupplierCollection[];gallery:SupplierGalleryItem[];leads:SupplierLead[];updatedAt:string};
export type SupplierEditableState=Pick<SupplierState,'profile'|'products'|'collections'|'gallery'>;
export type SupplierResponse={state:SupplierState;workspaceId:string};
export type PublicSupplierProfile=Pick<SupplierProfile,'businessName'|'slug'|'description'|'website'|'location'|'logo'|'cover'>;
export type PublicShowroomData={profile:PublicSupplierProfile;products:Product[];collections:SupplierCollection[];gallery:SupplierGalleryItem[];updatedAt:string;implementation:'local-showroom'};
export type SupplierRequestInput={type:'quote'|'sample'|'general';name:string;email:string;company:string;phone:string;message:string;productIds:string[]};
export const supplierLeadStatuses:SupplierLeadStatus[]=['new','contacted','qualified','quoted','won','closed'];
export const makeSupplierProfile=(name=''):SupplierProfile=>({businessName:name,slug:'',description:'',website:'',location:'',logo:'',cover:'',contactName:'',contactEmail:'',phone:'',internalNotes:'',published:false});
