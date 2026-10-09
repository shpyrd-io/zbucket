import {Providers} from '@/components/providers';
import '@/styles/global.css';
import type {Metadata} from 'next';
export const metadata:Metadata={title:'Warehouse · shpyrd',description:'Shared metrics and knowledge for every application.',robots:{index:false,follow:false},icons:{icon:'/logo.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" suppressHydrationWarning><head><script src="/theme.js"/></head><body><Providers>{children}</Providers></body></html>;}
