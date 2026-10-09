"use client";
import { KeybindingHint } from '@shpyrd/ui/components/keybinding-hint';
export function ShortcutHint({keys,always=false}:{keys:string;always?:boolean}){return <KeybindingHint keys={keys} size="sm" className={always?'':'shortcut-reveal'}/>;}
