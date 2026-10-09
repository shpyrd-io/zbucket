// API calls must not follow an expired-session redirect to another origin.
export async function request(input:string,init:RequestInit={}){
 const headers=new Headers(init.headers);
 if(!headers.has('Accept'))headers.set('Accept','application/json');
 const response=await fetch(input,{...init,headers,credentials:'same-origin',redirect:'manual'});
 if(response.type==='opaqueredirect'||(response.status>=300&&response.status<400)||response.status===401)
  throw new Error('Your session needs refreshing. Reload this page to sign in again.');
 return response;
}
