const FOCUSABLE='button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableElements(root:ParentNode){return[...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el=>!el.hidden&&el.getAttribute("aria-hidden")!=="true");}

export class FocusTrap{
  private previous:HTMLElement|null=null;
  private active=false;
  constructor(private root:HTMLElement,private onEscape?:()=>void){}
  private keydown=(event:KeyboardEvent)=>{if(!this.active)return;if(event.key==="Escape"&&this.onEscape){event.preventDefault();this.onEscape();return;}if(event.key!=="Tab")return;const items=focusableElements(this.root);if(!items.length){event.preventDefault();this.root.focus();return;}const first=items[0],last=items.at(-1)!;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
  activate(initial?:HTMLElement|null){if(this.active)return;this.active=true;this.previous=document.activeElement instanceof HTMLElement?document.activeElement:null;this.root.addEventListener("keydown",this.keydown);this.root.tabIndex=-1;queueMicrotask(()=>{const target=initial??focusableElements(this.root)[0]??this.root;target.focus();});}
  deactivate({restore=true}={}){if(!this.active)return;this.active=false;this.root.removeEventListener("keydown",this.keydown);if(restore&&this.previous?.isConnected)queueMicrotask(()=>this.previous?.focus());this.previous=null;}
}
