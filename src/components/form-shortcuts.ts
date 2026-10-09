import type { KeyboardEvent } from 'react';
import { isSubmitShortcut } from '@/models/keyboard';
export function submitOnShortcut(e:KeyboardEvent<HTMLFormElement>,pending=false){
 if(!isSubmitShortcut({...e,isComposing:e.nativeEvent.isComposing})||e.nativeEvent.keyCode===229)return;
 e.preventDefault();e.stopPropagation();
 if(pending||document.querySelector('[role="listbox"],[role="menu"]'))return;
 const button=e.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
 if(button&&!button.disabled)e.currentTarget.requestSubmit(button);
}
