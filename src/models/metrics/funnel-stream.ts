/** Exact sequential counts. Input must be ordered by actor, then time/event ID. */
export class FunnelStream {
 readonly counts:number[];
 private actor:string|null=null;
 private starts:(number|undefined)[]=[];
 private reached=0;
 constructor(readonly stages:number,readonly windowMs:number){this.counts=Array(stages).fill(0);}
 push(actor:string,at:number,mask:number):{id:string;reached:number}|null{
  let completed=null;
  if(this.actor!==actor){completed=this.finish();this.actor=actor;}
  // Descending updates require distinct occurrences even for repeated steps.
  for(let i=this.stages-1;i>=0;i--){
   if(!(mask&(1<<i)))continue;
   const start=i===0?at:this.starts[i-1];
   if(start===undefined||at-start>this.windowMs)continue;
   this.starts[i]=Math.max(this.starts[i]??-Infinity,start);
   this.reached=Math.max(this.reached,i+1);
  }
  return completed;
 }
 finish(){
  const result=this.actor!==null&&this.reached?{id:this.actor,reached:this.reached}:null;
  if(result)for(let i=0;i<result.reached;i++)this.counts[i]++;
  this.actor=null;this.starts=[];this.reached=0;return result;
 }
}
