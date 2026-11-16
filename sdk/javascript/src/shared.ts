export type Properties = Record<string, string | number | boolean | null>;
export type Context = {anonymousId: string; userId: string | null; accountId: string | null; token: string; expiresAt: number};
export type CaptureEvent = {eventId: string; occurredAt: string; name: string; sessionId: string; properties: Properties; context: Context};
export const browserDatasetSchema = {name:'string', person:'string', account:'string?', session:'string', properties:'properties'};
export const browserEventMapping = {name:'name', userId:'person', accountId:'account', sessionId:'session', properties:'properties'};
export function validProperties(value: unknown): value is Properties {
 return !!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length<=50 && Object.entries(value).every(([k,v])=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)&&(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=1000));
}

export function retryAfterDelay(value:string|null,now=Date.now()){
 if(!value?.trim())return 0;
 const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
 const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):0;
}
