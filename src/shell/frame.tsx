'use client';
import {useState,type ReactNode,useEffect} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ChartNoAxesCombined,BookOpen,Plug,Menu,Moon,Sun} from 'lucide-react';
import {Wordmark} from '@shpyrd/ui/components/brand';
import {Badge} from '@shpyrd/ui/components/badge';
import {Button} from '@shpyrd/ui/components/button';
import {Breadcrumbs,BreadcrumbsItem} from '@shpyrd/ui/components/breadcrumbs';
import {NavList,NavListItem} from '@shpyrd/ui/components/nav-list';
import {PageLayout,PageLayoutSidebar,PageLayoutHeader,PageLayoutContent} from '@shpyrd/ui/components/page-layout';
import {Stack} from '@shpyrd/ui/components/stack';
import {Dialog,DialogContent,DialogHeader,DialogTitle} from '@shpyrd/ui/components/dialog';
import {useTheme} from '@shpyrd/ui/lib/theme';
import {ShortcutHint} from '@/components/shortcut-hint';
const pages=[['metrics','Metrics',ChartNoAxesCombined,'m'],['knowledge','Knowledge',BookOpen,'k'],['integrations','Integrations',Plug,'i']] as const;
export function Frame({page,name,admin,children}:{page:string;name:string;admin:boolean;children:ReactNode}){
 const[open,setOpen]=useState(false),[theme,setTheme]=useTheme(),router=useRouter();
 useEffect(()=>{let prefix=0;const handler=(e:KeyboardEvent)=>{if(e.key==='Alt')document.documentElement.dataset.shortcutHints='true';const el=e.target as HTMLElement;if(el.closest('input,textarea,select,[contenteditable=true],[role=dialog]'))return;if(e.key==='g'){prefix=Date.now();return;}if(Date.now()-prefix<1000){const p=pages.find(x=>x[3]===e.key);if(p){e.preventDefault();router.push('/'+p[0]);prefix=0;return;}}
 if(e.key==='/'){e.preventDefault();document.querySelector<HTMLInputElement>('input[type=search],input[aria-label^="Search"]')?.focus();}if(e.key==='j'||e.key==='k'){const items=[...document.querySelectorAll<HTMLAnchorElement>('[data-keyboard-item]')],index=items.findIndex(i=>i.getAttribute('aria-current')==='page'),next=items[index+(e.key==='j'?1:-1)]??items[0];if(next){e.preventDefault();next.click();next.focus();}}};const clear=()=>{delete document.documentElement.dataset.shortcutHints;};window.addEventListener('keydown',handler);window.addEventListener('keyup',clear);window.addEventListener('blur',clear);return()=>{window.removeEventListener('keydown',handler);window.removeEventListener('keyup',clear);window.removeEventListener('blur',clear);};},[router]);
 const nav=<NavList aria-label="Warehouse">{pages.filter(p=>p[0]!=='integrations'||admin).map(([id,label,Icon,key])=><NavListItem key={id} asChild icon={<Icon/>} aria-current={page===id?'page':undefined}><Link href={'/'+id} onClick={()=>setOpen(false)}>{label}<ShortcutHint keys={'g '+key}/></Link></NavListItem>)}</NavList>;
 return <><a className="skip-link" href="#main">Skip to content</a><PageLayout containerWidth="full" padding="none" columnGap="none" rowGap="none" className="h-dvh overflow-hidden bg-background"><PageLayoutSidebar aria-label="Application" width="small" divider="line" hidden={{narrow:true}}><Stack direction="horizontal" align="center" gap="cozy" padding="normal"><Link href="/metrics" aria-label="Warehouse home"><Wordmark/></Link><Badge variant="outline">warehouse</Badge></Stack>{nav}</PageLayoutSidebar><PageLayoutHeader divider="line" className="px-4 py-3"><Stack direction="horizontal" align="center" gap="cozy"><Button variant="ghost" size="icon-sm" className="@3xl/page-layout:hidden" aria-label="Open navigation" onClick={()=>setOpen(true)}><Menu/></Button><Breadcrumbs><BreadcrumbsItem asChild><Link href="/metrics">Warehouse</Link></BreadcrumbsItem><BreadcrumbsItem selected>{pages.find(p=>p[0]===page)?.[1]}</BreadcrumbsItem></Breadcrumbs><div className="ml-auto flex items-center gap-3"><Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?<Sun/>:<Moon/>}</Button><span className="text-sm">{name}</span></div></Stack></PageLayoutHeader><PageLayoutContent id="main" width="full" padding="none" className="inbox-main"><div className="inbox-screen">{children}</div></PageLayoutContent></PageLayout><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Warehouse</DialogTitle></DialogHeader>{nav}</DialogContent></Dialog></>;
}
