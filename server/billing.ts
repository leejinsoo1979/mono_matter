import {HttpError,type Store} from './store.ts';
import {billingActive,creditCycle,type BillingRow} from './billing-state.ts';

type Env=Record<string,string|undefined>;
type ObjectValue=Record<string,unknown>;
const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const record=(value:unknown):ObjectValue=>object(value)?value:{};
const string=(value:unknown)=>typeof value==='string'?value:'';
const timestamp=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.floor(value):0;
const providerId=(value:unknown)=>typeof value==='string'?value:object(value)?string(value.id):'';
const items=(subscription:ObjectValue)=>{const list=record(subscription.items).data;return Array.isArray(list)?list.filter(object):[];};

export class BillingService {
  constructor(private store:Store,private env:Env,private fetcher:typeof fetch){}
  row(workspaceId:string){return this.store.db.prepare('SELECT * FROM billing_subscriptions WHERE workspace_id=?').get(workspaceId) as BillingRow|undefined;}
  private price(priceId:string):{plan:'Starter'|'Plus';interval:'monthly'|'annual'}|null{
    for(const plan of ['Starter','Plus'] as const)for(const interval of ['monthly','annual'] as const){const configured=this.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`];if(configured&&configured===priceId)return{plan,interval};}return null;
  }
  async stripe(route:string,init:RequestInit={}){
    if(!this.env.STRIPE_SECRET_KEY)throw new HttpError(503,'Billing is not connected.');
    const response=await this.fetcher(`https://api.stripe.com/v1/${route}`,{...init,headers:{Authorization:`Bearer ${this.env.STRIPE_SECRET_KEY}`,'Stripe-Version':this.env.STRIPE_API_VERSION||'2025-03-31.basil',...init.headers},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new HttpError(502,'The billing service could not confirm this update. Please try again.');
    const result=await response.json();if(!object(result))throw new HttpError(502,'The billing service returned an invalid response.');return result;
  }
  private async subscription(id:string){if(!/^sub_[A-Za-z0-9_]{1,180}$/.test(id))throw new HttpError(400,'Invalid subscription reference.');return this.stripe(`subscriptions/${id}`);}
  private async invoice(value:unknown){if(object(value))return value;const id=providerId(value);if(!/^in_[A-Za-z0-9_]{1,180}$/.test(id))return null;return this.stripe(`invoices/${id}`);}
  private invoiceSubscription(invoice:ObjectValue){return providerId(record(record(invoice.parent).subscription_details).subscription)||providerId(invoice.subscription);}
  private paidServiceEnd(invoice:ObjectValue,subscription:ObjectValue,priceId:string):number{
    if(invoice.status!=='paid'&&invoice.paid!==true)return 0;
    if(this.invoiceSubscription(invoice)!==providerId(subscription.id))return 0;
    if(providerId(invoice.customer)!==providerId(subscription.customer))return 0;
    const lines=record(invoice.lines).data;if(!Array.isArray(lines))return 0;
    return Math.max(0,...lines.filter(object).filter(line=>{
      const actualPrice=providerId(line.price)||providerId(record(record(line.pricing).price_details).price);
      return actualPrice===priceId;
    }).map(line=>timestamp(record(line.period).end)));
  }
  private saveRow(row:BillingRow){
    this.store.db.prepare(`INSERT INTO billing_subscriptions(workspace_id,subscription_id,customer_id,plan,interval,status,period_start,period_end,paid_through,credit_anchor,last_credit_cycle,last_event_created,cancel_at_period_end)
      VALUES(@workspace_id,@subscription_id,@customer_id,@plan,@interval,@status,@period_start,@period_end,@paid_through,@credit_anchor,@last_credit_cycle,@last_event_created,@cancel_at_period_end)
      ON CONFLICT(workspace_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,plan=excluded.plan,interval=excluded.interval,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,paid_through=excluded.paid_through,credit_anchor=excluded.credit_anchor,last_credit_cycle=excluded.last_credit_cycle,last_event_created=excluded.last_event_created,cancel_at_period_end=excluded.cancel_at_period_end`).run(row);
  }
  private reconcile(subscription:ObjectValue,eventCreated:number,invoice:ObjectValue|null,allowNew:boolean){
    const subscriptionId=providerId(subscription.id);if(!subscriptionId)return null;
    const oldBySubscription=this.store.db.prepare('SELECT * FROM billing_subscriptions WHERE subscription_id=?').get(subscriptionId) as BillingRow|undefined;
    const workspaceId=oldBySubscription?.workspace_id||string(record(subscription.metadata).workspaceId);
    if(!workspaceId||!this.store.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId))return null;
    const old=this.row(workspaceId);const seconds=Math.floor(this.store.now().getTime()/1000);
    if(old&&old.subscription_id!==subscriptionId&&(!allowNew||billingActive(old,seconds)||eventCreated<old.last_event_created))return null;
    if(!invoice&&old?.subscription_id===subscriptionId&&eventCreated<old.last_event_created)return null;
    const item=items(subscription).find(item=>!!this.price(providerId(item.price)));if(!item)return null;
    const priceId=providerId(item.price);const pricing=this.price(priceId)!;
    const start=timestamp(item.current_period_start)||timestamp(subscription.current_period_start);
    const end=timestamp(item.current_period_end)||timestamp(subscription.current_period_end);
    if(!start||end<=start)return null;
    const same=old?.subscription_id===subscriptionId;
    const status=string(subscription.status);const paidEnd=invoice&&status==='active'?this.paidServiceEnd(invoice,subscription,priceId):0;
    let paidThrough=same?old.paid_through:0;
    if(paidEnd)paidThrough=Math.max(paidThrough,Math.min(paidEnd,end));
    if(status==='trialing')paidThrough=timestamp(subscription.trial_end)||end;
    if(['canceled','unpaid','incomplete_expired','paused'].includes(status))paidThrough=0;
    const row:BillingRow={workspace_id:workspaceId,subscription_id:subscriptionId,customer_id:providerId(subscription.customer),plan:pricing.plan,interval:pricing.interval,status,period_start:start,period_end:end,paid_through:paidThrough,credit_anchor:timestamp(subscription.billing_cycle_anchor)||start,last_credit_cycle:same&&old.plan===pricing.plan?old.last_credit_cycle:'',last_event_created:Math.max(eventCreated,same?old.last_event_created:0),cancel_at_period_end:subscription.cancel_at_period_end===true?1:0};
    this.saveRow(row);
    return{workspaceId,state:this.store.get(workspaceId).state};
  }
  async handle(event:ObjectValue){
    const eventId=string(event.id);if(!eventId)throw new HttpError(400,'Invalid billing event.');
    if(this.store.db.prepare('SELECT id FROM billing_events WHERE id=?').get(eventId))return null;
    const item=record(record(event.data).object);const type=string(event.type);
    let subscription:ObjectValue|null=null,invoice:ObjectValue|null=null,allowNew=false;
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(type)&&['paid','no_payment_required'].includes(string(item.payment_status))){
      const id=providerId(item.subscription);if(id){subscription=await this.subscription(id);invoice=await this.invoice(item.invoice||subscription.latest_invoice);allowNew=true;}
    }else if(type==='invoice.paid'){
      const id=this.invoiceSubscription(item);if(id){subscription=await this.subscription(id);invoice=item;allowNew=true;}
    }else if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed'].includes(type)){
      subscription=item;if(type==='customer.subscription.deleted')subscription={...item,status:'canceled'};if(type==='customer.subscription.paused')subscription={...item,status:'paused'};
    }
    const created=timestamp(event.created)||Math.floor(this.store.now().getTime()/1000);
    return this.store.db.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM billing_events WHERE id=?').get(eventId))return null;
      const result=subscription?this.reconcile(subscription,created,invoice,allowNew):null;
      this.store.db.prepare('INSERT INTO billing_events(id,created_at) VALUES(?,?)').run(eventId,this.store.now().toISOString());
      return result;
    })();
  }
  status(workspaceId:string){
    const row=this.row(workspaceId);if(!row)return{connected:!!this.env.STRIPE_SECRET_KEY,plan:'Free',status:'none',cancelAtPeriodEnd:false};
    const now=Math.floor(this.store.now().getTime()/1000);const active=billingActive(row,now);
    const cycle=creditCycle(row.credit_anchor,now);
    return{connected:!!this.env.STRIPE_SECRET_KEY,plan:active?row.plan:'Free',status:row.status,interval:row.interval,periodStart:row.period_start,periodEnd:row.period_end,paidThrough:row.paid_through,cancelAtPeriodEnd:!!row.cancel_at_period_end,nextCreditRefresh:active&&row.plan==='Plus'&&cycle.next<row.paid_through?cycle.next:null};
  }
}
