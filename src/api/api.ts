export async function response<T>(r:Response):Promise<T>{const value=await r.json();if(!r.ok)throw new Error(value.error??'Request failed.');return value as T;}
