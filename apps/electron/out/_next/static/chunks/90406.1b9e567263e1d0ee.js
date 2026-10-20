"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[90406],{77039:function(t,e,a){function n(t,e){t.accDescr&&e.setAccDescription?.(t.accDescr),t.accTitle&&e.setAccTitle?.(t.accTitle),t.title&&e.setDiagramTitle?.(t.title)}a.d(e,{A:function(){return n}}),(0,a(53968).e)(n,"populateCommonDb")},90406:function(t,e,a){a.d(e,{diagram:function(){return B}});var n=a(77039),r=a(45066),i=a(87105),o=a(24550),l=a(75926),c=a(53968),s=a(76051),d=(0,c.e)(()=>({domains:new Map,transitions:[]}),"createDefaultData"),f=d(),p={getDomains:(0,c.e)(()=>f.domains,"getDomains"),getTransitions:(0,c.e)(()=>f.transitions,"getTransitions"),setDomains:(0,c.e)(t=>{if(t)for(let e of t){let t=e.domain,a=(e.items??[]).map(t=>({label:t.label}));f.domains.set(t,{name:t,items:a})}},"setDomains"),setTransitions:(0,c.e)(t=>{t&&(f.transitions=t.filter(t=>t.from!==t.to||(l.c.warn(`Cynefin: self-loop transition on domain "${t.from}" is not meaningful and will be skipped.`),!1)).map(t=>({from:t.from,to:t.to,label:t.label||void 0})))},"setTransitions"),getConfig:(0,c.e)(()=>(0,i.Rb)({...o.vZ.cynefin,...(0,o.iE)().cynefin}),"getConfig"),clear:(0,c.e)(()=>{(0,o.ZH)(),f=d()},"clear"),setAccTitle:o.GN,getAccTitle:o.eu,setDiagramTitle:o.g2,getDiagramTitle:o.Kr,getAccDescription:o.Mx,setAccDescription:o.U$},y=(0,c.e)(t=>{(0,n.A)(t,p),p.setDomains(t.domains),p.setTransitions(t.transitions)},"populate"),m={parse:(0,c.e)(async t=>{let e=await (0,s.Qc)("cynefin",t);l.c.debug(e),y(e)},"parse")};function x(t){let e=t+1831565813|0;return e=Math.imul(e^e>>>15,1|e),(((e^=e+Math.imul(e^e>>>7,61|e))^e>>>14)>>>0)/4294967296}function h(t){let e=0;for(let a=0;a<t.length;a++)e=(e<<5)-e+t.charCodeAt(a)|0;return e}function u(t,e){return"number"==typeof t&&Number.isFinite(t)&&0!==t?t:h(e)}function $(t,e,a,n){let r=t/2,i=n??.015*t,o=e/7,l=[];for(let t=0;t<=7;t++){let e=x(a+17*t)*i*2-i;l.push({x:r+e,y:t*o})}let c=`M${l[0].x},${l[0].y}`;for(let t=0;t<l.length-1;t++){let e=l[t],n=l[t+1],r=(e.y+n.y)/2,o=1.5*i*(t%2==0?1:-1)*x(a+31*t+7),s=e.x+o,d=n.x-o;c+=` C${s},${r} ${d},${r} ${n.x},${n.y}`}return c}function g(t,e,a,n){let r=e/2,i=n??.015*e,o=t/7,l=[];for(let t=0;t<=7;t++){let e=x(a+23*t)*i*2-i;l.push({x:t*o,y:r+e})}let c=`M${l[0].x},${l[0].y}`;for(let t=0;t<l.length-1;t++){let e=l[t],n=l[t+1],r=(e.x+n.x)/2,o=1.5*i*(t%2==0?1:-1)*x(a+37*t+11),s=e.y+o,d=n.y-o;c+=` C${r},${s} ${r},${d} ${n.x},${n.y}`}return c}function b(t,e){let a=t/2,n=.5*e,r=.03*t;return`M${a},${n} C${a+r},${n+(e-n)*.2} ${a-1.5*r},${n+(e-n)*.55} ${a+.5*r},${n+(e-n)*.75} C${a-r},${n+(e-n)*.85} ${a+.3*r},${n+(e-n)*.95} ${a},${e}`}function w(t,e,a,n){return`M${t-a},${e} A${a},${n} 0 1,1 ${t+a},${e} A${a},${n} 0 1,1 ${t-a},${e} Z`}(0,c.e)(x,"seededRandom"),(0,c.e)(h,"hashString"),(0,c.e)(u,"resolveSeed"),(0,c.e)($,"generateFoldPath"),(0,c.e)(g,"generateHorizontalBoundary"),(0,c.e)(b,"generateCliffPath"),(0,c.e)(w,"generateConfusionPath");var C={complex:{model:"Probe → Sense → Respond",practice:"Emergent Practices"},complicated:{model:"Sense → Analyse → Respond",practice:"Good Practices"},clear:{model:"Sense → Categorise → Respond",practice:"Best Practices"},chaotic:{model:"Act → Sense → Respond",practice:"Novel Practices"},confusion:{model:"",practice:"Disorder"}},k=(0,c.e)((t,e)=>{let a=t/2,n=e/2;return{complex:{cx:a/2,cy:n/2,x:0,y:0,w:a,h:n},complicated:{cx:a+a/2,cy:n/2,x:a,y:0,w:a,h:n},chaotic:{cx:a/2,cy:n+n/2,x:0,y:n,w:a,h:n},clear:{cx:a+a/2,cy:n+n/2,x:a,y:n,w:a,h:n},confusion:{cx:a,cy:n,x:.7*a,y:.7*n,w:.6*a,h:.6*n}}},"getDomainLayouts"),D=(0,c.e)(()=>{let t=(0,o.xN)(),e=(0,o.iE)();return(0,i.Rb)(t,e.themeVariables).cynefin},"getCynefinDomainColors"),A=(0,c.e)((t,e,a,n)=>{let i=n.db,c=i.getDomains(),s=i.getTransitions(),d=i.getDiagramTitle(),f=i.getAccTitle(),p=i.getAccDescription(),y=i.getConfig(),m=D();l.c.debug("Rendering Cynefin diagram");let x=y.width,h=y.height,A=y.padding,T=y.showDomainDescriptions,B=y.boundaryAmplitude,S=x+2*A,v=h+2*A,z={complex:m.complexBg,complicated:m.complicatedBg,clear:m.clearBg,chaotic:m.chaoticBg,confusion:m.confusionBg},M=(0,r.P)(e);(0,o.v2)(M,v,S,y.useMaxWidth??!0),M.attr("viewBox",`0 0 ${S} ${v}`),f&&M.append("title").text(f),p&&M.append("desc").text(p);let L=M.append("g").attr("transform",`translate(${A}, ${A})`),P=k(x,h),R=u(y.seed,e),E=L.append("g").attr("class","cynefin-backgrounds"),F=["complex","complicated","chaotic","clear"];for(let t of F){let e=P[t];E.append("rect").attr("class","cynefinDomain").attr("x",e.x).attr("y",e.y).attr("width",e.w).attr("height",e.h).attr("fill",z[t]).attr("fill-opacity",.4).attr("stroke","none")}let I=L.append("g").attr("class","cynefin-boundaries");I.append("path").attr("class","cynefinBoundary").attr("d",$(x,h,R,B)).attr("fill","none"),I.append("path").attr("class","cynefinBoundary").attr("d",g(x,h,R+100,B)).attr("fill","none"),I.append("path").attr("class","cynefinCliff").attr("d",b(x,h)).attr("fill","none");let N=.15*x,H=.15*h;L.append("path").attr("class","cynefinConfusion").attr("d",w(x/2,h/2,N,H)).attr("fill",z.confusion).attr("fill-opacity",.5);let W=L.append("g").attr("class","cynefin-labels");for(let t of F){let e=P[t];W.append("text").attr("class","cynefinDomainLabel").attr("x",e.cx).attr("y",T?e.cy-30:e.cy).attr("text-anchor","middle").attr("dominant-baseline","middle").text(t.charAt(0).toUpperCase()+t.slice(1))}if(W.append("text").attr("class","cynefinDomainLabel").attr("x",x/2).attr("y",T?h/2-10:h/2).attr("text-anchor","middle").attr("dominant-baseline","middle").text("Confusion"),T){let t=L.append("g").attr("class","cynefin-subtitles");for(let e of F){let a=P[e],n=C[e];t.append("text").attr("class","cynefinSubtitle").attr("x",a.cx).attr("y",a.cy-10).attr("text-anchor","middle").attr("dominant-baseline","middle").text(n.model),t.append("text").attr("class","cynefinSubtitle").attr("x",a.cx).attr("y",a.cy+5).attr("text-anchor","middle").attr("dominant-baseline","middle").text(n.practice)}t.append("text").attr("class","cynefinSubtitle").attr("x",x/2).attr("y",h/2+8).attr("text-anchor","middle").attr("dominant-baseline","middle").text(C.confusion.practice)}let _=L.append("g").attr("class","cynefin-items");for(let t of["complex","complicated","chaotic","clear","confusion"]){let e;let a=c.get(t);if(!a||0===a.items.length)continue;let n=P[t],r="confusion"===t,i=a.items,o=0;if(r&&a.items.length>3&&(o=a.items.length-3,i=a.items.slice(0,3)),r){let t=T?22:14;e=n.cy+t}else e=n.cy+(T?25:15);if([...i].forEach((a,r)=>{let i=e+30*r,o=_.append("g"),l=o.append("text").attr("class","cynefinItemText").attr("x",0).attr("y",13).attr("text-anchor","middle").attr("dominant-baseline","central").text(a.label),c=7*a.label.length,s=l.node();if(s&&"function"==typeof s.getBBox){let t=s.getBBox();t.width>0&&(c=t.width)}let d=c+20,f=n.cx-d/2;o.attr("transform",`translate(${f}, ${i})`),o.insert("rect","text").attr("class","cynefinItem").attr("x",0).attr("y",0).attr("width",d).attr("height",26).attr("rx",4).attr("ry",4).attr("fill",z[t]).attr("fill-opacity",.95),l.attr("x",d/2).attr("y",13)}),o>0){let a=e+30*i.length,r=`+${o} more`,l=_.append("g"),c=l.append("text").attr("class","cynefinItemText").attr("x",0).attr("y",13).attr("text-anchor","middle").attr("dominant-baseline","central").text(r),s=7*r.length,d=c.node();if(d&&"function"==typeof d.getBBox){let t=d.getBBox();t.width>0&&(s=t.width)}let f=s+20,p=n.cx-f/2;l.attr("transform",`translate(${p}, ${a})`),l.insert("rect","text").attr("class","cynefinItemOverflow").attr("x",0).attr("y",0).attr("width",f).attr("height",26).attr("rx",4).attr("ry",4).attr("fill",z[t]).attr("fill-opacity",.6),c.attr("x",f/2).attr("y",13)}}if(s.length>0){let t=M.select("defs").empty()?M.append("defs"):M.select("defs"),a=`cynefin-arrow-${e}`;t.append("marker").attr("id",a).attr("viewBox","0 0 10 10").attr("refX",9).attr("refY",5).attr("markerWidth",6).attr("markerHeight",6).attr("orient","auto-start-reverse").append("path").attr("d","M 0 0 L 10 5 L 0 10 z").attr("class","cynefinArrowHead");let n=L.append("g").attr("class","cynefin-arrows");s.forEach(t=>{let e=P[t.from],r=P[t.to];if(!e||!r)return;if(t.from===t.to){l.c.warn(`Cynefin renderer: skipping self-loop on domain "${t.from}"`);return}let i=e.cx,o=e.cy,c=r.cx,s=r.cy,d=c-i,f=s-o,p=Math.sqrt(d*d+f*f),y=.15*p,m=(i+c)/2+-f/p*y,x=(o+s)/2+d/p*y;n.append("path").attr("class","cynefinArrowLine").attr("d",`M${i},${o} Q${m},${x} ${c},${s}`).attr("fill","none").attr("marker-end",`url(#${a})`),t.label&&n.append("text").attr("class","cynefinArrowLabel").attr("x",m).attr("y",x-6).attr("text-anchor","middle").attr("dominant-baseline","auto").text(t.label)})}d&&L.append("text").attr("class","cynefinTitle").attr("x",x/2).attr("y",-A/2).attr("text-anchor","middle").attr("dominant-baseline","middle").text(d)},"draw"),T=(0,c.e)(()=>{let t=(0,o.xN)(),e=(0,o.iE)();return(0,i.Rb)(t,e.themeVariables).cynefin},"getCynefinTheme"),B={parser:m,db:p,renderer:{draw:A},styles:(0,c.e)(()=>{let t=T();return`
	.cynefinDomain {
		stroke: none;
	}
	.cynefinDomainLabel {
		font-size: ${t.domainFontSize}px;
		font-weight: bold;
		fill: ${t.labelColor};
	}
	.cynefinSubtitle {
		font-size: ${t.itemFontSize-1}px;
		fill: ${t.textColor};
		font-style: italic;
	}
	.cynefinItem {
		fill-opacity: 0.95;
		stroke: ${t.boundaryColor};
		stroke-width: 1;
	}
	.cynefinItemText {
		font-size: ${t.itemFontSize}px;
		fill: ${t.textColor};
	}
	.cynefinItemOverflow {
		fill-opacity: 0.6;
		stroke: ${t.boundaryColor};
		stroke-width: 1;
		stroke-dasharray: 3 2;
	}
	.cynefinBoundary {
		stroke: ${t.boundaryColor};
		stroke-width: ${t.boundaryWidth};
		stroke-dasharray: 6 3;
	}
	.cynefinCliff {
		stroke: ${t.cliffColor};
		stroke-width: ${t.cliffWidth};
	}
	.cynefinConfusion {
		stroke: ${t.boundaryColor};
		stroke-width: 1.5;
		stroke-dasharray: 4 2;
	}
	.cynefinArrowLine {
		stroke: ${t.arrowColor};
		stroke-width: ${t.arrowWidth};
		fill: none;
	}
	.cynefinArrowHead {
		fill: ${t.arrowColor};
		stroke: none;
	}
	.cynefinArrowLabel {
		font-size: ${t.itemFontSize-1}px;
		fill: ${t.textColor};
	}
	.cynefinTitle {
		font-size: ${t.domainFontSize+2}px;
		font-weight: bold;
		fill: ${t.labelColor};
	}
	`},"styles")}}}]);