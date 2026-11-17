import {request} from './request';
import {response} from './api';
export const get=<T>(path:string)=>request('/api/v1/'+path).then(response<T>);
export const post=<T>(path:string,data:unknown)=>request('/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(response<T>);
