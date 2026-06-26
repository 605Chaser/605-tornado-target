const https = require("https");

function scoreSTP(v) {
  if (v >= 4) return { tier:"sig", tierName:"Significant", pts:4.0 };
  if (v >= 2) return { tier:"str", tierName:"Strong", pts:3.0 };
  if (v >= 1) return { tier:"marg", tierName:"Marginal", pts:1.5 };
  return { tier:"weak", tierName:"Low", pts:0 };
}
function scoreSRH(v) {
  if (v >= 300) return { tier:"vs", tierName:"Very Strong", pts:3.0 };
  if (v >= 200) return { tier:"str", tierName:"Strong", pts:2.0 };
  if (v >= 100) return { tier:"marg", tierName:"Marginal", pts:1.0 };
  return { tier:"weak", tierName:"Weak", pts:0 };
}
function scoreCAPE(v) {
  if (v >= 4000) return { tier:"sig", tierName:"Extreme", pts:4.0 };
  if (v >= 2500) return { tier:"str", tierName:"Strong", pts:3.0 };
  if (v >= 1000) return { tier:"marg", tierName:"Moderate", pts:1.5 };
  return { tier:"weak", tierName:"Weak", pts:0 };
}
function scoreShear(v) {
  if (v >= 60) return { tier:"vs", tierName:"Very Strong", pts:3.0 };
  if (v >= 45) return { tier:"str", tierName:"Strong", pts:2.0 };
  if (v >= 30) return { tier:"marg", tierName:"Good", pts:1.5 };
  return { tier:"weak", tierName:"Weak", pts:0 };
}
function scoreEHI(v) {
  if (v >= 4) return { tier:"sig", tierName:"Significant", pts:4.0 };
  if (v >= 2) return { tier:"str", tierName:"Strong", pts:3.0 };
  if (v >= 1) return { tier:"marg", tierName:"Marginal", pts:1.5 };
  return { tier:"weak", tierName:"Low", pts:0 };
}
function scoreUH(v) {
  if (v >= 125) return { tier:"sig", tierName:"Very Strong", pts:3.0 };
  if (v >= 75) return { tier:"str", tierName:"Strong", pts:2.0 };
  if (v >= 25) return { tier:"marg", tierName:"Moderate", pts:1.0 };
  return { tier:"weak", tierName:"Weak", pts:0 };
}

function compositeScore(p) {
  return p.stp.pts*1.5 + p.srh.pts*1.2 + p.cape.pts*1.0 + p.shear.pts*1.0 + p.ehi.pts*1.3 + p.uh.pts*0.8;
}

function generateGrid(lat, lon, radiusMiles) {
  const points = [];
  const R = 3958.8;
  const latStep = (50/R)*(180/Math.PI);
  const lonStep = (50/R)*(180/Math.PI)/Math.cos(lat*Math.PI/180);
  for (let dlat = -radiusMiles/69; dlat <= radiusMiles/69; dlat += latStep) {
    for (let dlon = -radiusMiles/55; dlon <= radiusMiles/55; dlon += lonStep) {
      const glat = lat+dlat, glon = lon+dlon;
      const dLat=(glat-lat)*Math.PI/180, dLon=(glon-lon)*Math.PI/180;
      const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(glat*Math.PI/180)*Math.sin(dLon/2)**2;
      const dist=R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      if (dist<=radiusMiles) points.push({lat:parseFloat(glat.toFixed(3)),lon:parseFloat(glon.toFixed(3)),dist:Math.round(dist)});
    }
  }
  return points;
}

