import type {NextConfig} from 'next';
const config:NextConfig={agentRules:false,distDir:process.env.WAREHOUSE_DIST_DIR||'.next',transpilePackages:['@shpyrd/ui'],serverExternalPackages:['pg'],async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Frame-Options',value:'DENY'}]}];}};export default config;
