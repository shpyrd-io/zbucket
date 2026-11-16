/** A period-independent index of ordered funnel prefixes.
 * For each actor/stage/end we retain the latest possible start. A later start
 * dominates earlier starts with the same end for every [from, until) query.
 * Later ends with the same start are redundant too. Distinct starts are retained:
 * replacing them with one maximum stage would break arbitrary reporting periods.
 */
export type FunnelOccurrence = {actor:string;stage:number;startedAt:string;reachedAt:string};
export class FunnelOccurrences {
 private actor:string|null=null;
 private starts:(number|undefined)[]=[];
 private emitted:(number|undefined)[]=[];
 constructor(readonly stages:number,readonly windowMs:number){}
 push(actor:string,at:number,mask:number):FunnelOccurrence[]{
  if(actor!==this.actor){this.actor=actor;this.starts=[];this.emitted=[];}
  const result:FunnelOccurrence[]=[];
  for(let i=this.stages-1;i>=0;i--){
   if(!(mask&(1<<i)))continue;
   const start=i===0?at:this.starts[i-1];
   if(start===undefined||at-start>this.windowMs)continue;
   this.starts[i]=Math.max(this.starts[i]??-Infinity,start);
   if(start>(this.emitted[i]??-Infinity)){
    result.push({actor,stage:i+1,startedAt:new Date(start).toISOString(),reachedAt:new Date(at).toISOString()});
    this.emitted[i]=start;
   }
  }
  return result;
 }
}