function pointInPolygon(lat, lon, coords) {
  let inside = false;
  for (let i=0,j=coords.length-1;i<coords.length;j=i++) {
    const xi=coords[i][1],yi=coords[i][0],xj=coords[j][1],yj=coords[j][0];
    if (((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

function pointInFeature(lat, lon, feature) {
  if (!feature.geometry) return false;
  const g = feature.geometry;
  if (g.type==="Polygon") return pointInPolygon(lat,lon,g.coordinates[0]);
  if (g.type==="MultiPolygon") return g.coordinates.some(p=>pointInPolygon(lat,lon,p[0]));
  return false;
}

function fetchJSON(url) {
  return new Promise((resolve,reject) => {
    https.get(url,{headers:{"User-Agent":"605Chaser/1.0"}},res=>{
      let data="";
      res.on("data",c=>data+=c);
      res.on("end",()=>{ try{resolve(JSON.parse(data))}catch(e){reject(e)} });
    }).on("error",reject);
  });
}

async function fetchNAM(lat, lon, validISO) {
  const url = `https://mesonet.agron.iastate.edu/json/nwstext.py?lat=${lat}&lon=${lon}&valid=${validISO}&model=nam4km`;
  try {
    const d = (await fetchJSON(url)).data;
    if (!d) return null;
    const cape=parseFloat(d.mlcape||d.cape||0);
    const srh=parseFloat(d.srh1km||d.srh||0);
    const u6=parseFloat(d.shr6_u||0), v6=parseFloat(d.shr6_v||0);
    const shear=Math.sqrt(u6*u6+v6*v6)*1.944;
    const lcl=parseFloat(d.lclhght||1500);
    const cin=Math.abs(parseFloat(d.mlcin||0));
    const ehi=(cape*srh)/160000;
    const stp=Math.max(Math.min(cape/1500,2)*Math.min(srh/150,2)*Math.min((shear*0.5144)/20,1.5)*Math.max((2000-lcl)/1000,0)*Math.min(cin<50?1:(200-cin)/150,1),0);
    const uh=parseFloat(d.max_uh_0_2km||d.uh||0);
    return {cape,srh,shear,lcl,cin,ehi,stp,uh};
  } catch { return null; }
}

async function geocode(lat, lon) {
  try {
    const d = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    return { county:(d.address?.county||`${lat.toFixed(1)}°N`).replace(" County"," Co"), state:d.address?.state_abbr||d.address?.state||"" };
  } catch { return {county:`${lat.toFixed(1)}°N`,state:""}; }
}

exports.handler = async function(event) {
  const headers = {"Access-Control-Allow-Origin":"*","Content-Type":"application/json","Cache-Control":"public, max-age=900"};
  try {
    const p = event.queryStringParameters||{};
    const lat=parseFloat(p.lat||"43.55"), lon=parseFloat(p.lon||"-96.7");
    const day=parseInt(p.day||"1"), radius=parseInt(p.radius||"300");

    const spcUrl = day===1
      ? "https://www.spc.noaa.gov/products/outlook/day1otlk_torn.nolyr.geojson"
      : "https://www.spc.noaa.gov/products/outlook/day2otlk_torn.nolyr.geojson";

    const spcData = await fetchJSON(spcUrl);
    const features = (spcData.features||[]).filter(f=>parseFloat(f.properties?.DN||0)>=2);

    if (!features.length) return {statusCode:200,headers,body:JSON.stringify({hasRisk:false,day,targets:[],spc:{maxProb:0,zones:[]}})};

    const maxProb = Math.max(...features.map(f=>parseFloat(f.properties?.DN||0)));
    const zones = features.map(f=>`${f.properties?.DN||0}%`);

    const grid = generateGrid(lat,lon,radius);
    const spcPoints = grid.filter(pt=>features.some(f=>pointInFeature(pt.lat,pt.lon,f)));

    if (!spcPoints.length) return {statusCode:200,headers,body:JSON.stringify({hasRisk:false,day,targets:[],spc:{maxProb,zones},message:"SPC risk exists but doesn't overlap your 300-mile radius"})};

    const stride=Math.max(1,Math.floor(spcPoints.length/12));
    const sample=spcPoints.filter((_,i)=>i%stride===0).slice(0,12);
    const times=["15Z","18Z","21Z","00Z"];
    const now=new Date();
    const base=new Date(now);
    if (day===2) base.setUTCDate(base.getUTCDate()+1);
    const validTimes=[15,18,21,0].map(h=>{
      const t=new Date(base);
      t.setUTCHours(h,0,0,0);
      if (h===0) t.setUTCDate(t.getUTCDate()+1);
      return t.toISOString().slice(0,16)+":00";
    });

    const results=[];
    for (const pt of sample) {
      const timeResults=await Promise.all(validTimes.map(vt=>fetchNAM(pt.lat,pt.lon,vt)));
      let bestScore=0,bestParams=null,bestIdx=0;
      timeResults.forEach((tr,idx)=>{
        if (!tr) return;
        const params={
          stp:{...scoreSTP(tr.stp),val:tr.stp,label:tr.stp.toFixed(1),name:"STP"},
          srh:{...scoreSRH(tr.srh),val:tr.srh,label:Math.round(tr.srh)+" m²/s²",name:"0–1km SRH"},
          cape:{...scoreCAPE(tr.cape),val:tr.cape,label:Math.round(tr.cape)+" J/kg",name:"MLCAPE"},
          shear:{...scoreShear(tr.shear),val:tr.shear,label:Math.round(tr.shear)+" kt",name:"0–6km Shear"},
          ehi:{...scoreEHI(tr.ehi),val:tr.ehi,label:tr.ehi.toFixed(1),name:"EHI"},
          uh:{...scoreUH(tr.uh),val:tr.uh,label:Math.round(tr.uh)+" m²/s²",name:"UH"}
        };
        const s=compositeScore(params);
        if (s>bestScore){bestScore=s;bestParams=params;bestIdx=idx;}
      });
      if (!bestParams) continue;
      const spcProb=features.reduce((b,f)=>pointInFeature(pt.lat,pt.lon,f)?Math.max(b,parseFloat(f.properties?.DN||0)):b,0);
      results.push({
        lat:pt.lat,lon:pt.lon,dist:pt.dist,
        score:parseFloat(bestScore.toFixed(1)),
        tier:bestScore>=18?"high":bestScore>=12?"mod":"marg",
        window:{start:times[Math.max(0,bestIdx-1)],end:times[Math.min(3,bestIdx+1)],peak:times[bestIdx]},
        spc_prob:spcProb,params:bestParams
      });
    }

    results.sort((a,b)=>b.score-a.score);
    const top5=results.slice(0,5);
    for (let i=0;i<top5.length;i++) {
      const geo=await geocode(top5[i].lat,top5[i].lon);
      top5[i].county=geo.county;
      top5[i].state=geo.state;
      top5[i].rank=i+1;
    }

    return {statusCode:200,headers,body:JSON.stringify({hasRisk:true,day,spc:{maxProb,zones},targets:top5})};
  } catch(err) {
    return {statusCode:500,headers,body:JSON.stringify({error:err.message})};
  }
};

