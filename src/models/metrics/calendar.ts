// Calendar boundaries are resolved in the reporting timezone, not by adding 24 hours.
function parts(date:Date,zone:string){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));}
export function localInstant(year:number,month:number,day:number,zone:string,hour=0,minute=0,second=0){const target=Date.UTC(year,month-1,day,hour,minute,second);let t=target;for(let i=0;i<6;i++){const p=parts(new Date(t),zone);const delta=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);if(!delta)break;t+=delta;}return new Date(t).toISOString();}
export function metricPeriod(preset:string,zone='UTC',now=new Date(),weekStart=1,fiscalMonth=1){
 const p=parts(now,zone);let y=p.year,m=p.month,d=p.day;let end=now.toISOString();
 const at=(year:number,month:number,day:number)=>{const n=new Date(Date.UTC(year,month-1,day));return localInstant(n.getUTCFullYear(),n.getUTCMonth()+1,n.getUTCDate(),zone);};
 if(preset==='last_month'){end=at(y,m,1);m--;d=1;}
 else if(preset==='mtd')d=1;
 else if(preset==='wtd'||preset==='last_week'){const weekday=new Date(Date.UTC(y,m-1,d)).getUTCDay();d-=(weekday-weekStart+7)%7;if(preset==='last_week'){end=at(y,m,d);d-=7;}}
 else if(preset==='ytd'||preset==='last_year'){if(m<fiscalMonth)y--;m=fiscalMonth;d=1;if(preset==='last_year'){end=at(y,m,d);y--;}}
 else if(preset==='qtd'||preset==='last_quarter'){const offset=(m-fiscalMonth+12)%12;m-=offset%3;d=1;if(preset==='last_quarter'){end=at(y,m,d);m-=3;}}
 else if(preset==='last_2_years'){y-=2;}
 else if(preset==='last_30_days'||preset==='last_7_days')return{startsAt:new Date(now.getTime()-(preset==='last_7_days'?7:30)*86400000).toISOString(),endsAt:end};
 else if(preset==='yesterday'){end=at(y,m,d);d--;}
 return{startsAt:at(y,m,d),endsAt:end};
}
export function previousMonth(startsAt:string,endsAt:string,zone:string){function shift(s:string){const p=parts(new Date(s),zone);const last=new Date(Date.UTC(p.year,p.month-1,0));return localInstant(last.getUTCFullYear(),last.getUTCMonth()+1,Math.min(p.day,last.getUTCDate()),zone,p.hour,p.minute,p.second);}return{compareStartsAt:shift(startsAt),compareEndsAt:shift(endsAt)};}
// Tool inputs accept date-only values in the reporting timezone and offset-bearing
// timestamps. Equivalent ISO spellings must resolve to the same instant.
export function metricInstant(value:string,zone:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
 if(match){const [year,month,day]=match.slice(1).map(Number);if(new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10)!==value)throw new Error('Invalid calendar date.');return localInstant(year,month,day,zone);}
 if(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Use a date in YYYY-MM-DD format or an ISO timestamp with a timezone offset.');
 return new Date(value).toISOString();
}
