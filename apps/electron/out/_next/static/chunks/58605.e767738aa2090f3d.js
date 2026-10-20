(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[58605],{13049:function(e,t,n){"use strict";n.d(t,{WY:function(){return l},n9:function(){return a},qH:function(){return i},r9:function(){return r}});var o=n(42385);let r={background:"--bg_interaction_accent_focus_blue",border:"--icon_default_inverted",text:"--text_default_inverted_static",shadow:"--shadow_default"},i={markerBackground:r.background,markerBorder:r.border,markerText:r.text,markerShadow:r.shadow},a={size:24,width:"auto",borderWidth:2,borderRadius:999,paddingInline:4,fontWeight:500,fontSize:14,lineHeight:20,letterSpacing:0,fontFamily:o.IF,shadow:{offsetX:0,offsetY:0,blurRadius:24,figmaRadius:48,figmaSpread:-12},cursor:"pointer"};function l(e){return{number:e.number,label:String(e.number),interaction:e.interaction??"idle",visible:e.visible??!0,anchor:e.anchor}}},12230:function(e,t,n){"use strict";n.d(t,{y:function(){return s}});var o=n(27573),r=n(7653),i=n(13049),a=n(32425);function l(e){return`var(${e})`}let s=(0,r.forwardRef)(function(e,t){let{number:n,variant:r="default",anchorContext:s,interaction:c="idle",visible:d=!0,onActivate:u,ariaLabel:m=`Comment ${n}`,className:f,style:p,testId:h,selectionUi:g=!1,...x}=e,v=(0,i.WY)({number:n,interaction:c,visible:d,anchor:s});return v.visible?(0,o.jsx)("button",{...x,ref:t,type:"button","aria-label":m,disabled:"disabled"===v.interaction,"data-comment-marker":"true","data-comment-marker-variant":r,"data-comment-marker-state":v.interaction,"data-comment-anchor-surface":v.anchor.surface,"data-comment-anchor-context":v.anchor.contextId,"data-comment-anchor-selection-kind":v.anchor.selectionKind,"data-testid":h,"data-chat-selection-ui":g?"true":void 0,className:`desktop-text-ui-assist ${f??""}`,onMouseDown:e=>e.preventDefault(),onClick:e=>{e.preventDefault(),e.stopPropagation(),u()},style:{boxSizing:"border-box",appearance:"none",WebkitAppearance:"none",display:"inline-flex",flex:"0 0 auto",alignItems:"center",justifyContent:"center",width:i.n9.width,height:i.n9.size,minWidth:i.n9.size,paddingBlock:0,paddingInline:i.n9.paddingInline,borderStyle:"solid",borderWidth:i.n9.borderWidth,borderColor:"cross-chat"===r?"var(--border_accent)":l(i.r9.border),borderRadius:i.n9.borderRadius,background:"cross-chat"===r?"var(--bg_reference_session)":l(i.r9.background),color:"cross-chat"===r?"var(--icon_default_accent)":l(i.r9.text),boxShadow:`${i.n9.shadow.offsetX}px ${i.n9.shadow.offsetY}px ${i.n9.shadow.blurRadius}px ${l(i.r9.shadow)}`,fontFamily:i.n9.fontFamily,fontSize:(0,a.desktopTypographyFontSize)(i.n9.fontSize),fontWeight:i.n9.fontWeight,lineHeight:(0,a.desktopTypographyLineHeight)(i.n9.lineHeight),letterSpacing:i.n9.letterSpacing,textAlign:"center",cursor:"disabled"===v.interaction?"default":i.n9.cursor,...p},children:v.label}):null})},54781:function(e,t,n){"use strict";n.d(t,{V:function(){return d}});var o=n(27573),r=n(7653),i=n(3458),a=n(41317),l=n(32425),s=n(12230),c=n(9813);function d(e){let{items:t,onOpenEdit:n,activeContextId:a=null,hostRef:l,anchorSurface:s,testIdPrefix:d,selectionUi:m=!1,selectionUiAttribute:f}=e,[p,h]=(0,r.useState)([]);if((0,r.useEffect)(()=>{let e=()=>{let e=l?.current??null,n=e?.getBoundingClientRect()??null,o=e?.scrollTop??0,r=e?.scrollLeft??0,i=[];for(let e of t){let t;let a=e.resolveRange();if(a){let e=a.getClientRects();t=e[e.length-1]}if(!t){let n=e.resolveElement?.();n&&(t=n.getBoundingClientRect())}t&&i.push({...e,top:n?t.top-n.top+o:t.top,left:n?t.right-n.left+r:t.right})}h(e=>e.length===i.length&&e.every((e,t)=>{let n=i[t];return!!n&&e.contextId===n.contextId&&e.referenceNumber===n.referenceNumber&&e.comment===n.comment&&e.markerVariant===n.markerVariant&&e.tooltip===n.tooltip&&e.quotedText===n.quotedText&&e.selectionKind===n.selectionKind&&e.value===n.value&&.5>Math.abs(e.top-n.top)&&.5>Math.abs(e.left-n.left)})?e:i)};e();let n=0,o=()=>{n||(n=window.requestAnimationFrame(()=>{n=0,e()}))};window.addEventListener("resize",o,{passive:!0}),window.addEventListener("scroll",o,{passive:!0,capture:!0});let r=l?.current??null,i="undefined"==typeof ResizeObserver?null:new ResizeObserver(o);r&&i?.observe(r);let a=r&&"undefined"!=typeof MutationObserver?new MutationObserver(o):null;return a?.observe(r,{childList:!0,subtree:!0,characterData:!0,attributes:!0,attributeFilter:["class","style","hidden","open"]}),()=>{n&&window.cancelAnimationFrame(n),window.removeEventListener("resize",o),window.removeEventListener("scroll",o,{capture:!0}),i?.disconnect(),a?.disconnect()}},[a,l,t]),"undefined"==typeof document||0===p.length)return null;let g=l?.current??null,x=g??document.body,v=g?"absolute":"fixed";return(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true",className:`${g?"absolute inset-0":"fixed inset-0"} pointer-events-none`,style:{zIndex:c.MK},children:p.map(e=>(0,o.jsx)(u,{position:e,positionMode:v,anchorSurface:s,testIdPrefix:d,selectionUi:m,selectionUiAttribute:f,isActive:e.contextId===a,onOpenEdit:()=>n(e.value)},e.contextId))}),x)}function u(e){let{position:t,positionMode:n,anchorSurface:i,testIdPrefix:c,selectionUi:d,selectionUiAttribute:u,isActive:m,onOpenEdit:f}=e,p=(0,r.useMemo)(()=>({position:n,top:Math.round(t.top),left:Math.round(t.left),zIndex:5,transform:"translate(-50%, -100%)"}),[t.left,t.top,n]),h=t.tooltip??(t.comment.trim()||t.quotedText);return(0,o.jsx)(a.Z,{placement:"top",arrow:!1,mouseEnterDelay:.05,title:h?(0,o.jsx)("span",{className:"line-clamp-2 break-words",children:h}):null,overlayStyle:{maxWidth:320},overlayInnerStyle:{display:"flex",height:"auto",minHeight:0,alignItems:"center",fontSize:(0,l.desktopTypographyFontSize)(12),lineHeight:(0,l.desktopTypographyLineHeight)(16),padding:"6px 10px"},children:(0,o.jsx)(s.y,{...u?{[u]:"true"}:{},number:t.referenceNumber,variant:t.markerVariant,interaction:m?"active":"idle",anchorContext:{surface:i,contextId:t.contextId,selectionKind:t.selectionKind},selectionUi:d,testId:`${c}-${t.contextId}`,ariaLabel:`Comment ${t.referenceNumber}`,onActivate:f,className:"pointer-events-auto",style:p})})}},9813:function(e,t,n){"use strict";n.d(t,{MK:function(){return o},Qv:function(){return r},gm:function(){return a},mu:function(){return i}});let o=20,r=21,i=100,a=101},46511:function(e,t,n){"use strict";n.d(t,{GC:function(){return i},QR:function(){return d},Vh:function(){return r},YA:function(){return a}});var o=n(7653);let r={stored:"mavis-chat-selection",active:"mavis-chat-selection-active"},i={stored:"mavis-preview-selection",active:"mavis-preview-selection-active"},a={stored:"mavis-file-panel-selection",active:"mavis-file-panel-selection-active"},l="mavis-chat-selection-highlight-style",s=`
::highlight(${r.stored}),
::highlight(${i.stored}) {
  background-color: transparent;
  color: inherit;
  text-decoration-line: underline;
  text-decoration-color: var(--border_accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-skip-ink: none;
}
::highlight(${r.active}),
::highlight(${i.active}),
::highlight(${a.stored}),
::highlight(${a.active}) {
  background-color: transparent;
  background-color: var(--bg_interaction_accent_focus_highlight);
  color: inherit;
}
`,c=new Map;function d(e,t,n){(0,o.useEffect)(()=>{if(!function(){let e=globalThis;return!!(e.CSS?.highlights&&"function"==typeof e.Highlight)}())return;!function(){if("undefined"==typeof document)return;let e=document.getElementById(l);if(e){e.textContent!==s&&(e.textContent=s);return}let t=document.createElement("style");t.id=l,t.textContent=s,document.head.appendChild(t)}();let o=globalThis,r=o.Highlight,i=o.CSS?.highlights;if(!i)return;let a=JSON.stringify([n.stored,n.active]),d=c.get(a)??new Set;c.set(a,d);let u={targets:e,activeContextId:t};d.add(u);let m=()=>{let e=new Set(Array.from(d,e=>e.activeContextId).filter(e=>null!==e)),t=[],o=[];for(let n of Array.from(d).flatMap(e=>e.targets))for(let r of n.resolveRanges?.()??(()=>{let e=n.resolveRange();return e?[e]:[]})())e.has(n.contextId)?o.push(r):(n.shouldPaintStoredRange?.(r)??!0)&&t.push(r);i.delete(n.stored),i.delete(n.active),t.length>0&&i.set(n.stored,new r(...t)),o.length>0&&i.set(n.active,new r(...o))};m();let f=0,p=()=>{f||(f=window.requestAnimationFrame(()=>{f=0,m()}))};window.addEventListener("resize",p,{passive:!0}),window.addEventListener("scroll",p,{passive:!0,capture:!0});let h="undefined"==typeof MutationObserver||"undefined"==typeof document?null:new MutationObserver(p);return h?.observe(document.body,{childList:!0,subtree:!0,characterData:!0}),()=>{f&&window.cancelAnimationFrame(f),window.removeEventListener("resize",p),window.removeEventListener("scroll",p,{capture:!0}),h?.disconnect(),d.delete(u),m(),0===d.size&&c.delete(a)}},[t,n,e])}},46855:function(e,t,n){"use strict";n.d(t,{D:function(){return b}});var o=n(27573),r=n(7653),i=n(4605),a=n(73374),l=n(42050),s=n(58291),c=n(25012),d=n(51904),u=n(22917),m=n(99776),f=n(13156),p=n(82875),h=n(61721),g=n(30060),x=n(68445),v=n(84819);function b(e){let{fileName:t,error:n,workspaceDir:b,filePath:w,onRetry:y}=e,k=(0,i.$1)(),C=(0,c.X6)();(0,r.useEffect)(()=>{k?.fail(n)},[n,k]);let[_,E]=(0,r.useState)(!1),S=n instanceof m.M&&(404===n.status||"NOT_FOUND"===n.code),I=n instanceof m.M&&(403===n.status||"FORBIDDEN"===n.code),M=!S&&s.d&&(0,c.K0)(C)&&!(0,g.q)()&&!!(b&&w),N=(0,p.vD)(n),B=!!y&&!S&&!N&&!(n instanceof f.MJ),L=N?(0,d.t)("file_viewer.text_preview_too_large",{limit:h.w/1048576}):n instanceof f.MJ?(0,d.t)(M?"file_viewer.office_preview_limit_local":"file_viewer.office_preview_limit",{limit:n.maxBytes/1048576}):S||I?(0,x.Z2)(n):(0,d.t)("file_viewer.office_preview_unavailable"),R=async()=>{if(!(!M||!(0,c.o9)(C)||(0,g.q)())&&!_&&b&&w){E(!0);try{await u.b.revealFile(b,w)}catch(e){(0,x.wb)(e)}finally{E(!1)}}};return(0,o.jsx)("div",{className:"flex h-full min-h-0 flex-1 overflow-auto bg-bg_default_primary p-6",children:(0,o.jsxs)("div",{role:"alert",className:"m-auto flex w-full max-w-[360px] flex-col items-center gap-6",children:[(0,o.jsx)(v.N,{icon:(0,o.jsx)(l.V,{fileName:t,size:52,borderRadius:520/38}),title:(0,d.t)(N?"file_viewer.binary_not_displayed":"file_viewer.office_preview_failed"),description:L}),(M||B)&&(0,o.jsxs)("div",{className:"flex max-w-full flex-wrap justify-center gap-4",children:[M&&(0,o.jsx)(a.z,{type:"button",variant:"gray",size:"default",typographyRole:"ui-button-strong",className:v._,disabled:_,onClick:()=>void R(),children:(0,o.jsx)("span",{className:"px-1",children:(0,d.t)("file_viewer.open_folder")})}),B&&(0,o.jsx)(a.z,{type:"button",variant:"black",size:"default",typographyRole:"ui-button-strong",className:v._,onClick:()=>{k?.retry(),y?.()},children:(0,o.jsx)("span",{className:"px-1",children:(0,d.t)("common.retry")})})]})]})})}},4605:function(e,t,n){"use strict";n.d(t,{$1:function(){return l},W8:function(){return a},jK:function(){return s},qn:function(){return d}});var o=n(27573),r=n(7653),i=n(95564);let a=(0,r.createContext)(void 0),l=()=>(0,r.useContext)(a);function s(e){let{children:t}=e;return l()?t:(0,o.jsx)(c,{...e})}function c(e){let{identity:t,active:n,error:l,children:s,...c}=e,d=(0,r.useMemo)(()=>(0,i.Md)(c),[t,c.sessionId,c.source]);return(0,r.useEffect)(()=>d.connect(),[d]),(0,r.useEffect)(()=>{!1===n?d.cancel():l&&d.fail(l)},[d,n,l]),(0,o.jsx)(a.Provider,{value:d,children:s})}function d(e,t){let n,o=arguments.length>2&&void 0!==arguments[2]&&arguments[2],r=!1;return(0,i.oT)(()=>{e?.stage("first_render",t),n=requestAnimationFrame(()=>{(0,i.oT)(()=>{n=requestAnimationFrame(()=>{r||e?.ready(t,o)})})})}),()=>{(0,i.oT)(()=>{r=!0,void 0!==n&&cancelAnimationFrame(n)})}}},7545:function(e,t,n){"use strict";n.d(t,{G:function(){return c},O:function(){return d}});var o=n(27573),r=n(7653),i=n(32709),a=n(51904),l=n(45255),s=n(71412);let c=126;function d(e){let{mode:t,startLine:n,endLine:c,value:d,onSubmit:u,onSend:m,onCancel:f,onDelete:p,onEdit:h,submitOnOutsideClick:g=!1,bodyTestId:x,testIdPrefix:v}=e,[b,w]=(0,r.useState)(d),[y,k]=(0,r.useState)(d),[C,_]=(0,r.useState)(!1),[E,S]=(0,r.useState)(!1),[I,M]=(0,r.useState)(!1),N=(0,l.xL)(e=>e.subUserName||e.userName),B=(0,l.xL)(l.Jh);(0,r.useEffect)(()=>{M(!1)},[B]),(0,r.useEffect)(()=>{w(d),k(d)},[d]),(0,r.useEffect)(()=>{"composer"===t&&_(!1)},[t]);let L=(0,r.useCallback)(()=>{let e=y.trim();w(e),k(e),_(!0),S(!1),u(e)},[y,u]),R=(0,r.useCallback)(()=>{k(b),_(!0),f?.()},[b,f]);if("composer"===t&&!C)return(0,o.jsx)(s.j,{startLine:n,endLine:c,value:y,onChange:k,onSubmit:L,...m?{onSend:m}:{},onCancel:R,...p?{onDelete:p}:{},showCancel:!0,showDelete:!!p,optionalComment:!0,embedded:!0,deleteControl:"icon",submitOnOutsideClick:g,testIdPrefix:v});let O=(0,a.t)(n===c?"code_review.commented_on_line":"code_review.commented_on_lines",{startLine:n,endLine:c});return(0,o.jsxs)("div",{className:`flex w-full flex-col overflow-hidden rounded-2xl border border-border_light bg-bg_grouped_tertiary font-sans text-text_default_primary ${E?"":"min-h-[126px] max-h-[226px]"}`,"data-testid":v,"data-collapsed":E?"true":"false",children:[(0,o.jsxs)("button",{type:"button",className:"flex h-12 w-full shrink-0 items-center gap-1 p-2 text-left","data-testid":`${v}-toggle`,"aria-expanded":!E,onClick:()=>S(e=>!e),children:[(0,o.jsx)("span",{className:"flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg",children:B&&!I?(0,o.jsx)("img",{src:B,alt:N||(0,a.t)("message.item.sender_you"),className:"size-5 rounded-full object-cover",referrerPolicy:"no-referrer",crossOrigin:"anonymous",onError:()=>M(!0)}):(0,o.jsx)(i.vo$,{size:20,className:"text-icon_default_tertiary"})}),(0,o.jsx)("span",{className:"desktop-text-ui-body-strong min-w-0 flex-1 truncate text-[14px] font-medium leading-5",children:N||(0,a.t)("message.item.sender_you")}),(0,o.jsx)("span",{className:"desktop-text-ui-assist shrink-0 text-[12px] leading-4 text-text_default_tertiary",children:O}),E?(0,o.jsx)(i.DU3,{size:16,className:"shrink-0 text-icon_default_secondary"}):(0,o.jsx)(i.GiZ,{size:16,className:"shrink-0 text-icon_default_secondary"})]}),E?null:(0,o.jsxs)("div",{className:"flex min-h-0 flex-1 flex-col",children:[b.trim()?(0,o.jsx)("button",{type:"button",className:"desktop-text-chat-body block min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 text-left text-[14px] leading-5 text-text_default_primary","data-testid":x??`${v}-body`,onClick:h,children:b}):null,p||h?(0,o.jsxs)("div",{className:"mt-auto flex shrink-0 items-center justify-end gap-2 px-3 pb-3",children:[(0,o.jsx)("div",{className:"mr-auto flex min-w-0 items-center gap-2",children:p?(0,o.jsx)("button",{type:"button",className:"flex size-8 shrink-0 items-center justify-center rounded-lg text-text_default_tertiary transition-colors hover:bg-bg_interaction_secondary_hover hover:text-text_status_error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border_accent","aria-label":(0,a.t)("common.delete"),"data-testid":`${v}-delete`,onClick:p,children:(0,o.jsx)(i.pJl,{size:18})}):null}),h?(0,o.jsx)("button",{type:"button",className:"desktop-text-ui-small-strong flex h-8 min-w-[68px] items-center justify-center rounded-lg bg-bg_interaction_secondary_default px-3 text-[14px] font-medium leading-5 text-text_label_secondary_default transition-colors hover:bg-bg_interaction_secondary_hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border_accent","data-testid":`${v}-edit`,onClick:h,children:(0,a.t)("common.edit")}):null]}):null]})]})}},65817:function(e,t,n){"use strict";n.d(t,{A:function(){return W}});var o=n(27573),r=n(53559),i=n(8556),a=n(79707),l=n(7653),s=n(3458),c=n(91576),d=n(51904),u=n(42940),m=n(95777),f=n(26063),p=n(34721),h=n(8770),g=n(47482),x=n(7545);let v=x.G+8+12;function b(e){let t=Number(e.attributes.endLine||e.attributes.startLine||1);return Number.isFinite(t)&&t>0?Math.floor(t):1}function w(e){let{block:t,zIndex:n,onSave:r,onEdit:i,onDelete:a,onComposerHostChange:s,onHeightChange:c}=e,d=t.item,u=(0,l.useRef)(null),m=(0,l.useRef)(null);return(0,l.useLayoutEffect)(()=>{if(t.composer&&t.portalComposer)return s?.(m.current),()=>s?.(null)},[t.composer,t.portalComposer,s]),(0,l.useLayoutEffect)(()=>{let e=u.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||v);n>0&&c(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,c]),(0,o.jsx)("div",{ref:u,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":`code-text-selection-inline-comment-${t.id}`,style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:t.composer?d?t.portalComposer?(0,o.jsx)("div",{ref:m,className:"pointer-events-auto w-full"}):(0,o.jsx)("div",{className:"pointer-events-auto w-full",children:(0,o.jsx)(x.O,{mode:"composer",startLine:Number(d.attributes.startLine||b(d)),endLine:b(d),value:d.feedback,onSubmit:e=>r?.(f.Sb(d,e)),onCancel:()=>a?.(d.contextId),...a?{onDelete:()=>a(d.contextId)}:{},submitOnOutsideClick:!0,testIdPrefix:"code-text-selection-comment"})}):null:d?(0,o.jsx)("div",{className:"pointer-events-auto w-full",children:(0,o.jsx)(x.O,{mode:"comment",startLine:Number(d.attributes.startLine||b(d)),endLine:b(d),value:d.feedback,onSubmit:e=>r?.({...d,feedback:e}),onEdit:()=>i?.(d),bodyTestId:`code-text-selection-inline-comment-composer-text-${d.contextId}`,...a?{onDelete:()=>a(d.contextId)}:{},testIdPrefix:`code-text-selection-comment-card-${d.contextId}`})}):null})})}var y=n(62340);function k(e){let{block:t,zIndex:n,onHandle:r,onHeightChange:i}=e,a=(0,l.useRef)(null);return(0,l.useLayoutEffect)(()=>{let e=a.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||200);n>0&&i(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,i]),(0,o.jsx)("div",{ref:a,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":"code-review-inline-comment-block",style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:(0,o.jsx)(y.Z,{comment:t.comment,path:t.path,className:"pointer-events-auto w-full",testId:"code-review-inline-comment",toggleTestId:"code-review-comment-toggle",handleTestId:"code-review-handle-comment",...r?{onHandle:r}:{}})})})}var C=n(75482);class _{rowRef(e){let t=this.rowRefs.get(e);return t||(t=t=>{this.onRowElement?.(t),t?(this.rows.set(e,t),this.lineByRow.set(t,e)):this.rows.delete(e)},this.rowRefs.set(e,t)),t}contentRef(e){let t=this.contentRefs.get(e);return t||(t=t=>{t?this.contents.set(e,t):this.contents.delete(e)},this.contentRefs.set(e,t)),t}isMounted(e){return this.contents.has(e)}hasUnmountedLine(e,t){for(let n=e;n<=t;n+=1)if(!this.contents.has(n))return!0;return!1}lineOf(e){for(let t=e;t;t=t.parentNode){let e=this.lineByRow.get(t);if(void 0!==e)return this.rows.get(e)===t?e:null}return null}toPosition(e,t,n){let o;let r=this.lineOf(e);if(null===r)return null;let i=this.contents.get(r),a=n[r];if(!i||void 0===a)return null;if(i===e||i.contains(e)){let n=(0,m.c4)(i,e,t);return n>=0&&n<=a.length?{lineIndex:r,column:n}:null}let l=document.createRange();l.selectNodeContents(i);try{o=l.comparePoint(e,t)}catch{return null}if(o<0)return{lineIndex:r,column:0};if(o>0&&e.contains(i)){let n=document.createRange();if(n.setStart(l.endContainer,l.endOffset),n.setEnd(e,t),""===n.toString())return{lineIndex:r,column:a.length}}return null}toDomPoint(e){let t=this.contents.get(e.lineIndex);if(!t)return null;let n=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),o=e.column;for(let e=n.nextNode();e;e=n.nextNode()){let t=e.nodeValue?.length??0;if(o<=t)return{node:e,offset:o};o-=t}return 0===o?{node:t,offset:0}:null}constructor(){this.onRowElement=null,this.rows=new Map,this.contents=new Map,this.lineByRow=new WeakMap,this.rowRefs=new Map,this.contentRefs=new Map}}function E(e,t,n){let o=e.toPosition(t.startContainer,t.startOffset,n),r=e.toPosition(t.endContainer,t.endOffset,n);if(!o||!r||r.lineIndex<=o.lineIndex||!e.hasUnmountedLine(o.lineIndex,r.lineIndex))return null;let i=[(n[o.lineIndex]??"").slice(o.column)];for(let e=o.lineIndex+1;e<r.lineIndex;e+=1)i.push(n[e]??"");return i.push((n[r.lineIndex]??"").slice(0,r.column)),i.join("\n")}function S(e,t){return e?.lineIndex===t?.lineIndex&&e?.column===t?.column}function I(e,t,n,o){return t?e.toPosition(t,n,o):null}function M(e){return e?Array.from(new Set([e.anchor?.lineIndex,e.focus?.lineIndex].filter(e=>void 0!==e))):[]}var N=n(5268),B=n(77575),L=n(10853),R=n(18397),O=n(32425);let j="mavis-code-chat-selection",T="mavis-code-chat-selection-highlight-style",A=`
::highlight(${j}) {
  background-color: var(--bg_interaction_accent_focus_highlight);
  color: var(--text_default_primary);
}
`;function D(){let e=globalThis;e.CSS?.highlights?.delete(j)}function $(e,t,n,r){if(0===n.length)return e;let i=[],a=0;for(let l of n){let n=Math.max(0,l.start-t),s=Math.min(e.length,l.end-t);if(s<=0||n>=e.length||s<=n)continue;n>a&&i.push(e.slice(a,n));let c=r?.lineIndex===l.lineIndex&&r.start===l.start&&r.end===l.end;i.push((0,o.jsx)("mark",{"data-testid":"code-view-find-match","data-current":c?"true":void 0,className:c?"rounded-[2px] bg-bg_interaction_accent_focus_highlight text-text_default_primary":"rounded-[2px] bg-[color-mix(in_srgb,var(--warning_500)_28%,transparent)] text-inherit",children:e.slice(n,s)},`${l.lineIndex}:${l.start}:${t}`)),a=s}return a<e.length&&i.push(e.slice(a)),i.length>0?i:e}function P(){return new Promise(e=>{if("function"==typeof window.requestAnimationFrame){window.requestAnimationFrame(e);return}window.setTimeout(()=>e(performance.now()),16)})}async function z(e,t,n){let o=performance.now();for(;performance.now()-o<1200;){if(Array.from(e.querySelectorAll(".code-view-row[data-line]")).some(e=>{let o=Number(e.dataset.line);return Number.isInteger(o)&&o>=t&&o<=n}))return!0;await P()}return!1}async function H(e){let t=performance.now(),n=t,o=e.scrollTop;for(;performance.now()-t<800;){await P();let t=performance.now();if(Math.abs(e.scrollTop-o)>.5){o=e.scrollTop,n=t;continue}if(t-n>=80)return}}function F(e,t,n){let o=window.getSelection?.();if(!o||0===o.rangeCount||o.isCollapsed)return null;let r=(E(t,o.getRangeAt(0),n)??o.toString()).trimEnd();if(!r.trim())return null;let i=o.getRangeAt(0);try{if(!i.intersectsNode(e))return null}catch{if(!e.contains(i.commonAncestorContainer))return null}let a=function(e,t){let n=[];return(t.querySelectorAll(".code-view-row").forEach(t=>{let o=function(e){let t=Number(e.getAttribute("data-index"));return!Number.isInteger(t)||t<0?null:t+1}(t);if(null!==o)try{e.intersectsNode(t)&&n.push(o)}catch{}}),0===n.length)?null:[Math.min(...n),Math.max(...n)]}(i,e);if(!a)return null;let l=e.querySelector(`.code-view-row[data-line='${a[0]}'] .code-view-line-content`),s=e.querySelector(`.code-view-row[data-line='${a[1]}'] .code-view-line-content`),c=l?(0,m.c4)(l,i.startContainer,i.startOffset):-1,d=s?(0,m.c4)(s,i.endContainer,i.endOffset):-1;return{selectedText:r,startLine:a[0],endLine:a[1],...c>=0?{startColumn:c}:{},...d>=0?{endColumn:d}:{}}}function q(e){return"edit"===e.attributes.intent||"edit"===e.attributes.requestedAction||"edit"===e.attributes.sourceAction}function W(e){let{content:t,...n}=e;return(0,o.jsx)(a.s,{content:t,...n,children:(0,o.jsx)(U,{content:t,...n})})}function U(e){let{content:t,fileName:a,filePath:s,overlayRightInset:d="0px",onAddSelectionToChat:m,onTextSelectionComment:y,onTextSelectionSend:W,onTextSelectionCommentRemove:U,onTextSelectionEditComposerChange:Q,onTextSelectionEditAccept:X,onTextSelectionEditReject:G,enableTextSelectionEditAction:Y=!1,textSelectionEditDiffs:J=[],textSelectionComments:Z=[],textSelectionCommentVariant:ee,showCommentAnchors:et=!0,showCommentHighlights:en=!0,commentHighlightNames:eo,selectionSurface:er,hideInlineCommentBlock:ei=!1,textSelectionEditRequest:ea,lineStart:el,lineEnd:es,focusRequestId:ec,onFocusRequestConsumed:ed,reviewComment:eu,onHandleReviewComment:em}=e,ef=(0,r.fP)(),ep=null!==ef,eh=(0,L.G)(),eg=(0,R.yd)(),ex=(0,O.getDesktopTypographyScene)(eh).code.block,ev=eg?ex.lineHeight:18,eb=(0,l.useRef)(null),ew=(0,l.useRef)(null),ey=(0,l.useRef)(null),ek=(0,l.useRef)(0),eC=(0,l.useRef)(0),e_=(0,l.useRef)(null),eE=(0,l.useRef)(!1),eS=(0,l.useRef)(!1),eI=(0,l.useRef)(null),[eM,eN]=(0,l.useState)(!1),[eB]=(0,l.useState)(()=>new _),[eL,eR]=(0,l.useState)(null),[eO,ej]=(0,l.useState)(null),[eT,eA]=(0,l.useState)(null),eD=(0,l.useRef)(null),[e$,eP]=(0,l.useState)(null),[ez,eH]=(0,l.useState)(null),[eF,eq]=(0,l.useState)(null),eW=(0,l.useRef)(0),[eU,eV]=(0,l.useState)(!1),[eK,eQ]=(0,l.useState)(""),[eX,eG]=(0,l.useState)(0),eY="large"===ee&&!ei,eJ=(0,N.vL)(e=>e.fileLineWrapEnabled);(0,l.useEffect)(()=>{"large"!==ee&&(eP(null),eH(null))},[t,s,ee]);let eZ=(0,l.useMemo)(()=>t?t.split("\n"):Array.from({length:2},()=>""),[t]),e0=(0,l.useMemo)(()=>Z.map(e=>(function(e,t,n,o){let r=Number(e.attributes.sourceStartOffset),i=Number(e.attributes.sourceEndOffset),a=Number.isFinite(r)&&r>=0&&r<=t.length?r:void 0,l=Number.isFinite(i)&&i>=0&&i<=t.length?i:void 0,s=Number(e.attributes.startLine),c=Number(e.attributes.endLine);if("markdown-preview"!==e.attributes.source&&s>0&&c>0)return e;let d=Number(e.attributes.markdownStartOffset??e.attributes.startOffset),u=Number(e.attributes.markdownOccurrenceIndex),m=(0,g.P)(t,e.text,Number.isFinite(d)?d:void 0,Number.isSafeInteger(u)&&u>=0?u:void 0),f="markdown-preview"===e.attributes.source&&void 0!==a&&void 0!==l&&function(e,t,n,o){if(o<=n)return!1;let r=e.slice(n,o),i=(0,g.P)(r,t);return i?.startOffset===0&&i.endOffset===r.length}(t,e.text,a,l),p="markdown-preview"===e.attributes.source?f?a:m?.startOffset:a??m?.startOffset;if(void 0===p)return e;let h="markdown-preview"===e.attributes.source?f?l:m?.endOffset??p+e.text.length:l??m?.endOffset??p+e.text.length,x=t.slice(0,p).split("\n").length,v=t.slice(0,Math.max(p,h)).split("\n").length;return{...e,targetPath:`${o||n}:${x}-${v}`,attributes:{...e.attributes,startLine:String(x),endLine:String(v)}}})(e,t,a,s)),[t,a,s,Z]),e1=(0,l.useMemo)(()=>(function(e,t){let n=t.trim().toLowerCase();if(!n)return[];let o=[];for(let t=0;t<e.length;t+=1){let r=(e[t]??"").toLowerCase(),i=0;for(;i<=r.length;){let e=r.indexOf(n,i);if(e<0)break;let a=e+n.length;o.push({lineIndex:t,start:e,end:a}),i=Math.max(a,e+1)}}return o})(eZ,eK),[eK,eZ]),e2=e1[eX],e5=(0,l.useMemo)(()=>{let e=new Map;for(let t of e1){let n=e.get(t.lineIndex);n?n.push(t):e.set(t.lineIndex,[t])}return e},[e1]),e4=String(eZ.length).length,e3=(0,l.useMemo)(()=>(function(e){let t=1;for(let n of e)t=Math.max(t,function(e){let t=0;for(let n of e)"	"===n?t+=4-t%4:t+=1;return t}(n));return t+2})(eZ),[eZ]),e8=void 0===el||0===eZ.length?void 0:Math.max(1,Math.min(eZ.length,el)),e7=void 0===e8?void 0:Math.max(e8,Math.min(eZ.length,es??e8)),[e6,e9]=(0,l.useState)(()=>void 0===e8||void 0===e7?null:{lineStart:e8,lineEnd:e7,...void 0!==ec?{requestId:ec}:{}}),te=e6?.lineStart,tt=e6?.lineEnd,tn=e6?.requestId;(0,l.useEffect)(()=>{if(void 0===e8||void 0===e7){ed||e9(null);return}e9(e=>e?.lineStart===e8&&e.lineEnd===e7&&e.requestId===ec?e:{lineStart:e8,lineEnd:e7,...void 0!==ec?{requestId:ec}:{}})},[ec,ed,e7,e8]);let to=(0,l.useMemo)(()=>{let e=new Map;if(eu){let t=Math.max(1,Math.min(eZ.length,eu.endLine));e.set(t,200)}if(ei)return e;let t=e$?.contextId;for(let n of[...e0.filter(e=>e.contextId!==t&&!q(e)),...e$?[e$]:[]]){let t=b(n);e.set(t,(e.get(t)??0)+v)}return e},[ei,e$,eZ.length,e0,eu]),{rangeExtractor:tr}=function(e){let{containerRef:t,registry:n,lines:o,highlightedLines:r}=e,i=(0,l.useRef)(null),a=(0,l.useRef)(o),[s,c]=(0,l.useState)(0),d=(0,l.useCallback)(()=>{let e=t.current,o=window.getSelection?.(),r=null;if(e&&o&&o.rangeCount>0){let e=I(n,o.anchorNode,o.anchorOffset,a.current),t=I(n,o.focusNode,o.focusOffset,a.current);r=e||t?{anchor:e,focus:t}:null}i.current=r,M(r).some(e=>!n.isMounted(e))&&c(e=>e+1)},[t,n]),u=(0,l.useCallback)(e=>{let t=(0,C.MK)(e),n=M(i.current).filter(n=>n<e.count&&!t.includes(n));return 0===n.length?t:[...t,...n].sort((e,t)=>e-t)},[s]);return(0,l.useEffect)(()=>(document.addEventListener("selectionchange",d),()=>document.removeEventListener("selectionchange",d)),[d]),(0,l.useLayoutEffect)(()=>{a.current=o,d()},[o,d]),(0,l.useLayoutEffect)(()=>{let e=i.current,o=t.current,r=window.getSelection?.();if(!e||!o||!r||0===r.rangeCount)return;let{anchor:l,focus:s}=e;if(!l||!s)return;let{anchorNode:c}=r;if(c?.isConnected&&!o.contains(c))return;let d=a.current,u=I(n,c,r.anchorOffset,d),m=I(n,r.focusNode,r.focusOffset,d);if(S(u,l)&&S(m,s))return;let f=n.toDomPoint(l),p=n.toDomPoint(s);f&&p&&r.setBaseAndExtent(f.node,f.offset,p.node,p.offset)},[t,r,n]),{rangeExtractor:u}}({containerRef:eb,registry:eB,lines:eZ,highlightedLines:eL}),ti=(0,c.MG)({count:eZ.length,getScrollElement:()=>eb.current,rangeExtractor:tr,estimateSize:e=>ev+(to.get(e+1)??0),overscan:20,measureElement:e=>{let t=e.querySelector(".code-view-line-main"),n=Math.ceil(t?.getBoundingClientRect().height||t?.offsetHeight||ev);return Math.max(ev,n+Array.from(e.querySelectorAll(".code-view-inline-comment")).reduce((e,t)=>e+Math.ceil(t.getBoundingClientRect().height||t.offsetHeight||v),0))}});eB.onRowElement=ti.measureElement;let ta=ti.scrollToIndex,tl=(0,l.useCallback)(()=>{let e=eb.current;e&&e.querySelectorAll(".code-view-row").forEach(e=>{ti.measureElement(e)})},[ti]),ts=(0,l.useCallback)(()=>{if(null!==eI.current)return;let e=window.requestAnimationFrame(()=>{tl(),eI.current===e&&(eI.current=null)});eI.current=e},[tl]);(0,l.useEffect)(()=>{eG(0)},[eK,t]),(0,l.useEffect)(()=>{eX<e1.length||eG(Math.max(0,e1.length-1))},[eX,e1.length]),(0,l.useEffect)(()=>{eU&&e2&&ta(e2.lineIndex,{align:"center",behavior:"smooth"})},[e2,eU,ta]),(0,l.useEffect)(()=>{ts()},[ev,t,eJ,ts]),(0,l.useEffect)(()=>{if(!eJ)return;let e=eb.current;if(!e||"undefined"==typeof ResizeObserver)return;let t=new ResizeObserver(()=>{ts()});return t.observe(e),ts(),()=>{t.disconnect(),null!==eI.current&&(window.cancelAnimationFrame(eI.current),eI.current=null)}},[eJ,ts]),(0,l.useEffect)(()=>{let e=eb.current;if(!e||void 0===te||void 0===tt){ej(null);return}let t=Math.floor((te+tt)/2)-1,n=Math.max(0,te-10-1),o=eC.current+1;eC.current=o;let r=!1;return void 0!==tn&&ed?.(tn),ej(null),ta(n,{align:"center",behavior:"auto"}),(async()=>{await P(),!r&&(ta(t,{align:"center",behavior:"smooth"}),await z(e,te,tt)&&!r&&(await H(e),r||ej(`${tn??"range"}:${o}`)))})(),()=>{r=!0}},[tn,tt,te,ed,ta]),(0,l.useEffect)(()=>{let e=eb.current;if(!e)return;let t=()=>{eN(!0),e_.current&&window.clearTimeout(e_.current),e_.current=window.setTimeout(()=>{eN(!1),e_.current=null},700)};return e.addEventListener("scroll",t,{passive:!0}),()=>{e.removeEventListener("scroll",t),e_.current&&(window.clearTimeout(e_.current),e_.current=null)}},[]);let tc=eZ.length;(0,l.useEffect)(()=>{let e=eb.current;if(!e)return;let n=n=>{let o=window.getSelection();if(!o||0===o.rangeCount||o.isCollapsed)return;let r=o.getRangeAt(0);try{if(!r.intersectsNode(e))return}catch{return}if(eE.current){n.preventDefault(),n.clipboardData?.setData("text/plain",t),eE.current=!1;return}let i=e.querySelectorAll(".code-view-row");if(0===i.length||tc<=i.length)return;let a=E(eB,r,eZ);if(null!==a){n.preventDefault(),n.clipboardData?.setData("text/plain",a);return}try{let e=i[0],o=i[i.length-1];e&&o&&r.intersectsNode(e)&&r.intersectsNode(o)&&(n.preventDefault(),n.clipboardData?.setData("text/plain",t))}catch{}};return e.addEventListener("copy",n),()=>e.removeEventListener("copy",n)},[t,eB,eZ,tc]),(0,l.useEffect)(()=>{if(!eT)return;let e=e=>{let t=e.target;t instanceof Node&&ew.current?.contains(t)||eA(null)},t=e=>{let t=e.target;if(t instanceof Node&&ew.current?.contains(t)){e.preventDefault();return}eA(null)},n=e=>{"Escape"===e.key&&eA(null)},o=()=>eA(null);return window.addEventListener("pointerdown",e,!0),window.addEventListener("contextmenu",t,!0),window.addEventListener("resize",o),window.addEventListener("scroll",o,!0),window.addEventListener("keydown",n),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("contextmenu",t,!0),window.removeEventListener("resize",o),window.removeEventListener("scroll",o,!0),window.removeEventListener("keydown",n)}},[eT]),(0,l.useEffect)(()=>{let e=e=>{let t=eb.current;eS.current=!!(null!==t&&e.target instanceof Node)&&t.contains(e.target)},t=e=>{var t;if(!eS.current||!(!e.altKey&&(e.ctrlKey||e.metaKey)&&"a"===e.key.toLowerCase())||(t=e.target)instanceof HTMLElement&&t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'))return;let n=eb.current;n&&function(e){let t=e.querySelectorAll(".code-view-line-content"),n=t[0],o=t[t.length-1];if(!n||!o)return!1;let r=window.getSelection?.();if(!r)return!1;let i=document.createRange();return i.setStartBefore(n),i.setEndAfter(o),r.removeAllRanges(),r.addRange(i),!0}(n)&&(e.preventDefault(),e.stopPropagation(),eE.current=!0,eA(null))};return window.addEventListener("pointerdown",e,!0),window.addEventListener("keydown",t),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("keydown",t)}},[]),(0,l.useEffect)(()=>{if(!t){eR(null);return}let e=ey.current??function(){if("undefined"==typeof Worker)return null;try{return new Worker(n.tu(new URL(n.p+n.u(4647),n.b)),{type:void 0})}catch{return null}}();if(ey.current=e,!e)return;let o=ek.current+1;ek.current=o;let r=e=>{let t=e.data;t.id===ek.current&&"success"===t.type&&"tokens"in t&&eR(t.tokens)},i=t=>{t.preventDefault(),eR(null),e.terminate(),ey.current===e&&(ey.current=null)};e.addEventListener("message",r),e.addEventListener("error",i);try{e.postMessage({type:"highlight",id:o,code:t,fileName:a,...ep?{desktopSemanticColors:!0}:{}})}catch{e.removeEventListener("message",r),e.removeEventListener("error",i),e.terminate(),ey.current===e&&(ey.current=null);return}return()=>{e.removeEventListener("message",r),e.removeEventListener("error",i)}},[t,a,ep]),(0,l.useEffect)(()=>()=>{ey.current?.terminate(),ey.current=null,D()},[]),(0,l.useEffect)(()=>{D()},[t,s]);let td=(0,l.useCallback)(e=>{let t=eb.current;if(!t)return;let n=F(t,eB,eZ),o=window.getSelection?.();eD.current=o&&o.rangeCount>0&&!o.isCollapsed?o.getRangeAt(0).cloneRange():null,e.preventDefault(),e.stopPropagation(),eA(function(e,t){let n=Number.isFinite(e.clientX)?e.clientX:8,o=Number.isFinite(e.clientY)?e.clientY:8;return{x:Math.min(Math.max(8,n),Math.max(8,window.innerWidth-176-8)),y:Math.min(Math.max(8,o),Math.max(8,window.innerHeight-120-8)),selection:t}}(e,n))},[eB,eZ]),tu=(0,l.useCallback)(()=>{eE.current=!1,D()},[]),tm=(0,l.useCallback)(()=>{eG(e=>0===e1.length?0:(e+1)%e1.length)},[e1.length]),tf=(0,l.useCallback)(()=>{eG(e=>0===e1.length?0:(e-1+e1.length)%e1.length)},[e1.length]),tp=(0,l.useCallback)(()=>{B.o.getState().closeSearch(),eV(!0)},[]),th=async()=>{eT?.selection&&(await (0,u.v)(eT.selection.selectedText),eA(null))},tg=async()=>{await (0,u.v)(t),eA(null)},tx=async()=>{if(eT?.selection&&m)try{await m({selectedText:eT.selection.selectedText,startLine:eT.selection.startLine,endLine:eT.selection.endLine})}finally{let e=eD.current,t=window.getSelection?.();e&&t&&(t.removeAllRanges(),t.addRange(e),function(e){let t=globalThis,n=t.CSS?.highlights,o=t.Highlight;if(!n||"function"!=typeof o||"undefined"==typeof document)return;let r=document.getElementById(T);r||((r=document.createElement("style")).id=T,document.head.appendChild(r)),r.textContent!==A&&(r.textContent=A),n.set(j,new o(e.cloneRange()))}(e)),eD.current=null,eA(null)}},tv=`calc(${e4}ch + 14px)`,tb=ti.getVirtualItems(),tw=tb.length>0?tb:Array.from({length:Math.min(eZ.length,21)},(e,t)=>({index:t,key:`fallback-${t}`,start:t*ev})),ty=(0,l.useMemo)(()=>{if(!eY)return[];let e=e$?.contextId,t=!1,n=e0.flatMap(n=>q(n)?[]:n.contextId===e?e$?(t=!0,[{id:`composer-${e$.contextId}`,afterLineNumber:b(e$),item:e$,composer:!0,portalComposer:!0}]):[]:[{id:`comment-${n.contextId}`,afterLineNumber:b(n),item:n,composer:!(0,f.t_)(n)}]);return e$&&!t&&n.push({id:`composer-${e$.contextId}`,afterLineNumber:b(e$),item:e$,composer:!0,portalComposer:!0}),n.sort((e,t)=>e.afterLineNumber-t.afterLineNumber)},[eY,e$,e0]),tk=(0,l.useMemo)(()=>{let e=ty.map(e=>({kind:"comment",...e}));return eu&&e.push({kind:"review-comment",id:`review-comment-${eu.id}`,afterLineNumber:Math.max(1,Math.min(eZ.length,eu.endLine)),comment:eu,path:s??a}),e.sort((e,t)=>e.afterLineNumber-t.afterLineNumber)},[a,s,ty,eZ.length,eu]),tC=(0,l.useMemo)(()=>{let e=new Map,t=tk.length;return tk.forEach((n,o)=>{e.set(n.id,t-o)}),e},[tk]),t_=(0,l.useMemo)(()=>{let e=new Map;for(let t of tk){let n=e.get(t.afterLineNumber);n?n.push(t):e.set(t.afterLineNumber,[t])}return e},[tk]),[tE,tS]=(0,l.useState)({});(0,l.useEffect)(()=>{tS(e=>{let t={};for(let n of tk){let o=e[n.id];void 0!==o&&(t[n.id]=o)}let n=Object.keys(e),o=Object.keys(t);if(n.length!==o.length)return t;for(let n of o)if(e[n]!==t[n])return t;return e})},[tk]);let tI=(0,l.useCallback)((e,t)=>{tS(n=>n[e]===t?n:{...n,[e]:t})},[]);(0,l.useLayoutEffect)(()=>{ts()},[tE,tk,ts]);let tM=(0,l.useCallback)(e=>{if(Q?.(!1),"large"!==ee){eP(null),eH(null),eq(null);return}eP(e),e||(eH(null),eq(null))},[Q,ee]),tN=(0,l.useCallback)(e=>{eP(e),eW.current-=1,eq({token:eW.current,contextId:e.contextId})},[]),tB=(0,l.useCallback)(e=>{W?.(e)},[W]),tL={...(0,i.cC)(ef),"--code-line-number-width":tv,"--code-content-min-width":`calc(var(--code-line-number-width) + ${e3}ch)`,"--code-view-overlay-right-inset":d};return(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("style",{children:`
        .code-view {
          --code-line-height: ${ev}px;
          --code-view-background: var(--bg_default_primary);
          background: var(--code-view-background);
          container-type: inline-size;
          font-size: var(--mavis-code-block-font-size, 12px);
          font-weight: 400;
          tab-size: 4;
        }
        .code-view-spacer {
          position: relative;
          width: max(100%, var(--code-content-min-width));
          min-width: max(100%, var(--code-content-min-width));
        }
        .code-view-row {
          position: absolute;
          left: 0;
          display: block;
          width: max-content;
          min-width: 100%;
          height: auto;
          white-space: pre;
        }
        .code-view[data-line-wrap='true'] .code-view-spacer {
          width: 100%;
          min-width: 100%;
        }
        .code-view[data-line-wrap='true'] .code-view-row {
          width: 100%;
          white-space: normal;
        }
        .code-view-line-main {
          display: flex;
          min-width: 0;
          min-height: var(--code-line-height);
          line-height: var(--code-line-height);
          align-items: flex-start;
        }
        .code-view[data-line-wrap='true'] .code-view-line-main {
          display: grid;
          width: 100%;
          grid-template-columns: var(--code-line-number-width) minmax(0, 1fr);
          align-items: start;
          min-height: var(--code-line-height);
          line-height: var(--code-line-height);
          white-space: normal;
        }
        .code-view-line-body {
          display: flex;
          flex: 1 1 auto;
          min-width: 0;
          flex-direction: column;
        }
        .code-view[data-line-wrap='true'] .code-view-line-body {
          grid-column: 2;
        }
        .code-view-row[data-focus-highlight='true'] .code-view-line-number,
        .code-view-row[data-focus-highlight='true'] .code-view-line-content {
          animation: code-view-focus-flash 1.8s ease-in-out;
        }
        @keyframes code-view-focus-flash {
          0% { background-color: transparent; }
          22% {
            background-color: color-mix(in srgb, var(--text_default_accent) 16%, transparent);
          }
          50% {
            background-color: color-mix(in srgb, var(--text_default_accent) 2.5%, transparent);
          }
          72% {
            background-color: color-mix(in srgb, var(--text_default_accent) 10%, transparent);
          }
          100% { background-color: transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          :root
            .code-view-row[data-focus-highlight='true'] .code-view-line-number,
          :root
            .code-view-row[data-focus-highlight='true'] .code-view-line-content {
            animation: none;
          }
        }
        .code-view-line-number {
          position: sticky;
          left: 0;
          z-index: 1;
          flex: 0 0 var(--code-line-number-width);
          width: var(--code-line-number-width);
          box-sizing: border-box;
          padding-left: 6px;
          padding-right: 8px;
          text-align: right;
          color: var(--text_default_tertiary);
          background: var(--code-view-background);
          user-select: none;
        }
        .code-view-line-number::selection {
          background: transparent;
        }
        .code-view-line-content {
          display: inline-block;
          flex: 1 0 auto;
          white-space: pre;
          color: var(--code-theme-default);
        }
        .code-view[data-line-wrap='true'] .code-view-line-content {
          display: block;
          width: 100%;
          min-width: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: normal;
        }
        .code-view[data-line-wrap='true'] .code-token {
          white-space: inherit !important;
        }
        .code-view .code-token {
          background-color: transparent !important;
          font-style: var(--shiki-light-font-style, normal);
          font-weight: var(--shiki-light-font-weight, normal);
          text-decoration: var(--shiki-light-text-decoration, none);
        }
        .dark .code-view .code-token {
          color: var(--shiki-dark, var(--code-theme-default)) !important;
          font-style: var(
            --shiki-dark-font-style,
            var(--shiki-light-font-style, normal)
          );
          font-weight: var(
            --shiki-dark-font-weight,
            var(--shiki-light-font-weight, normal)
          );
          text-decoration: var(
            --shiki-dark-text-decoration,
            var(--shiki-light-text-decoration, none)
          );
        }
        .code-view::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .code-view::-webkit-scrollbar-track {
          background: transparent;
        }
        .code-view::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 4px;
          transition: background 0.16s ease;
        }
        .code-view.is-scrolling::-webkit-scrollbar-thumb {
          background: rgba(138, 134, 152, 0.18);
        }
        .code-view.is-scrolling::-webkit-scrollbar-thumb:hover {
          background: rgba(138, 134, 152, 0.26);
        }
      `}),(0,o.jsxs)("div",{className:"relative h-full w-full min-w-0","data-app-shortcut-priority":"text-editor",children:[(0,o.jsx)("div",{ref:eb,className:`code-view mavis-desktop-typography-fixed relative h-full w-full min-w-0 font-mono ${eJ?"overflow-y-auto overflow-x-hidden":"overflow-auto"} ${eM?"is-scrolling":""}`,"data-line-wrap":eJ?"true":"false",style:tL,onContextMenu:td,onPointerDownCapture:tu,children:(0,o.jsx)("div",{className:"code-view-spacer",style:{height:`${ti.getTotalSize()}px`},children:tw.map(e=>{let n=e.index,r=n+1,i=null!==eO&&void 0!==te&&void 0!==tt&&r>=te&&r<=tt,a=eL?.length===eZ.length?eL[n]:void 0,l=e5.get(n)??[];return(0,o.jsxs)("div",{"data-index":n,"data-line":r,"data-focus-highlight":i?"true":void 0,"data-focus-highlight-key":i?eO:void 0,className:"code-view-row",ref:eB.rowRef(n),style:{transform:`translateY(${e.start}px)`,...eJ?{boxSizing:"border-box",paddingRight:d}:{}},children:[(0,o.jsxs)("div",{className:"code-view-line-main",children:[(0,o.jsx)("span",{className:"code-view-line-number",children:n+1}),(0,o.jsx)("div",{className:"code-view-line-body",children:(0,o.jsx)("span",{className:"code-view-line-content",ref:eB.contentRef(n),children:a?function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:[],n=arguments.length>2?arguments[2]:void 0,r=0;return e.map((e,i)=>{let a=r;return r+=e.content.length,(0,o.jsx)("span",{className:"code-token",style:function(e){if(e.htmlStyle)return e.htmlStyle;let t={};return e.color&&(t.color=e.color),e.bgColor&&(t.backgroundColor=e.bgColor),Object.keys(t).length>0?t:void 0}(e),children:$(e.content,a,t,n)},`${e.offset}:${i}`)})}(a,l,e2):$(eZ[n]??"",0,l,e2)})})]}),t_.get(r)?.map(e=>"edit-review"===e.kind?o.jsx(K,{block:e,zIndex:tC.get(e.id),content:t,onAccept:X,onReject:G,onRemoveComment:U,onHeightChange:tI},e.id):"review-comment"===e.kind?o.jsx(k,{block:e,zIndex:tC.get(e.id),onHandle:em,onHeightChange:tI},e.id):o.jsx(w,{block:e,zIndex:tC.get(e.id),onSave:y,onEdit:tN,onDelete:U,onComposerHostChange:eH,onHeightChange:tI},e.id))??null]},e.key)})})}),(0,o.jsx)(h.j,{hostRef:eb,isOpen:eU,query:eK,matchCount:e1.length,currentIndex:eX,testIdPrefix:"code-view",rightInset:d,onOpen:tp,onClose:()=>eV(!1),onQueryChange:eQ,onNext:tm,onPrevious:tf})]}),(0,o.jsx)(V,{refEl:ew,contextMenu:eT,canAddToChat:!!m,onCopy:()=>void th(),onCopyAll:()=>void tg(),onAddToChat:()=>void tx()}),(0,o.jsx)(p.k4,{hostRef:eb,fileName:a,filePath:s,sourceLabel:"code-view",onAddComment:y,onSendComment:tB,onRemoveComment:U,commentItems:e0,openEditRequest:eF??ea,commentVariant:ee,editComposerVariant:"large",keepComposerOpenOnSubmit:!1,showCommentAnchors:et,showCommentHighlights:en,commentHighlightNames:eo,selectionSurface:er,composerPlacement:eY?"inline":"floating",getInlineComposerHost:()=>ez,onOpenComposerChange:tM,renderComposer:eY?e=>{let{item:t,onSubmit:n,onSend:r,onCancel:i,onDelete:a,testIdPrefix:l}=e;return(0,o.jsx)(x.O,{mode:"composer",startLine:Number(t.attributes.startLine||b(t)),endLine:b(t),value:t.feedback,onSubmit:n,...r?{onSend:r}:{},onCancel:i,...a?{onDelete:a}:{},submitOnOutsideClick:!0,testIdPrefix:l})}:void 0,getSelectionMetadata:()=>{let e=eb.current,t=e?F(e,eB,eZ):null;return{targetPath:t?`${s||a}:${t.startLine}-${t.endLine}`:s||a,attributes:t?{startLine:String(t.startLine),endLine:String(t.endLine),...void 0===t.startColumn?{}:{startColumn:String(t.startColumn)},...void 0===t.endColumn?{}:{endColumn:String(t.endColumn)}}:void 0}},testIdPrefix:"code-text-selection"})]})}function V(e){let{refEl:t,contextMenu:n,canAddToChat:r,onCopy:i,onCopyAll:a,onAddToChat:l}=e;if(!n||"undefined"==typeof document)return null;let c=null!==n.selection,u="block w-full rounded-lg px-3 py-1.5 text-left text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:text-text_default_tertiary disabled:hover:bg-transparent";return(0,s.createPortal)((0,o.jsxs)("div",{ref:e=>{t.current=e},role:"menu","data-testid":"code-selection-context-menu",className:"mavis-file-context-menu desktop-text-ui-body fixed z-[100] w-44 rounded-[12px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-1 text-sm text-text_default_primary shadow-[0_0_20px_rgba(10,10,10,0.08)]",style:{left:n.x,top:n.y},onClick:e=>e.stopPropagation(),onContextMenu:e=>e.preventDefault(),children:[c&&(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-copy",className:u,onClick:i,children:(0,d.t)("common.copy")}),(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-copy-all",className:u,onClick:a,children:(0,d.t)("common.copy_all")}),c&&(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-add-to-chat",disabled:!r,className:u,onClick:l,children:(0,d.t)("file_panel.add_to_chat")})]}),document.body)}function K(e){let{block:t,zIndex:n,content:r,onAccept:i,onReject:a,onRemoveComment:s,onHeightChange:c}=e,[u,m]=(0,l.useState)(null),f=(0,l.useRef)(null);(0,l.useEffect)(()=>{m(null)},[t.id]),(0,l.useLayoutEffect)(()=>{let e=f.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||260);n>0&&c(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,c]);let p=(0,l.useCallback)(()=>{if(i){i(t.item.contextId);return}s?.(t.item.contextId)},[t.item.contextId,i,s]),h=(0,l.useCallback)(async()=>{if(a){m("reject");try{await a(t.item.contextId,function(e,t){let n=e.split("\n"),o=Math.max(0,Math.min(n.length,t.startLine-1)),r=Math.max(0,t.endLine-t.startLine+1),i=t.text.length>0?t.text.split("\n"):[];return n.splice(o,r,...i),n.join("\n")}(r,t.replacement))}finally{m(null)}}},[t.item.contextId,t.replacement,r,a,s]);return(0,o.jsx)("div",{ref:f,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":`code-text-selection-edit-review-${t.item.contextId}`,style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:(0,o.jsxs)("div",{className:"pointer-events-auto overflow-hidden rounded-2xl border-[0.5px] border-border_default bg-bg_default_primary shadow-[0_10px_24px_rgba(0,0,0,0.06)]",children:[(0,o.jsxs)("div",{className:"border-b-[0.5px] border-border_default px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-small-strong mb-2 text-[12px] font-medium text-text_default_secondary",children:(0,d.t)("file_panel.edit_review_title")}),(0,o.jsxs)("div",{className:"overflow-hidden rounded-xl border-[0.5px] border-border_default bg-bg_grouped_secondary/50",children:[(0,o.jsxs)("div",{className:"border-l-4 border-l-text_status_error bg-red-500/10 px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-assist mb-2 inline-flex rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-text_status_error",children:(0,d.t)("file_panel.edit_review_before")}),(0,o.jsx)("div",{className:"desktop-text-code-diff whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-text_default_primary",children:t.beforeText})]}),(0,o.jsxs)("div",{className:"border-l-4 border-l-text_status_success bg-green-500/10 px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-assist mb-2 inline-flex rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-text_status_success",children:(0,d.t)("file_panel.edit_review_after")}),(0,o.jsx)("div",{className:"desktop-text-code-diff whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-text_default_primary",children:t.afterText})]})]})]}),(0,o.jsxs)("div",{className:"flex justify-end gap-2 px-4 py-3",children:[(0,o.jsx)("button",{type:"button","data-testid":`code-text-selection-edit-review-reject-${t.item.contextId}`,className:"desktop-text-ui-body-strong rounded-lg border border-border_default px-4 py-1.5 text-sm text-text_status_error transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50",disabled:null!==u,onClick:()=>void h(),children:(0,d.t)("file_panel.edit_review_reject")}),(0,o.jsx)("button",{type:"button","data-testid":`code-text-selection-edit-review-accept-${t.item.contextId}`,className:"desktop-text-ui-body-strong rounded-lg border border-border_default px-4 py-1.5 text-sm text-text_status_success transition-colors hover:bg-bg_interaction_tertiary_hover",disabled:null!==u,onClick:p,children:(0,d.t)("file_panel.edit_review_accept")})]})]})})})}},79707:function(e,t,n){"use strict";n.d(t,{s:function(){return d},z:function(){return c}});var o=n(27573),r=n(7653),i=n(51904),a=n(82875),l=n(46855);let s=(0,r.lazy)(()=>Promise.all([n.e(83855),n.e(85902),n.e(45197),n.e(15696),n.e(93917)]).then(n.bind(n,50812)).then(e=>({default:e.MonacoTextPreview})));function c(e){if(e.length>2097152)return!0;let t=0,n=1;for(;t<e.length;){let o=e.indexOf("\n",t);if((-1===o?e.length:o)-t>1e4)return!0;if(-1===o)break;if(++n>1e5)return!0;t=o+1}return!1}function d(e){let{content:t,sizeBytes:n,children:d,...u}=e,m=(0,r.useMemo)(()=>(0,a.wk)(t,n)?"unsupported":c(t)?"monaco":"normal",[t,n]);return"normal"===m?d:"unsupported"===m?(0,o.jsx)(l.D,{fileName:u.fileName??"",error:(0,a.ws)()}):(0,o.jsx)(r.Suspense,{fallback:(0,o.jsx)("div",{role:"status",className:"desktop-text-ui-small p-3 text-text_default_secondary",children:(0,i.t)("file_viewer.loading")}),children:(0,o.jsx)(s,{content:t,...u})})}},362:function(e,t,n){"use strict";n.d(t,{D5:function(){return u},Xv:function(){return c},l:function(){return d}});var o=n(27573),r=n(7653),i=n(3458),a=n(42350),l=n(9813),s=n(51904);let c=8;function d(e){let{anchorRect:t,releasePointAlignment:n="end",releasePointX:l,selectionBottom:c,bottomInset:d=0,onAdd:m,alternativeLabel:f,alternativeIcon:p,onAlternativeAdd:h,testId:g,host:x=null,overlayMode:v="contained"}=e,b=(0,r.useRef)(null),[w,y]=(0,r.useState)(120),[k,C]=(0,r.useState)(0);(0,r.useLayoutEffect)(()=>{let e=b.current;if(!e)return;let t=()=>{let t=Math.ceil(e.getBoundingClientRect().width);t>0&&y(e=>e===t?e:t)},n=()=>{t(),C(e=>e+1)};t(),window.addEventListener("resize",n,{passive:!0});let o="undefined"==typeof ResizeObserver?null:new ResizeObserver(n);return o?.observe(e),x&&o?.observe(x),()=>{window.removeEventListener("resize",n),o?.disconnect()}},[x]);let _=(0,r.useMemo)(()=>u(t,x,w,c,d,n,l,v,h?38:32),[t,d,w,x,k,h,v,n,l,c]);if("undefined"==typeof document)return null;let E="floating"===v?document.body:x??document.body;return(0,i.createPortal)((0,o.jsxs)("div",{ref:b,style:_,"data-chat-selection-ui":"true",className:h?"mavis-chat-selection-toolbar desktop-text-ui-small-strong inline-flex h-[38px] items-center rounded-xl border border-border_default bg-bg_grouped_secondary_elevated px-0.5 shadow-[0_0_20px_var(--shadow_default)] [-webkit-app-region:no-drag]":"desktop-text-ui-small-strong inline-flex items-center rounded-lg bg-bg_grouped_secondary_elevated [-webkit-app-region:no-drag]",children:[(0,o.jsxs)("button",{type:"button","aria-keyshortcuts":"Tab","data-chat-selection-ui":"true","data-chat-selection-add-button":"true","data-testid":g??"chat-selection-add-button",onMouseDown:e=>e.preventDefault(),onClick:e=>{e.preventDefault(),e.stopPropagation(),m()},className:h?"inline-flex h-[33px] w-max shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border-none bg-transparent p-1.5 text-sm font-normal leading-5 text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover":"inline-flex h-8 w-max shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 text-[13px] font-medium leading-none text-text_default_primary shadow-[0_0_20px_var(--shadow_default)] transition-colors hover:bg-bg_grouped_tertiary",children:[(0,o.jsx)(a.rDX,{size:h?20:18,className:"shrink-0 text-icon_default_secondary"}),(0,o.jsx)("span",{"data-testid":"chat-selection-add-label",className:"shrink-0 whitespace-nowrap bg-transparent",children:(0,s.t)(h?"sidechat.to_task":"chat_selection.add_to_chat")})]}),h&&(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("span",{"aria-hidden":"true",className:"h-4 w-px shrink-0 bg-border_default"}),(0,o.jsxs)("button",{type:"button","data-chat-selection-ui":"true",onMouseDown:e=>e.preventDefault(),onClick:e=>{e.preventDefault(),e.stopPropagation(),h()},className:"inline-flex h-[33px] w-max shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border-none bg-transparent p-1.5 text-sm font-normal leading-5 text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover",children:[p??(0,o.jsx)(a.Ub_,{size:20,className:"shrink-0 text-icon_default_secondary"}),(0,o.jsx)("span",{children:f})]})]})]}),E)}function u(e,t){let n=arguments.length>2&&void 0!==arguments[2]?arguments[2]:120,o=arguments.length>3&&void 0!==arguments[3]?arguments[3]:e.bottom,r=arguments.length>4&&void 0!==arguments[4]?arguments[4]:0,i=arguments.length>5&&void 0!==arguments[5]?arguments[5]:"end",a=arguments.length>6?arguments[6]:void 0,s=arguments.length>7&&void 0!==arguments[7]?arguments[7]:"contained",d=arguments.length>8&&void 0!==arguments[8]?arguments[8]:32,u=window.innerWidth,m=window.innerHeight,f=t?.getBoundingClientRect()??null;if("floating"===s){let t=Math.max(8,e.top-d-c),o=f?Math.max(8,f.left+8):8,r=f?Math.min(u-8,f.right-8):u-8,i=void 0!==a?a-n/2:e.left;return{position:"fixed",top:`${Math.round(t)}px`,left:`${Math.round(Math.min(Math.max(i,o),Math.max(o,r-n)))}px`,zIndex:l.mu}}let p=f?Math.max(8,f.top+8):8,h=Math.max(0,r),g=f?Math.min(m-h-8,f.bottom-h-8):m-h-8,x=e.top-d-c,v=o+c,b=x>=p,w=v+d<=g,y=b?x:w?v:p,k=!b&&!w,C=void 0!==a?a-n/2:"start"===i?e.left:"center"===i?e.right-n/2:e.right-n,_=u-8;if(t&&f){let e=Math.max(8,f.left+8),o=Math.min(_,f.right-8);return{position:"absolute",top:`${Math.round(y-f.top+t.scrollTop)}px`,left:`${Math.round(Math.min(Math.max(C,e),Math.max(e,o-n))-f.left+t.scrollLeft)}px`,zIndex:6,visibility:k?"hidden":void 0,pointerEvents:k?"none":void 0}}return{position:"fixed",top:`${Math.round(y)}px`,left:`${Math.round(Math.min(Math.max(C,8),Math.max(8,_-n)))}px`,zIndex:2147483645,visibility:k?"hidden":void 0,pointerEvents:k?"none":void 0}}},45734:function(e,t,n){"use strict";n.d(t,{p:function(){return l}});var o=n(59403),r=n(13049),i=n(9813);let a=2*o.OQ.edit.inputRowPaddingY+o.OQ.edit.gap+o.OQ.edit.footerHeight+o.OQ.wrapper.padding.top+o.OQ.wrapper.padding.bottom+2*o.OQ.wrapper.borderWidth;function l(e,t,n){let l,s,c=arguments.length>3&&void 0!==arguments[3]?arguments[3]:0,d=arguments.length>4&&void 0!==arguments[4]?arguments[4]:null,u=window.innerWidth,m=window.innerHeight,f=function(){let e=o.OQ.input.lineHeight,t=e;if("undefined"!=typeof document){let n=Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(`--mavis-line-height-${e}`));Number.isFinite(n)&&n>0&&(t=n)}return o.OQ.input.maxLines*t+a}(),p=n?.getBoundingClientRect()??null,h=o.OQ.width.viewportInset,g=o.OQ.placement.bottomInset,x=p?Math.max(p.left+h,h):h,v=p?Math.min(p.right-h,u-h):u-h,b=Math.min(o.OQ.width.max,Math.max(o.OQ.width.min,Math.max(0,v-x))),w="large"===t?o.OQ.edit.height:o.OQ.create.height;if(d){let t=Math.min(Math.max(d.left,x),Math.max(x,v-b)),n=d.bottom<=e.top,r=e=>({position:"fixed",bottom:`${Math.round(e)}px`,left:`${Math.round(t)}px`,width:`${b}px`,zIndex:i.gm});if(n&&d.bottom-f>=8)return r(Math.max(8,m-d.bottom));let a=n?d.bottom-w:d.bottom+o.OQ.placement.anchorGap;return a>Math.max(8,m-8-f)?r(8):{position:"fixed",top:`${Math.round(Math.max(a,8))}px`,left:`${Math.round(t)}px`,width:`${b}px`,zIndex:i.gm}}l=Math.max(l=e.left+b<=v?e.left:v-b,x);let y=p?Math.max(p.top+g,g):g,k=p?Math.max(y,Math.min(p.bottom-Math.max(0,c)-g,m-g)):m-g,C=e.bottom+o.OQ.placement.anchorGap,_="small"===t?r.n9.size:0,E=e.top-o.OQ.placement.anchorGap-w-_,S=Math.max(y,k-f);return(s="small"===t?Math.min(Math.max(E,y),S):C+f<=k?C:E>=y?E:Math.min(Math.max(C,y),S),n&&p)?{position:"absolute",top:`${Math.round(s-p.top+n.scrollTop)}px`,left:`${Math.round(l-p.left+n.scrollLeft)}px`,width:`${b}px`,zIndex:i.Qv}:{position:"fixed",top:`${Math.round(s)}px`,left:`${Math.round(l)}px`,width:`${b}px`,zIndex:2147483646}}},48857:function(e,t,n){"use strict";n.d(t,{O:function(){return w}});var o=n(27573),r=n(7653),i=n(58291),a=n(96841),l=n(75639),s=n(10423),c=n(5268),d=n(77575),u=n(34721),m=n(8770),f=n(47482);let p="mavis-scoped-find",h="mavis-scoped-find-active",g=`
::highlight(${p}) {
  background-color: color-mix(in srgb, var(--warning_500) 28%, transparent);
  color: inherit;
}
::highlight(${h}) {
  background-color: var(--bg_interaction_accent_focus_highlight);
  color: inherit;
}
`;function x(e,t){let n=globalThis,o=n.CSS?.highlights,r=n.Highlight;if(!o||"function"!=typeof r)return;let i=e[t],a=i?e.filter((e,n)=>n!==t):e;a.length>0?o.set(p,new r(...a)):o.delete(p),i?o.set(h,new r(i)):o.delete(h)}function v(){let e=globalThis.CSS?.highlights;e?.delete(p),e?.delete(h)}function b(e,t,n,o,r,i){let a=(0,f.P)(e,o,r,i);if(!a)return{attributes:{}};let{startOffset:l,endOffset:s}=a,c=e.slice(0,l).split("\n").length,d=e.lastIndexOf("\n",l-1)+1,u=e.slice(0,s).split("\n").length,m=e.lastIndexOf("\n",s-1)+1,p={startLine:String(c),endLine:String(u),startColumn:String(l-d),endColumn:String(s-m),sourceStartOffset:String(l),sourceEndOffset:String(s)};return{targetPath:`${n||t}:${c}-${u}`,attributes:p}}function w(e){let{content:t,testId:n="markdown-view",className:f,fileName:p="Markdown preview",filePath:h,onTextSelectionComment:w,onTextSelectionSend:y,onTextSelectionCommentRemove:k,textSelectionComments:C,textSelectionEditRequest:_,selectionSurface:E="previewer-content",overlayRightInset:S}=e,I=(0,r.useMemo)(()=>t.split("\n"),[t]),M=(0,r.useMemo)(()=>(function(e){let t=[];for(let n=0;n<e.length;n+=300)t.push(e.slice(n,n+300).join("\n"));return t})(I),[I]),N=(0,r.useMemo)(()=>(0,l.my)(h),[h]),B=M.length>1,L=(0,c.vL)(e=>e.fileLineWrapEnabled),[R,O]=(0,r.useState)(1),[j,T]=(0,r.useState)(!1),[A,D]=(0,r.useState)(""),[$,P]=(0,r.useState)(0),[z,H]=(0,r.useState)(0),F=(0,r.useRef)(null),q=(0,r.useRef)([]);(0,r.useEffect)(()=>{O(1)},[t]);let W=B&&R<M.length,U=(0,r.useCallback)(()=>{O(e=>Math.min(e+1,M.length))},[M.length]),V=(0,s.M)({containerRef:F,hasMore:W,onLoadMore:U,rootMargin:"300px"});(0,r.useEffect)(()=>{H(0)},[A,t,R]),(0,r.useLayoutEffect)(()=>{let e=F.current,t=j&&e?function(e,t){let n=t.trim().toLowerCase();if(!n)return[];let o=[],r=document.createTreeWalker(e,NodeFilter.SHOW_TEXT,{acceptNode:e=>!function(e){let t=e.parentElement;return!!t?.closest('[data-scoped-find-ui="true"], [data-preview-text-selection-ui="true"]')}(e)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}),i=r.nextNode();for(;i;){let e=(i.textContent??"").toLowerCase(),t=0;for(;t<=e.length;){let r=e.indexOf(n,t);if(r<0)break;let a=r+n.length,l=document.createRange();l.setStart(i,r),l.setEnd(i,a),o.push(l),t=Math.max(a,r+1)}i=r.nextNode()}return o}(e,A):[];return q.current=t,P(t.length),H(e=>Math.min(e,Math.max(0,t.length-1))),x(t,Math.min(z,Math.max(0,t.length-1))),()=>{j||v()}},[z,t,j,A,R]),(0,r.useEffect)(()=>{if(!j){v();return}let e=q.current[z];e?.startContainer.parentElement?.scrollIntoView({block:"center",inline:"nearest"}),x(q.current,z)},[z,j]),(0,r.useEffect)(()=>v,[]);let K=(0,r.useCallback)(()=>{H(e=>0===$?0:(e+1)%$)},[$]),Q=(0,r.useCallback)(()=>{H(e=>0===$?0:(e-1+$)%$)},[$]),X=(0,r.useCallback)(()=>{d.o.getState().closeSearch(),T(!0)},[]),G=(0,o.jsx)(m.j,{hostRef:F,isOpen:j,query:A,matchCount:$,currentIndex:z,testIdPrefix:"markdown-view",rightInset:S,onOpen:X,onClose:()=>T(!1),onQueryChange:D,onNext:K,onPrevious:Q}),Y=[L?"markdown-view-wrap":"markdown-view-nowrap",f].filter(Boolean).join(" "),J=`markdown-view-container ${i.$L?"markdown-view-container--web":""} relative h-full min-w-0 bg-bg_default_primary text-text_default_primary ${L?"overflow-y-auto overflow-x-hidden":"overflow-auto"}`,Z=S?{"--markdown-view-overlay-right-inset":S}:void 0;return B?(0,o.jsx)(l.Pk,{value:N,children:(0,o.jsxs)("div",{ref:F,className:J,"data-app-shortcut-priority":"text-editor","data-testid":n??void 0,style:Z,children:[(0,o.jsx)("style",{children:g}),G,M.slice(0,R).map((e,t)=>(0,o.jsx)(a.UG,{shiftHeading:0,className:Y,children:e},t)),W&&(0,o.jsx)("div",{ref:V,className:"h-1"}),(0,o.jsx)(u.k4,{hostRef:F,fileName:p,filePath:h,sourceLabel:"markdown-preview",onAddComment:w,onSendComment:y,onRemoveComment:k,commentItems:C,openEditRequest:_,commentVariant:"small",editComposerVariant:"large",selectionSurface:E,getSelectionMetadata:e=>b(t,p,h,e.selectedText,e.markdownStartOffset??e.startOffset,e.markdownOccurrenceIndex),testIdPrefix:"markdown-text-selection"})]})}):(0,o.jsx)(l.Pk,{value:N,children:(0,o.jsxs)("div",{ref:F,className:J,"data-app-shortcut-priority":"text-editor","data-testid":n??void 0,style:Z,children:[(0,o.jsx)("style",{children:g}),G,(0,o.jsx)(a.UG,{shiftHeading:0,className:Y,children:t}),(0,o.jsx)(u.k4,{hostRef:F,fileName:p,filePath:h,sourceLabel:"markdown-preview",onAddComment:w,onSendComment:y,onRemoveComment:k,commentItems:C,openEditRequest:_,commentVariant:"small",editComposerVariant:"large",selectionSurface:E,getSelectionMetadata:e=>b(t,p,h,e.selectedText,e.markdownStartOffset??e.startOffset,e.markdownOccurrenceIndex),testIdPrefix:"markdown-text-selection"})]})})}},34721:function(e,t,n){"use strict";n.d(t,{k4:function(){return D},up:function(){return y}});var o=n(27573),r=n(7653),i=n(3458),a=n(24191),l=n(360),s=n(362),c=n(45734),d=n(54781),u=n(95777),m=n(46511),f=n(51904),p=n(49817),h=n(42940),g=n(26063),x=n(47482);let v=new WeakSet,b=new DOMRect(0,0,0,0);function w(e){let t=2166136261;for(let n=0;n<e.length;n+=1)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return(t>>>0).toString(16).padStart(8,"0")}function y(e){let{candidate:t,fileName:n,filePath:o,sourceLabel:r,commentId:i,contextId:a,feedback:l,metadata:s,selectionSurface:c}=e,d=t.viewportRect;return{schema:"mavis.html_selection.v1",contextId:a,fileName:n,...o?{filePath:o}:{},createdAtMs:Date.now(),selectionMode:"dom_node",selector:r,tagName:"TEXT",text:t.selectedText,attributes:{surface:"text-selection",source:r,...c?{selectionSurface:c}:{},...s?.attributes??{},...void 0!==t.startOffset&&void 0!==t.endOffset?{startOffset:String(t.startOffset),endOffset:String(t.endOffset)}:{},...void 0!==t.markdownStartOffset?{markdownStartOffset:String(t.markdownStartOffset)}:{},...void 0!==t.markdownOccurrenceIndex?{markdownOccurrenceIndex:String(t.markdownOccurrenceIndex)}:{},...void 0!==t.markdownCodeBlockIndex&&void 0!==t.markdownCodeBlockStartOffset&&void 0!==t.markdownCodeBlockEndOffset&&t.markdownCodeBlockFingerprint?{markdownCodeBlockIndex:String(t.markdownCodeBlockIndex),markdownCodeBlockStartOffset:String(t.markdownCodeBlockStartOffset),markdownCodeBlockEndOffset:String(t.markdownCodeBlockEndOffset),markdownCodeBlockFingerprint:t.markdownCodeBlockFingerprint}:{}},rect:{x:d.x,y:d.y,width:d.width,height:d.height},viewport:{width:window.innerWidth,height:window.innerHeight},pageUrl:o||n,targetPath:s?.targetPath||r,commentId:i,feedback:l}}function k(e){if(void 0===e||!/^\d+$/u.test(e))return null;let t=Number(e);return Number.isSafeInteger(t)&&t>=0?t:null}function C(e){if(void 0===e||!/^\d+$/u.test(e))return null;let t=Number(e);return Number.isSafeInteger(t)&&t>0?t:null}function _(e){let t=/:(\d+)(?:-(\d+))?$/u.exec(e.targetPath.trim());if(t){let e=Number(t[1]),n=Number(t[2]??t[1]);if(Number.isFinite(e)&&Number.isFinite(n)&&e>0&&n>0){let t=Math.floor(e),o=Math.floor(n);return[Math.min(t,o),Math.max(t,o)]}}let n=C(e.attributes.startLine);if(null===n)return null;let o=C(e.attributes.endLine)??n;return[Math.min(n,o),Math.max(n,o)]}function E(e,t){let n=_(t);if(!n)return null;let[o,r]=n,i=e.querySelector(`.code-view-row[data-line='${o}']`),a=e.querySelector(`.code-view-row[data-line='${r}']`);if(!i||!a)return null;let l=Array.from(e.querySelectorAll(".code-view-row")).filter(e=>{let t=Number(e.dataset.line);return Number.isInteger(t)&&t>=o&&t<=r});if(0===l.length)return null;let s=k(t.attributes.startColumn),c=k(t.attributes.endColumn);if(null!==s&&null!==c){let e=i.querySelector(".code-view-line-content")??i,t=a.querySelector(".code-view-line-content")??a,n=(0,u.oW)(e,s,s+1),o=(0,u.oW)(t,Math.max(0,c-1),c);if(n&&o){let e=document.createRange();try{return e.setStart(n.startContainer,n.startOffset),e.setEnd(o.endContainer,o.endOffset),e}catch{}}}let d=[];for(let e of l){let t=e.querySelector(".code-view-line-content")??e,n=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),o=[],r=n.nextNode();for(;r;)o.push(r),r=n.nextNode();o.length>0&&d.push(o)}if(0===d.length)return null;let m=[],f=d.map((e,t)=>{let n=e.map(e=>e.nodeValue??"").join("");for(let t of e){let e=t.nodeValue??"";for(let n=0;n<e.length;n+=1)m.push({node:t,offset:n})}return t<d.length-1&&m.push(null),n}).join("\n"),p=t.text.replace(/\r\n/gu,"\n"),h=e=>e.replace(/\s+/gu,""),g=h(f),x=h(p);if(!x)return null;let v=g.indexOf(x);if(v<0)return null;let b=[];for(let e=0;e<f.length;e+=1)/\s/u.test(f[e]??"")||b.push(e);let w=b[v],y=b[v+x.length-1];if(void 0===w||void 0===y)return null;let C=m[w],E=m[y];if(!C||!E)return null;let S=document.createRange();try{return S.setStart(C.node,C.offset),S.setEnd(E.node,E.offset+1),S}catch{return null}}function S(e){return(0,x.V)(e).trim()}function I(e){return Array.from(new Set([e.trim(),S(e)])).filter(Boolean)}function M(e){return S(e).replace(/\s+/gu,"")}function N(e,t){let n=[],o=[];e.forEach((t,r)=>{let i=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),a=i.nextNode(),l="";for(;a;){let e=a.nodeValue??"";l+=e;for(let t=0;t<e.length;t+=1)n.push({node:a,offset:t});a=i.nextNode()}o.push(l),r<e.length-1&&n.push(null)});let r=o.join("\n"),i=r.replace(/\s+/gu,""),a=[];for(let e=0;e<r.length;e+=1)/\s/u.test(r[e]??"")||a.push(e);for(let e of I(t)){let t=e.replace(/\s+/gu,"");if(!t)continue;let o=i.indexOf(t);if(o<0||i.indexOf(t,o+t.length)>=0)continue;let r=n[a[o]??-1],l=n[a[o+t.length-1]??-1];if(!r||!l)continue;let s=document.createRange();try{return s.setStart(r.node,r.offset),s.setEnd(l.node,l.offset+1),s}catch{continue}}return null}function B(e,t){if(_(t)&&e.querySelector(".code-view-row"))return E(e,t);let n=t.text,o=function(e){let t=Array.from(e.querySelectorAll(".matrix-markdown"));return t.length>0?t:[e]}(e),r=function(e,t){let n=k(t.attributes.markdownCodeBlockIndex),o=k(t.attributes.markdownCodeBlockStartOffset),r=k(t.attributes.markdownCodeBlockEndOffset);if(null===n||null===o||null===r||r<=o)return null;let i=e.querySelectorAll(".codeblock-code")[n];if(!i)return null;let a=t.attributes.markdownCodeBlockFingerprint;if(!a||w((0,u.ti)(i))===a){let e=(0,u.oW)(i,o,r);if(e){let n=M(t.text),o=M(e.toString());if(n&&o===n)return e}}return N([i],t.text)}(e,t);if(r)return r;if(void 0!==t.attributes.markdownCodeBlockIndex)return null;if(n){let e=N(o,n);if(e)return e;let t=o.flatMap(e=>{let t=(0,u.ti)(e),o=t.indexOf(n);if(o<0||t.indexOf(n,o+n.length)>=0)return[];let r=(0,u.oW)(e,o,o+n.length);return r?[r]:[]});if(1===t.length)return t[0]??null;for(let e of I(n)){if(e===n)continue;let t=o.flatMap(t=>{let n=(0,u.ti)(t),o=n.indexOf(e);if(o<0||n.indexOf(e,o+e.length)>=0)return[];let r=(0,u.oW)(t,o,o+e.length);return r?[r]:[]});if(1===t.length)return t[0]??null}}if(!n)return null;let i=o.flatMap(e=>{let t=(0,u.ti)(e),o=t.indexOf(n);if(o<0||t.indexOf(n,o+n.length)>=0)return[];let r=(0,u.oW)(e,o,o+n.length);return r?[r]:[]});return 1===i.length?i[0]??null:null}function L(e){return"edit"===e.attributes.intent||"edit"===e.attributes.requestedAction||"edit"===e.attributes.sourceAction}function R(e){return!!(e&&("stored-comment"===e.source||L(e.item)))}function O(e){return e instanceof Element?e:e.parentElement}function j(e,t){let n=O(e.startContainer)?.closest(".codeblock-code"),o=O(e.endContainer)?.closest(".codeblock-code");return!!(n&&n===o&&t.contains(n))}function T(e){let{hostRef:t,targets:n,activeContextId:a,testIdPrefix:l}=e,[s,c]=(0,r.useState)([]);(0,r.useEffect)(()=>{let e=t.current;if(!e)return;let o=()=>{let t=e.getBoundingClientRect(),o=[];for(let r of n)r.contextId!==a&&(r.resolveRanges?.()??(()=>{let e=r.resolveRange();return e?[e]:[]})()).forEach((n,i)=>{j(n,e)&&Array.from(n.getClientRects()).forEach(n=>{n.width<=0||n.height<=0||o.push({contextId:r.contextId,rangeIndex:i,left:n.left-t.left+e.scrollLeft,top:n.bottom-t.top+e.scrollTop-1,width:n.width})})});c(o)};o();let r=0,i=()=>{r||(r=window.requestAnimationFrame(()=>{r=0,o()}))};window.addEventListener("resize",i,{passive:!0}),window.addEventListener("scroll",i,{passive:!0,capture:!0});let l="undefined"==typeof ResizeObserver?null:new ResizeObserver(i);l?.observe(e);let s="undefined"==typeof MutationObserver?null:new MutationObserver(i);return s?.observe(e,{childList:!0,subtree:!0,characterData:!0}),()=>{r&&window.cancelAnimationFrame(r),window.removeEventListener("resize",i),window.removeEventListener("scroll",i,{capture:!0}),l?.disconnect(),s?.disconnect()}},[a,t,n]);let d=t.current;return d&&0!==s.length&&"undefined"!=typeof document?(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true",className:"pointer-events-none absolute inset-0","aria-hidden":"true",children:s.map((e,t)=>(0,o.jsx)("span",{"data-testid":`${l}-code-underline-${e.contextId}-${t}`,className:"absolute rounded-full bg-border_accent",style:{left:Math.round(e.left),top:Math.round(e.top),width:Math.round(e.width),height:1}},`${e.contextId}-${e.rangeIndex}-${t}`))}),d):null}function A(e){let{candidate:t,host:n,bottomInset:l,onAdd:c,canAdd:d=!0,onCopy:u,testIdPrefix:m}=e,p=(0,r.useRef)(null),[h,g]=(0,r.useState)(170),[x,v]=(0,r.useState)(0);(0,r.useLayoutEffect)(()=>{let e=p.current;if(!e)return;let t=()=>{let t=Math.ceil(e.getBoundingClientRect().width);t>0&&g(e=>e===t?e:t),v(e=>e+1)};t(),window.addEventListener("resize",t,{passive:!0});let o="undefined"==typeof ResizeObserver?null:new ResizeObserver(t);return o?.observe(e),n&&o?.observe(n),()=>{window.removeEventListener("resize",t),o?.disconnect()}},[n]);let b=(0,r.useMemo)(()=>(0,s.D5)(t.buttonAnchorRect,n,h,t.selectionBottom,l,t.buttonReleaseAlignment),[l,t.buttonAnchorRect,t.buttonReleaseAlignment,t.selectionBottom,n,x,h]);return"undefined"==typeof document?null:(0,i.createPortal)((0,o.jsx)(a.X,{ref:p,"data-preview-text-selection-ui":"true","data-testid":`${m}-toolbar`,style:b,className:"desktop-text-ui-small-strong",aiLabel:(0,f.t)("chat_selection.add_to_chat"),onAsk:d?c:void 0,primaryButtonProps:{"aria-keyshortcuts":"Tab","data-chat-selection-add-button":"true","data-testid":`${m}-add-to-task`},children:(0,o.jsx)("button",{type:"button","data-testid":`${m}-copy`,onClick:e=>{e.preventDefault(),e.stopPropagation(),u()},children:(0,f.t)("common.copy")})}),n??document.body)}function D(e){let{hostRef:t,externalSelection:n,fileName:a,filePath:s,sourceLabel:x="preview-text-selection",enabled:k=!0,onAddComment:C,onSendComment:S,onRemoveComment:I,commentItems:M,showCommentAnchors:N=!0,showCommentHighlights:D=!0,commentHighlightNames:$=m.GC,selectionSurface:P,openEditRequest:z,enableEditAction:H=!1,commentVariant:F="small",editComposerVariant:q,keepComposerOpenOnSubmit:W="large"===F,getSelectionMetadata:U,composerPlacement:V="floating",editComposerPlacement:K,getInlineComposerHost:Q,onOpenComposerChange:X,onTextSelectionEditComposerChange:G,renderComposer:Y,bottomInset:J=0,testIdPrefix:Z="preview-text-selection"}=e,[ee,et]=(0,r.useState)(null),[en,eo]=(0,r.useState)(null);(0,r.useEffect)(()=>{void 0!==n&&et(n)},[n]);let er=(0,r.useRef)(0),ei=(0,r.useRef)(new Set),ea=(0,r.useRef)(null),el=(0,r.useMemo)(()=>(M??[]).filter(e=>!P||e.attributes.selectionSurface===P||!e.attributes.selectionSurface&&e.attributes.source===x),[M,P,x]),es=(0,r.useMemo)(()=>"inline"===V?el.filter(L):[],[V,el]),ec=R(en),ed=ec?q??F:F,eu="large"===ed?en?.item.contextId??es[0]?.contextId??null:null,em=(0,r.useMemo)(()=>{let e=[...el];en&&e.push(en.item),"inline"===V&&e.push(...es);let t=new Set;return e.filter(e=>!t.has(e.contextId)&&(t.add(e.contextId),!0))},[V,es,en,el]),ef=(0,r.useMemo)(()=>em.map(e=>({contextId:e.contextId,resolveRange:()=>{let n=t.current;return n?B(n,e):null},...$.stored===m.GC.stored?{shouldPaintStoredRange:e=>{let n=t.current;return!n||!j(e,n)}}:{},..._(e)?{resolveRanges:()=>{let n=t.current;if(!n)return[];if(n.querySelector(".code-view-row"))return function(e,t){let n=E(e,t);return n?Array.from(e.querySelectorAll(".code-view-row")).filter(e=>{let n=Number(e.dataset.line),[o,r]=_(t)??[0,0];return Number.isInteger(n)&&n>=o&&n<=r}).flatMap(e=>{let t=e.querySelector(".code-view-line-content");if(!t)return[];let o=document.createRange();o.selectNodeContents(t);let r=document.createRange();try{let e=n.compareBoundaryPoints(Range.START_TO_START,o)>0?n.startContainer:o.startContainer,t=e===n.startContainer?n.startOffset:o.startOffset,i=0>n.compareBoundaryPoints(Range.END_TO_END,o)?n.endContainer:o.endContainer,a=i===n.endContainer?n.endOffset:o.endOffset;return r.setStart(e,t),r.setEnd(i,a),r.collapsed?[]:[r]}catch{return[]}}):[]}(n,e);let o=B(n,e);return o?[o]:[]}}:{}})),[$.stored,em,t]),ep=(0,r.useMemo)(()=>el.map((e,n)=>({contextId:e.contextId,referenceNumber:n+1,quotedText:e.text,comment:e.feedback,selectionKind:"text-range",value:e,resolveRange:()=>{let n=t.current;return n?B(n,e):null},resolveElement:()=>{let n=t.current;if(!n)return null;let[o,r]=_(e)??[],i=r??o;return i?n.querySelector(`.code-view-row[data-line='${i}']`):null}})),[t,el]),eh=(0,r.useMemo)(()=>D||$!==m.GC?ef:ef.filter(e=>e.contextId===eu),[eu,$,ef,D]);(0,m.QR)(eh,eu,$);let eg=(0,r.useCallback)(()=>{window.getSelection?.()?.removeAllRanges()},[]),ex=(0,r.useCallback)(async()=>{if(!ee)return;let e=await (0,h.v)(ee.selectedText);p.useToastStore.getState().addToast(e?"success":"error",e?(0,f.t)("copied"):(0,f.t)("chat_panel.copy_failed")),et(null),eg()},[ee,eg]),ev=(0,r.useCallback)(e=>{if(!ee||!C)return;let t=ee.metadata??U?.(ee),n=er.current+1;er.current=n;let o=`text-selection-${(s||a).replace(/[^a-zA-Z0-9_-]+/gu,"-").replace(/^-+|-+$/gu,"").slice(0,80)||"text"}-${function(){try{return crypto.randomUUID()}catch{return`${Date.now()}-${Math.random().toString(36).slice(2)}`}}()}`,r=y({candidate:ee,fileName:a,...s?{filePath:s}:{},sourceLabel:x,commentId:n,contextId:o,feedback:"",...P?{selectionSurface:P}:{},metadata:{...t??{},attributes:{...t?.attributes??{},..."edit"===e?{intent:"edit",requestedAction:"edit",sourceAction:"edit"}:{}}}});"edit"===e&&G?.(!0),C(r),eo({item:r,anchorRect:ee.composerAnchorRect??ee.viewportRect,source:"selection"}),et(null),eg()},[ee,eg,a,s,U,C,G,P,x]),eb=(0,r.useCallback)(()=>ev("comment"),[ev]);(0,r.useEffect)(()=>{if(!ee)return;let e=e=>{if("Tab"!==e.key||e.shiftKey||e.metaKey||e.ctrlKey||e.altKey||e.isComposing||e.repeat)return;let n=t.current?.querySelector('[data-chat-selection-add-button="true"]');n&&"hidden"!==window.getComputedStyle(n).visibility&&(e.preventDefault(),e.stopPropagation(),eb())};return document.addEventListener("keydown",e,!0),()=>document.removeEventListener("keydown",e,!0)},[ee,eb,t]);let ew=(0,r.useCallback)(function(e){let n=arguments.length>1&&void 0!==arguments[1]&&arguments[1];if(!n&&L(e))return;let o=t.current,r=o?B(o,e):null,{x:i,y:a,width:l,height:s}=e.rect;et(null),eo({item:e,anchorRect:r?function(e){let t=e.getClientRects();return t[t.length-1]??e.getBoundingClientRect()}(r):new DOMRect(i,a,l,s),source:"stored-comment"})},[t]),ey=(0,r.useCallback)(e=>{if(!en||!C)return;let t=(0,g.Sb)({...en.item,createdAtMs:en.item.createdAtMs},e);if(L(t)&&S){C(t),S(t),eo(null);return}C(t),W?eo(t=>t&&t.item.contextId===en.item.contextId?{...t,item:{...t.item,feedback:e}}:t):eo(null)},[W,C,S,en]),ek=(0,r.useCallback)(()=>{en&&(I?.(en.item.contextId),eo(null))},[I,en]),eC=(0,r.useCallback)(()=>{if(!en)return;let e=R(en),t=e?q??F:F;"selection"===en.source&&("large"===t||e)&&!en.item.feedback.trim()&&I?.(en.item.contextId),eo(null)},[F,q,I,en]),e_=(0,r.useCallback)(e=>{if(!en||!C||!S)return;let t=(0,g.Sb)({...en.item,createdAtMs:en.item.createdAtMs},e);C(t),S(t),eo(null)},[C,S,en]);(0,r.useLayoutEffect)(()=>{X?.(en?.item??null)},[X,en?.item]),(0,r.useEffect)(()=>{en||G?.(!1)},[G,en]),(0,r.useEffect)(()=>{if(!z||ea.current===z.token)return;let e=M?.find(e=>e.contextId===z.contextId);e&&(ea.current=z.token,!v.has(z)&&(v.add(z),1)&&ew(e,!0))},[M,ew,z]),(0,r.useEffect)(()=>{let e=en?.item.contextId;if(e&&M){if(M.some(t=>t.contextId===e)){ei.current.add(e);return}ei.current.has(e)&&(eo(t=>t?.item.contextId===e?null:t),ei.current.delete(e))}},[M,en?.item.contextId]),(0,r.useEffect)(()=>{if(void 0!==n||!k||!C)return;let e=!1,o=!1,r=null,i=e=>et(e),a=()=>{let e=t.current;e&&i(function(e){let t=window.getSelection?.();if(!t||0===t.rangeCount||t.isCollapsed)return null;let n=t.toString(),o=n.trim();if(!o)return null;let r=t.getRangeAt(t.rangeCount-1);if(!function(e,t){try{return e.intersectsNode(t)}catch{return t.contains(e.commonAncestorContainer)}}(r,e))return null;let i=r.getBoundingClientRect(),a=Array.from(r.getClientRects()).filter(e=>e.width>0||e.height>0),l=a[0]??i,s=a[a.length-1]??i;if(s.width<=0&&s.height<=0||i.width<=0&&i.height<=0)return null;let c=e.getBoundingClientRect(),d=Math.max(0,c.top),m=Math.min(window.innerHeight,c.bottom),f=a.filter(e=>e.bottom>d&&e.top<m),p=(0,u.p4)(t),h=("start"===p?f[0]:f[f.length-1])??s;if(h.bottom<=d||h.top>=m)return null;let g=n.length-n.trimStart().length,x=n.length-n.trimEnd().length,v=(0,u.c4)(e,r.startContainer,r.startOffset),b=(0,u.c4)(e,r.endContainer,r.endOffset),y=function(e,t,n){let o=Array.from(e.querySelectorAll(".matrix-markdown")),r=0;for(let e of o){if(e===t||e.contains(t)){let o=(0,u.c4)(e,t,n);return o<0?-1:r+o}r+=(0,u.ti)(e).length+1}return -1}(e,r.startContainer,r.startOffset),k=v<0?-1:v+g,C=b<0?-1:b-x,_=y<0?-1:y+g,E=function(e,t,n){if(n<0)return;let o=Array.from(e.querySelectorAll(".matrix-markdown")).map(u.ti).join("\n"),r=t.replace(/\s+/gu,"");if(!r)return;let i="",a=0;for(let e=0;e<o.length;e+=1){let t=o[e]??"";/\s/u.test(t)||(e<n&&(a+=1),i+=t)}let l=[],s=0;for(;s<=i.length-r.length;){let e=i.indexOf(r,s);if(e<0)break;l.push(e),s=e+Math.max(1,r.length)}if(0===l.length)return;let c=0,d=Math.abs((l[0]??0)-a);for(let e=1;e<l.length;e+=1){let t=Math.abs((l[e]??0)-a);t>=d||(c=e,d=t)}return c}(e,o,_),S=O(r.startContainer)?.closest(".codeblock-code"),I=O(r.endContainer)?.closest(".codeblock-code"),M=Array.from(e.querySelectorAll(".codeblock-code")),N=S?M.indexOf(S):-1,B=S?(0,u.c4)(S,r.startContainer,r.startOffset):-1,L=S?(0,u.c4)(S,r.endContainer,r.endOffset):-1,R=B<0?-1:B+g,j=L<0?-1:L-x,T=!!(S&&S===I&&N>=0&&R>=0&&j>R);return{selectedText:o,anchorRect:s,buttonAnchorRect:h,buttonReleaseAlignment:p,composerAnchorRect:l,selectionBottom:Math.max(...(f.length>0?f:[h]).map(e=>e.bottom)),viewportRect:i,...k>=0&&C>k?{startOffset:k,endOffset:C}:{},..._>=0?{markdownStartOffset:_}:{},...void 0!==E?{markdownOccurrenceIndex:E}:{},...T&&S?{markdownCodeBlockIndex:N,markdownCodeBlockStartOffset:R,markdownCodeBlockEndOffset:j,markdownCodeBlockFingerprint:w((0,u.ti)(S))}:{}}}(e))},l=()=>{null!==r&&window.clearTimeout(r),r=window.setTimeout(()=>{r=null,e&&(e=!1,o=!1,a())},0)},s=()=>{e=!0,o&&l()},c=()=>{o=!0,l()},d=e=>{let t=e?.target;t instanceof HTMLElement&&t.closest('[data-preview-text-selection-ui="true"], [data-chat-selection-ui="true"]')||(null!==r&&(window.clearTimeout(r),r=null),o=!1,i(null),"small"===(R(en)?q??F:F)&&(en&&L(en.item)&&!en.item.feedback.trim()&&I?.(en.item.contextId),eo(null)))},m=e=>{let n=t.current,o=e.target;(o===e.currentTarget||n&&o instanceof Node&&(n.contains(o)||o.contains(n)))&&d(e)},f=e=>{"Escape"===e.key&&(null!==r&&(window.clearTimeout(r),r=null),o=!1,i(null),eo(null))};return document.addEventListener("selectionchange",s),document.addEventListener("mouseup",c),document.addEventListener("touchend",c),document.addEventListener("keyup",c),document.addEventListener("mousedown",d),window.addEventListener("resize",d),window.addEventListener("scroll",m,!0),document.addEventListener("keydown",f),()=>{null!==r&&window.clearTimeout(r),document.removeEventListener("selectionchange",s),document.removeEventListener("mouseup",c),document.removeEventListener("touchend",c),document.removeEventListener("keyup",c),document.removeEventListener("mousedown",d),window.removeEventListener("resize",d),window.removeEventListener("scroll",m,!0),document.removeEventListener("keydown",f)}},[F,q,n,k,t,C,I,en]);let eE=ec?K??V:V,eS="inline"===eE&&en?Q?.(en.item)??null:t.current,eI=(0,r.useMemo)(()=>{if("inline"!==eE)return(0,c.p)(en?.anchorRect??b,ed,eS,J)},[J,eS,eE,ed,en?.anchorRect]),eM=ec?`chat-selection-composer-${en?.item.contextId??"unknown"}`:`${Z}-comment`,eN=ec?`chat-selection-composer-container-${en?.item.contextId??"unknown"}`:`${Z}-composer`,eB=Y&&eE===V&&ed===F;return k&&(C||void 0!==n)?(0,o.jsxs)(o.Fragment,{children:[N?(0,o.jsx)(d.V,{items:ep,onOpenEdit:ew,activeContextId:eu,hostRef:t,anchorSurface:"html-preview",testIdPrefix:`${Z}-badge`,selectionUiAttribute:"data-preview-text-selection-ui",selectionUi:!0}):null,D&&$.stored===m.GC.stored?(0,o.jsx)(T,{hostRef:t,targets:eh,activeContextId:eu,testIdPrefix:Z}):null,ee?(0,o.jsx)(A,{candidate:ee,host:t.current,bottomInset:J,onAdd:eb,canAdd:!!C,onCopy:ex,testIdPrefix:Z}):null,en&&eS?(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true","data-testid":eN,style:eI,className:"inline"===eE?"markdown-text-selection-comment-wrapper w-full":void 0,children:eB?Y({item:en.item,onSubmit:ey,...S?{onSend:e_}:{},onCancel:eC,...I?{onDelete:ek}:{},testIdPrefix:eM}):(0,o.jsx)(l.m,{anchorContext:{surface:"html-preview",contextId:en.item.contextId,selectionKind:"text-range"},variant:ed,initialValue:en.item.feedback,onSubmit:ey,onSend:S?e_:void 0,onCancel:eC,onDelete:I?ek:void 0,testIdPrefix:eM})},en.item.contextId),eS):null]}):null}},8770:function(e,t,n){"use strict";n.d(t,{j:function(){return a}});var o=n(27573),r=n(7653),i=n(51904);function a(e){let{hostRef:t,isOpen:n,query:a,matchCount:l,currentIndex:s,testIdPrefix:c,rightInset:d,onOpen:u,onClose:m,onQueryChange:f,onNext:p,onPrevious:h}=e,g=(0,r.useRef)(null),x=(0,r.useRef)(null),v=(0,r.useRef)(!1);(0,r.useEffect)(()=>{let e=e=>{let n=t.current;v.current=!!(n&&e.target instanceof Node&&n.contains(e.target))},o=e=>{let o=e.target,r=o instanceof Node&&!!g.current?.contains(o);if((e.metaKey||e.ctrlKey)&&"f"===e.key.toLowerCase()){let n=t.current,i=n&&o instanceof Node&&n.contains(o);if(!r&&!i&&!v.current||!r&&function(e){if(!(e instanceof HTMLElement))return!1;let t=e.tagName.toLowerCase();return e.isContentEditable||"input"===t||"textarea"===t||"select"===t}(o))return;e.preventDefault(),e.stopPropagation(),u();return}n&&r&&"Escape"===e.key&&(e.preventDefault(),e.stopPropagation(),m())};return window.addEventListener("pointerdown",e,!0),window.addEventListener("keydown",o,!0),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("keydown",o,!0)}},[t,n,m,u]),(0,r.useEffect)(()=>{n&&window.requestAnimationFrame(()=>{x.current?.focus(),x.current?.select()})},[n]);let b=(0,r.useCallback)(e=>{"Enter"===e.key&&(e.preventDefault(),e.shiftKey?h():p())},[p,h]);if(!n)return null;let w=a&&l>0?s+1:0,y=0===l;return(0,o.jsxs)("div",{ref:g,"data-scoped-find-ui":"true","data-app-shortcut-priority":"text-editor","data-testid":`${c}-find-bar`,className:"desktop-text-ui-small absolute top-5 z-[7] flex w-[240px] max-w-[calc(100%-40px)] flex-col overflow-hidden rounded-[14px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated text-[13px] text-text_default_primary shadow-[0_8px_28px_rgba(10,10,10,0.12)]",style:d?{right:`calc(1.25rem + ${d})`}:{right:"1.25rem"},onMouseDown:e=>e.stopPropagation(),children:[(0,o.jsxs)("div",{className:"flex h-10 items-center gap-2 px-3",children:[(0,o.jsx)("span",{"aria-hidden":"true",className:"text-[17px] leading-none text-text_default_secondary",children:"⌕"}),(0,o.jsx)("input",{ref:x,"data-testid":`${c}-find-input`,value:a,placeholder:(0,i.t)("file_panel.find_placeholder"),"aria-label":(0,i.t)("file_panel.find_label"),onChange:e=>f(e.target.value),onKeyDown:b,className:"desktop-text-ui-body h-8 min-w-0 flex-1 bg-transparent text-[15px] leading-5 text-text_default_primary outline-none placeholder:text-text_default_tertiary"}),(0,o.jsx)("div",{className:"h-5 w-[0.5px] bg-border_default"}),(0,o.jsx)("button",{type:"button","data-testid":`${c}-find-close`,"aria-label":(0,i.t)("file_panel.find_close"),onClick:m,className:"h-7 w-7 rounded-md text-[22px] leading-none text-text_default_secondary hover:bg-bg_interaction_tertiary_hover",children:"\xd7"})]}),(0,o.jsxs)("div",{className:"flex h-9 items-center border-t-[0.5px] border-border_default px-3 text-text_default_secondary",children:[(0,o.jsxs)("div",{className:"flex items-center gap-1",children:[(0,o.jsx)("button",{type:"button","data-testid":`${c}-find-previous`,"aria-label":(0,i.t)("file_panel.find_previous"),disabled:y,onClick:h,className:"h-7 w-7 rounded-md text-[20px] leading-none hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",children:"↑"}),(0,o.jsx)("button",{type:"button","data-testid":`${c}-find-next`,"aria-label":(0,i.t)("file_panel.find_next"),disabled:y,onClick:p,className:"h-7 w-7 rounded-md text-[20px] leading-none hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",children:"↓"})]}),(0,o.jsxs)("span",{"data-testid":`${c}-find-results`,className:"ml-auto whitespace-nowrap",children:[w," / ",l," ",(0,i.t)("file_panel.find_results")]})]})]})}},26063:function(e,t,n){"use strict";n.d(t,{mE:function(){return c},fw:function(){return v},Z:function(){return b},Sb:function(){return m},t_:function(){return f},se:function(){return g}});var o=n(7653),r=n(13920),i=n(51459);function a(e,t){return(0,r.uS)((0,o.createElement)(e,{size:t}))}let l={close:a(i.Tw,18),confirm:a(i.cv,18),delete:a(i.pJ,18)};var s=n(99377);let c="mavis-html-selection",d="commentState",u="completed";function m(e,t){return{...e,feedback:t,attributes:{...e.attributes,[d]:u}}}function f(e){return!!e.feedback.trim()||e.attributes[d]===u}function p(e){return null!==e&&"object"==typeof e}function h(e){var t,n;return!!p(e)&&"string"==typeof e.selector&&"string"==typeof e.tagName&&"string"==typeof e.text&&p(e.attributes)&&!!p(t=e.rect)&&"number"==typeof t.x&&"number"==typeof t.y&&"number"==typeof t.width&&"number"==typeof t.height&&!!p(n=e.viewport)&&"number"==typeof n.width&&"number"==typeof n.height&&"string"==typeof e.pageUrl&&"string"==typeof e.targetPath}function g(e,t){var n,o,r;if(!p(e)||e.source!==c||"string"!=typeof e.token||e.token!==t)return null;if("ready"===e.type)return{source:c,token:e.token,type:"ready",payload:p(e.payload)?{enabled:"boolean"==typeof e.payload.enabled?e.payload.enabled:void 0}:void 0};if("element-selected"===e.type&&h(e.payload))return{source:c,token:e.token,type:"element-selected",payload:e.payload};if("comment-added"===e.type&&h(n=e.payload)&&"number"==typeof n.commentId&&"string"==typeof n.feedback&&(!("screenshotDataUrl"in n)||"string"==typeof n.screenshotDataUrl)&&(!("screenshotFileName"in n)||"string"==typeof n.screenshotFileName))return{source:c,token:e.token,type:"comment-added",payload:e.payload};if("comment-removed"===e.type&&p(o=e.payload)&&"number"==typeof o.commentId)return{source:c,token:e.token,type:"comment-removed",payload:e.payload};if("draft-changed"===e.type&&(null===e.payload||p(r=e.payload)&&h(r.selection)&&"string"==typeof r.feedback&&(void 0===r.commentId||Number.isSafeInteger(r.commentId)&&Number(r.commentId)>0)))return{source:c,token:e.token,type:"draft-changed",payload:e.payload};if("draft-restore-failed"===e.type&&p(e.payload)&&("target-missing"===e.payload.reason||"comment-missing"===e.payload.reason))return{source:c,token:e.token,type:"draft-restore-failed",payload:{reason:e.payload.reason}};if("diagnostic"===e.type){let t=function(e){if(!p(e)||"page-control-event"!==e.event||"string"!=typeof e.eventType)return null;let t=t=>"string"==typeof e[t]?String(e[t]).slice(0,80):null,n=t=>"boolean"==typeof e[t]?!!e[t]:null,o=t=>"number"==typeof e[t]&&Number.isFinite(e[t])?Number(e[t]):null;return{event:"page-control-event",eventType:e.eventType.slice(0,80),eventPhase:o("eventPhase"),defaultPrevented:n("defaultPrevented")??!1,propagationStopped:n("propagationStopped")??!1,selectionModeEnabled:n("selectionModeEnabled")??!1,targetTag:t("targetTag"),targetInputType:t("targetInputType"),targetRole:t("targetRole"),targetDisabled:n("targetDisabled"),targetHasPointerCapture:n("targetHasPointerCapture"),button:o("button"),buttons:o("buttons"),pointerType:t("pointerType"),ts:o("ts")??0}}(e.payload);return t?{source:c,token:e.token,type:"diagnostic",payload:t}:null}return null}let x=`(() => {
  const source = '${c}';
  const bridgeToken = __MAVIS_HTML_SELECTION_BRIDGE_TOKEN__;
  const bridgeIcons = ${JSON.stringify(l)};
  const composerTokens = ${JSON.stringify(s.D)};
  const markerColor = composerTokens.markerColor;
  if (window.__mavisHtmlSelectionBridgeInstalled) return;
  window.__mavisHtmlSelectionBridgeInstalled = true;
  if (document.currentScript && document.currentScript.parentNode) document.currentScript.remove();

  let enabled = false;
  // Canvas opts in: ordinary Previewer keeps its existing composer lifecycle.
  let preserveDraft = false;
  let draft = null;
  let hovered = null;
  let hoverBox = null;
  let activeElement = null;
  let activeBox = null;
  let composer = null;
  let placeholder = 'Add comment...';
  let commentSeq = 0;
  const comments = [];
  // commentIds the bridge has locally removed but whose deletion has not yet
  // round-tripped through the host. If a stale seed-comments message arrives
  // with one of these ids before the host confirms the delete, we must NOT
  // re-create the marker — otherwise the user has to click Delete twice (the
  // first click splices locally and posts comment-removed, the second only
  // succeeds after the host has actually pruned the seed list).
  const pendingHostRemovalIds = new Set();
  // Stable internal id stays on each comment. The number you see on the
  // marker is purely a display index — comments are sorted by commentId and
  // the badge shows their 1-based position. After deleting one, the rest
  // automatically renumber from 1, but contextIds / store keys / screenshot
  // file names stay stable so any in-flight round-trip keeps lining up.
  const relabelMarkers = () => {
    const sorted = comments.slice().sort((a, b) => a.commentId - b.commentId);
    sorted.forEach((c, idx) => {
      if (!c.marker) return;
      const numberNode = c.marker.querySelector('[data-mavis-html-selection-marker-number]');
      if (numberNode) numberNode.textContent = String(idx + 1);
      c.displayIndex = idx + 1;
    });
  };


  const round = (value) => Math.round(value * 100) / 100;
  const toArray = (value) => Array.prototype.slice.call(value || []);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  };

  const isBridgeUi = (target) => Boolean(target.closest && target.closest('[data-mavis-html-selection-ui]'));

  const ensureBox = (kind) => {
    const existing = kind === 'hover' ? hoverBox : activeBox;
    if (existing) return existing;
    const box = document.createElement('div');
    box.setAttribute('data-mavis-html-selection-ui', 'true');
    box.setAttribute('data-mavis-html-selection-box', kind);
    box.style.position = 'fixed';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.display = 'none';
    box.style.zIndex = kind === 'hover' ? '2147483644' : '2147483645';
    box.style.border = '2px solid ' + markerColor;
    box.style.background = kind === 'hover' ? 'rgba(10, 132, 255, 0.08)' : 'rgba(10, 132, 255, 0.16)';
    box.style.borderRadius = '0';
    box.style.boxShadow = kind === 'hover' ? 'none' : '0 18px 48px rgba(15,23,42,0.16)';
    document.documentElement.appendChild(box);
    if (kind === 'hover') hoverBox = box;
    else activeBox = box;
    return box;
  };

  const createCommentBox = () => {
    const box = document.createElement('div');
    box.setAttribute('data-mavis-html-selection-ui', 'true');
    box.setAttribute('data-mavis-html-selection-box', 'comment');
    box.style.position = 'fixed';
    box.style.pointerEvents = 'none';
    box.style.boxSizing = 'border-box';
    box.style.display = 'none';
    box.style.zIndex = '2147483645';
    box.style.border = '2px solid ' + markerColor;
    box.style.background = 'rgba(10, 132, 255, 0.16)';
    box.style.borderRadius = '0';
    box.style.boxShadow = '0 18px 48px rgba(15,23,42,0.16)';
    document.documentElement.appendChild(box);
    return box;
  };

  const updateBox = (box, element) => {
    if (!box || !element || !document.documentElement.contains(element)) {
      if (box) box.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      box.style.display = 'none';
      return;
    }
    // Outset the highlight slightly so the blue border sits outside the element's
    // own border/glow edge instead of leaving a thin gap (the "white line") around it.
    const outset = 2;
    const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
    const rawLeft = rect.left - outset;
    const rawTop = rect.top - outset;
    const rawRight = rect.right + outset;
    const rawBottom = rect.bottom + outset;
    const left = clamp(rawLeft, 0, viewportWidth);
    const top = clamp(rawTop, 0, viewportHeight);
    const right = clamp(rawRight, 0, viewportWidth);
    const bottom = clamp(rawBottom, 0, viewportHeight);
    if (right <= left || bottom <= top) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = right - left + 'px';
    box.style.height = bottom - top + 'px';
  };

  const selectorFor = (element) => {
    if (element.id) return '#' + cssEscape(element.id);
    const stableAttrs = ['data-testid', 'data-test-id', 'aria-label', 'name'];
    for (const attr of stableAttrs) {
      const value = element.getAttribute(attr);
      if (value) return element.tagName.toLowerCase() + '[' + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
    }

    const parts = [];
    let node = element;
    while (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node !== document.documentElement &&
      node !== document.body &&
      parts.length < 5
    ) {
      let part = node.tagName.toLowerCase();
      const classNames = toArray(node.classList)
        .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
        .slice(0, 2);
      if (classNames.length > 0) part += '.' + classNames.map(cssEscape).join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = toArray(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.length > 0 ? 'html > body > ' + parts.join(' > ') : element.tagName.toLowerCase();
  };

  const targetPathFor = (element) => {
    const parts = [];
    let node = element;
    while (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node !== document.documentElement &&
      node !== document.body &&
      parts.length < 4
    ) {
      parts.unshift(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return parts.join(' > ') || element.tagName.toLowerCase();
  };

  const payloadFor = (element) => {
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const attr of ['id', 'class', 'role', 'aria-label', 'data-testid', 'data-test-id']) {
      const value = element.getAttribute(attr);
      if (value) attributes[attr] = value;
    }
    return {
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      attributes,
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      viewport: {
        width: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
        height: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
      },
      pageUrl: window.location.href || document.URL || 'about:srcdoc',
      targetPath: targetPathFor(element),
    };
  };

  const post = (type, payload) => {
    window.parent.postMessage({ source, token: bridgeToken, type, payload }, '*');
  };
  let lastControlPointerMoveDiagnosticAt = 0;
  const interactiveControlFor = (target) => {
    if (!(target instanceof Element)) return null;
    return target.closest(
      'input,button,select,textarea,a[href],[role="button"],[role="slider"],[contenteditable="true"]',
    );
  };
  const diagnosePageControlEvent = (event) => {
    const control = interactiveControlFor(event.target);
    if (!control || isBridgeUi(control)) return;
    const targetInputType =
      control instanceof HTMLInputElement ? String(control.type || 'text').toLowerCase() : null;
    const targetRole = control.getAttribute('role');
    const isSlider = targetInputType === 'range' || targetRole === 'slider';
    if (event.type === 'pointermove') {
      if (!isSlider) return;
      const now = Date.now();
      if (now - lastControlPointerMoveDiagnosticAt < 100) return;
      lastControlPointerMoveDiagnosticAt = now;
    }
    const eventPhase = event.eventPhase;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const emitFinalState = () => {
      let targetHasPointerCapture = null;
      try {
        if (pointerId !== null && typeof control.hasPointerCapture === 'function') {
          targetHasPointerCapture = Boolean(control.hasPointerCapture(pointerId));
        }
      } catch (_) {
        targetHasPointerCapture = null;
      }
      post('diagnostic', {
        event: 'page-control-event',
        eventType: event.type,
        eventPhase,
        defaultPrevented: Boolean(event.defaultPrevented),
        propagationStopped: Boolean(event.cancelBubble),
        selectionModeEnabled: enabled,
        targetTag: control.tagName ? control.tagName.toLowerCase() : null,
        targetInputType,
        targetRole,
        targetDisabled: 'disabled' in control ? Boolean(control.disabled) : null,
        targetHasPointerCapture,
        button: typeof event.button === 'number' ? event.button : null,
        buttons: typeof event.buttons === 'number' ? event.buttons : null,
        pointerType: typeof event.pointerType === 'string' ? event.pointerType : null,
        ts: Date.now(),
      });
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(emitFinalState);
    else Promise.resolve().then(emitFinalState);
  };

  const refreshBoxes = () => {
    updateBox(hoverBox, hovered);
    updateBox(activeBox, activeElement);
    comments.forEach(positionComment);
    positionComposer();
  };

  const createMarker = (comment) => {
    const marker = document.createElement('div');
    marker.setAttribute('data-mavis-html-selection-ui', 'true');
    marker.setAttribute('data-mavis-html-selection-marker', String(comment.commentId));
    marker.style.position = 'fixed';
    marker.style.zIndex = '2147483647';
    marker.style.width = '24px';
    marker.style.height = '24px';
    marker.style.border = '0';
    marker.style.background = 'transparent';
    marker.style.padding = '0';
    marker.style.display = 'none';
    marker.style.pointerEvents = 'auto';
    marker.style.cursor = 'pointer';
    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openComposer(comment.element, comment);
    });

    const numberButton = document.createElement('div');
    numberButton.textContent = String(comment.commentId);
    numberButton.setAttribute('data-mavis-html-selection-marker-number', String(comment.commentId));
    numberButton.style.position = 'absolute';
    numberButton.style.inset = '0';
    numberButton.style.width = '24px';
    numberButton.style.height = '24px';
    numberButton.style.border = '1.5px solid #ffffff';
    numberButton.style.borderRadius = '999px';
    numberButton.style.background = markerColor;
    numberButton.style.color = '#ffffff';
    numberButton.style.font = '500 12px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    numberButton.style.boxShadow = '0 10px 30px rgba(10,132,255,0.35)';
    numberButton.style.padding = '0';
    numberButton.style.display = 'flex';
    numberButton.style.alignItems = 'center';
    numberButton.style.justifyContent = 'center';
    numberButton.style.pointerEvents = 'auto';
    numberButton.style.cursor = 'pointer';

    const tooltip = document.createElement('div');
    tooltip.setAttribute('data-mavis-html-selection-ui', 'true');
    tooltip.setAttribute('data-mavis-html-selection-marker-tooltip', String(comment.commentId));
    tooltip.style.position = 'absolute';
    tooltip.style.left = 'calc(100% + 8px)';
    tooltip.style.top = '50%';
    tooltip.style.transform = 'translateY(-50%)';
    tooltip.style.maxWidth = '260px';
    tooltip.style.padding = '6px 12px';
    tooltip.style.borderRadius = '999px';
    tooltip.style.background = '#ffffff';
    tooltip.style.color = '#171717';
    tooltip.style.font = '500 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    tooltip.style.boxShadow = '0 0 20px rgba(10,10,10,0.08)';
    tooltip.style.whiteSpace = 'nowrap';
    tooltip.style.overflow = 'hidden';
    tooltip.style.textOverflow = 'ellipsis';
    tooltip.style.pointerEvents = 'auto';
    tooltip.style.display = 'none';
    tooltip.style.cursor = 'pointer';
    tooltip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openComposer(comment.element, comment);
    });

    marker.addEventListener('mouseenter', () => {
      const text = (comment.feedback || '').trim();
      tooltip.textContent = text || ('Comment ' + (comment.displayIndex || comment.commentId));
      tooltip.style.display = 'block';
      updateBox(comment.box, comment.element);
    });
    marker.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      if (activeElement !== comment.element) {
        updateBox(comment.box, null);
      }
    });
    marker.appendChild(numberButton);
    marker.appendChild(tooltip);
    document.documentElement.appendChild(marker);
    return marker;
  };

  function positionComment(comment) {
    const element = comment.element;
    const isActive = activeElement === element;
    // Only show the highlight box when (a) selection mode is on AND (b) this
    // comment's element is the active one (open composer). Hover-driven show
    // is handled in the marker's mouseenter handler.
    updateBox(comment.box, enabled && isActive ? element : null);
    if (!enabled) {
      if (comment.marker) comment.marker.style.display = 'none';
      return;
    }
    if (!comment.marker || !element || !document.documentElement.contains(element)) {
      if (comment.marker) comment.marker.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      comment.marker.style.display = 'none';
      return;
    }
    const left = clamp(rect.left - 12, 8, Math.max(8, window.innerWidth - 32));
    const top = clamp(rect.bottom - 14, 8, Math.max(8, window.innerHeight - 32));
    comment.marker.style.display = 'block';
    comment.marker.style.left = left + 'px';
    comment.marker.style.top = top + 'px';
  }

  const removeComposer = () => {
    if (composer) composer.remove();
    composer = null;
    activeElement = null;
    updateBox(activeBox, null);
  };

  const clearDraft = () => {
    if (!preserveDraft) return;
    draft = null;
    post('draft-changed', null);
  };

  const syncDraftInput = () => {
    if (!preserveDraft || !draft || !composer) return;
    const input = composer.querySelector('[data-mavis-html-selection-input]');
    if (!input) return;
    draft = { ...draft, feedback: input.value };
    post('draft-changed', draft);
  };

  const clearComments = () => {
    // Sending stored comments only clears their markers, not a new unsent draft.
    // An edit of a cleared comment keeps its text/identity for host recovery,
    // but must not retain a submit closure pointing at the removed comment.
    if (preserveDraft) syncDraftInput();
    const keepComposer = preserveDraft && draft && !draft.commentId;
    if (!keepComposer) removeComposer();
    for (const comment of comments) {
      if (comment.marker) comment.marker.remove();
      if (comment.box) comment.box.remove();
    }
    comments.length = 0;
    commentSeq = 0;
    hovered = null;
    updateBox(hoverBox, null);
    if (preserveDraft && draft && draft.commentId) restoreDraft();
  };

  const resolveSeedElement = (seed) => {
    if (!seed) return null;
    if (seed.selector) {
      try {
        const found = document.querySelector(seed.selector);
        if (found) return found;
      } catch (_) { /* invalid selector — fall through */ }
    }
    if (seed.attributes && seed.attributes.id) {
      try {
        const byId = document.getElementById(seed.attributes.id);
        if (byId) return byId;
      } catch (_) { /* ignore */ }
    }
    if (seed.attributes && seed.attributes['data-testid']) {
      try {
        const byTestId = document.querySelector('[data-testid="' + String(seed.attributes['data-testid']).replace(/"/g, '\\\\"') + '"]');
        if (byTestId) return byTestId;
      } catch (_) { /* ignore */ }
    }
    return null;
  };

  const seedComments = (seeds) => {
    // Reconcile existing markers/boxes with the canonical set from the host
    // (React store), keyed by commentId. We only ADD or UPDATE here — never
    // delete a local comment just because it isn't in the seed list, because
    // a freshly-submitted comment can race with this round-trip and would
    // otherwise be wiped before its 'comment-added' has reached the host.
    // Host-driven deletions go through the dedicated 'clear-comments' /
    // remove-comment paths.
    let maxId = 0;
    const seedIds = new Set();
    for (const seed of seeds) {
      const commentId = Number(seed && seed.commentId);
      if (!Number.isFinite(commentId) || commentId <= 0) continue;
      seedIds.add(commentId);
      if (commentId > maxId) maxId = commentId;
      // Suppress re-creation of a comment the user just deleted locally but
      // whose deletion the host has not yet pruned from its store. Without
      // this guard, every Delete press would visibly bring the marker back
      // on the very next seedComments tick (so it would take two Delete
      // clicks to actually get rid of it).
      if (pendingHostRemovalIds.has(commentId)) continue;
      const existing = comments.find((c) => c.commentId === commentId);
      if (existing) {
        if (typeof seed.feedback === 'string') existing.feedback = seed.feedback;
        // Re-resolve element only if the original reference fell out of the DOM.
        if (!existing.element || !document.documentElement.contains(existing.element)) {
          const resolved = resolveSeedElement(seed);
          if (resolved) existing.element = resolved;
        }
        positionComment(existing);
        continue;
      }
      const element = resolveSeedElement(seed);
      if (!element) continue; // DOM changed — skip stale entries; outer store still has them.
      const comment = {
        commentId,
        element,
        feedback: typeof seed.feedback === 'string' ? seed.feedback : '',
        box: createCommentBox(),
        marker: null,
      };
      comment.marker = createMarker(comment);
      positionComment(comment);
      comments.push(comment);
    }
    // Once the host has confirmed the deletion (i.e. the id is no longer in
    // the seed list), drop it from the pending set so future re-adds of a
    // brand-new comment with the same id (after a session reset) would work.
    pendingHostRemovalIds.forEach((id) => {
      if (!seedIds.has(id)) pendingHostRemovalIds.delete(id);
    });
    commentSeq = Math.max(commentSeq, maxId);
    relabelMarkers();
  };

  function removeComment(comment) {
    if (draft && draft.commentId === comment.commentId) clearDraft();
    const index = comments.indexOf(comment);
    if (index >= 0) comments.splice(index, 1);
    if (comment.marker) comment.marker.remove();
    if (comment.box) comment.box.remove();
    const strayMarkers = document.querySelectorAll(
      '[data-mavis-html-selection-marker="' + comment.commentId + '"]',
    );
    strayMarkers.forEach((node) => node.remove());
    if (activeElement === comment.element) removeComposer();
    if (hovered === comment.element) {
      hovered = null;
      updateBox(hoverBox, null);
    }
    pendingHostRemovalIds.add(comment.commentId);
    post('comment-removed', { commentId: comment.commentId });
    relabelMarkers();
  }

  function positionComposer() {
    if (!composer || !activeElement || !document.documentElement.contains(activeElement)) return;
    const rect = activeElement.getBoundingClientRect();
    const composerHeight = composerTokens.wrapper.height;
    const bottomInset = composerTokens.position.bottomInset;
    const gap = composerTokens.position.gap;
    const width = Math.min(360, Math.max(260, Math.min(window.innerWidth - 32, rect.width)));
    const viewportInset = composerTokens.position.viewportInset;
    const left = clamp(
      rect.left + rect.width / 2 - width / 2,
      viewportInset,
      Math.max(viewportInset, window.innerWidth - width - viewportInset),
    );
    let top = rect.bottom + gap;
    if (top + composerHeight + bottomInset > window.innerHeight) top = rect.top - composerHeight - gap;
    top = clamp(
      top,
      viewportInset,
      Math.max(viewportInset, window.innerHeight - composerHeight - bottomInset),
    );
    composer.style.left = left + 'px';
    composer.style.top = top + 'px';
    composer.style.width = width + 'px';
  }

  const createComposer = (initialValue, commentNumber, onSubmit, onCancel, onDelete) => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-mavis-html-selection-ui', 'true');
    wrapper.setAttribute('data-mavis-html-selection-composer', 'true');
    wrapper.style.position = 'fixed';
    wrapper.style.zIndex = '2147483647';
    wrapper.style.height = composerTokens.wrapper.height + 'px';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = composerTokens.wrapper.gap + 'px';
    wrapper.style.border = composerTokens.wrapper.border;
    wrapper.style.borderRadius = composerTokens.wrapper.borderRadius + 'px';
    wrapper.style.background = composerTokens.wrapper.background;
    wrapper.style.boxShadow = composerTokens.wrapper.boxShadow;
    wrapper.style.padding = composerTokens.wrapper.padding;
    wrapper.style.backdropFilter = composerTokens.wrapper.backdropFilter;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialValue || '';
    input.placeholder = placeholder;
    input.setAttribute('data-mavis-html-selection-input', 'true');
    input.style.minWidth = '0';
    input.style.flex = '1 1 auto';
    input.style.border = '0';
    input.style.outline = '0';
    input.style.background = 'transparent';
    input.style.color = composerTokens.input.color;
    input.style.font = composerTokens.input.font;
    input.style.caretColor = markerColor;
    const placeholderStyle = document.createElement('style');
    placeholderStyle.textContent =
      '[data-mavis-html-selection-input]::placeholder { color: ' +
      composerTokens.input.placeholderColor +
      '; opacity: 1; }';
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = input.value.trim();
        if (value) onSubmit(value);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    });

    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.style.flex = '0 0 auto';
    actionButton.style.width = composerTokens.actionButton.size + 'px';
    actionButton.style.height = composerTokens.actionButton.size + 'px';
    actionButton.style.padding = '0';
    actionButton.style.border = '0';
    actionButton.style.borderRadius = composerTokens.actionButton.borderRadius + 'px';
    actionButton.style.display = 'inline-flex';
    actionButton.style.alignItems = 'center';
    actionButton.style.justifyContent = 'center';
    actionButton.style.cursor = 'pointer';
    actionButton.style.transition = 'background-color 0.15s, color 0.15s';

    let hovering = false;
    const syncActionButton = () => {
      const hasValue = input.value.trim().length > 0;
      if (hasValue) {
        actionButton.innerHTML = bridgeIcons.confirm;
        actionButton.setAttribute('aria-label', 'Submit');
        actionButton.style.background = hovering
          ? composerTokens.actionButton.submitHoverBackground
          : composerTokens.actionButton.submitBackground;
        actionButton.style.color = composerTokens.actionButton.submitColor;
      } else {
        actionButton.innerHTML = bridgeIcons.close;
        actionButton.setAttribute('aria-label', 'Cancel');
        actionButton.style.background = hovering
          ? composerTokens.actionButton.cancelHoverBackground
          : composerTokens.actionButton.cancelBackground;
        actionButton.style.color = hovering
          ? composerTokens.actionButton.cancelHoverColor
          : composerTokens.actionButton.cancelColor;
      }
    };
    actionButton.addEventListener('mouseenter', () => {
      hovering = true;
      syncActionButton();
    });
    actionButton.addEventListener('mouseleave', () => {
      hovering = false;
      syncActionButton();
    });
    actionButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = input.value.trim();
      if (value) onSubmit(value);
      else onCancel();
    });
    input.addEventListener('input', () => {
      syncActionButton();
      syncDraftInput();
    });
    syncActionButton();

    wrapper.appendChild(placeholderStyle);
    wrapper.appendChild(input);
    if (typeof onDelete === 'function') {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.setAttribute('aria-label', 'Delete comment');
      deleteButton.innerHTML = bridgeIcons.delete;
      deleteButton.style.flex = '0 0 auto';
      deleteButton.style.width = composerTokens.actionButton.size + 'px';
      deleteButton.style.height = composerTokens.actionButton.size + 'px';
      deleteButton.style.padding = '0';
      deleteButton.style.border = '0';
      deleteButton.style.borderRadius = composerTokens.actionButton.borderRadius + 'px';
      deleteButton.style.display = 'inline-flex';
      deleteButton.style.alignItems = 'center';
      deleteButton.style.justifyContent = 'center';
      deleteButton.style.cursor = 'pointer';
      deleteButton.style.transition = 'background-color 0.15s, color 0.15s';
      deleteButton.style.background = 'transparent';
      deleteButton.style.color = composerTokens.deleteButton.color;
      deleteButton.style.marginRight = '-4px'; // collapse the 10px wrapper gap to ~4px against the action button
      deleteButton.addEventListener('mouseenter', () => {
        deleteButton.style.background = composerTokens.deleteButton.hoverBackground;
        deleteButton.style.color = composerTokens.deleteButton.hoverColor;
      });
      deleteButton.addEventListener('mouseleave', () => {
        deleteButton.style.background = 'transparent';
        deleteButton.style.color = composerTokens.deleteButton.color;
      });
      deleteButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onDelete();
      });
      wrapper.appendChild(deleteButton);
    }
    wrapper.appendChild(actionButton);
    document.documentElement.appendChild(wrapper);
    window.setTimeout(() => input.focus(), 0);
    return wrapper;
  };

  const captureMarkedScreenshot = async (element, comment) => {
    try {
      if (!element || !document.documentElement.contains(element)) return undefined;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;
      const viewport = {
        width: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
        height: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
      };
      if (viewport.width <= 0 || viewport.height <= 0) return undefined;

      if (composer) composer.style.visibility = 'hidden';
      updateBox(comment.box, element);
      positionComment(comment);

      const padding = 64;
      const cropX = Math.max(0, Math.floor(rect.left - padding));
      const cropY = Math.max(0, Math.floor(rect.top - padding));
      const cropWidth = Math.min(viewport.width - cropX, Math.ceil(rect.width + padding * 2));
      const cropHeight = Math.min(viewport.height - cropY, Math.ceil(rect.height + padding * 2));
      if (cropWidth <= 0 || cropHeight <= 0) return undefined;

      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script[data-mavis-html-selection-bridge], [data-mavis-html-selection-composer]').forEach((node) => node.remove());
      const serialized = new XMLSerializer().serializeToString(clone);
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        viewport.width +
        '" height="' +
        viewport.height +
        '"><foreignObject width="100%" height="100%">' +
        serialized +
        '</foreignObject></svg>';
      const image = new Image();
      const dataUrl = await new Promise((resolve, reject) => {
        image.onload = () => resolve('ok');
        image.onerror = reject;
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }).then(() => {
        const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(cropWidth * scale);
        canvas.height = Math.round(cropHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        ctx.scale(scale, scale);
        ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        return canvas.toDataURL('image/png');
      });
      return typeof dataUrl === 'string' ? dataUrl : undefined;
    } catch (_error) {
      return undefined;
    } finally {
      if (composer) composer.style.visibility = '';
    }
  };

  function openComposer(element, existingComment, restoredDraft) {
    if (!element || !document.documentElement.contains(element)) return;
    // A second DOM click must not silently overwrite an unsent Canvas comment.
    if (preserveDraft && draft && draft.feedback && !restoredDraft) {
      if (composer) composer.querySelector('[data-mavis-html-selection-input]').focus();
      else restoreDraft();
      return;
    }
    hovered = null;
    updateBox(hoverBox, null);
    // Hide any hover tooltips that may still be visible from the marker
    // the user just clicked — otherwise the pill would overlap the composer.
    const tooltips = document.querySelectorAll('[data-mavis-html-selection-marker-tooltip]');
    tooltips.forEach((node) => { (node).style.display = 'none'; });
    activeElement = element;
    updateBox(ensureBox('selected'), activeElement);
    removeComposer();
    activeElement = element;
    updateBox(ensureBox('selected'), activeElement);

    const handleCancel = () => {
      clearDraft();
      removeComposer();
    };

    const handleSubmit = async (feedback) => {
      let comment = existingComment;
      if (!comment) {
        // Derive next id from the CURRENT comment set, not the monotonic
        // commentSeq — that way after the user deletes everything and
        // starts over, numbering restarts at 1 instead of resuming where the
        // previous run left off (e.g. 6, 7 again).
        const maxLocal = comments.reduce((m, c) => (c.commentId > m ? c.commentId : m), 0);
        const nextId = maxLocal + 1;
        commentSeq = nextId;
        comment = {
          commentId: nextId,
          element,
          feedback,
          box: createCommentBox(),
          marker: null,
        };
        comment.marker = createMarker(comment);
        comments.push(comment);
        relabelMarkers();
      } else {
        comment.feedback = feedback;
      }

      updateBox(comment.box, element);
      positionComment(comment);
      // Close the composer synchronously — the screenshot capture below is
      // async and the user might open a new composer in the meantime; if we
      // removed the composer after the await we would kill THAT composer
      // (race that previously made the second comment look "not submitted").
      // We only clear composer/activeElement if they still point at this
      // submission, otherwise we leave the newer composer alone.
      if (composer && activeElement === element) {
        removeComposer();
      }
      const payload = {
        ...payloadFor(element),
        commentId: comment.commentId,
        feedback,
        screenshotFileName: 'browser-comment-' + comment.commentId + '.png',
      };
      if (preserveDraft) {
        // Persist the comment before optional host-side capture. Leave the host's
        // saved draft intact until it receives this message and accepts the comment.
        draft = null;
        post('comment-added', payload);
        return;
      }
      const screenshotDataUrl = await captureMarkedScreenshot(element, comment);
      if (comments.indexOf(comment) === -1) return;
      if (screenshotDataUrl) payload.screenshotDataUrl = screenshotDataUrl;
      post('comment-added', payload);
    };

    composer = createComposer(
      restoredDraft ? restoredDraft.feedback : (existingComment ? existingComment.feedback : ''),
      existingComment
        ? (existingComment.displayIndex || existingComment.commentId)
        : (comments.length + 1),
      handleSubmit,
      handleCancel,
      existingComment ? () => removeComment(existingComment) : undefined,
    );
    if (preserveDraft) {
      draft = {
        selection: payloadFor(element),
        feedback: restoredDraft ? restoredDraft.feedback : (existingComment ? existingComment.feedback : ''),
        ...(existingComment ? { commentId: existingComment.commentId } : {}),
      };
      post('draft-changed', draft);
    }
    positionComposer();
    if (!restoredDraft) post('element-selected', payloadFor(element));
  }

  const restoreDraft = () => {
    if (!preserveDraft || !draft || !enabled || composer) return;
    const element = resolveSeedElement(draft.selection);
    if (!element) {
      post('draft-restore-failed', { reason: 'target-missing' });
      return;
    }
    const existing = draft.commentId ? comments.find((comment) => comment.commentId === draft.commentId) : null;
    if (draft.commentId && !existing) {
      post('draft-restore-failed', { reason: 'comment-missing' });
      return;
    }
    openComposer(element, existing, draft);
  };

  const handlePointerMove = (event) => {
    if (!enabled) return;
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) return;
    hovered = target;
    updateBox(ensureBox('hover'), hovered);
  };

  const handlePointerDown = (event) => {
    if (!enabled) return;
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) return;
    event.preventDefault();
  };

  const handlePointerLeave = () => {
    hovered = null;
    updateBox(hoverBox, null);
  };

  const handleClick = (event) => {
    if (!enabled) return;
    const target = event.target;
    if (!(target instanceof Element) || isBridgeUi(target)) return;
    event.preventDefault();
    event.stopPropagation();
    // If this element already has a comment, treat the click as "edit /
    // reopen" rather than spawning a new overlapping comment on top of it.
    const existing = comments.find((c) => c.element === target);
    if (existing) {
      openComposer(target, existing);
      return;
    }
    openComposer(target, null);
  };

  const setEnabled = (nextEnabled) => {
    enabled = Boolean(nextEnabled);
    document.documentElement.style.cursor = enabled ? 'crosshair' : '';
    if (enabled) {
      document.addEventListener('pointerdown', handlePointerDown, true);
      document.addEventListener('pointermove', handlePointerMove, true);
      document.addEventListener('pointerleave', handlePointerLeave, true);
      document.addEventListener('click', handleClick, true);
      restoreDraft();
    } else {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointermove', handlePointerMove, true);
      document.removeEventListener('pointerleave', handlePointerLeave, true);
      document.removeEventListener('click', handleClick, true);
      hovered = null;
      updateBox(hoverBox, null);
      syncDraftInput();
      removeComposer();
    }
    // Show/hide existing comment markers + selection boxes to match the new
    // selection-mode state. When disabled, hide them; when enabled, reposition.
    comments.forEach(positionComment);
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== source) return;
    if (typeof data.placeholder === 'string') placeholder = data.placeholder;
    if (data.type === 'set-enabled') {
      if (data.preserveDraft === true) preserveDraft = true;
      setEnabled(data.enabled);
    }
    if (data.type === 'clear-selected') {
      clearDraft();
      removeComposer();
    }
    if (data.type === 'clear-comments') clearComments();
    if (data.type === 'seed-comments') seedComments(Array.isArray(data.comments) ? data.comments : []);
    if (data.type === 'restore-draft' && preserveDraft && event.source === window.parent) {
      if (data.draft === null) {
        draft = null;
        removeComposer();
      } else if (data.draft && typeof data.draft.feedback === 'string' && data.draft.selection && typeof data.draft.selection.selector === 'string') {
        if (composer) return;
        draft = data.draft;
        restoreDraft();
      }
    }
  });
  // Best effort final flush; host memory remains the source of truth after unmount.
  window.addEventListener('pagehide', syncDraftInput);
  window.addEventListener('resize', refreshBoxes);
  document.addEventListener('scroll', refreshBoxes, true);
  ['pointerdown', 'pointerup', 'pointercancel', 'click', 'input', 'change'].forEach((type) => {
    document.addEventListener(type, diagnosePageControlEvent, true);
  });
  document.addEventListener('pointermove', diagnosePageControlEvent, true);
  // Readiness is an initialization event, not an acknowledgement of set-enabled.
  // Both hosts reply to ready with set-enabled, so echoing it would loop forever.
  post('ready', { enabled });
})();`;function v(e){return`<script data-mavis-html-selection-bridge>${x.replace("__MAVIS_HTML_SELECTION_BRIDGE_TOKEN__",JSON.stringify(e))}</script>`}function b(e,t){var n;return n=v(t),/<\/body>/iu.test(e)?e.replace(/<\/body>/iu,`${n}</body>`):`${e}${n}`}},47482:function(e,t,n){"use strict";function o(e,t,n){e.text+=t;for(let o=0;o<t.length;o+=1)e.sourceOffsets.push(n+o)}function r(e,t,n){let o=t;for(;o<n&&"`"===e[o];)o+=1;return o-t}function i(e){let t={text:"",sourceOffsets:[]},n=0,i=null;for(;n<=e.length;){let a=e.indexOf("\n",n),l=a<0?e.length:a,s=e.slice(n,l),c=/^\s{0,3}(`{3,}|~{3,})/u.exec(s)?.[1];if(c){let e=c[0];null===i?i=e:i===e&&(i=null)}else if(i)for(let r=n;r<l;r+=1)o(t,e[r]??"",r);else!function(e,t,n,i){let a=e.slice(t,n),l=/^\s{0,3}(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)(?:\[[ xX]\]\s+)?/u.exec(a),s=t+(l?.[0].length??0),c=0;for(;s<n;){let t=e[s]??"",a=e[s+1]??"";if("`"===t){let t=r(e,s,n);if(c===t){c=0,s+=t;continue}if(0===c&&function(e,t,n,o){let i=t;for(;i<n;){if("`"!==e[i]){i+=1;continue}let t=r(e,i,n);if(t===o)return!0;i+=t}return!1}(e,s+t,n,t)){c=t,s+=t;continue}for(let e=0;e<t;e+=1)o(i,"`",s+e);s+=t;continue}if(c>0){o(i,t,s),s+=1;continue}if("\\"===t&&s+1<n){o(i,a,s+1),s+=2;continue}if("!"===t&&"["===a){s+=2;continue}if("["===t){s+=1;continue}if("]"===t&&"("===a){let t=function(e,t,n){let o=1;for(let r=t;r<n;r+=1){let t=e[r];if("\\"===t){r+=1;continue}if("("===t&&(o+=1),")"===t&&0==(o-=1))return r+1}return t}(e,s+2,n);s=t>s+2?t:s+1;continue}if("]"===t||"*"===t||"_"===t||"~"===t){s+=1;continue}if("<"===t){let t=e.indexOf(">",s+1);if(t>=0&&t<n){let n=e.slice(s+1,t);/^(?:https?:\/\/|mailto:)/u.test(n)&&o(i,n.replace(/^mailto:/u,""),s+1+(n.startsWith("mailto:")?7:0)),s=t+1;continue}}if("|"===t){s+=1;continue}o(i,t,s),s+=1}}(e,n,l,t);if(a<0)break;o(t,"\n",a),n=a+1}return t}function a(e){return i(e).text}function l(e,t,n){let o=e[0];if(!o)return null;if(Number.isSafeInteger(n)&&(n??-1)>=0&&(n??e.length)<e.length)return e[n??0]??null;let r=Number.isFinite(t)&&(t??-1)>=0?t:void 0;return e.slice(1).reduce((e,t)=>{let n=t.endOffset-t.startOffset,o=e.endOffset-e.startOffset,i=void 0===r?n:Math.abs(t.startOffset-r),a=void 0===r?o:Math.abs(e.startOffset-r);return i!==a?i<a?t:e:n!==o?n<o?t:e:t.startOffset<e.startOffset?t:e},o)}function s(e,t,n,o){let r=t.trim();if(!r)return null;let a=l(function(e,t){let n=[],o=0;for(;o<=e.length-t.length;){let r=e.indexOf(t,o);if(r<0)break;n.push({startOffset:r,endOffset:r+t.length}),o=r+Math.max(1,t.length)}return n}(e,r),n,o);return a?a:l(function(e,t){let n=i(e),o=t.replace(/\s+/gu,"");if(!o)return[];let r="",a=[];for(let e=0;e<n.text.length;e+=1){let t=n.text[e]??"";/\s/u.test(t)||(r+=t,a.push(n.sourceOffsets[e]??-1))}let l=[],s=0;for(;s<=r.length-o.length;){let e=r.indexOf(o,s);if(e<0)break;let t=a[e],n=a[e+o.length-1];void 0!==t&&void 0!==n&&t>=0&&n>=0&&l.push({startOffset:t,endOffset:n+1}),s=e+Math.max(1,o.length)}return l}(e,r),n,o)||l(function(e,t){let n=t.trim().split(/\s+/gu).filter(Boolean),o=n[0];if(!o||n.length<2)return[];let r=[],i=0;for(;i<=e.length-o.length;){let t=e.indexOf(o,i);if(t<0)break;let a=t+o.length,l=!0;for(let t of n.slice(1)){let n=e.indexOf(t,a);if(n<0){l=!1;break}a=n+t.length}l&&r.push({startOffset:t,endOffset:a}),i=t+Math.max(1,o.length)}return r}(e,r),n,o)}n.d(t,{P:function(){return s},V:function(){return a}})},99377:function(e,t,n){"use strict";n.d(t,{D:function(){return r}});var o=n(42385);let r={markerColor:"#0A84FF",wrapper:{height:42,gap:10,border:"1px solid rgba(15, 23, 42, 0.10)",borderRadius:12,background:"rgba(255, 255, 255, 0.96)",boxShadow:"0 0 20px rgba(10,10,10,0.08)",padding:"8px 8px 8px 12px",backdropFilter:"blur(12px)"},position:{gap:12,viewportInset:16,bottomInset:24},input:{color:"#171717",placeholderColor:"#adadad",font:`400 14px/20px ${o.IF}`},actionButton:{size:30,borderRadius:9999,submitBackground:"#171717",submitHoverBackground:"#303030",submitColor:"#ffffff",cancelBackground:"transparent",cancelHoverBackground:"rgba(15, 23, 42, 0.06)",cancelColor:"rgb(148, 163, 184)",cancelHoverColor:"#475569"},deleteButton:{color:"#adadad",hoverBackground:"#0a0a0a0a",hoverColor:"#666666"}};["surface","border","shadow","text","caret","primary","primary-hover","primary-text","cancel-text","cancel-hover","cancel-hover-text","marker","marker-text"].map(e=>`--mavis-selection-${e}`)},84819:function(e,t,n){"use strict";n.d(t,{N:function(){return i},_:function(){return r}});var o=n(27573);let r="flex min-h-9 min-w-20 items-center justify-center text-sm font-medium leading-5 [--mavis-button-height:36px] [--mavis-button-padding-block:8px] [--mavis-button-padding-inline:12px] [--mavis-radius-control:8px]";function i(e){let{icon:t,title:n,description:r,children:i}=e;return(0,o.jsxs)("div",{className:"flex w-full min-w-0 max-w-[360px] flex-col items-center gap-2",children:[t&&(0,o.jsx)("div",{"aria-hidden":"true",className:"flex size-[52px] shrink-0 items-center justify-center",children:t}),(0,o.jsx)("p",{className:"desktop-text-empty-state-title m-0 max-w-full break-words text-left text-base font-semibold leading-[26px] text-text_default_secondary",children:n}),r&&(0,o.jsx)("p",{className:"desktop-text-empty-state-description m-0 max-w-full break-words text-center text-sm font-normal leading-5 text-text_default_tertiary",children:r}),i]})}},24191:function(e,t,n){"use strict";n.d(t,{X:function(){return i}});var o=n(27573),r=n(7653);n(16229);let i=(0,r.forwardRef)(function(e,t){let{label:n,aiLabel:r,aiIcon:i,onAsk:a,busy:l,disabled:s,aiTitle:c,primaryButtonProps:d,children:u,className:m="",...f}=e;return(0,o.jsxs)("div",{...f,ref:t,className:`office-selection-toolbar ${m}`,role:"toolbar","aria-label":n,"aria-busy":l||void 0,onMouseDown:e=>e.preventDefault(),children:[a&&(0,o.jsxs)("button",{type:"button",className:"office-selection-ai",disabled:l||s,title:c,...d,onClick:e=>{e.preventDefault(),e.stopPropagation(),a()},children:[i," ",r]}),u]})})},16229:function(){}}]);