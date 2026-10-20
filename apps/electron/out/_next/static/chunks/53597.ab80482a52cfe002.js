"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[53597],{77039:function(e,t,a){function i(e,t){e.accDescr&&t.setAccDescription?.(e.accDescr),e.accTitle&&t.setAccTitle?.(e.accTitle),e.title&&t.setDiagramTitle?.(e.title)}a.d(t,{A:function(){return i}}),(0,a(53968).e)(i,"populateCommonDb")},53597:function(e,t,a){a.d(t,{diagram:function(){return D}});var i=a(77039),l=a(45066),r=a(87105),n=a(24550),s=a(75926),o=a(53968),c=a(76051),d=a(78493),p=n.vZ.pie,h={sections:new Map,showData:!1,config:p},g=h.sections,u=h.showData,f=structuredClone(p),m=(0,o.e)(()=>structuredClone(f),"getConfig"),x=(0,o.e)(()=>{g=new Map,u=h.showData,(0,n.ZH)()},"clear"),$=(0,o.e)(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);g.has(e)||(g.set(e,t),s.c.debug(`added new section: ${e}, with value: ${t}`))},"addSection"),w=(0,o.e)(()=>g,"getSections"),b=(0,o.e)(e=>{u=e},"setShowData"),S=(0,o.e)(()=>u,"getShowData"),v={getConfig:m,clear:x,setDiagramTitle:n.g2,getDiagramTitle:n.Kr,setAccTitle:n.GN,getAccTitle:n.eu,setAccDescription:n.U$,getAccDescription:n.Mx,addSection:$,getSections:w,setShowData:b,getShowData:S},y=(0,o.e)((e,t)=>{(0,i.A)(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},"populateDb"),C={parse:(0,o.e)(async e=>{let t=await (0,c.Qc)("pie",e);s.c.debug(t),y(t,v)},"parse")},T=(0,o.e)(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,"getStyles"),k=(0,o.e)(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),a=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return(0,d.ve8)().value(e=>e.value).sort(null)(a)},"createPieArcs"),D={parser:C,db:v,renderer:{draw:(0,o.e)((e,t,a,i)=>{s.c.debug("rendering pie chart\n"+e);let o=i.db,c=(0,n.nV)(),p=(0,r.Rb)(o.getConfig(),c.pie),h=(0,l.P)(t),g=h.append("g");g.attr("transform","translate(225,225)");let{themeVariables:u}=c,[f]=(0,r.VG)(u.pieOuterStrokeWidth);f??=2;let m=p.legendPosition,x=p.textPosition,$=p.donutHole>0&&p.donutHole<=.9?p.donutHole:0,w=(0,d.Nb1)().innerRadius(185*$).outerRadius(185),b=(0,d.Nb1)().innerRadius(185*x).outerRadius(185*x),S=g.append("g");S.append("circle").attr("cx",0).attr("cy",0).attr("r",185+f/2).attr("class","pieOuterCircle");let v=o.getSections(),y=k(v),C=[u.pie1,u.pie2,u.pie3,u.pie4,u.pie5,u.pie6,u.pie7,u.pie8,u.pie9,u.pie10,u.pie11,u.pie12],T=0;v.forEach(e=>{T+=e});let D=y.filter(e=>"0"!==(e.data.value/T*100).toFixed(0)),A=(0,d.PKp)(C).domain([...v.keys()]);S.selectAll("mySlices").data(D).enter().append("path").attr("d",w).attr("fill",e=>A(e.data.label)).attr("class",e=>{let t="pieCircle";return"hover"===p.highlightSlice?t+=" highlightedOnHover":p.highlightSlice===e.data.label&&(t+=" highlighted"),t}),S.selectAll("mySlices").data(D).enter().append("text").text(e=>(e.data.value/T*100).toFixed(0)+"%").attr("transform",e=>"translate("+b.centroid(e)+")").style("text-anchor","middle").attr("class","slice");let O=g.append("text").text(o.getDiagramTitle()).attr("x",0).attr("y",-200).attr("class","pieTitleText"),M=[...v.entries()].map(([e,t])=>({label:e,value:t})),R=g.selectAll(".legend").data(M).enter().append("g").attr("class","legend");R.append("rect").attr("width",18).attr("height",18).style("fill",e=>A(e.label)).style("stroke",e=>A(e.label)),R.append("text").attr("x",22).attr("y",14).text(e=>o.getShowData()?`${e.label} [${e.value}]`:e.label);let z=Math.max(...R.selectAll("text").nodes().map(e=>e?.getBoundingClientRect().width??0)),H=450,N=490,F=22*M.length;switch(m){case"center":R.attr("transform",(e,t)=>"translate("+(-z/2-22)+","+(22*t-22*M.length/2)+")");break;case"top":H+=F,R.attr("transform",(e,t)=>`translate(${-z/2-22}, ${22*t-185})`),S.attr("transform",()=>`translate(0, ${F+22})`);break;case"bottom":H+=F,R.attr("transform",(e,t)=>"translate("+(-z/2-22)+","+(22*t- -207)+")");break;case"left":N+=22+z,R.attr("transform",(e,t)=>"translate(-207,"+(22*t-22*M.length/2)+")"),S.attr("transform",()=>`translate(${z+18+4}, 0)`);break;default:N+=22+z,R.attr("transform",(e,t)=>"translate(216,"+(22*t-22*M.length/2)+")")}let P=O.node()?.getBoundingClientRect().width??0,E=Math.min(0,225-P/2),W=Math.max(N,225+P/2)-E;h.attr("viewBox",`${E} 0 ${W} ${H}`),(0,n.v2)(h,H,W,p.useMaxWidth)},"draw")},styles:T}}}]);