import {randomUUID} from 'node:crypto';
import type {WorkspaceState} from '../shared/types.ts';

export type BillingRow={workspace_id:string;subscription_id:string;customer_id:string;plan:'Starter'|'Plus';interval:'monthly'|'annual';status:string;period_start:number;period_end:number;paid_through:number;credit_anchor:number;last_credit_cycle:string;last_event_created:number;cancel_at_period_end:number};

/** Add calendar months from the original UTC anchor, clamping month-end dates without drift. */
export function addCalendarMonths(anchor:number,months:number):number{
  const original=new Date(anchor*1000);const result=new Date(anchor*1000);
  result.setUTCDate(1);result.setUTCMonth(original.getUTCMonth()+months);
  const lastDay=new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0)).getUTCDate();
  result.setUTCDate(Math.min(original.getUTCDate(),lastDay));
  return Math.floor(result.getTime()/1000);
}
export function creditCycle(anchor:number,now:number):{key:number;start:number;next:number}{
  const initial=new Date(anchor*1000),current=new Date(now*1000);
  let key=(current.getUTCFullYear()-initial.getUTCFullYear())*12+current.getUTCMonth()-initial.getUTCMonth();
  if(addCalendarMonths(anchor,key)>now)key-=1;
  return{key,start:addCalendarMonths(anchor,key),next:addCalendarMonths(anchor,key+1)};
}
export function billingActive(row:BillingRow,now:number){return['active','trialing','past_due'].includes(row.status)&&row.paid_through>now;}
export function refreshBillingCredits(row:BillingRow,state:WorkspaceState,now:Date):boolean{
  const seconds=Math.floor(now.getTime()/1000);const active=billingActive(row,seconds);let changed=false;
  const plan=active?row.plan:'Free';
  if(state.plan!==plan){state.plan=plan;changed=true;}
  const allowance=active&&row.plan==='Plus'&&row.status!=='trialing'?2500:0;
  if(!allowance){
    if(state.credits.monthly){state.credits.history.unshift({id:randomUUID(),activity:'Subscription credits expired',amount:-state.credits.monthly,type:'monthly',date:now.toISOString()});state.credits.monthly=0;changed=true;}
    return changed;
  }
  const cycle=creditCycle(row.credit_anchor,seconds);
  if(cycle.key<0)return changed;
  const cycleId=`${row.subscription_id}:${row.credit_anchor}:${cycle.key}`;
  if(row.last_credit_cycle!==cycleId){
    state.credits.history.unshift({id:randomUUID(),activity:'Monthly credits refreshed',amount:allowance-state.credits.monthly,type:'monthly',date:now.toISOString()});
    state.credits.monthly=allowance;row.last_credit_cycle=cycleId;changed=true;
  }
  return changed;
}
