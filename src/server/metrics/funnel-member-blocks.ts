import type pg from 'pg';

export type FunnelMember={id:string;reached:number};
type Block={last_actor:string;actors:string[];reached:number[];reached_counts:number[];dropped_counts:number[]};

/** Immutable, ordered snapshots. Store thousands of actors in each database row
 * instead of maintaining two index entries and a heap tuple per participant. */
export class FunnelMemberBlocks {
 private actors:string[]=[];
 private reached:number[]=[];
 private blocks:Block[]=[];
 constructor(private stages:number,private blockSize=4096){}
 push(member:FunnelMember){this.actors.push(member.id);this.reached.push(member.reached);if(this.actors.length>=this.blockSize)this.finish();}
 finish(){
  if(!this.actors.length)return;
  const reached_counts=Array(this.stages).fill(0),dropped_counts=Array(this.stages).fill(0);
  for(const stage of this.reached){dropped_counts[stage-1]++;for(let i=0;i<stage;i++)reached_counts[i]++;}
  this.blocks.push({last_actor:this.actors.at(-1)!,actors:this.actors,reached:this.reached,reached_counts,dropped_counts});
  this.actors=[];this.reached=[];
 }
 get pending(){return this.blocks.length;}
 take(){const result=this.blocks;this.blocks=[];return result;}
}

export async function readFunnelMemberBlocks(c:Pick<pg.PoolClient,'query'>,runId:string,attempt:string,stage:number,outcome:string,after:string){
 const rows:FunnelMember[]=[];let cursor=after;
 // Per-block histograms skip blocks with no matching participant. The keyset
 // index chooses each block before any arrays are decoded; no global unnest.
 while(rows.length<51){
  const block=(await c.query(`SELECT last_actor,actors,reached FROM metric_funnel_member_blocks
   WHERE run_id=$1 AND attempt=$2 AND last_actor>$3 COLLATE "C"
   AND ${outcome==='reached'?'reached_counts':'dropped_counts'}[$4]>0 ORDER BY last_actor LIMIT 1`,[runId,attempt,cursor,stage])).rows[0];
  if(!block)break;
  for(let i=0;i<block.actors.length&&rows.length<51;i++){
   const id=block.actors[i],reached=block.reached[i];
   if(Buffer.compare(Buffer.from(id),Buffer.from(after))>0&&(outcome==='reached'?reached>=stage:reached===stage))rows.push({id,reached});
  }
  cursor=block.last_actor;
 }
 return rows;
}
