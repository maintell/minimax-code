(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[60145],{59403:function(e,t,n){"use strict";n.d(t,{AI:function(){return d},GL:function(){return r},OQ:function(){return i},Q1:function(){return s},VU:function(){return l},jW:function(){return a}});var o=n(42385);let r={surface:"--bg_grouped_secondary_elevated",border:"--border_default",shadow:"--shadow_default",text:"--text_default_primary",placeholder:"--text_default_tertiary",caret:"--border_accent",primaryBg:"--bg_interaction_primary_default",primaryHover:"--bg_interaction_primary_hover",primaryInactive:"--bg_interaction_primary_inactive",primaryIcon:"--icon_interaction_primary_default",secondaryBg:"--bg_interaction_secondary_default",secondaryHover:"--bg_interaction_secondary_hover",secondaryIcon:"--icon_default_primary",tertiaryIcon:"--icon_default_tertiary",tertiaryHover:"--icon_interaction_tertiary_hover"},i={width:{min:260,max:383,viewportInset:16},placement:{anchorGap:12,bottomInset:24},wrapper:{borderWidth:1,borderRadius:12,shadowBlur:10,padding:{top:5,right:5,bottom:5,left:11},stackedPaddingX:11},create:{height:44,gap:16,inputRowHeight:32,inputHeight:20,inputRowPaddingY:6},edit:{height:106,gap:4,inputRowHeight:58,inputHeight:50,inputRowPaddingY:4,footerHeight:32,actionsGap:8},input:{fontWeight:400,fontSize:14,lineHeight:20,fontFamily:o.IF,focusOutline:0,maxLines:5},actionButton:{size:30,borderRadius:9999,iconSize:18,transition:"background-color 0.15s, color 0.15s",enabledCursor:"pointer",disabledCursor:"default"},deleteButton:{size:20,iconSize:20,transition:"color 0.15s"},behavior:{trimOnSubmit:!0,disableEmptySubmit:!0,escapeCancels:!0,focusOnOpen:!0,createEnterSubmitsWithShift:!0,editShiftEnterCreatesNewline:!0}};function a(e){let t="edit"===e.mode&&!0===e.canDelete;return{mode:e.mode,draft:e.draft??"",anchor:e.anchor,canDelete:t,actions:t?["submit","cancel","delete"]:["submit","cancel"]}}function l(e){let t=i.behavior.trimOnSubmit?e.trim():e;return t.length>0?t:null}function s(e){let t=Math.max(e.minHeight,e.maxHeight);return{height:Math.min(Math.max(e.contentHeight,e.minHeight),t),overflowY:e.contentHeight>t+.5?"auto":"hidden",wrapped:e.contentHeight>e.minHeight+.5}}function d(e,t){return"create"===e?i.behavior.createEnterSubmitsWithShift:!(t&&i.behavior.editShiftEnterCreatesNewline)}},13049:function(e,t,n){"use strict";n.d(t,{WY:function(){return l},n9:function(){return a},qH:function(){return i},r9:function(){return r}});var o=n(42385);let r={background:"--bg_interaction_accent_focus_blue",border:"--icon_default_inverted",text:"--text_default_inverted_static",shadow:"--shadow_default"},i={markerBackground:r.background,markerBorder:r.border,markerText:r.text,markerShadow:r.shadow},a={size:24,width:"auto",borderWidth:2,borderRadius:999,paddingInline:4,fontWeight:500,fontSize:14,lineHeight:20,letterSpacing:0,fontFamily:o.IF,shadow:{offsetX:0,offsetY:0,blurRadius:24,figmaRadius:48,figmaSpread:-12},cursor:"pointer"};function l(e){return{number:e.number,label:String(e.number),interaction:e.interaction??"idle",visible:e.visible??!0,anchor:e.anchor}}},12230:function(e,t,n){"use strict";n.d(t,{y:function(){return s}});var o=n(27573),r=n(7653),i=n(13049),a=n(32425);function l(e){return`var(${e})`}let s=(0,r.forwardRef)(function(e,t){let{number:n,anchorContext:r,interaction:s="idle",visible:d=!0,onActivate:c,ariaLabel:u=`Comment ${n}`,className:m,style:f,testId:p,selectionUi:h=!1,...g}=e,b=(0,i.WY)({number:n,interaction:s,visible:d,anchor:r});return b.visible?(0,o.jsx)("button",{...g,ref:t,type:"button","aria-label":u,disabled:"disabled"===b.interaction,"data-comment-marker":"true","data-comment-marker-state":b.interaction,"data-comment-anchor-surface":b.anchor.surface,"data-comment-anchor-context":b.anchor.contextId,"data-comment-anchor-selection-kind":b.anchor.selectionKind,"data-testid":p,"data-chat-selection-ui":h?"true":void 0,className:`desktop-text-ui-assist ${m??""}`,onMouseDown:e=>e.preventDefault(),onClick:e=>{e.preventDefault(),e.stopPropagation(),c()},style:{boxSizing:"border-box",appearance:"none",WebkitAppearance:"none",display:"inline-flex",flex:"0 0 auto",alignItems:"center",justifyContent:"center",width:i.n9.width,height:i.n9.size,minWidth:i.n9.size,paddingBlock:0,paddingInline:i.n9.paddingInline,borderStyle:"solid",borderWidth:i.n9.borderWidth,borderColor:l(i.r9.border),borderRadius:i.n9.borderRadius,background:l(i.r9.background),color:l(i.r9.text),boxShadow:`${i.n9.shadow.offsetX}px ${i.n9.shadow.offsetY}px ${i.n9.shadow.blurRadius}px ${l(i.r9.shadow)}`,fontFamily:i.n9.fontFamily,fontSize:(0,a.desktopTypographyFontSize)(i.n9.fontSize),fontWeight:i.n9.fontWeight,lineHeight:(0,a.desktopTypographyLineHeight)(i.n9.lineHeight),letterSpacing:i.n9.letterSpacing,textAlign:"center",cursor:"disabled"===b.interaction?"default":i.n9.cursor,...f},children:b.label}):null})},54781:function(e,t,n){"use strict";n.d(t,{V:function(){return c}});var o=n(27573),r=n(7653),i=n(3458),a=n(41317),l=n(32425),s=n(12230),d=n(9813);function c(e){let{items:t,onOpenEdit:n,activeContextId:a=null,hostRef:l,anchorSurface:s,testIdPrefix:c,selectionUi:m=!1,selectionUiAttribute:f}=e,[p,h]=(0,r.useState)([]);if((0,r.useEffect)(()=>{let e=()=>{let e=l?.current??null,n=e?.getBoundingClientRect()??null,o=e?.scrollTop??0,r=e?.scrollLeft??0,i=[];for(let e of t){let t;let a=e.resolveRange();if(a){let e=a.getClientRects();t=e[e.length-1]}if(!t){let n=e.resolveElement?.();n&&(t=n.getBoundingClientRect())}t&&i.push({...e,top:n?t.top-n.top+o:t.top,left:n?t.right-n.left+r:t.right})}h(e=>e.length===i.length&&e.every((e,t)=>{let n=i[t];return!!n&&e.contextId===n.contextId&&e.referenceNumber===n.referenceNumber&&e.comment===n.comment&&e.quotedText===n.quotedText&&e.selectionKind===n.selectionKind&&e.value===n.value&&.5>Math.abs(e.top-n.top)&&.5>Math.abs(e.left-n.left)})?e:i)};e();let n=0,o=()=>{n||(n=window.requestAnimationFrame(()=>{n=0,e()}))};window.addEventListener("resize",o,{passive:!0}),window.addEventListener("scroll",o,{passive:!0,capture:!0});let r=l?.current??null,i="undefined"==typeof ResizeObserver?null:new ResizeObserver(o);r&&i?.observe(r);let a=r&&"undefined"!=typeof MutationObserver?new MutationObserver(o):null;return a?.observe(r,{childList:!0,subtree:!0,characterData:!0,attributes:!0,attributeFilter:["class","style","hidden","open"]}),()=>{n&&window.cancelAnimationFrame(n),window.removeEventListener("resize",o),window.removeEventListener("scroll",o,{capture:!0}),i?.disconnect(),a?.disconnect()}},[a,l,t]),"undefined"==typeof document||0===p.length)return null;let g=l?.current??null,b=g??document.body,v=g?"absolute":"fixed";return(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true",className:`${g?"absolute inset-0":"fixed inset-0"} pointer-events-none`,style:{zIndex:d.MK},children:p.map(e=>(0,o.jsx)(u,{position:e,positionMode:v,anchorSurface:s,testIdPrefix:c,selectionUi:m,selectionUiAttribute:f,isActive:e.contextId===a,onOpenEdit:()=>n(e.value)},e.contextId))}),b)}function u(e){let{position:t,positionMode:n,anchorSurface:i,testIdPrefix:d,selectionUi:c,selectionUiAttribute:u,isActive:m,onOpenEdit:f}=e,p=(0,r.useMemo)(()=>({position:n,top:Math.round(t.top),left:Math.round(t.left),zIndex:5,transform:"translate(-50%, -100%)"}),[t.left,t.top,n]),h=t.comment.trim()||t.quotedText;return(0,o.jsx)(a.Z,{placement:"top",arrow:!1,mouseEnterDelay:.05,title:h?(0,o.jsx)("span",{className:"line-clamp-2 break-words",children:h}):null,overlayStyle:{maxWidth:320},overlayInnerStyle:{display:"flex",height:"auto",minHeight:0,alignItems:"center",fontSize:(0,l.desktopTypographyFontSize)(12),lineHeight:(0,l.desktopTypographyLineHeight)(16),padding:"6px 10px"},children:(0,o.jsx)(s.y,{...u?{[u]:"true"}:{},number:t.referenceNumber,interaction:m?"active":"idle",anchorContext:{surface:i,contextId:t.contextId,selectionKind:t.selectionKind},selectionUi:c,testId:`${d}-${t.contextId}`,ariaLabel:`Comment ${t.referenceNumber}`,onActivate:f,className:"pointer-events-auto",style:p})})}},9813:function(e,t,n){"use strict";n.d(t,{MK:function(){return o},Qv:function(){return r},gm:function(){return a},mu:function(){return i}});let o=20,r=21,i=100,a=101},95777:function(e,t,n){"use strict";function o(e){let{anchorNode:t,anchorOffset:n,focusNode:o,focusOffset:r}=e;if(!t||!o)return"end";if(t===o)return r<n?"start":"end";let i=t.ownerDocument??o.ownerDocument;if(!i)return"end";let a=i.createRange(),l=i.createRange();try{return a.setStart(t,n),a.collapse(!0),l.setStart(o,r),l.collapse(!0),0>=a.compareBoundaryPoints(Range.START_TO_START,l)?"end":"start"}catch{return"end"}}function r(e,t,n){if(!e.contains(t)&&t!==e)return -1;if(t.nodeType===Node.TEXT_NODE){let o=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),r=0,i=o.nextNode();for(;i;){if(i===t)return r+n;r+=(i.nodeValue??"").length,i=o.nextNode()}return -1}let o=t.childNodes;if(n<o.length){let t=o[n];return t?i(e,t):-1}return function(e,t){let n=i(e,t);if(t.nodeType===Node.TEXT_NODE)return n+(t.nodeValue??"").length;let o=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),r=0,a=o.nextNode();for(;a;)r+=(a.nodeValue??"").length,a=o.nextNode();return n+r}(e,t)}function i(e,t){let n=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),o=0,r=n.nextNode();for(;r&&!(r===t||t.contains(r));){if(r.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING){o+=(r.nodeValue??"").length,r=n.nextNode();continue}break}return o}function a(e){let t=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),n="",o=t.nextNode();for(;o;)n+=o.nodeValue??"",o=t.nextNode();return n}function l(e,t,n){if(!Number.isInteger(t)||!Number.isInteger(n)||t<0||n<=t)return null;let o=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),r=0,i=null,a=0,l=null,s=0,d=o.nextNode();for(;d;){let e=r+(d.nodeValue?.length??0);if(!i&&t>=r&&t<e&&(i=d,a=t-r),n>r&&n<=e){l=d,s=n-r;break}r=e,d=o.nextNode()}if(!i||!l)return null;let c=document.createRange();try{c.setStart(i,a),c.setEnd(l,s)}catch{return null}return c}n.d(t,{c4:function(){return r},oW:function(){return l},p4:function(){return o},ti:function(){return a}})},46511:function(e,t,n){"use strict";n.d(t,{GC:function(){return i},QR:function(){return d},Vh:function(){return r},YA:function(){return a}});var o=n(7653);let r={stored:"mavis-chat-selection",active:"mavis-chat-selection-active"},i={stored:"mavis-preview-selection",active:"mavis-preview-selection-active"},a={stored:"mavis-file-panel-selection",active:"mavis-file-panel-selection-active"},l="mavis-chat-selection-highlight-style",s=`
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
`;function d(e,t,n){(0,o.useEffect)(()=>{if(!function(){let e=globalThis;return!!(e.CSS?.highlights&&"function"==typeof e.Highlight)}())return;!function(){if("undefined"==typeof document)return;let e=document.getElementById(l);if(e){e.textContent!==s&&(e.textContent=s);return}let t=document.createElement("style");t.id=l,t.textContent=s,document.head.appendChild(t)}();let o=globalThis,r=o.Highlight,i=o.CSS?.highlights;if(!i)return;let a=()=>{let o=[],a=[];for(let n of e)for(let e of n.resolveRanges?.()??(()=>{let e=n.resolveRange();return e?[e]:[]})())n.contextId===t?a.push(e):(n.shouldPaintStoredRange?.(e)??!0)&&o.push(e);i.delete(n.stored),i.delete(n.active),o.length>0&&i.set(n.stored,new r(...o)),a.length>0&&i.set(n.active,new r(...a))};a();let d=0,c=()=>{d||(d=window.requestAnimationFrame(()=>{d=0,a()}))};window.addEventListener("resize",c,{passive:!0}),window.addEventListener("scroll",c,{passive:!0,capture:!0});let u="undefined"==typeof MutationObserver||"undefined"==typeof document?null:new MutationObserver(c);return u?.observe(document.body,{childList:!0,subtree:!0,characterData:!0}),()=>{d&&window.cancelAnimationFrame(d),window.removeEventListener("resize",c),window.removeEventListener("scroll",c,{capture:!0}),u?.disconnect(),i.delete(n.stored),i.delete(n.active)}},[t,n,e])}},78173:function(e,t,n){"use strict";n.d(t,{G:function(){return d},O:function(){return c}});var o=n(27573),r=n(7653),i=n(32709),a=n(51904),l=n(45255),s=n(33278);let d=126;function c(e){let{mode:t,startLine:n,endLine:d,value:c,onSubmit:u,onSend:m,onCancel:f,onDelete:p,onEdit:h,submitOnOutsideClick:g=!1,bodyTestId:b,testIdPrefix:v}=e,[x,w]=(0,r.useState)(c),[y,k]=(0,r.useState)(c),[C,S]=(0,r.useState)(!1),[E,_]=(0,r.useState)(!1),[I,M]=(0,r.useState)(!1),N=(0,l.xL)(e=>e.subUserName||e.userName),B=(0,l.xL)(l.Jh);(0,r.useEffect)(()=>{M(!1)},[B]),(0,r.useEffect)(()=>{w(c),k(c)},[c]),(0,r.useEffect)(()=>{"composer"===t&&S(!1)},[t]);let L=(0,r.useCallback)(()=>{let e=y.trim();w(e),k(e),S(!0),_(!1),u(e)},[y,u]),R=(0,r.useCallback)(()=>{k(x),S(!0),f?.()},[x,f]);if("composer"===t&&!C)return(0,o.jsx)(s.j,{startLine:n,endLine:d,value:y,onChange:k,onSubmit:L,...m?{onSend:m}:{},onCancel:R,...p?{onDelete:p}:{},showCancel:!0,showDelete:!!p,optionalComment:!0,embedded:!0,deleteControl:"icon",submitOnOutsideClick:g,testIdPrefix:v});let O=(0,a.t)(n===d?"code_review.commented_on_line":"code_review.commented_on_lines",{startLine:n,endLine:d});return(0,o.jsxs)("div",{className:`flex w-full flex-col overflow-hidden rounded-2xl border border-border_light bg-bg_grouped_tertiary font-sans text-text_default_primary ${E?"":"min-h-[126px] max-h-[226px]"}`,"data-testid":v,"data-collapsed":E?"true":"false",children:[(0,o.jsxs)("button",{type:"button",className:"flex h-12 w-full shrink-0 items-center gap-1 p-2 text-left","data-testid":`${v}-toggle`,"aria-expanded":!E,onClick:()=>_(e=>!e),children:[(0,o.jsx)("span",{className:"flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg",children:B&&!I?(0,o.jsx)("img",{src:B,alt:N||(0,a.t)("message.item.sender_you"),className:"size-5 rounded-full object-cover",referrerPolicy:"no-referrer",crossOrigin:"anonymous",onError:()=>M(!0)}):(0,o.jsx)(i.vo$,{size:20,className:"text-icon_default_tertiary"})}),(0,o.jsx)("span",{className:"desktop-text-ui-body-strong min-w-0 flex-1 truncate text-[14px] font-medium leading-5",children:N||(0,a.t)("message.item.sender_you")}),(0,o.jsx)("span",{className:"desktop-text-ui-assist shrink-0 text-[12px] leading-4 text-text_default_tertiary",children:O}),E?(0,o.jsx)(i.DU3,{size:16,className:"shrink-0 text-icon_default_secondary"}):(0,o.jsx)(i.GiZ,{size:16,className:"shrink-0 text-icon_default_secondary"})]}),E?null:(0,o.jsxs)("div",{className:"flex min-h-0 flex-1 flex-col",children:[x.trim()?(0,o.jsx)("button",{type:"button",className:"desktop-text-chat-body block min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-3 text-left text-[14px] leading-5 text-text_default_primary","data-testid":b??`${v}-body`,onClick:h,children:x}):null,p||h?(0,o.jsxs)("div",{className:"mt-auto flex shrink-0 items-center justify-end gap-2 px-3 pb-3",children:[(0,o.jsx)("div",{className:"mr-auto flex min-w-0 items-center gap-2",children:p?(0,o.jsx)("button",{type:"button",className:"flex size-8 shrink-0 items-center justify-center rounded-lg text-text_default_tertiary transition-colors hover:bg-bg_interaction_secondary_hover hover:text-text_status_error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border_accent","aria-label":(0,a.t)("common.delete"),"data-testid":`${v}-delete`,onClick:p,children:(0,o.jsx)(i.pJl,{size:18})}):null}),h?(0,o.jsx)("button",{type:"button",className:"desktop-text-ui-small-strong flex h-8 min-w-[68px] items-center justify-center rounded-lg bg-bg_interaction_secondary_default px-3 text-[14px] font-medium leading-5 text-text_label_secondary_default transition-colors hover:bg-bg_interaction_secondary_hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border_accent","data-testid":`${v}-edit`,onClick:h,children:(0,a.t)("common.edit")}):null]}):null]})]})}},77635:function(e,t,n){"use strict";n.d(t,{A:function(){return D}});var o=n(27573),r=n(53559),i=n(8556),a=n(7653),l=n(3458),s=n(96541),d=n(51904),c=n(42940),u=n(95777),m=n(26063),f=n(34721),p=n(8770),h=n(47482),g=n(78173);let b=g.G+8+12;function v(e){let t=Number(e.attributes.endLine||e.attributes.startLine||1);return Number.isFinite(t)&&t>0?Math.floor(t):1}function x(e){let{block:t,zIndex:n,onSave:r,onEdit:i,onDelete:l,onComposerHostChange:s,onHeightChange:d}=e,c=t.item,u=(0,a.useRef)(null),f=(0,a.useRef)(null);return(0,a.useLayoutEffect)(()=>{if(t.composer&&t.portalComposer)return s?.(f.current),()=>s?.(null)},[t.composer,t.portalComposer,s]),(0,a.useLayoutEffect)(()=>{let e=u.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||b);n>0&&d(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,d]),(0,o.jsx)("div",{ref:u,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":`code-text-selection-inline-comment-${t.id}`,style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:t.composer?c?t.portalComposer?(0,o.jsx)("div",{ref:f,className:"pointer-events-auto w-full"}):(0,o.jsx)("div",{className:"pointer-events-auto w-full",children:(0,o.jsx)(g.O,{mode:"composer",startLine:Number(c.attributes.startLine||v(c)),endLine:v(c),value:c.feedback,onSubmit:e=>r?.(m.Sb(c,e)),onCancel:()=>l?.(c.contextId),...l?{onDelete:()=>l(c.contextId)}:{},submitOnOutsideClick:!0,testIdPrefix:"code-text-selection-comment"})}):null:c?(0,o.jsx)("div",{className:"pointer-events-auto w-full",children:(0,o.jsx)(g.O,{mode:"comment",startLine:Number(c.attributes.startLine||v(c)),endLine:v(c),value:c.feedback,onSubmit:e=>r?.({...c,feedback:e}),onEdit:()=>i?.(c),bodyTestId:`code-text-selection-inline-comment-composer-text-${c.contextId}`,...l?{onDelete:()=>l(c.contextId)}:{},testIdPrefix:`code-text-selection-comment-card-${c.contextId}`})}):null})})}var w=n(2186);function y(e){let{block:t,zIndex:n,onHandle:r,onHeightChange:i}=e,l=(0,a.useRef)(null);return(0,a.useLayoutEffect)(()=>{let e=l.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||200);n>0&&i(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,i]),(0,o.jsx)("div",{ref:l,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":"code-review-inline-comment-block",style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:(0,o.jsx)(w.Z,{comment:t.comment,path:t.path,className:"pointer-events-auto w-full",testId:"code-review-inline-comment",toggleTestId:"code-review-comment-toggle",handleTestId:"code-review-handle-comment",...r?{onHandle:r}:{}})})})}var k=n(5268),C=n(77575),S=n(10853),E=n(18397),_=n(32425);let I="mavis-code-chat-selection",M="mavis-code-chat-selection-highlight-style",N=`
::highlight(${I}) {
  background-color: var(--bg_interaction_accent_focus_highlight);
  color: var(--text_default_primary);
}
`;function B(){let e=globalThis;e.CSS?.highlights?.delete(I)}function L(e,t,n,r){if(0===n.length)return e;let i=[],a=0;for(let l of n){let n=Math.max(0,l.start-t),s=Math.min(e.length,l.end-t);if(s<=0||n>=e.length||s<=n)continue;n>a&&i.push(e.slice(a,n));let d=r?.lineIndex===l.lineIndex&&r.start===l.start&&r.end===l.end;i.push((0,o.jsx)("mark",{"data-testid":"code-view-find-match","data-current":d?"true":void 0,className:d?"rounded-[2px] bg-bg_interaction_accent_focus_highlight text-text_default_primary":"rounded-[2px] bg-[color-mix(in_srgb,var(--warning_500)_28%,transparent)] text-inherit",children:e.slice(n,s)},`${l.lineIndex}:${l.start}:${t}`)),a=s}return a<e.length&&i.push(e.slice(a)),i.length>0?i:e}function R(){return new Promise(e=>{if("function"==typeof window.requestAnimationFrame){window.requestAnimationFrame(e);return}window.setTimeout(()=>e(performance.now()),16)})}async function O(e,t,n){let o=performance.now();for(;performance.now()-o<1200;){if(Array.from(e.querySelectorAll(".code-view-row[data-line]")).some(e=>{let o=Number(e.dataset.line);return Number.isInteger(o)&&o>=t&&o<=n}))return!0;await R()}return!1}async function T(e){let t=performance.now(),n=t,o=e.scrollTop;for(;performance.now()-t<800;){await R();let t=performance.now();if(Math.abs(e.scrollTop-o)>.5){o=e.scrollTop,n=t;continue}if(t-n>=80)return}}function j(e){let t=window.getSelection?.();if(!t||0===t.rangeCount||t.isCollapsed)return null;let n=t.toString().trimEnd();if(!n.trim())return null;let o=t.getRangeAt(0);try{if(!o.intersectsNode(e))return null}catch{if(!e.contains(o.commonAncestorContainer))return null}let r=function(e,t){let n=[];return(t.querySelectorAll(".code-view-row").forEach(t=>{let o=function(e){let t=Number(e.getAttribute("data-index"));return!Number.isInteger(t)||t<0?null:t+1}(t);if(null!==o)try{e.intersectsNode(t)&&n.push(o)}catch{}}),0===n.length)?null:[Math.min(...n),Math.max(...n)]}(o,e);if(!r)return null;let i=e.querySelector(`.code-view-row[data-line='${r[0]}'] .code-view-line-content`),a=e.querySelector(`.code-view-row[data-line='${r[1]}'] .code-view-line-content`),l=i?(0,u.c4)(i,o.startContainer,o.startOffset):-1,s=a?(0,u.c4)(a,o.endContainer,o.endOffset):-1;return{selectedText:n,startLine:r[0],endLine:r[1],...l>=0?{startColumn:l}:{},...s>=0?{endColumn:s}:{}}}function $(e){return"edit"===e.attributes.intent||"edit"===e.attributes.requestedAction||"edit"===e.attributes.sourceAction}function D(e){let{content:t,fileName:l,filePath:d,overlayRightInset:u="0px",onAddSelectionToChat:w,onTextSelectionComment:D,onTextSelectionSend:P,onTextSelectionCommentRemove:z,onTextSelectionEditComposerChange:W,onTextSelectionEditAccept:F,onTextSelectionEditReject:q,enableTextSelectionEditAction:U=!1,textSelectionEditDiffs:K=[],textSelectionComments:V=[],textSelectionCommentVariant:Q,showCommentAnchors:X=!0,showCommentHighlights:Y=!0,commentHighlightNames:G,selectionSurface:J,hideInlineCommentBlock:Z=!1,textSelectionEditRequest:ee,lineStart:et,lineEnd:en,focusRequestId:eo,onFocusRequestConsumed:er,reviewComment:ei,onHandleReviewComment:ea}=e,el=(0,r.fP)(),es=null!==el,ed=(0,S.G)(),ec=(0,E.yd)(),eu=(0,_.getDesktopTypographyScene)(ed).code.block,em=ec?eu.lineHeight:18,ef=(0,a.useRef)(null),ep=(0,a.useRef)(null),eh=(0,a.useRef)(null),eg=(0,a.useRef)(0),eb=(0,a.useRef)(0),ev=(0,a.useRef)(null),ex=(0,a.useRef)(!1),ew=(0,a.useRef)(!1),ey=(0,a.useRef)(null),[ek,eC]=(0,a.useState)(!1),[eS,eE]=(0,a.useState)(null),[e_,eI]=(0,a.useState)(null),[eM,eN]=(0,a.useState)(null),eB=(0,a.useRef)(null),[eL,eR]=(0,a.useState)(null),[eO,eT]=(0,a.useState)(null),[ej,e$]=(0,a.useState)(null),eD=(0,a.useRef)(0),[eA,eH]=(0,a.useState)(!1),[eP,ez]=(0,a.useState)(""),[eW,eF]=(0,a.useState)(0),eq="large"===Q&&!Z,eU=(0,k.vL)(e=>e.fileLineWrapEnabled);(0,a.useEffect)(()=>{"large"!==Q&&(eR(null),eT(null))},[t,d,Q]);let eK=(0,a.useMemo)(()=>t?t.split("\n"):Array.from({length:2},()=>""),[t]),eV=(0,a.useMemo)(()=>V.map(e=>(function(e,t,n,o){let r=Number(e.attributes.sourceStartOffset),i=Number(e.attributes.sourceEndOffset),a=Number.isFinite(r)&&r>=0&&r<=t.length?r:void 0,l=Number.isFinite(i)&&i>=0&&i<=t.length?i:void 0,s=Number(e.attributes.startLine),d=Number(e.attributes.endLine);if("markdown-preview"!==e.attributes.source&&s>0&&d>0)return e;let c=Number(e.attributes.markdownStartOffset??e.attributes.startOffset),u=Number(e.attributes.markdownOccurrenceIndex),m=(0,h.P)(t,e.text,Number.isFinite(c)?c:void 0,Number.isSafeInteger(u)&&u>=0?u:void 0),f="markdown-preview"===e.attributes.source&&void 0!==a&&void 0!==l&&function(e,t,n,o){if(o<=n)return!1;let r=e.slice(n,o),i=(0,h.P)(r,t);return i?.startOffset===0&&i.endOffset===r.length}(t,e.text,a,l),p="markdown-preview"===e.attributes.source?f?a:m?.startOffset:a??m?.startOffset;if(void 0===p)return e;let g="markdown-preview"===e.attributes.source?f?l:m?.endOffset??p+e.text.length:l??m?.endOffset??p+e.text.length,b=t.slice(0,p).split("\n").length,v=t.slice(0,Math.max(p,g)).split("\n").length;return{...e,targetPath:`${o||n}:${b}-${v}`,attributes:{...e.attributes,startLine:String(b),endLine:String(v)}}})(e,t,l,d)),[t,l,d,V]),eQ=(0,a.useMemo)(()=>(function(e,t){let n=t.trim().toLowerCase();if(!n)return[];let o=[];for(let t=0;t<e.length;t+=1){let r=(e[t]??"").toLowerCase(),i=0;for(;i<=r.length;){let e=r.indexOf(n,i);if(e<0)break;let a=e+n.length;o.push({lineIndex:t,start:e,end:a}),i=Math.max(a,e+1)}}return o})(eK,eP),[eP,eK]),eX=eQ[eW],eY=(0,a.useMemo)(()=>{let e=new Map;for(let t of eQ){let n=e.get(t.lineIndex);n?n.push(t):e.set(t.lineIndex,[t])}return e},[eQ]),eG=String(eK.length).length,eJ=(0,a.useMemo)(()=>(function(e){let t=1;for(let n of e)t=Math.max(t,function(e){let t=0;for(let n of e)"	"===n?t+=4-t%4:t+=1;return t}(n));return t+2})(eK),[eK]),eZ=void 0===et||0===eK.length?void 0:Math.max(1,Math.min(eK.length,et)),e0=void 0===eZ?void 0:Math.max(eZ,Math.min(eK.length,en??eZ)),[e1,e2]=(0,a.useState)(()=>void 0===eZ||void 0===e0?null:{lineStart:eZ,lineEnd:e0,...void 0!==eo?{requestId:eo}:{}}),e5=e1?.lineStart,e4=e1?.lineEnd,e3=e1?.requestId;(0,a.useEffect)(()=>{if(void 0===eZ||void 0===e0){er||e2(null);return}e2(e=>e?.lineStart===eZ&&e.lineEnd===e0&&e.requestId===eo?e:{lineStart:eZ,lineEnd:e0,...void 0!==eo?{requestId:eo}:{}})},[eo,er,e0,eZ]);let e8=(0,a.useMemo)(()=>{let e=new Map;if(ei){let t=Math.max(1,Math.min(eK.length,ei.endLine));e.set(t,200)}if(Z)return e;let t=eL?.contextId;for(let n of[...eV.filter(e=>e.contextId!==t&&!$(e)),...eL?[eL]:[]]){let t=v(n);e.set(t,(e.get(t)??0)+b)}return e},[Z,eL,eK.length,eV,ei]),e7=(0,s.MG)({count:eK.length,getScrollElement:()=>ef.current,estimateSize:e=>em+(e8.get(e+1)??0),overscan:20,measureElement:e=>{let t=e.querySelector(".code-view-line-main"),n=Math.ceil(t?.getBoundingClientRect().height||t?.offsetHeight||em);return Math.max(em,n+Array.from(e.querySelectorAll(".code-view-inline-comment")).reduce((e,t)=>e+Math.ceil(t.getBoundingClientRect().height||t.offsetHeight||b),0))}}),e6=e7.scrollToIndex,e9=(0,a.useCallback)(()=>{let e=ef.current;e&&e.querySelectorAll(".code-view-row").forEach(e=>{e7.measureElement(e)})},[e7]),te=(0,a.useCallback)(()=>{if(null!==ey.current)return;let e=window.requestAnimationFrame(()=>{e9(),ey.current===e&&(ey.current=null)});ey.current=e},[e9]);(0,a.useEffect)(()=>{eF(0)},[eP,t]),(0,a.useEffect)(()=>{eW<eQ.length||eF(Math.max(0,eQ.length-1))},[eW,eQ.length]),(0,a.useEffect)(()=>{eA&&eX&&e6(eX.lineIndex,{align:"center",behavior:"smooth"})},[eX,eA,e6]),(0,a.useEffect)(()=>{te()},[em,t,eU,te]),(0,a.useEffect)(()=>{if(!eU)return;let e=ef.current;if(!e||"undefined"==typeof ResizeObserver)return;let t=new ResizeObserver(()=>{te()});return t.observe(e),te(),()=>{t.disconnect(),null!==ey.current&&(window.cancelAnimationFrame(ey.current),ey.current=null)}},[eU,te]),(0,a.useEffect)(()=>{let e=ef.current;if(!e||void 0===e5||void 0===e4){eI(null);return}let t=Math.floor((e5+e4)/2)-1,n=Math.max(0,e5-10-1),o=eb.current+1;eb.current=o;let r=!1;return void 0!==e3&&er?.(e3),eI(null),e6(n,{align:"center",behavior:"auto"}),(async()=>{await R(),!r&&(e6(t,{align:"center",behavior:"smooth"}),await O(e,e5,e4)&&!r&&(await T(e),r||eI(`${e3??"range"}:${o}`)))})(),()=>{r=!0}},[e3,e4,e5,er,e6]),(0,a.useEffect)(()=>{let e=ef.current;if(!e)return;let t=()=>{eC(!0),ev.current&&window.clearTimeout(ev.current),ev.current=window.setTimeout(()=>{eC(!1),ev.current=null},700)};return e.addEventListener("scroll",t,{passive:!0}),()=>{e.removeEventListener("scroll",t),ev.current&&(window.clearTimeout(ev.current),ev.current=null)}},[]);let tt=eK.length;(0,a.useEffect)(()=>{let e=ef.current;if(!e)return;let n=n=>{let o=window.getSelection();if(!o||0===o.rangeCount||o.isCollapsed)return;let r=o.getRangeAt(0);try{if(!r.intersectsNode(e))return}catch{return}if(ex.current){n.preventDefault(),n.clipboardData?.setData("text/plain",t),ex.current=!1;return}let i=e.querySelectorAll(".code-view-row");if(0!==i.length&&!(tt<=i.length))try{let e=i[0],o=i[i.length-1];e&&o&&r.intersectsNode(e)&&r.intersectsNode(o)&&(n.preventDefault(),n.clipboardData?.setData("text/plain",t))}catch{}};return e.addEventListener("copy",n),()=>e.removeEventListener("copy",n)},[t,tt]),(0,a.useEffect)(()=>{if(!eM)return;let e=e=>{let t=e.target;t instanceof Node&&ep.current?.contains(t)||eN(null)},t=e=>{let t=e.target;if(t instanceof Node&&ep.current?.contains(t)){e.preventDefault();return}eN(null)},n=e=>{"Escape"===e.key&&eN(null)},o=()=>eN(null);return window.addEventListener("pointerdown",e,!0),window.addEventListener("contextmenu",t,!0),window.addEventListener("resize",o),window.addEventListener("scroll",o,!0),window.addEventListener("keydown",n),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("contextmenu",t,!0),window.removeEventListener("resize",o),window.removeEventListener("scroll",o,!0),window.removeEventListener("keydown",n)}},[eM]),(0,a.useEffect)(()=>{let e=e=>{let t=ef.current;ew.current=!!(null!==t&&e.target instanceof Node)&&t.contains(e.target)},t=e=>{var t;if(!ew.current||!(!e.altKey&&(e.ctrlKey||e.metaKey)&&"a"===e.key.toLowerCase())||(t=e.target)instanceof HTMLElement&&t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'))return;let n=ef.current;n&&function(e){let t=e.querySelectorAll(".code-view-line-content"),n=t[0],o=t[t.length-1];if(!n||!o)return!1;let r=window.getSelection?.();if(!r)return!1;let i=document.createRange();return i.setStartBefore(n),i.setEndAfter(o),r.removeAllRanges(),r.addRange(i),!0}(n)&&(e.preventDefault(),e.stopPropagation(),ex.current=!0,eN(null))};return window.addEventListener("pointerdown",e,!0),window.addEventListener("keydown",t),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("keydown",t)}},[]),(0,a.useEffect)(()=>{if(!t){eE(null);return}let e=eh.current??function(){if("undefined"==typeof Worker)return null;try{return new Worker(n.tu(new URL(n.p+n.u(4647),n.b)),{type:void 0})}catch{return null}}();if(eh.current=e,!e)return;let o=eg.current+1;eg.current=o;let r=e=>{let t=e.data;t.id===eg.current&&"success"===t.type&&"tokens"in t&&eE(t.tokens)},i=t=>{t.preventDefault(),eE(null),e.terminate(),eh.current===e&&(eh.current=null)};e.addEventListener("message",r),e.addEventListener("error",i);try{e.postMessage({type:"highlight",id:o,code:t,fileName:l,...es?{desktopSemanticColors:!0}:{}})}catch{e.removeEventListener("message",r),e.removeEventListener("error",i),e.terminate(),eh.current===e&&(eh.current=null);return}return()=>{e.removeEventListener("message",r),e.removeEventListener("error",i)}},[t,l,es]),(0,a.useEffect)(()=>()=>{eh.current?.terminate(),eh.current=null,B()},[]),(0,a.useEffect)(()=>{B()},[t,d]);let tn=(0,a.useCallback)(e=>{let t=ef.current;if(!t)return;let n=j(t),o=window.getSelection?.();eB.current=o&&o.rangeCount>0&&!o.isCollapsed?o.getRangeAt(0).cloneRange():null,e.preventDefault(),e.stopPropagation(),eN(function(e,t){let n=Number.isFinite(e.clientX)?e.clientX:8,o=Number.isFinite(e.clientY)?e.clientY:8;return{x:Math.min(Math.max(8,n),Math.max(8,window.innerWidth-176-8)),y:Math.min(Math.max(8,o),Math.max(8,window.innerHeight-120-8)),selection:t}}(e,n))},[]),to=(0,a.useCallback)(()=>{ex.current=!1,B()},[]),tr=(0,a.useCallback)(()=>{eF(e=>0===eQ.length?0:(e+1)%eQ.length)},[eQ.length]),ti=(0,a.useCallback)(()=>{eF(e=>0===eQ.length?0:(e-1+eQ.length)%eQ.length)},[eQ.length]),ta=(0,a.useCallback)(()=>{C.o.getState().closeSearch(),eH(!0)},[]),tl=async()=>{eM?.selection&&(await (0,c.v)(eM.selection.selectedText),eN(null))},ts=async()=>{await (0,c.v)(t),eN(null)},td=async()=>{if(eM?.selection&&w)try{await w({selectedText:eM.selection.selectedText,startLine:eM.selection.startLine,endLine:eM.selection.endLine})}finally{let e=eB.current,t=window.getSelection?.();e&&t&&(t.removeAllRanges(),t.addRange(e),function(e){let t=globalThis,n=t.CSS?.highlights,o=t.Highlight;if(!n||"function"!=typeof o||"undefined"==typeof document)return;let r=document.getElementById(M);r||((r=document.createElement("style")).id=M,document.head.appendChild(r)),r.textContent!==N&&(r.textContent=N),n.set(I,new o(e.cloneRange()))}(e)),eB.current=null,eN(null)}},tc=`calc(${eG}ch + 14px)`,tu=e7.getVirtualItems(),tm=tu.length>0?tu:Array.from({length:Math.min(eK.length,21)},(e,t)=>({index:t,key:`fallback-${t}`,start:t*em})),tf=(0,a.useMemo)(()=>{if(!eq)return[];let e=eL?.contextId,t=!1,n=eV.flatMap(n=>$(n)?[]:n.contextId===e?eL?(t=!0,[{id:`composer-${eL.contextId}`,afterLineNumber:v(eL),item:eL,composer:!0,portalComposer:!0}]):[]:[{id:`comment-${n.contextId}`,afterLineNumber:v(n),item:n,composer:!(0,m.t_)(n)}]);return eL&&!t&&n.push({id:`composer-${eL.contextId}`,afterLineNumber:v(eL),item:eL,composer:!0,portalComposer:!0}),n.sort((e,t)=>e.afterLineNumber-t.afterLineNumber)},[eq,eL,eV]),tp=(0,a.useMemo)(()=>{let e=tf.map(e=>({kind:"comment",...e}));return ei&&e.push({kind:"review-comment",id:`review-comment-${ei.id}`,afterLineNumber:Math.max(1,Math.min(eK.length,ei.endLine)),comment:ei,path:d??l}),e.sort((e,t)=>e.afterLineNumber-t.afterLineNumber)},[l,d,tf,eK.length,ei]),th=(0,a.useMemo)(()=>{let e=new Map,t=tp.length;return tp.forEach((n,o)=>{e.set(n.id,t-o)}),e},[tp]),tg=(0,a.useMemo)(()=>{let e=new Map;for(let t of tp){let n=e.get(t.afterLineNumber);n?n.push(t):e.set(t.afterLineNumber,[t])}return e},[tp]),[tb,tv]=(0,a.useState)({});(0,a.useEffect)(()=>{tv(e=>{let t={};for(let n of tp){let o=e[n.id];void 0!==o&&(t[n.id]=o)}let n=Object.keys(e),o=Object.keys(t);if(n.length!==o.length)return t;for(let n of o)if(e[n]!==t[n])return t;return e})},[tp]);let tx=(0,a.useCallback)((e,t)=>{tv(n=>n[e]===t?n:{...n,[e]:t})},[]);(0,a.useLayoutEffect)(()=>{te()},[tb,tp,te]);let tw=(0,a.useCallback)(e=>{if(W?.(!1),"large"!==Q){eR(null),eT(null),e$(null);return}eR(e),e||(eT(null),e$(null))},[W,Q]),ty=(0,a.useCallback)(e=>{eR(e),eD.current-=1,e$({token:eD.current,contextId:e.contextId})},[]),tk=(0,a.useCallback)(e=>{P?.(e)},[P]),tC={...(0,i.cC)(el),"--code-line-number-width":tc,"--code-content-min-width":`calc(var(--code-line-number-width) + ${eJ}ch)`,"--code-view-overlay-right-inset":u};return(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("style",{children:`
        .code-view {
          --code-line-height: ${em}px;
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
      `}),(0,o.jsxs)("div",{className:"relative h-full w-full min-w-0","data-app-shortcut-priority":"text-editor",children:[(0,o.jsx)("div",{ref:ef,className:`code-view mavis-desktop-typography-fixed relative h-full w-full min-w-0 font-mono ${eU?"overflow-y-auto overflow-x-hidden":"overflow-auto"} ${ek?"is-scrolling":""}`,"data-line-wrap":eU?"true":"false",style:tC,onContextMenu:tn,onPointerDownCapture:to,children:(0,o.jsx)("div",{className:"code-view-spacer",style:{height:`${e7.getTotalSize()}px`},children:tm.map(e=>{let n=e.index,r=n+1,i=null!==e_&&void 0!==e5&&void 0!==e4&&r>=e5&&r<=e4,a=eS?.length===eK.length?eS[n]:void 0,l=eY.get(n)??[];return(0,o.jsxs)("div",{"data-index":n,"data-line":r,"data-focus-highlight":i?"true":void 0,"data-focus-highlight-key":i?e_:void 0,className:"code-view-row",ref:e7.measureElement,style:{transform:`translateY(${e.start}px)`,...eU?{boxSizing:"border-box",paddingRight:u}:{}},children:[(0,o.jsxs)("div",{className:"code-view-line-main",children:[(0,o.jsx)("span",{className:"code-view-line-number",children:n+1}),(0,o.jsx)("div",{className:"code-view-line-body",children:(0,o.jsx)("span",{className:"code-view-line-content",children:a?function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:[],n=arguments.length>2?arguments[2]:void 0,r=0;return e.map((e,i)=>{let a=r;return r+=e.content.length,(0,o.jsx)("span",{className:"code-token",style:function(e){if(e.htmlStyle)return e.htmlStyle;let t={};return e.color&&(t.color=e.color),e.bgColor&&(t.backgroundColor=e.bgColor),Object.keys(t).length>0?t:void 0}(e),children:L(e.content,a,t,n)},`${e.offset}:${i}`)})}(a,l,eX):L(eK[n]??"",0,l,eX)})})]}),tg.get(r)?.map(e=>"edit-review"===e.kind?o.jsx(H,{block:e,zIndex:th.get(e.id),content:t,onAccept:F,onReject:q,onRemoveComment:z,onHeightChange:tx},e.id):"review-comment"===e.kind?o.jsx(y,{block:e,zIndex:th.get(e.id),onHandle:ea,onHeightChange:tx},e.id):o.jsx(x,{block:e,zIndex:th.get(e.id),onSave:D,onEdit:ty,onDelete:z,onComposerHostChange:eT,onHeightChange:tx},e.id))??null]},e.key)})})}),(0,o.jsx)(p.j,{hostRef:ef,isOpen:eA,query:eP,matchCount:eQ.length,currentIndex:eW,testIdPrefix:"code-view",rightInset:u,onOpen:ta,onClose:()=>eH(!1),onQueryChange:ez,onNext:tr,onPrevious:ti})]}),(0,o.jsx)(A,{refEl:ep,contextMenu:eM,canAddToChat:!!w,onCopy:()=>void tl(),onCopyAll:()=>void ts(),onAddToChat:()=>void td()}),(0,o.jsx)(f.k4,{hostRef:ef,fileName:l,filePath:d,sourceLabel:"code-view",onAddComment:D,onSendComment:tk,onRemoveComment:z,commentItems:eV,openEditRequest:ej??ee,commentVariant:Q,editComposerVariant:"large",keepComposerOpenOnSubmit:!1,showCommentAnchors:X,showCommentHighlights:Y,commentHighlightNames:G,selectionSurface:J,composerPlacement:eq?"inline":"floating",getInlineComposerHost:()=>eO,onOpenComposerChange:tw,renderComposer:eq?e=>{let{item:t,onSubmit:n,onSend:r,onCancel:i,onDelete:a,testIdPrefix:l}=e;return(0,o.jsx)(g.O,{mode:"composer",startLine:Number(t.attributes.startLine||v(t)),endLine:v(t),value:t.feedback,onSubmit:n,...r?{onSend:r}:{},onCancel:i,...a?{onDelete:a}:{},submitOnOutsideClick:!0,testIdPrefix:l})}:void 0,getSelectionMetadata:()=>{let e=ef.current,t=e?j(e):null;return{targetPath:t?`${d||l}:${t.startLine}-${t.endLine}`:d||l,attributes:t?{startLine:String(t.startLine),endLine:String(t.endLine),...void 0===t.startColumn?{}:{startColumn:String(t.startColumn)},...void 0===t.endColumn?{}:{endColumn:String(t.endColumn)}}:void 0}},testIdPrefix:"code-text-selection"})]})}function A(e){let{refEl:t,contextMenu:n,canAddToChat:r,onCopy:i,onCopyAll:a,onAddToChat:s}=e;if(!n||"undefined"==typeof document)return null;let c=null!==n.selection,u="block w-full rounded-lg px-3 py-1.5 text-left text-text_default_primary transition-colors hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:text-text_default_tertiary disabled:hover:bg-transparent";return(0,l.createPortal)((0,o.jsxs)("div",{ref:e=>{t.current=e},role:"menu","data-testid":"code-selection-context-menu",className:"mavis-file-context-menu desktop-text-ui-body fixed z-[100] w-44 rounded-[12px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-1 text-sm text-text_default_primary shadow-[0_0_20px_rgba(10,10,10,0.08)]",style:{left:n.x,top:n.y},onClick:e=>e.stopPropagation(),onContextMenu:e=>e.preventDefault(),children:[c&&(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-copy",className:u,onClick:i,children:(0,d.t)("common.copy")}),(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-copy-all",className:u,onClick:a,children:(0,d.t)("common.copy_all")}),c&&(0,o.jsx)("button",{type:"button",role:"menuitem","data-testid":"code-selection-context-menu-add-to-chat",disabled:!r,className:u,onClick:s,children:(0,d.t)("file_panel.add_to_chat")})]}),document.body)}function H(e){let{block:t,zIndex:n,content:r,onAccept:i,onReject:l,onRemoveComment:s,onHeightChange:c}=e,[u,m]=(0,a.useState)(null),f=(0,a.useRef)(null);(0,a.useEffect)(()=>{m(null)},[t.id]),(0,a.useLayoutEffect)(()=>{let e=f.current;if(!e)return;let n=()=>{let n=Math.ceil(e.getBoundingClientRect().height||e.offsetHeight||260);n>0&&c(t.id,n)};if(n(),"undefined"==typeof ResizeObserver)return;let o=new ResizeObserver(n);return o.observe(e),()=>o.disconnect()},[t.id,c]);let p=(0,a.useCallback)(()=>{if(i){i(t.item.contextId);return}s?.(t.item.contextId)},[t.item.contextId,i,s]),h=(0,a.useCallback)(async()=>{if(l){m("reject");try{await l(t.item.contextId,function(e,t){let n=e.split("\n"),o=Math.max(0,Math.min(n.length,t.startLine-1)),r=Math.max(0,t.endLine-t.startLine+1),i=t.text.length>0?t.text.split("\n"):[];return n.splice(o,r,...i),n.join("\n")}(r,t.replacement))}finally{m(null)}}},[t.item.contextId,t.replacement,r,l,s]);return(0,o.jsx)("div",{ref:f,className:"code-view-inline-comment pointer-events-none box-border w-full basis-full","data-testid":`code-text-selection-edit-review-${t.item.contextId}`,style:void 0!==n?{position:"relative",zIndex:n}:void 0,children:(0,o.jsx)("div",{className:"box-border",style:{width:"100%",paddingLeft:"calc(var(--code-line-number-width) + 16px)",paddingRight:16,paddingTop:8,paddingBottom:12},children:(0,o.jsxs)("div",{className:"pointer-events-auto overflow-hidden rounded-2xl border-[0.5px] border-border_default bg-bg_default_primary shadow-[0_10px_24px_rgba(0,0,0,0.06)]",children:[(0,o.jsxs)("div",{className:"border-b-[0.5px] border-border_default px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-small-strong mb-2 text-[12px] font-medium text-text_default_secondary",children:(0,d.t)("file_panel.edit_review_title")}),(0,o.jsxs)("div",{className:"overflow-hidden rounded-xl border-[0.5px] border-border_default bg-bg_grouped_secondary/50",children:[(0,o.jsxs)("div",{className:"border-l-4 border-l-text_status_error bg-red-500/10 px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-assist mb-2 inline-flex rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-text_status_error",children:(0,d.t)("file_panel.edit_review_before")}),(0,o.jsx)("div",{className:"desktop-text-code-diff whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-text_default_primary",children:t.beforeText})]}),(0,o.jsxs)("div",{className:"border-l-4 border-l-text_status_success bg-green-500/10 px-4 py-3",children:[(0,o.jsx)("div",{className:"desktop-text-ui-assist mb-2 inline-flex rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-text_status_success",children:(0,d.t)("file_panel.edit_review_after")}),(0,o.jsx)("div",{className:"desktop-text-code-diff whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-text_default_primary",children:t.afterText})]})]})]}),(0,o.jsxs)("div",{className:"flex justify-end gap-2 px-4 py-3",children:[(0,o.jsx)("button",{type:"button","data-testid":`code-text-selection-edit-review-reject-${t.item.contextId}`,className:"desktop-text-ui-body-strong rounded-lg border border-border_default px-4 py-1.5 text-sm text-text_status_error transition-colors hover:bg-bg_interaction_tertiary_hover disabled:opacity-50",disabled:null!==u,onClick:()=>void h(),children:(0,d.t)("file_panel.edit_review_reject")}),(0,o.jsx)("button",{type:"button","data-testid":`code-text-selection-edit-review-accept-${t.item.contextId}`,className:"desktop-text-ui-body-strong rounded-lg border border-border_default px-4 py-1.5 text-sm text-text_status_success transition-colors hover:bg-bg_interaction_tertiary_hover",disabled:null!==u,onClick:p,children:(0,d.t)("file_panel.edit_review_accept")})]})]})})})}},360:function(e,t,n){"use strict";n.d(t,{m:function(){return C}});var o=n(27573),r=n(7653),i=n(59403),a=n(51459),l=n(90321),s=n(84991),d=n(51904),c=n(32425),u=n(67699);let m=i.OQ,f=i.GL,p={surface:"chat-selection",contextId:"standalone-comment-composer",selectionKind:"unknown"};function h(e){return"large"===e?"edit":"create"}function g(e){return`var(${e})`}let b={pointerEvents:"none"},v="mavis-chat-selection-comment-placeholder-style";function x(e,t){return"edit"===h(e)||t}function w(e){let t=arguments.length>1&&void 0!==arguments[1]&&arguments[1],n="edit"===h(e)?m.edit:m.create,o=x(e,t);return{display:"flex",flexDirection:o?"column":"row",alignItems:o?"stretch":"center",boxSizing:"border-box",minHeight:n.height,gap:o?m.edit.gap:n.gap,border:`${m.wrapper.borderWidth}px solid ${g(f.border)}`,borderRadius:m.wrapper.borderRadius,background:g(f.surface),boxShadow:`0 0 ${m.wrapper.shadowBlur}px ${g(f.shadow)}`,padding:o?`${m.wrapper.padding.top}px ${m.wrapper.stackedPaddingX}px ${m.wrapper.padding.bottom}px ${m.wrapper.stackedPaddingX}px`:`${m.wrapper.padding.top}px ${m.wrapper.padding.right}px ${m.wrapper.padding.bottom}px ${m.wrapper.padding.left}px`}}function y(e){let t=arguments.length>1&&void 0!==arguments[1]&&arguments[1],n="edit"===h(e)?m.edit:m.create,o=x(e,t),r=o?m.edit.inputRowPaddingY:m.create.inputRowPaddingY;return{display:"flex",minWidth:0,width:o?"100%":"auto",minHeight:n.inputRowHeight,flex:o?"0 0 auto":"1 1 auto",alignItems:"flex-start",boxSizing:"border-box",padding:`${r}px 0`}}function k(e){return{flex:"0 0 auto",width:m.deleteButton.size,height:m.deleteButton.size,padding:0,border:0,borderRadius:0,display:"inline-flex",alignItems:"center",justifyContent:"center",cursor:m.actionButton.enabledCursor,transition:m.deleteButton.transition,background:"transparent",color:e?g(f.tertiaryHover):g(f.tertiaryIcon)}}let C=(0,r.forwardRef)(function(e,t){let{anchorContext:n=p,initialValue:C="",placeholder:S,variant:E="small",onSubmit:_,onSend:I,allowEmptySend:M=!1,onCancel:N,onDelete:B,autoFocus:L=m.behavior.focusOnOpen,inputAriaLabel:R,className:O,style:T,testIdPrefix:j="chat-selection-comment"}=e,[$,D]=(0,r.useState)(C),[A,H]=(0,r.useState)(!1),[P,z]=(0,r.useState)(!1),[W,F]=(0,r.useState)(!1),q=(0,r.useRef)(!1),U=(0,r.useRef)(null),K=h(E),[V,Q]=(0,r.useState)(!1),X=x(E,V);(0,r.useEffect)(()=>{!function(){if("undefined"==typeof document||document.getElementById(v))return;let e=document.createElement("style");e.id=v,e.textContent=`[data-mavis-chat-selection-comment-input]::placeholder { color: ${g(f.placeholder)}; opacity: 1; }`,document.head.appendChild(e)}()},[]),(0,r.useEffect)(()=>{0===$.length&&Q(!1)},[$]);let Y=(0,r.useCallback)(()=>{let e=U.current;if(!e)return;let t=window.getComputedStyle(e),n=Number.parseFloat(t.lineHeight),o=Number.isFinite(n)&&n>0?n:m.input.lineHeight,r="edit"===K?m.edit.inputHeight:o,a=Number.parseFloat(t.maxHeight),l=Number.isFinite(a)&&a>0?a:o*m.input.maxLines,s=e.style.height,d=e.style.overflowY;e.style.overflowY="hidden",e.style.height="0px";let c=e.scrollHeight;if(c<=0){e.style.height=s,e.style.overflowY=d;return}let u=(0,i.Q1)({contentHeight:c,minHeight:r,maxHeight:l});e.style.height=`${u.height}px`,e.style.overflowY=u.overflowY,"create"===K&&u.wrapped&&Q(!0)},[!0,K]);(0,r.useLayoutEffect)(()=>{Y()},[Y,$,V]),(0,r.useLayoutEffect)(()=>{let e=U.current;if(!e||"undefined"==typeof ResizeObserver)return;let t=e.clientWidth,n=new ResizeObserver(()=>{let n=e.clientWidth;n!==t&&(t=n,Y())});return n.observe(e),()=>n.disconnect()},[Y,!0]),(0,r.useEffect)(()=>{if(!L)return;let e=window.setTimeout(()=>{U.current?.focus({preventScroll:!0});let e=U.current;if(e&&"setSelectionRange"in e&&"string"==typeof e.value){let t=e.value.length;try{e.setSelectionRange(t,t)}catch{}}},0);return()=>window.clearTimeout(e)},[L]),(0,r.useImperativeHandle)(t,()=>({focus:()=>U.current?.focus({preventScroll:!0}),getValue:()=>$,setValue:e=>D(e)}),[$]);let G=(0,r.useMemo)(()=>(0,i.jW)({mode:K,draft:$,anchor:n,canDelete:!!B}),[n,K,B,$]),J=(0,r.useMemo)(()=>(0,i.VU)($),[$]),Z=null!==J,ee=(0,r.useMemo)(()=>(0,u.DQ)()===u.Oj.MAC,[]),et=(0,r.useCallback)(()=>{J&&_(J)},[_,J]),en=(0,r.useCallback)(()=>{(J||M)&&I?.(J??"")},[M,I,J]),eo=(0,r.useCallback)(e=>{if("Enter"===e.key&&!e.nativeEvent.isComposing){let t=ee?e.metaKey&&!e.ctrlKey:e.ctrlKey&&!e.metaKey,n=e.shiftKey||e.altKey;if(t&&!n&&I){e.preventDefault(),en();return}if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&(0,i.AI)(K,e.shiftKey)){e.preventDefault(),et();return}}"Escape"===e.key&&(e.preventDefault(),e.stopPropagation(),N())},[en,et,ee,K,N,I]),er=(0,r.useCallback)(e=>{e.preventDefault(),e.stopPropagation(),N()},[N]),ei=(0,r.useCallback)(e=>{e.preventDefault(),e.stopPropagation(),B?.()},[B]),ea=(0,r.useCallback)(e=>{if(e.preventDefault(),e.stopPropagation(),q.current){q.current=!1;return}et()},[et]),el=(0,r.useCallback)(e=>{0===e.button&&(q.current=!0,e.preventDefault(),e.stopPropagation(),et())},[et]),es=S??(0,d.t)("previewer.html_selection_feedback_placeholder_short"),ed={ref:U,"data-mavis-chat-selection-comment-input":"true","data-testid":`${j}-input`,value:$,placeholder:es,onChange:e=>D(e.target.value),onKeyDown:eo,style:function(e){let t=h(e);return{minWidth:0,width:"100%",height:("edit"===t?m.edit:m.create).inputHeight,maxHeight:`calc(${(0,c.desktopTypographyLineHeight)(m.input.lineHeight)} * ${m.input.maxLines})`,flex:"1 1 auto",boxSizing:"border-box",appearance:"none",WebkitAppearance:"none",border:0,outline:m.input.focusOutline,margin:0,background:"transparent",boxShadow:"none",color:g(f.text),fontFamily:m.input.fontFamily,fontSize:(0,c.desktopTypographyFontSize)(m.input.fontSize),fontWeight:m.input.fontWeight,lineHeight:(0,c.desktopTypographyLineHeight)(m.input.lineHeight),caretColor:g(f.caret),resize:"none",overflowX:"hidden",overflowY:"edit"===t?"auto":"hidden",padding:0,whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}(E),className:"desktop-text-chat-body","aria-label":R??es},ec=(0,o.jsx)("button",{type:"button","aria-label":(0,d.t)("previewer.html_selection_feedback_submit"),"aria-disabled":!Z,disabled:m.behavior.disableEmptySubmit&&!Z,"data-testid":`${j}-action`,style:function(e,t){let n=!e;return{flex:`0 0 ${m.actionButton.size}px`,width:m.actionButton.size,height:m.actionButton.size,padding:0,border:0,borderRadius:m.actionButton.borderRadius,display:"inline-flex",alignItems:"center",justifyContent:"center",cursor:n?m.actionButton.disabledCursor:m.actionButton.enabledCursor,transition:m.actionButton.transition,background:n?g(f.primaryInactive):t?g(f.primaryHover):g(f.primaryBg),color:g(f.primaryIcon)}}(Z,A),onMouseEnter:()=>H(!0),onMouseLeave:()=>H(!1),onMouseDown:el,onClick:ea,children:(0,o.jsx)(a.cv,{size:m.actionButton.iconSize})}),eu=(0,o.jsx)(l.J2,{placement:"topRight",trigger:"hover",arrow:!1,mouseEnterDelay:.1,overlayStyle:b,overlayInnerStyle:{padding:"8px 10px",borderRadius:12},content:(0,o.jsxs)("div",{className:"grid w-max grid-cols-[max-content_max-content] items-center gap-x-2 gap-y-2","data-testid":`${j}-shortcut-hint`,children:[(0,o.jsx)("span",{className:"desktop-text-ui-small-strong text-body-strong !tracking-[0px] text-text_default_primary","data-testid":`${j}-add-label`,children:(0,d.t)("chat_selection.add_action")}),(0,o.jsx)(s.j,{value:"↵",shape:"pill",className:"justify-self-end",testId:`${j}-add-key`}),(0,o.jsx)("span",{className:"desktop-text-ui-small-strong text-body-strong !tracking-[0px] text-text_default_primary","data-testid":`${j}-send-label`,children:(0,d.t)("common.send")}),(0,o.jsx)(s.j,{value:ee?"⌘↵":"Ctrl+↵",shape:"pill",className:"justify-self-end",testId:`${j}-send-key`})]}),children:(0,o.jsx)("span",{className:"inline-flex",children:ec})}),em=(0,o.jsx)("button",{type:"button","aria-label":(0,d.t)("previewer.html_selection_feedback_delete"),"data-testid":`${j}-discard`,style:k(W),onMouseEnter:()=>F(!0),onMouseLeave:()=>F(!1),onClick:er,children:(0,o.jsx)(a.pJ,{size:m.deleteButton.iconSize})});return"small"===E?(0,o.jsxs)("div",{className:O,style:{...w("small",V),...T},"data-testid":`${j}-wrapper`,"data-comment-composer-mode":G.mode,"data-comment-composer-expanded":V?"true":void 0,"data-comment-composer-context-id":G.anchor.contextId,"data-comment-composer-selection-kind":G.anchor.selectionKind,children:[(0,o.jsx)("div",{style:y("small",V),children:(0,o.jsx)("textarea",{rows:1,...ed})}),X?(0,o.jsxs)("div",{style:{display:"flex",width:"100%",height:m.edit.footerHeight,alignItems:"center",justifyContent:"space-between"},children:[em,eu]}):eu]}):(0,o.jsxs)("div",{className:O,style:{...w("large"),...T},"data-testid":`${j}-wrapper`,"data-comment-composer-mode":G.mode,"data-comment-composer-context-id":G.anchor.contextId,"data-comment-composer-selection-kind":G.anchor.selectionKind,children:[(0,o.jsx)("div",{style:y("large"),children:(0,o.jsx)("textarea",{rows:2,...ed})}),(0,o.jsxs)("div",{style:{display:"flex",width:"100%",height:m.edit.footerHeight,alignItems:"center",justifyContent:"space-between"},children:[B?(0,o.jsx)("button",{type:"button","aria-label":(0,d.t)("previewer.html_selection_feedback_delete"),"data-testid":`${j}-delete`,style:k(W),onMouseEnter:()=>F(!0),onMouseLeave:()=>F(!1),onClick:ei,children:(0,o.jsx)(a.pJ,{size:m.deleteButton.iconSize})}):(0,o.jsx)("span",{}),(0,o.jsxs)("div",{style:{display:"inline-flex",gap:m.edit.actionsGap},children:[(0,o.jsx)("button",{type:"button","aria-label":(0,d.t)("previewer.html_selection_feedback_cancel"),"data-testid":`${j}-cancel`,style:{flex:"0 0 auto",width:m.actionButton.size,height:m.actionButton.size,padding:0,border:0,borderRadius:m.actionButton.borderRadius,display:"inline-flex",alignItems:"center",justifyContent:"center",cursor:m.actionButton.enabledCursor,transition:m.actionButton.transition,background:P?g(f.secondaryHover):g(f.secondaryBg),color:g(f.secondaryIcon)},onMouseEnter:()=>z(!0),onMouseLeave:()=>z(!1),onClick:er,children:(0,o.jsx)(a.Tw,{size:m.actionButton.iconSize})}),eu]})]})]})})},362:function(e,t,n){"use strict";n.d(t,{D5:function(){return u},Xv:function(){return d},l:function(){return c}});var o=n(27573),r=n(7653),i=n(3458),a=n(42350),l=n(9813),s=n(51904);let d=8;function c(e){let{anchorRect:t,releasePointAlignment:n="end",releasePointX:l,selectionBottom:d,bottomInset:c=0,onAdd:m,testId:f,host:p=null,overlayMode:h="contained"}=e,g=(0,r.useRef)(null),[b,v]=(0,r.useState)(120),[x,w]=(0,r.useState)(0);(0,r.useLayoutEffect)(()=>{let e=g.current;if(!e)return;let t=()=>{let t=Math.ceil(e.getBoundingClientRect().width);t>0&&v(e=>e===t?e:t)},n=()=>{t(),w(e=>e+1)};t(),window.addEventListener("resize",n,{passive:!0});let o="undefined"==typeof ResizeObserver?null:new ResizeObserver(n);return o?.observe(e),p&&o?.observe(p),()=>{window.removeEventListener("resize",n),o?.disconnect()}},[p]);let y=(0,r.useMemo)(()=>u(t,p,b,d,c,n,l,h),[t,c,b,p,x,h,n,l,d]);if("undefined"==typeof document)return null;let k="floating"===h?document.body:p??document.body;return(0,i.createPortal)((0,o.jsxs)("button",{ref:g,type:"button","aria-keyshortcuts":"Tab","data-chat-selection-ui":"true","data-chat-selection-add-button":"true","data-testid":f??"chat-selection-add-button",onMouseDown:e=>e.preventDefault(),onClick:e=>{e.preventDefault(),e.stopPropagation(),m()},style:y,className:"desktop-text-ui-small-strong inline-flex h-8 w-max shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-border_default bg-bg_grouped_secondary_elevated px-3 text-[13px] font-medium leading-none text-text_default_primary shadow-[0_0_20px_rgba(10,10,10,0.08)] transition-colors hover:bg-bg_grouped_tertiary [-webkit-app-region:no-drag]",children:[(0,o.jsx)(a.rDX,{size:18,className:"shrink-0 text-icon_default_secondary"}),(0,o.jsx)("span",{"data-testid":"chat-selection-add-label",className:"shrink-0 whitespace-nowrap bg-transparent",children:(0,s.t)("chat_selection.add_to_chat")})]}),k)}function u(e,t){let n=arguments.length>2&&void 0!==arguments[2]?arguments[2]:120,o=arguments.length>3&&void 0!==arguments[3]?arguments[3]:e.bottom,r=arguments.length>4&&void 0!==arguments[4]?arguments[4]:0,i=arguments.length>5&&void 0!==arguments[5]?arguments[5]:"end",a=arguments.length>6?arguments[6]:void 0,s=arguments.length>7&&void 0!==arguments[7]?arguments[7]:"contained",c=window.innerWidth,u=window.innerHeight,m=t?.getBoundingClientRect()??null;if("floating"===s){let t=Math.max(8,e.top-32-d),o=m?Math.max(8,m.left+8):8,r=m?Math.min(c-8,m.right-8):c-8,i=void 0!==a?a-n/2:e.left;return{position:"fixed",top:`${Math.round(t)}px`,left:`${Math.round(Math.min(Math.max(i,o),Math.max(o,r-n)))}px`,zIndex:l.mu}}let f=m?Math.max(8,m.top+8):8,p=Math.max(0,r),h=m?Math.min(u-p-8,m.bottom-p-8):u-p-8,g=e.top-32-d,b=o+d,v=g>=f,x=b+32<=h,w=v?g:x?b:f,y=!v&&!x,k=void 0!==a?a-n/2:"start"===i?e.left:"center"===i?e.right-n/2:e.right-n,C=c-8;if(t&&m){let e=Math.max(8,m.left+8),o=Math.min(C,m.right-8);return{position:"absolute",top:`${Math.round(w-m.top+t.scrollTop)}px`,left:`${Math.round(Math.min(Math.max(k,e),Math.max(e,o-n))-m.left+t.scrollLeft)}px`,zIndex:6,visibility:y?"hidden":void 0,pointerEvents:y?"none":void 0}}return{position:"fixed",top:`${Math.round(w)}px`,left:`${Math.round(Math.min(Math.max(k,8),Math.max(8,C-n)))}px`,zIndex:2147483645,visibility:y?"hidden":void 0,pointerEvents:y?"none":void 0}}},45734:function(e,t,n){"use strict";n.d(t,{p:function(){return l}});var o=n(59403),r=n(13049),i=n(9813);let a=2*o.OQ.edit.inputRowPaddingY+o.OQ.edit.gap+o.OQ.edit.footerHeight+o.OQ.wrapper.padding.top+o.OQ.wrapper.padding.bottom+2*o.OQ.wrapper.borderWidth;function l(e,t,n){let l,s,d=arguments.length>3&&void 0!==arguments[3]?arguments[3]:0,c=arguments.length>4&&void 0!==arguments[4]?arguments[4]:null,u=window.innerWidth,m=window.innerHeight,f=function(){let e=o.OQ.input.lineHeight,t=e;if("undefined"!=typeof document){let n=Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(`--mavis-line-height-${e}`));Number.isFinite(n)&&n>0&&(t=n)}return o.OQ.input.maxLines*t+a}(),p=n?.getBoundingClientRect()??null,h=o.OQ.width.viewportInset,g=o.OQ.placement.bottomInset,b=p?Math.max(p.left+h,h):h,v=p?Math.min(p.right-h,u-h):u-h,x=Math.min(o.OQ.width.max,Math.max(o.OQ.width.min,Math.max(0,v-b))),w="large"===t?o.OQ.edit.height:o.OQ.create.height;if(c){let t=Math.min(Math.max(c.left,b),Math.max(b,v-x)),n=c.bottom<=e.top,r=e=>({position:"fixed",bottom:`${Math.round(e)}px`,left:`${Math.round(t)}px`,width:`${x}px`,zIndex:i.gm});if(n&&c.bottom-f>=8)return r(Math.max(8,m-c.bottom));let a=n?c.bottom-w:c.bottom+o.OQ.placement.anchorGap;return a>Math.max(8,m-8-f)?r(8):{position:"fixed",top:`${Math.round(Math.max(a,8))}px`,left:`${Math.round(t)}px`,width:`${x}px`,zIndex:i.gm}}l=Math.max(l=e.left+x<=v?e.left:v-x,b);let y=p?Math.max(p.top+g,g):g,k=p?Math.max(y,Math.min(p.bottom-Math.max(0,d)-g,m-g)):m-g,C=e.bottom+o.OQ.placement.anchorGap,S="small"===t?r.n9.size:0,E=e.top-o.OQ.placement.anchorGap-w-S,_=Math.max(y,k-f);return(s="small"===t?Math.min(Math.max(E,y),_):C+f<=k?C:E>=y?E:Math.min(Math.max(C,y),_),n&&p)?{position:"absolute",top:`${Math.round(s-p.top+n.scrollTop)}px`,left:`${Math.round(l-p.left+n.scrollLeft)}px`,width:`${x}px`,zIndex:i.Qv}:{position:"fixed",top:`${Math.round(s)}px`,left:`${Math.round(l)}px`,width:`${x}px`,zIndex:2147483646}}},48857:function(e,t,n){"use strict";n.d(t,{O:function(){return x}});var o=n(27573),r=n(7653),i=n(96841),a=n(75639),l=n(10423),s=n(5268),d=n(77575),c=n(34721),u=n(8770),m=n(47482);let f="mavis-scoped-find",p="mavis-scoped-find-active",h=`
::highlight(${f}) {
  background-color: color-mix(in srgb, var(--warning_500) 28%, transparent);
  color: inherit;
}
::highlight(${p}) {
  background-color: var(--bg_interaction_accent_focus_highlight);
  color: inherit;
}
`;function g(e,t){let n=globalThis,o=n.CSS?.highlights,r=n.Highlight;if(!o||"function"!=typeof r)return;let i=e[t],a=i?e.filter((e,n)=>n!==t):e;a.length>0?o.set(f,new r(...a)):o.delete(f),i?o.set(p,new r(i)):o.delete(p)}function b(){let e=globalThis.CSS?.highlights;e?.delete(f),e?.delete(p)}function v(e,t,n,o,r,i){let a=(0,m.P)(e,o,r,i);if(!a)return{attributes:{}};let{startOffset:l,endOffset:s}=a,d=e.slice(0,l).split("\n").length,c=e.lastIndexOf("\n",l-1)+1,u=e.slice(0,s).split("\n").length,f=e.lastIndexOf("\n",s-1)+1,p={startLine:String(d),endLine:String(u),startColumn:String(l-c),endColumn:String(s-f),sourceStartOffset:String(l),sourceEndOffset:String(s)};return{targetPath:`${n||t}:${d}-${u}`,attributes:p}}function x(e){let{content:t,testId:n="markdown-view",className:m,fileName:f="Markdown preview",filePath:p,onTextSelectionComment:x,onTextSelectionSend:w,onTextSelectionCommentRemove:y,textSelectionComments:k,textSelectionEditRequest:C,selectionSurface:S="previewer-content",overlayRightInset:E}=e,_=(0,r.useMemo)(()=>t.split("\n"),[t]),I=(0,r.useMemo)(()=>(function(e){let t=[];for(let n=0;n<e.length;n+=300)t.push(e.slice(n,n+300).join("\n"));return t})(_),[_]),M=(0,r.useMemo)(()=>(0,a.my)(p),[p]),N=I.length>1,B=(0,s.vL)(e=>e.fileLineWrapEnabled),[L,R]=(0,r.useState)(1),[O,T]=(0,r.useState)(!1),[j,$]=(0,r.useState)(""),[D,A]=(0,r.useState)(0),[H,P]=(0,r.useState)(0),z=(0,r.useRef)(null),W=(0,r.useRef)([]);(0,r.useEffect)(()=>{R(1)},[t]);let F=N&&L<I.length,q=(0,r.useCallback)(()=>{R(e=>Math.min(e+1,I.length))},[I.length]),U=(0,l.M)({containerRef:z,hasMore:F,onLoadMore:q,rootMargin:"300px"});(0,r.useEffect)(()=>{P(0)},[j,t,L]),(0,r.useLayoutEffect)(()=>{let e=z.current,t=O&&e?function(e,t){let n=t.trim().toLowerCase();if(!n)return[];let o=[],r=document.createTreeWalker(e,NodeFilter.SHOW_TEXT,{acceptNode:e=>!function(e){let t=e.parentElement;return!!t?.closest('[data-scoped-find-ui="true"], [data-preview-text-selection-ui="true"]')}(e)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}),i=r.nextNode();for(;i;){let e=(i.textContent??"").toLowerCase(),t=0;for(;t<=e.length;){let r=e.indexOf(n,t);if(r<0)break;let a=r+n.length,l=document.createRange();l.setStart(i,r),l.setEnd(i,a),o.push(l),t=Math.max(a,r+1)}i=r.nextNode()}return o}(e,j):[];return W.current=t,A(t.length),P(e=>Math.min(e,Math.max(0,t.length-1))),g(t,Math.min(H,Math.max(0,t.length-1))),()=>{O||b()}},[H,t,O,j,L]),(0,r.useEffect)(()=>{if(!O){b();return}let e=W.current[H];e?.startContainer.parentElement?.scrollIntoView({block:"center",inline:"nearest"}),g(W.current,H)},[H,O]),(0,r.useEffect)(()=>b,[]);let K=(0,r.useCallback)(()=>{P(e=>0===D?0:(e+1)%D)},[D]),V=(0,r.useCallback)(()=>{P(e=>0===D?0:(e-1+D)%D)},[D]),Q=(0,r.useCallback)(()=>{d.o.getState().closeSearch(),T(!0)},[]),X=(0,o.jsx)(u.j,{hostRef:z,isOpen:O,query:j,matchCount:D,currentIndex:H,testIdPrefix:"markdown-view",rightInset:E,onOpen:Q,onClose:()=>T(!1),onQueryChange:$,onNext:K,onPrevious:V}),Y=[B?"markdown-view-wrap":"markdown-view-nowrap",m].filter(Boolean).join(" "),G=`markdown-view-container relative h-full min-w-0 p-6 bg-bg_default_primary text-text_default_primary ${B?"overflow-y-auto overflow-x-hidden":"overflow-auto"}`,J=E?{"--markdown-view-overlay-right-inset":E,paddingRight:`calc(1.5rem + ${E})`}:void 0;return N?(0,o.jsx)(a.Pk,{value:M,children:(0,o.jsxs)("div",{ref:z,className:G,"data-app-shortcut-priority":"text-editor","data-testid":n??void 0,style:J,children:[(0,o.jsx)("style",{children:h}),X,I.slice(0,L).map((e,t)=>(0,o.jsx)(i.UG,{shiftHeading:0,className:Y,children:e},t)),F&&(0,o.jsx)("div",{ref:U,className:"h-1"}),(0,o.jsx)(c.k4,{hostRef:z,fileName:f,filePath:p,sourceLabel:"markdown-preview",onAddComment:x,onSendComment:w,onRemoveComment:y,commentItems:k,openEditRequest:C,commentVariant:"small",editComposerVariant:"large",selectionSurface:S,getSelectionMetadata:e=>v(t,f,p,e.selectedText,e.markdownStartOffset??e.startOffset,e.markdownOccurrenceIndex),testIdPrefix:"markdown-text-selection"})]})}):(0,o.jsx)(a.Pk,{value:M,children:(0,o.jsxs)("div",{ref:z,className:G,"data-app-shortcut-priority":"text-editor","data-testid":n??void 0,style:J,children:[(0,o.jsx)("style",{children:h}),X,(0,o.jsx)(i.UG,{shiftHeading:0,className:Y,children:t}),(0,o.jsx)(c.k4,{hostRef:z,fileName:f,filePath:p,sourceLabel:"markdown-preview",onAddComment:x,onSendComment:w,onRemoveComment:y,commentItems:k,openEditRequest:C,commentVariant:"small",editComposerVariant:"large",selectionSurface:S,getSelectionMetadata:e=>v(t,f,p,e.selectedText,e.markdownStartOffset??e.startOffset,e.markdownOccurrenceIndex),testIdPrefix:"markdown-text-selection"})]})})}},34721:function(e,t,n){"use strict";n.d(t,{k4:function(){return D},up:function(){return y}});var o=n(27573),r=n(7653),i=n(3458),a=n(24191),l=n(360),s=n(362),d=n(45734),c=n(54781),u=n(95777),m=n(46511),f=n(51904),p=n(49817),h=n(42940),g=n(26063),b=n(47482);let v=new WeakSet,x=new DOMRect(0,0,0,0);function w(e){let t=2166136261;for(let n=0;n<e.length;n+=1)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return(t>>>0).toString(16).padStart(8,"0")}function y(e){let{candidate:t,fileName:n,filePath:o,sourceLabel:r,commentId:i,contextId:a,feedback:l,metadata:s,selectionSurface:d}=e,c=t.viewportRect;return{schema:"mavis.html_selection.v1",contextId:a,fileName:n,...o?{filePath:o}:{},createdAtMs:Date.now(),selectionMode:"dom_node",selector:r,tagName:"TEXT",text:t.selectedText,attributes:{surface:"text-selection",source:r,...d?{selectionSurface:d}:{},...s?.attributes??{},...void 0!==t.startOffset&&void 0!==t.endOffset?{startOffset:String(t.startOffset),endOffset:String(t.endOffset)}:{},...void 0!==t.markdownStartOffset?{markdownStartOffset:String(t.markdownStartOffset)}:{},...void 0!==t.markdownOccurrenceIndex?{markdownOccurrenceIndex:String(t.markdownOccurrenceIndex)}:{},...void 0!==t.markdownCodeBlockIndex&&void 0!==t.markdownCodeBlockStartOffset&&void 0!==t.markdownCodeBlockEndOffset&&t.markdownCodeBlockFingerprint?{markdownCodeBlockIndex:String(t.markdownCodeBlockIndex),markdownCodeBlockStartOffset:String(t.markdownCodeBlockStartOffset),markdownCodeBlockEndOffset:String(t.markdownCodeBlockEndOffset),markdownCodeBlockFingerprint:t.markdownCodeBlockFingerprint}:{}},rect:{x:c.x,y:c.y,width:c.width,height:c.height},viewport:{width:window.innerWidth,height:window.innerHeight},pageUrl:o||n,targetPath:s?.targetPath||r,commentId:i,feedback:l}}function k(e){if(void 0===e||!/^\d+$/u.test(e))return null;let t=Number(e);return Number.isSafeInteger(t)&&t>=0?t:null}function C(e){if(void 0===e||!/^\d+$/u.test(e))return null;let t=Number(e);return Number.isSafeInteger(t)&&t>0?t:null}function S(e){let t=/:(\d+)(?:-(\d+))?$/u.exec(e.targetPath.trim());if(t){let e=Number(t[1]),n=Number(t[2]??t[1]);if(Number.isFinite(e)&&Number.isFinite(n)&&e>0&&n>0){let t=Math.floor(e),o=Math.floor(n);return[Math.min(t,o),Math.max(t,o)]}}let n=C(e.attributes.startLine);if(null===n)return null;let o=C(e.attributes.endLine)??n;return[Math.min(n,o),Math.max(n,o)]}function E(e,t){let n=S(t);if(!n)return null;let[o,r]=n,i=e.querySelector(`.code-view-row[data-line='${o}']`),a=e.querySelector(`.code-view-row[data-line='${r}']`);if(!i||!a)return null;let l=Array.from(e.querySelectorAll(".code-view-row")).filter(e=>{let t=Number(e.dataset.line);return Number.isInteger(t)&&t>=o&&t<=r});if(0===l.length)return null;let s=k(t.attributes.startColumn),d=k(t.attributes.endColumn);if(null!==s&&null!==d){let e=i.querySelector(".code-view-line-content")??i,t=a.querySelector(".code-view-line-content")??a,n=(0,u.oW)(e,s,s+1),o=(0,u.oW)(t,Math.max(0,d-1),d);if(n&&o){let e=document.createRange();try{return e.setStart(n.startContainer,n.startOffset),e.setEnd(o.endContainer,o.endOffset),e}catch{}}}let c=[];for(let e of l){let t=e.querySelector(".code-view-line-content")??e,n=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),o=[],r=n.nextNode();for(;r;)o.push(r),r=n.nextNode();o.length>0&&c.push(o)}if(0===c.length)return null;let m=[],f=c.map((e,t)=>{let n=e.map(e=>e.nodeValue??"").join("");for(let t of e){let e=t.nodeValue??"";for(let n=0;n<e.length;n+=1)m.push({node:t,offset:n})}return t<c.length-1&&m.push(null),n}).join("\n"),p=t.text.replace(/\r\n/gu,"\n"),h=e=>e.replace(/\s+/gu,""),g=h(f),b=h(p);if(!b)return null;let v=g.indexOf(b);if(v<0)return null;let x=[];for(let e=0;e<f.length;e+=1)/\s/u.test(f[e]??"")||x.push(e);let w=x[v],y=x[v+b.length-1];if(void 0===w||void 0===y)return null;let C=m[w],E=m[y];if(!C||!E)return null;let _=document.createRange();try{return _.setStart(C.node,C.offset),_.setEnd(E.node,E.offset+1),_}catch{return null}}function _(e){return(0,b.V)(e).trim()}function I(e){return Array.from(new Set([e.trim(),_(e)])).filter(Boolean)}function M(e){return _(e).replace(/\s+/gu,"")}function N(e,t){let n=[],o=[];e.forEach((t,r)=>{let i=document.createTreeWalker(t,NodeFilter.SHOW_TEXT),a=i.nextNode(),l="";for(;a;){let e=a.nodeValue??"";l+=e;for(let t=0;t<e.length;t+=1)n.push({node:a,offset:t});a=i.nextNode()}o.push(l),r<e.length-1&&n.push(null)});let r=o.join("\n"),i=r.replace(/\s+/gu,""),a=[];for(let e=0;e<r.length;e+=1)/\s/u.test(r[e]??"")||a.push(e);for(let e of I(t)){let t=e.replace(/\s+/gu,"");if(!t)continue;let o=i.indexOf(t);if(o<0||i.indexOf(t,o+t.length)>=0)continue;let r=n[a[o]??-1],l=n[a[o+t.length-1]??-1];if(!r||!l)continue;let s=document.createRange();try{return s.setStart(r.node,r.offset),s.setEnd(l.node,l.offset+1),s}catch{continue}}return null}function B(e,t){if(S(t)&&e.querySelector(".code-view-row"))return E(e,t);let n=t.text,o=function(e){let t=Array.from(e.querySelectorAll(".matrix-markdown"));return t.length>0?t:[e]}(e),r=function(e,t){let n=k(t.attributes.markdownCodeBlockIndex),o=k(t.attributes.markdownCodeBlockStartOffset),r=k(t.attributes.markdownCodeBlockEndOffset);if(null===n||null===o||null===r||r<=o)return null;let i=e.querySelectorAll(".codeblock-code")[n];if(!i)return null;let a=t.attributes.markdownCodeBlockFingerprint;if(!a||w((0,u.ti)(i))===a){let e=(0,u.oW)(i,o,r);if(e){let n=M(t.text),o=M(e.toString());if(n&&o===n)return e}}return N([i],t.text)}(e,t);if(r)return r;if(void 0!==t.attributes.markdownCodeBlockIndex)return null;if(n){let e=N(o,n);if(e)return e;let t=o.flatMap(e=>{let t=(0,u.ti)(e),o=t.indexOf(n);if(o<0||t.indexOf(n,o+n.length)>=0)return[];let r=(0,u.oW)(e,o,o+n.length);return r?[r]:[]});if(1===t.length)return t[0]??null;for(let e of I(n)){if(e===n)continue;let t=o.flatMap(t=>{let n=(0,u.ti)(t),o=n.indexOf(e);if(o<0||n.indexOf(e,o+e.length)>=0)return[];let r=(0,u.oW)(t,o,o+e.length);return r?[r]:[]});if(1===t.length)return t[0]??null}}if(!n)return null;let i=o.flatMap(e=>{let t=(0,u.ti)(e),o=t.indexOf(n);if(o<0||t.indexOf(n,o+n.length)>=0)return[];let r=(0,u.oW)(e,o,o+n.length);return r?[r]:[]});return 1===i.length?i[0]??null:null}function L(e){return"edit"===e.attributes.intent||"edit"===e.attributes.requestedAction||"edit"===e.attributes.sourceAction}function R(e){return!!(e&&("stored-comment"===e.source||L(e.item)))}function O(e){return e instanceof Element?e:e.parentElement}function T(e,t){let n=O(e.startContainer)?.closest(".codeblock-code"),o=O(e.endContainer)?.closest(".codeblock-code");return!!(n&&n===o&&t.contains(n))}function j(e){let{hostRef:t,targets:n,activeContextId:a,testIdPrefix:l}=e,[s,d]=(0,r.useState)([]);(0,r.useEffect)(()=>{let e=t.current;if(!e)return;let o=()=>{let t=e.getBoundingClientRect(),o=[];for(let r of n)r.contextId!==a&&(r.resolveRanges?.()??(()=>{let e=r.resolveRange();return e?[e]:[]})()).forEach((n,i)=>{T(n,e)&&Array.from(n.getClientRects()).forEach(n=>{n.width<=0||n.height<=0||o.push({contextId:r.contextId,rangeIndex:i,left:n.left-t.left+e.scrollLeft,top:n.bottom-t.top+e.scrollTop-1,width:n.width})})});d(o)};o();let r=0,i=()=>{r||(r=window.requestAnimationFrame(()=>{r=0,o()}))};window.addEventListener("resize",i,{passive:!0}),window.addEventListener("scroll",i,{passive:!0,capture:!0});let l="undefined"==typeof ResizeObserver?null:new ResizeObserver(i);l?.observe(e);let s="undefined"==typeof MutationObserver?null:new MutationObserver(i);return s?.observe(e,{childList:!0,subtree:!0,characterData:!0}),()=>{r&&window.cancelAnimationFrame(r),window.removeEventListener("resize",i),window.removeEventListener("scroll",i,{capture:!0}),l?.disconnect(),s?.disconnect()}},[a,t,n]);let c=t.current;return c&&0!==s.length&&"undefined"!=typeof document?(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true",className:"pointer-events-none absolute inset-0","aria-hidden":"true",children:s.map((e,t)=>(0,o.jsx)("span",{"data-testid":`${l}-code-underline-${e.contextId}-${t}`,className:"absolute rounded-full bg-border_accent",style:{left:Math.round(e.left),top:Math.round(e.top),width:Math.round(e.width),height:1}},`${e.contextId}-${e.rangeIndex}-${t}`))}),c):null}function $(e){let{candidate:t,host:n,bottomInset:l,onAdd:d,onCopy:c,testIdPrefix:u}=e,m=(0,r.useRef)(null),[p,h]=(0,r.useState)(170),[g,b]=(0,r.useState)(0);(0,r.useLayoutEffect)(()=>{let e=m.current;if(!e)return;let t=()=>{let t=Math.ceil(e.getBoundingClientRect().width);t>0&&h(e=>e===t?e:t),b(e=>e+1)};t(),window.addEventListener("resize",t,{passive:!0});let o="undefined"==typeof ResizeObserver?null:new ResizeObserver(t);return o?.observe(e),n&&o?.observe(n),()=>{window.removeEventListener("resize",t),o?.disconnect()}},[n]);let v=(0,r.useMemo)(()=>(0,s.D5)(t.buttonAnchorRect,n,p,t.selectionBottom,l,t.buttonReleaseAlignment),[l,t.buttonAnchorRect,t.buttonReleaseAlignment,t.selectionBottom,n,g,p]);return"undefined"==typeof document?null:(0,i.createPortal)((0,o.jsx)(a.X,{ref:m,"data-preview-text-selection-ui":"true","data-testid":`${u}-toolbar`,style:v,className:"desktop-text-ui-small-strong",aiLabel:(0,f.t)("chat_selection.add_to_chat"),onAsk:d,primaryButtonProps:{"aria-keyshortcuts":"Tab","data-chat-selection-add-button":"true","data-testid":`${u}-add-to-task`},children:(0,o.jsx)("button",{type:"button","data-testid":`${u}-copy`,onClick:e=>{e.preventDefault(),e.stopPropagation(),c()},children:(0,f.t)("common.copy")})}),n??document.body)}function D(e){let{hostRef:t,fileName:n,filePath:a,sourceLabel:s="preview-text-selection",enabled:b=!0,onAddComment:k,onSendComment:C,onRemoveComment:_,commentItems:I,showCommentAnchors:M=!0,showCommentHighlights:N=!0,commentHighlightNames:D=m.GC,selectionSurface:A,openEditRequest:H,enableEditAction:P=!1,commentVariant:z="small",editComposerVariant:W,keepComposerOpenOnSubmit:F="large"===z,getSelectionMetadata:q,composerPlacement:U="floating",editComposerPlacement:K,getInlineComposerHost:V,onOpenComposerChange:Q,onTextSelectionEditComposerChange:X,renderComposer:Y,bottomInset:G=0,testIdPrefix:J="preview-text-selection"}=e,[Z,ee]=(0,r.useState)(null),[et,en]=(0,r.useState)(null),eo=(0,r.useRef)(0),er=(0,r.useRef)(new Set),ei=(0,r.useRef)(null),ea=(0,r.useMemo)(()=>(I??[]).filter(e=>!A||e.attributes.selectionSurface===A||!e.attributes.selectionSurface&&e.attributes.source===s),[I,A,s]),el=(0,r.useMemo)(()=>"inline"===U?ea.filter(L):[],[U,ea]),es=R(et),ed=es?W??z:z,ec="large"===ed?et?.item.contextId??el[0]?.contextId??null:null,eu=(0,r.useMemo)(()=>{let e=[...ea];et&&e.push(et.item),"inline"===U&&e.push(...el);let t=new Set;return e.filter(e=>!t.has(e.contextId)&&(t.add(e.contextId),!0))},[U,el,et,ea]),em=(0,r.useMemo)(()=>eu.map(e=>({contextId:e.contextId,resolveRange:()=>{let n=t.current;return n?B(n,e):null},...D.stored===m.GC.stored?{shouldPaintStoredRange:e=>{let n=t.current;return!n||!T(e,n)}}:{},...S(e)?{resolveRanges:()=>{let n=t.current;if(!n)return[];if(n.querySelector(".code-view-row"))return function(e,t){let n=E(e,t);return n?Array.from(e.querySelectorAll(".code-view-row")).filter(e=>{let n=Number(e.dataset.line),[o,r]=S(t)??[0,0];return Number.isInteger(n)&&n>=o&&n<=r}).flatMap(e=>{let t=e.querySelector(".code-view-line-content");if(!t)return[];let o=document.createRange();o.selectNodeContents(t);let r=document.createRange();try{let e=n.compareBoundaryPoints(Range.START_TO_START,o)>0?n.startContainer:o.startContainer,t=e===n.startContainer?n.startOffset:o.startOffset,i=0>n.compareBoundaryPoints(Range.END_TO_END,o)?n.endContainer:o.endContainer,a=i===n.endContainer?n.endOffset:o.endOffset;return r.setStart(e,t),r.setEnd(i,a),r.collapsed?[]:[r]}catch{return[]}}):[]}(n,e);let o=B(n,e);return o?[o]:[]}}:{}})),[D.stored,eu,t]),ef=(0,r.useMemo)(()=>ea.map((e,n)=>({contextId:e.contextId,referenceNumber:n+1,quotedText:e.text,comment:e.feedback,selectionKind:"text-range",value:e,resolveRange:()=>{let n=t.current;return n?B(n,e):null},resolveElement:()=>{let n=t.current;if(!n)return null;let[o,r]=S(e)??[],i=r??o;return i?n.querySelector(`.code-view-row[data-line='${i}']`):null}})),[t,ea]),ep=(0,r.useMemo)(()=>N||D!==m.GC?em:em.filter(e=>e.contextId===ec),[ec,D,em,N]);(0,m.QR)(ep,ec,D);let eh=(0,r.useCallback)(()=>{window.getSelection?.()?.removeAllRanges()},[]),eg=(0,r.useCallback)(async()=>{if(!Z)return;let e=await (0,h.v)(Z.selectedText);p.E.getState().addToast(e?"success":"error",e?(0,f.t)("copied"):(0,f.t)("chat_panel.copy_failed")),ee(null),eh()},[Z,eh]),eb=(0,r.useCallback)(e=>{if(!Z||!k)return;let t=q?.(Z),o=eo.current+1;eo.current=o;let r=`text-selection-${(a||n).replace(/[^a-zA-Z0-9_-]+/gu,"-").replace(/^-+|-+$/gu,"").slice(0,80)||"text"}-${function(){try{return crypto.randomUUID()}catch{return`${Date.now()}-${Math.random().toString(36).slice(2)}`}}()}`,i=y({candidate:Z,fileName:n,...a?{filePath:a}:{},sourceLabel:s,commentId:o,contextId:r,feedback:"",...A?{selectionSurface:A}:{},metadata:{...t??{},attributes:{...t?.attributes??{},..."edit"===e?{intent:"edit",requestedAction:"edit",sourceAction:"edit"}:{}}}});"edit"===e&&X?.(!0),k(i),en({item:i,anchorRect:Z.composerAnchorRect??Z.viewportRect,source:"selection"}),ee(null),eh()},[Z,eh,n,a,q,k,X,A,s]),ev=(0,r.useCallback)(()=>eb("comment"),[eb]);(0,r.useEffect)(()=>{if(!Z)return;let e=e=>{if("Tab"!==e.key||e.shiftKey||e.metaKey||e.ctrlKey||e.altKey||e.isComposing||e.repeat)return;let n=t.current?.querySelector('[data-chat-selection-add-button="true"]');n&&"hidden"!==window.getComputedStyle(n).visibility&&(e.preventDefault(),e.stopPropagation(),ev())};return document.addEventListener("keydown",e,!0),()=>document.removeEventListener("keydown",e,!0)},[Z,ev,t]);let ex=(0,r.useCallback)(function(e){let n=arguments.length>1&&void 0!==arguments[1]&&arguments[1];if(!n&&L(e))return;let o=t.current,r=o?B(o,e):null,{x:i,y:a,width:l,height:s}=e.rect;ee(null),en({item:e,anchorRect:r?function(e){let t=e.getClientRects();return t[t.length-1]??e.getBoundingClientRect()}(r):new DOMRect(i,a,l,s),source:"stored-comment"})},[t]),ew=(0,r.useCallback)(e=>{if(!et||!k)return;let t=(0,g.Sb)({...et.item,createdAtMs:et.item.createdAtMs},e);if(L(t)&&C){k(t),C(t),en(null);return}k(t),F?en(t=>t&&t.item.contextId===et.item.contextId?{...t,item:{...t.item,feedback:e}}:t):en(null)},[F,k,C,et]),ey=(0,r.useCallback)(()=>{et&&(_?.(et.item.contextId),en(null))},[_,et]),ek=(0,r.useCallback)(()=>{if(!et)return;let e=R(et),t=e?W??z:z;"selection"===et.source&&("large"===t||e)&&!et.item.feedback.trim()&&_?.(et.item.contextId),en(null)},[z,W,_,et]),eC=(0,r.useCallback)(e=>{if(!et||!k||!C)return;let t=(0,g.Sb)({...et.item,createdAtMs:et.item.createdAtMs},e);k(t),C(t),en(null)},[k,C,et]);(0,r.useLayoutEffect)(()=>{Q?.(et?.item??null)},[Q,et?.item]),(0,r.useEffect)(()=>{et||X?.(!1)},[X,et]),(0,r.useEffect)(()=>{if(!H||ei.current===H.token)return;let e=I?.find(e=>e.contextId===H.contextId);e&&(ei.current=H.token,!v.has(H)&&(v.add(H),1)&&ex(e,!0))},[I,ex,H]),(0,r.useEffect)(()=>{let e=et?.item.contextId;if(e&&I){if(I.some(t=>t.contextId===e)){er.current.add(e);return}er.current.has(e)&&(en(t=>t?.item.contextId===e?null:t),er.current.delete(e))}},[I,et?.item.contextId]),(0,r.useEffect)(()=>{if(!b||!k)return;let e=!1,n=!1,o=null,r=e=>ee(e),i=()=>{let e=t.current;e&&r(function(e){let t=window.getSelection?.();if(!t||0===t.rangeCount||t.isCollapsed)return null;let n=t.toString(),o=n.trim();if(!o)return null;let r=t.getRangeAt(t.rangeCount-1);if(!function(e,t){try{return e.intersectsNode(t)}catch{return t.contains(e.commonAncestorContainer)}}(r,e))return null;let i=r.getBoundingClientRect(),a=Array.from(r.getClientRects()).filter(e=>e.width>0||e.height>0),l=a[0]??i,s=a[a.length-1]??i;if(s.width<=0&&s.height<=0||i.width<=0&&i.height<=0)return null;let d=e.getBoundingClientRect(),c=Math.max(0,d.top),m=Math.min(window.innerHeight,d.bottom),f=a.filter(e=>e.bottom>c&&e.top<m),p=(0,u.p4)(t),h=("start"===p?f[0]:f[f.length-1])??s;if(h.bottom<=c||h.top>=m)return null;let g=n.length-n.trimStart().length,b=n.length-n.trimEnd().length,v=(0,u.c4)(e,r.startContainer,r.startOffset),x=(0,u.c4)(e,r.endContainer,r.endOffset),y=function(e,t,n){let o=Array.from(e.querySelectorAll(".matrix-markdown")),r=0;for(let e of o){if(e===t||e.contains(t)){let o=(0,u.c4)(e,t,n);return o<0?-1:r+o}r+=(0,u.ti)(e).length+1}return -1}(e,r.startContainer,r.startOffset),k=v<0?-1:v+g,C=x<0?-1:x-b,S=y<0?-1:y+g,E=function(e,t,n){if(n<0)return;let o=Array.from(e.querySelectorAll(".matrix-markdown")).map(u.ti).join("\n"),r=t.replace(/\s+/gu,"");if(!r)return;let i="",a=0;for(let e=0;e<o.length;e+=1){let t=o[e]??"";/\s/u.test(t)||(e<n&&(a+=1),i+=t)}let l=[],s=0;for(;s<=i.length-r.length;){let e=i.indexOf(r,s);if(e<0)break;l.push(e),s=e+Math.max(1,r.length)}if(0===l.length)return;let d=0,c=Math.abs((l[0]??0)-a);for(let e=1;e<l.length;e+=1){let t=Math.abs((l[e]??0)-a);t>=c||(d=e,c=t)}return d}(e,o,S),_=O(r.startContainer)?.closest(".codeblock-code"),I=O(r.endContainer)?.closest(".codeblock-code"),M=Array.from(e.querySelectorAll(".codeblock-code")),N=_?M.indexOf(_):-1,B=_?(0,u.c4)(_,r.startContainer,r.startOffset):-1,L=_?(0,u.c4)(_,r.endContainer,r.endOffset):-1,R=B<0?-1:B+g,T=L<0?-1:L-b,j=!!(_&&_===I&&N>=0&&R>=0&&T>R);return{selectedText:o,anchorRect:s,buttonAnchorRect:h,buttonReleaseAlignment:p,composerAnchorRect:l,selectionBottom:Math.max(...(f.length>0?f:[h]).map(e=>e.bottom)),viewportRect:i,...k>=0&&C>k?{startOffset:k,endOffset:C}:{},...S>=0?{markdownStartOffset:S}:{},...void 0!==E?{markdownOccurrenceIndex:E}:{},...j&&_?{markdownCodeBlockIndex:N,markdownCodeBlockStartOffset:R,markdownCodeBlockEndOffset:T,markdownCodeBlockFingerprint:w((0,u.ti)(_))}:{}}}(e))},a=()=>{null!==o&&window.clearTimeout(o),o=window.setTimeout(()=>{o=null,e&&(e=!1,n=!1,i())},0)},l=()=>{e=!0,n&&a()},s=()=>{n=!0,a()},d=e=>{let t=e?.target;t instanceof HTMLElement&&t.closest('[data-preview-text-selection-ui="true"], [data-chat-selection-ui="true"]')||(null!==o&&(window.clearTimeout(o),o=null),n=!1,r(null),"small"===(R(et)?W??z:z)&&(et&&L(et.item)&&!et.item.feedback.trim()&&_?.(et.item.contextId),en(null)))},c=e=>{let n=t.current,o=e.target;(o===e.currentTarget||n&&o instanceof Node&&(n.contains(o)||o.contains(n)))&&d(e)},m=e=>{"Escape"===e.key&&(null!==o&&(window.clearTimeout(o),o=null),n=!1,r(null),en(null))};return document.addEventListener("selectionchange",l),document.addEventListener("mouseup",s),document.addEventListener("touchend",s),document.addEventListener("keyup",s),document.addEventListener("mousedown",d),window.addEventListener("resize",d),window.addEventListener("scroll",c,!0),document.addEventListener("keydown",m),()=>{null!==o&&window.clearTimeout(o),document.removeEventListener("selectionchange",l),document.removeEventListener("mouseup",s),document.removeEventListener("touchend",s),document.removeEventListener("keyup",s),document.removeEventListener("mousedown",d),window.removeEventListener("resize",d),window.removeEventListener("scroll",c,!0),document.removeEventListener("keydown",m)}},[z,W,b,t,k,_,et]);let eS=es?K??U:U,eE="inline"===eS&&et?V?.(et.item)??null:t.current,e_=(0,r.useMemo)(()=>{if("inline"!==eS)return(0,d.p)(et?.anchorRect??x,ed,eE,G)},[G,eE,eS,ed,et?.anchorRect]),eI=es?`chat-selection-composer-${et?.item.contextId??"unknown"}`:`${J}-comment`,eM=es?`chat-selection-composer-container-${et?.item.contextId??"unknown"}`:`${J}-composer`,eN=Y&&eS===U&&ed===z;return b&&k?(0,o.jsxs)(o.Fragment,{children:[M?(0,o.jsx)(c.V,{items:ef,onOpenEdit:ex,activeContextId:ec,hostRef:t,anchorSurface:"html-preview",testIdPrefix:`${J}-badge`,selectionUiAttribute:"data-preview-text-selection-ui",selectionUi:!0}):null,N&&D.stored===m.GC.stored?(0,o.jsx)(j,{hostRef:t,targets:ep,activeContextId:ec,testIdPrefix:J}):null,Z?(0,o.jsx)($,{candidate:Z,host:t.current,bottomInset:G,onAdd:ev,onCopy:eg,testIdPrefix:J}):null,et&&eE?(0,i.createPortal)((0,o.jsx)("div",{"data-preview-text-selection-ui":"true","data-testid":eM,style:e_,className:"inline"===eS?"markdown-text-selection-comment-wrapper w-full":void 0,children:eN?Y({item:et.item,onSubmit:ew,...C?{onSend:eC}:{},onCancel:ek,..._?{onDelete:ey}:{},testIdPrefix:eI}):(0,o.jsx)(l.m,{anchorContext:{surface:"html-preview",contextId:et.item.contextId,selectionKind:"text-range"},variant:ed,initialValue:et.item.feedback,onSubmit:ew,onSend:C?eC:void 0,onCancel:ek,onDelete:_?ey:void 0,testIdPrefix:eI})},et.item.contextId),eE):null]}):null}},8770:function(e,t,n){"use strict";n.d(t,{j:function(){return a}});var o=n(27573),r=n(7653),i=n(51904);function a(e){let{hostRef:t,isOpen:n,query:a,matchCount:l,currentIndex:s,testIdPrefix:d,rightInset:c,onOpen:u,onClose:m,onQueryChange:f,onNext:p,onPrevious:h}=e,g=(0,r.useRef)(null),b=(0,r.useRef)(null),v=(0,r.useRef)(!1);(0,r.useEffect)(()=>{let e=e=>{let n=t.current;v.current=!!(n&&e.target instanceof Node&&n.contains(e.target))},o=e=>{let o=e.target,r=o instanceof Node&&!!g.current?.contains(o);if((e.metaKey||e.ctrlKey)&&"f"===e.key.toLowerCase()){let n=t.current,i=n&&o instanceof Node&&n.contains(o);if(!r&&!i&&!v.current||!r&&function(e){if(!(e instanceof HTMLElement))return!1;let t=e.tagName.toLowerCase();return e.isContentEditable||"input"===t||"textarea"===t||"select"===t}(o))return;e.preventDefault(),e.stopPropagation(),u();return}n&&r&&"Escape"===e.key&&(e.preventDefault(),e.stopPropagation(),m())};return window.addEventListener("pointerdown",e,!0),window.addEventListener("keydown",o,!0),()=>{window.removeEventListener("pointerdown",e,!0),window.removeEventListener("keydown",o,!0)}},[t,n,m,u]),(0,r.useEffect)(()=>{n&&window.requestAnimationFrame(()=>{b.current?.focus(),b.current?.select()})},[n]);let x=(0,r.useCallback)(e=>{"Enter"===e.key&&(e.preventDefault(),e.shiftKey?h():p())},[p,h]);if(!n)return null;let w=a&&l>0?s+1:0,y=0===l;return(0,o.jsxs)("div",{ref:g,"data-scoped-find-ui":"true","data-app-shortcut-priority":"text-editor","data-testid":`${d}-find-bar`,className:"desktop-text-ui-small absolute top-5 z-[7] flex w-[240px] max-w-[calc(100%-40px)] flex-col overflow-hidden rounded-[14px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated text-[13px] text-text_default_primary shadow-[0_8px_28px_rgba(10,10,10,0.12)]",style:c?{right:`calc(1.25rem + ${c})`}:{right:"1.25rem"},onMouseDown:e=>e.stopPropagation(),children:[(0,o.jsxs)("div",{className:"flex h-10 items-center gap-2 px-3",children:[(0,o.jsx)("span",{"aria-hidden":"true",className:"text-[17px] leading-none text-text_default_secondary",children:"⌕"}),(0,o.jsx)("input",{ref:b,"data-testid":`${d}-find-input`,value:a,placeholder:(0,i.t)("file_panel.find_placeholder"),"aria-label":(0,i.t)("file_panel.find_label"),onChange:e=>f(e.target.value),onKeyDown:x,className:"desktop-text-ui-body h-8 min-w-0 flex-1 bg-transparent text-[15px] leading-5 text-text_default_primary outline-none placeholder:text-text_default_tertiary"}),(0,o.jsx)("div",{className:"h-5 w-[0.5px] bg-border_default"}),(0,o.jsx)("button",{type:"button","data-testid":`${d}-find-close`,"aria-label":(0,i.t)("file_panel.find_close"),onClick:m,className:"h-7 w-7 rounded-md text-[22px] leading-none text-text_default_secondary hover:bg-bg_interaction_tertiary_hover",children:"\xd7"})]}),(0,o.jsxs)("div",{className:"flex h-9 items-center border-t-[0.5px] border-border_default px-3 text-text_default_secondary",children:[(0,o.jsxs)("div",{className:"flex items-center gap-1",children:[(0,o.jsx)("button",{type:"button","data-testid":`${d}-find-previous`,"aria-label":(0,i.t)("file_panel.find_previous"),disabled:y,onClick:h,className:"h-7 w-7 rounded-md text-[20px] leading-none hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",children:"↑"}),(0,o.jsx)("button",{type:"button","data-testid":`${d}-find-next`,"aria-label":(0,i.t)("file_panel.find_next"),disabled:y,onClick:p,className:"h-7 w-7 rounded-md text-[20px] leading-none hover:bg-bg_interaction_tertiary_hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",children:"↓"})]}),(0,o.jsxs)("span",{"data-testid":`${d}-find-results`,className:"ml-auto whitespace-nowrap",children:[w," / ",l," ",(0,i.t)("file_panel.find_results")]})]})]})}},26063:function(e,t,n){"use strict";n.d(t,{mE:function(){return d},fw:function(){return v},Z:function(){return x},Sb:function(){return m},t_:function(){return f},se:function(){return g}});var o=n(7653),r=n(13920),i=n(51459);function a(e,t){return(0,r.uS)((0,o.createElement)(e,{size:t}))}let l={close:a(i.Tw,18),confirm:a(i.cv,18),delete:a(i.pJ,18)};var s=n(99377);let d="mavis-html-selection",c="commentState",u="completed";function m(e,t){return{...e,feedback:t,attributes:{...e.attributes,[c]:u}}}function f(e){return!!e.feedback.trim()||e.attributes[c]===u}function p(e){return null!==e&&"object"==typeof e}function h(e){var t,n;return!!p(e)&&"string"==typeof e.selector&&"string"==typeof e.tagName&&"string"==typeof e.text&&p(e.attributes)&&!!p(t=e.rect)&&"number"==typeof t.x&&"number"==typeof t.y&&"number"==typeof t.width&&"number"==typeof t.height&&!!p(n=e.viewport)&&"number"==typeof n.width&&"number"==typeof n.height&&"string"==typeof e.pageUrl&&"string"==typeof e.targetPath}function g(e,t){var n,o,r;if(!p(e)||e.source!==d||"string"!=typeof e.token||e.token!==t)return null;if("ready"===e.type)return{source:d,token:e.token,type:"ready",payload:p(e.payload)?{enabled:"boolean"==typeof e.payload.enabled?e.payload.enabled:void 0}:void 0};if("element-selected"===e.type&&h(e.payload))return{source:d,token:e.token,type:"element-selected",payload:e.payload};if("comment-added"===e.type&&h(n=e.payload)&&"number"==typeof n.commentId&&"string"==typeof n.feedback&&(!("screenshotDataUrl"in n)||"string"==typeof n.screenshotDataUrl)&&(!("screenshotFileName"in n)||"string"==typeof n.screenshotFileName))return{source:d,token:e.token,type:"comment-added",payload:e.payload};if("comment-removed"===e.type&&p(o=e.payload)&&"number"==typeof o.commentId)return{source:d,token:e.token,type:"comment-removed",payload:e.payload};if("draft-changed"===e.type&&(null===e.payload||p(r=e.payload)&&h(r.selection)&&"string"==typeof r.feedback&&(void 0===r.commentId||Number.isSafeInteger(r.commentId)&&Number(r.commentId)>0)))return{source:d,token:e.token,type:"draft-changed",payload:e.payload};if("draft-restore-failed"===e.type&&p(e.payload)&&("target-missing"===e.payload.reason||"comment-missing"===e.payload.reason))return{source:d,token:e.token,type:"draft-restore-failed",payload:{reason:e.payload.reason}};if("diagnostic"===e.type){let t=function(e){if(!p(e)||"page-control-event"!==e.event||"string"!=typeof e.eventType)return null;let t=t=>"string"==typeof e[t]?String(e[t]).slice(0,80):null,n=t=>"boolean"==typeof e[t]?!!e[t]:null,o=t=>"number"==typeof e[t]&&Number.isFinite(e[t])?Number(e[t]):null;return{event:"page-control-event",eventType:e.eventType.slice(0,80),eventPhase:o("eventPhase"),defaultPrevented:n("defaultPrevented")??!1,propagationStopped:n("propagationStopped")??!1,selectionModeEnabled:n("selectionModeEnabled")??!1,targetTag:t("targetTag"),targetInputType:t("targetInputType"),targetRole:t("targetRole"),targetDisabled:n("targetDisabled"),targetHasPointerCapture:n("targetHasPointerCapture"),button:o("button"),buttons:o("buttons"),pointerType:t("pointerType"),ts:o("ts")??0}}(e.payload);return t?{source:d,token:e.token,type:"diagnostic",payload:t}:null}return null}let b=`(() => {
  const source = '${d}';
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
})();`;function v(e){return`<script data-mavis-html-selection-bridge>${b.replace("__MAVIS_HTML_SELECTION_BRIDGE_TOKEN__",JSON.stringify(e))}</script>`}function x(e,t){var n;return n=v(t),/<\/body>/iu.test(e)?e.replace(/<\/body>/iu,`${n}</body>`):`${e}${n}`}},47482:function(e,t,n){"use strict";function o(e,t,n){e.text+=t;for(let o=0;o<t.length;o+=1)e.sourceOffsets.push(n+o)}function r(e,t,n){let o=t;for(;o<n&&"`"===e[o];)o+=1;return o-t}function i(e){let t={text:"",sourceOffsets:[]},n=0,i=null;for(;n<=e.length;){let a=e.indexOf("\n",n),l=a<0?e.length:a,s=e.slice(n,l),d=/^\s{0,3}(`{3,}|~{3,})/u.exec(s)?.[1];if(d){let e=d[0];null===i?i=e:i===e&&(i=null)}else if(i)for(let r=n;r<l;r+=1)o(t,e[r]??"",r);else!function(e,t,n,i){let a=e.slice(t,n),l=/^\s{0,3}(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)(?:\[[ xX]\]\s+)?/u.exec(a),s=t+(l?.[0].length??0),d=0;for(;s<n;){let t=e[s]??"",a=e[s+1]??"";if("`"===t){let t=r(e,s,n);if(d===t){d=0,s+=t;continue}if(0===d&&function(e,t,n,o){let i=t;for(;i<n;){if("`"!==e[i]){i+=1;continue}let t=r(e,i,n);if(t===o)return!0;i+=t}return!1}(e,s+t,n,t)){d=t,s+=t;continue}for(let e=0;e<t;e+=1)o(i,"`",s+e);s+=t;continue}if(d>0){o(i,t,s),s+=1;continue}if("\\"===t&&s+1<n){o(i,a,s+1),s+=2;continue}if("!"===t&&"["===a){s+=2;continue}if("["===t){s+=1;continue}if("]"===t&&"("===a){let t=function(e,t,n){let o=1;for(let r=t;r<n;r+=1){let t=e[r];if("\\"===t){r+=1;continue}if("("===t&&(o+=1),")"===t&&0==(o-=1))return r+1}return t}(e,s+2,n);s=t>s+2?t:s+1;continue}if("]"===t||"*"===t||"_"===t||"~"===t){s+=1;continue}if("<"===t){let t=e.indexOf(">",s+1);if(t>=0&&t<n){let n=e.slice(s+1,t);/^(?:https?:\/\/|mailto:)/u.test(n)&&o(i,n.replace(/^mailto:/u,""),s+1+(n.startsWith("mailto:")?7:0)),s=t+1;continue}}if("|"===t){s+=1;continue}o(i,t,s),s+=1}}(e,n,l,t);if(a<0)break;o(t,"\n",a),n=a+1}return t}function a(e){return i(e).text}function l(e,t,n){let o=e[0];if(!o)return null;if(Number.isSafeInteger(n)&&(n??-1)>=0&&(n??e.length)<e.length)return e[n??0]??null;let r=Number.isFinite(t)&&(t??-1)>=0?t:void 0;return e.slice(1).reduce((e,t)=>{let n=t.endOffset-t.startOffset,o=e.endOffset-e.startOffset,i=void 0===r?n:Math.abs(t.startOffset-r),a=void 0===r?o:Math.abs(e.startOffset-r);return i!==a?i<a?t:e:n!==o?n<o?t:e:t.startOffset<e.startOffset?t:e},o)}function s(e,t,n,o){let r=t.trim();if(!r)return null;let a=l(function(e,t){let n=[],o=0;for(;o<=e.length-t.length;){let r=e.indexOf(t,o);if(r<0)break;n.push({startOffset:r,endOffset:r+t.length}),o=r+Math.max(1,t.length)}return n}(e,r),n,o);return a?a:l(function(e,t){let n=i(e),o=t.replace(/\s+/gu,"");if(!o)return[];let r="",a=[];for(let e=0;e<n.text.length;e+=1){let t=n.text[e]??"";/\s/u.test(t)||(r+=t,a.push(n.sourceOffsets[e]??-1))}let l=[],s=0;for(;s<=r.length-o.length;){let e=r.indexOf(o,s);if(e<0)break;let t=a[e],n=a[e+o.length-1];void 0!==t&&void 0!==n&&t>=0&&n>=0&&l.push({startOffset:t,endOffset:n+1}),s=e+Math.max(1,o.length)}return l}(e,r),n,o)||l(function(e,t){let n=t.trim().split(/\s+/gu).filter(Boolean),o=n[0];if(!o||n.length<2)return[];let r=[],i=0;for(;i<=e.length-o.length;){let t=e.indexOf(o,i);if(t<0)break;let a=t+o.length,l=!0;for(let t of n.slice(1)){let n=e.indexOf(t,a);if(n<0){l=!1;break}a=n+t.length}l&&r.push({startOffset:t,endOffset:a}),i=t+Math.max(1,o.length)}return r}(e,r),n,o)}n.d(t,{P:function(){return s},V:function(){return a}})},99377:function(e,t,n){"use strict";n.d(t,{D:function(){return r}});var o=n(42385);let r={markerColor:"#0A84FF",wrapper:{height:42,gap:10,border:"1px solid rgba(15, 23, 42, 0.10)",borderRadius:12,background:"rgba(255, 255, 255, 0.96)",boxShadow:"0 0 20px rgba(10,10,10,0.08)",padding:"8px 8px 8px 12px",backdropFilter:"blur(12px)"},position:{gap:12,viewportInset:16,bottomInset:24},input:{color:"#171717",placeholderColor:"#adadad",font:`400 14px/20px ${o.IF}`},actionButton:{size:30,borderRadius:9999,submitBackground:"#171717",submitHoverBackground:"#303030",submitColor:"#ffffff",cancelBackground:"transparent",cancelHoverBackground:"rgba(15, 23, 42, 0.06)",cancelColor:"rgb(148, 163, 184)",cancelHoverColor:"#475569"},deleteButton:{color:"#adadad",hoverBackground:"#0a0a0a0a",hoverColor:"#666666"}};["surface","border","shadow","text","caret","primary","primary-hover","primary-text","cancel-text","cancel-hover","cancel-hover-text","marker","marker-text"].map(e=>`--mavis-selection-${e}`)},77575:function(e,t,n){"use strict";n.d(t,{o:function(){return i}});var o=n(18918),r=n(13327);let i=(0,o.U)((e,t)=>({open:!1,query:"",mode:"chat",modeManuallySelected:!1,hits:[],activeIndex:-1,diffAvailable:!1,diffProjection:a(),diffController:null,openSearch:()=>{let n=t(),o=n.diffAvailable?"diff":"chat";e({open:!0,mode:o,modeManuallySelected:!1}),"diff"===o&&n.diffController?.setQuery(n.query)},closeSearch:()=>{t().diffController?.clear(),e({open:!1,query:"",modeManuallySelected:!1,hits:[],activeIndex:-1,diffProjection:a()})},setMode:n=>{let o=t();if("diff"!==n||o.diffAvailable){if(o.mode===n){e({modeManuallySelected:!0});return}"diff"===o.mode&&o.diffController?.clear(),e({mode:n,modeManuallySelected:!0}),"diff"===n&&o.diffController?.setQuery(o.query)}},setQuery:n=>{e({query:n});let o=t();o.open&&"diff"===o.mode&&o.diffController?.setQuery(n)},registerDiffSearch:n=>{let o=t(),r=o.open&&!o.modeManuallySelected;return e({diffAvailable:!0,diffController:n,...r?{mode:"diff"}:{}}),(r||"diff"===o.mode)&&o.open&&n.setQuery(o.query),()=>{t().diffController?.ownerId===n.ownerId&&(n.clear(),e({diffAvailable:!1,diffController:null,diffProjection:a(),mode:"chat"}))}},setDiffSearchProjection:(n,o)=>{t().diffController?.ownerId===n&&e({diffProjection:o})},recompute:n=>{let{query:o,activeIndex:i}=t(),a=function(e,t){let n=t.trim();if(0===n.length)return[];let o=n.toLowerCase(),i=o.length,a=[],l=0;for(let t of e){let e="user"===t.role?(0,r.eW)(t.msg_content??""):t.msg_content??"";if(0===e.length)continue;let n=e.toLowerCase(),s=0,d=0;for(;d<=n.length-i;){let e=n.indexOf(o,d);if(-1===e)break;a.push({messageId:t.msg_id,matchIndex:s,start:e,end:e+i,globalIndex:l}),s+=1,l+=1,d=e+i}}return a}(n,o);if(0===a.length){e({hits:a,activeIndex:-1});return}let l=i>=0&&i<a.length?i:0;e({hits:a,activeIndex:l})},next:()=>{let{hits:n,activeIndex:o}=t();0!==n.length&&e({activeIndex:(o+1)%n.length})},prev:()=>{let{hits:n,activeIndex:o}=t();0!==n.length&&e({activeIndex:o<=0?n.length-1:o-1})}}));function a(){return{phase:"idle",navigableTotal:0,totalMatches:0,activeIndex:-1,truncated:!1}}},24191:function(e,t,n){"use strict";n.d(t,{X:function(){return i}});var o=n(27573),r=n(7653);n(16229);let i=(0,r.forwardRef)(function(e,t){let{label:n,aiLabel:r,aiIcon:i,onAsk:a,busy:l,disabled:s,aiTitle:d,primaryButtonProps:c,children:u,className:m="",...f}=e;return(0,o.jsxs)("div",{...f,ref:t,className:`office-selection-toolbar ${m}`,role:"toolbar","aria-label":n,"aria-busy":l||void 0,onMouseDown:e=>e.preventDefault(),children:[a&&(0,o.jsxs)("button",{type:"button",className:"office-selection-ai",disabled:l||s,title:d,...c,onClick:e=>{e.preventDefault(),e.stopPropagation(),a()},children:[i," ",r]}),u]})})},16229:function(){}}]);