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
  if (v >= 75)  return { tier:"str", tierName:"Strong", pts:2.0 };
  if (v >= 25)  return { tier:"marg", tierName:"Moderate", pts:1.0 };
  return { tier:"weak", tierName:"Weak", pts:0 };
}

function compositeScore(p) {
  return p.stp.pts*1.5 + p.srh.pts*1.2 + p.cape.pts*1.0 + p.shear.pts*1.0 + p.ehi.pts*1.3 + p.uh.pts*0.8;
}

function generateGrid(lat, lon, radiusMiles) {
  const points = [];
  const R = 3958.8;
  const latStep = (55/R)*(180/Math.PI);
  const lonStep = (55/R)*(180/Math.PI)/Math.cos(lat*Math.PI/180);
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
    const xi=coords[i][0],yi=coords[i][1],xj=coords[j][0],yj=coords[j][1];
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

// Open-Meteo: fetch CAPE, shear, SRH for a point across hourly forecast
async function fetchOpenMeteo(lat, lon, day) {
  const forecastDays = day === 2 ? 2 : 1;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cape,lifted_index,convective_inhibition,wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_10m,wind_direction_180m,temperature_2m,dewpoint_2m` +
    `&wind_speed_unit=kn&forecast_days=${forecastDays}&timezone=UTC&models=gfs_seamless`;
  try {
    const data = await fetchJSON(url);
    if (!data || !data.hourly) return null;
    return data.hourly;
  } catch { return null; }
}

// Find the best scoring hour window within a day's hourly data
function scoreBestWindow(hourly, day) {
  const times = hourly.time;
  const now = new Date();
  const targetDate = new Date(now);
  if (day === 2) targetDate.setUTCDate(targetDate.getUTCDate() + 1);
  const targetDateStr = targetDate.toISOString().slice(0, 10);

  let bestScore = 0;
  let bestParams = null;
  let bestTimeLabel = null;
  let bestIdx = -1;

  times.forEach((t, i) => {
    if (!t.startsWith(targetDateStr)) return;
    const hour = parseInt(t.slice(11, 13));
    // Focus on afternoon/evening convective window 15Z-03Z
    if (hour < 15 && hour > 3) return;

    const cape = Math.max(parseFloat(hourly.cape?.[i] || 0), 0);
    const cin  = Math.abs(parseFloat(hourly.convective_inhibition?.[i] || 0));
    const li   = parseFloat(hourly.lifted_index?.[i] || 0);

    // Bulk shear estimate: surface to ~6km using wind components at surface vs 180m (proxy)
    const ws10  = parseFloat(hourly.wind_speed_10m?.[i] || 0);
    const wd10  = parseFloat(hourly.wind_direction_10m?.[i] || 0);
    const ws180 = parseFloat(hourly.wind_speed_180m?.[i] || 0);
    const wd180 = parseFloat(hourly.wind_direction_180m?.[i] || 0);

    // Convert to u/v components and get shear magnitude (scaled to 0-6km proxy)
    const u10  = -ws10  * Math.sin(wd10  * Math.PI/180);
    const v10  = -ws10  * Math.cos(wd10  * Math.PI/180);
    const u180 = -ws180 * Math.sin(wd180 * Math.PI/180);
    const v180 = -ws180 * Math.cos(wd180 * Math.PI/180);
    const shearRaw = Math.sqrt((u180-u10)**2 + (v180-v10)**2);
    // Scale: 180m layer shear to approximate 0-6km (empirical multiplier ~2.8)
    const shear = shearRaw * 2.8;

    // SRH: approximate from CAPE and shear (proxy when direct SRH unavailable)
    // Use LI as a proxy quality check — LI < -2 with high CAPE suggests strong rotation potential
    const srhProxy = cape > 500 ? Math.min((cape / 8) * (shear / 30), 400) : 0;

    // EHI = (CAPE * SRH) / 160000
    const ehi = (cape * srhProxy) / 160000;

    // STP components
    const lcl = li < -3 ? 800 : li < -1 ? 1200 : 1600; // proxy LCL from LI
    const stp = Math.max(
      Math.min(cape/1500, 2) *
      Math.min(srhProxy/150, 2) *
      Math.min((shear*0.5144)/20, 1.5) *
      Math.max((2000-lcl)/1000, 0) *
      Math.min(cin < 50 ? 1 : (200-cin)/150, 1),
      0
    );

    // UH proxy: high CAPE + strong shear + low CIN
    const uhProxy = (cape > 1000 && shear > 30 && cin < 100) ?
      Math.min((cape/100) * (shear/40), 150) : 0;

    const params = {
      stp:   {...scoreSTP(stp),   val:stp,      label:stp.toFixed(1),          name:"STP"},
      srh:   {...scoreSRH(srhProxy), val:srhProxy, label:Math.round(srhProxy)+" m²/s²", name:"0–1km SRH"},
      cape:  {...scoreCAPE(cape), val:cape,     label:Math.round(cape)+" J/kg", name:"MLCAPE"},
      shear: {...scoreShear(shear), val:shear,  label:Math.round(shear)+" kt",  name:"0–6km Shear"},
      ehi:   {...scoreEHI(ehi),   val:ehi,      label:ehi.toFixed(1),           name:"EHI"},
      uh:    {...scoreUH(uhProxy), val:uhProxy, label:Math.round(uhProxy)+" m²/s²", name:"UH"}
    };

    const s = compositeScore(params);
    if (s > bestScore) {
      bestScore = s;
      bestParams = params;
      bestIdx = i;
      bestTimeLabel = `${hour.toString().padStart(2,'0')}Z`;
    }
  });

  if (!bestParams) return null;

  const peakHour = parseInt(times[bestIdx].slice(11,13));
  const startHour = Math.max(peakHour - 2, 12);
  const endHour   = Math.min(peakHour + 2, 3);

  return {
    score: parseFloat(bestScore.toFixed(1)),
    params: bestParams,
    window: {
      start: `${startHour.toString().padStart(2,'0')}Z`,
      peak:  bestTimeLabel,
      end:   `${(peakHour+2).toString().padStart(2,'0')}Z`
    }
  };
}

async function geocode(lat, lon) {
  try {
    const d = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    return {
      county: (d.address?.county||`${lat.toFixed(1)}°N`).replace(" County"," Co"),
      state: d.address?.state_abbr||d.address?.state||""
    };
  } catch { return {county:`${lat.toFixed(1)}°N`, state:""}; }
}

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=900"
  };

  try {
    const p = event.queryStringParameters||{};
    const lat    = parseFloat(p.lat||"43.55");
    const lon    = parseFloat(p.lon||"-96.7");
    const day    = parseInt(p.day||"1");
    const radius = parseInt(p.radius||"800");

    // 1. Fetch SPC tornado outlook
    const spcUrl = day===1
      ? "https://www.spc.noaa.gov/products/outlook/day1otlk_torn.nolyr.geojson"
      : "https://www.spc.noaa.gov/products/outlook/day2otlk_torn.nolyr.geojson";

    const spcData = await fetchJSON(spcUrl);
    const features = (spcData.features||[]).filter(f=>parseFloat(f.properties?.DN||0)>=2);

    if (!features.length) return {
      statusCode:200, headers,
      body: JSON.stringify({hasRisk:false, day, targets:[], spc:{maxProb:0, zones:[]}})
    };

    const maxProb = Math.max(...features.map(f=>parseFloat(f.properties?.DN||0)));
    const zones   = features.map(f=>`${f.properties?.DN||0}%`);

    // 2. Generate grid and filter to SPC overlap
    const grid      = generateGrid(lat, lon, radius);
    const spcPoints = grid.filter(pt=>features.some(f=>pointInFeature(pt.lat,pt.lon,f)));

    if (!spcPoints.length) return {
      statusCode:200, headers,
      body: JSON.stringify({hasRisk:false, day, targets:[], spc:{maxProb,zones}, message:"SPC risk exists but doesn't overlap your 800-mile radius"})
    };

    // 3. Sample up to 15 points
    const stride = Math.max(1, Math.floor(spcPoints.length/15));
    const sample = spcPoints.filter((_,i)=>i%stride===0).slice(0,15);

    // 4. Fetch Open-Meteo for each point and score
    const results = [];
    for (const pt of sample) {
      const hourly = await fetchOpenMeteo(pt.lat, pt.lon, day);
      if (!hourly) continue;

      const best = scoreBestWindow(hourly, day);
      if (!best || best.score === 0) continue;

      const spcProb = features.reduce((b,f)=>
        pointInFeature(pt.lat,pt.lon,f) ? Math.max(b,parseFloat(f.properties?.DN||0)) : b, 0);

      results.push({
        lat: pt.lat, lon: pt.lon, dist: pt.dist,
        score: best.score,
        tier: best.score>=18?"high": best.score>=12?"mod":"marg",
        window: best.window,
        spc_prob: spcProb,
        params: best.params
      });
    }

    if (!results.length) return {
      statusCode:200, headers,
      body: JSON.stringify({hasRisk:true, day, spc:{maxProb,zones}, targets:[], message:"SPC risk found but model parameters too weak to score targets"})
    };

    // 5. Sort and geocode top 5
    results.sort((a,b)=>b.score-a.score);
    const top5 = results.slice(0,5);

    for (let i=0; i<top5.length; i++) {
      const geo = await geocode(top5[i].lat, top5[i].lon);
      top5[i].county = geo.county;
      top5[i].state  = geo.state;
      top5[i].rank   = i+1;
    }

    return {
      statusCode:200, headers,
      body: JSON.stringify({hasRisk:true, day, spc:{maxProb,zones}, targets:top5})
    };

  } catch(err) {
    return {statusCode:500, headers, body:JSON.stringify({error:err.message})};
  }
};
