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

function utcHourToLocal(utcHour, ianaTimezone) {
  try {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: ianaTimezone
    });
    const parts = fmt.formatToParts(d);
    const hour = parts.find(p=>p.type==='hour')?.value;
    const min  = parts.find(p=>p.type==='minute')?.value;
    const ampm = parts.find(p=>p.type==='dayperiod')?.value||'';
    return `${hour}${min==='00'?'':':'+min}${ampm.toLowerCase()}`;
  } catch {
    return `${utcHour.toString().padStart(2,'0')}Z`;
  }
}

function tzAbbr(ianaTimezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZoneName: 'short', timeZone: ianaTimezone
    });
    const parts = fmt.formatToParts(new Date());
    return parts.find(p=>p.type==='timeZoneName')?.value || '';
  } catch { return ''; }
}

async function getTimezone(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&forecast_days=1&timezone=auto`;
    const data = await fetchJSON(url);
    return data.timezone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

async function fetchNAM(lat, lon, day) {
  const forecastDays = day === 2 ? 2 : 1;
  // nam_conus = NAM CONUS 3km — 3km resolution, updates every 6 hours, 60hr forecast
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lon}` +
    `&hourly=cape,lifted_index,convective_inhibition,wind_speed_10m,wind_speed_80m,` +
    `wind_speed_120m,wind_direction_10m,wind_direction_80m,wind_direction_120m,` +
    `temperature_2m,dew_point_2m` +
    `&wind_speed_unit=kn&forecast_days=${forecastDays}&timezone=UTC&models=nam_conus`;
  try {
    const data = await fetchJSON(url);
    if (!data || !data.hourly) return null;
    return data.hourly;
  } catch { return null; }
}

function scoreBestWindow(hourly, day, targetTz) {
  const times = hourly.time;
  const now = new Date();
  const targetDate = new Date(now);
  if (day === 2) targetDate.setUTCDate(targetDate.getUTCDate() + 1);
  const targetDateStr = targetDate.toISOString().slice(0, 10);

  let bestScore = 0, bestParams = null, bestUTCHour = 18, bestIdx = -1;

  times.forEach((t, i) => {
    if (!t.startsWith(targetDateStr)) return;
    const hour = parseInt(t.slice(11, 13));
    // Focus on afternoon/evening convective window 15Z-03Z
    if (hour < 15 && hour > 3) return;

    const cape  = Math.max(parseFloat(hourly.cape?.[i] || 0), 0);
    const cin   = Math.abs(parseFloat(hourly.convective_inhibition?.[i] || 0));
    const li    = parseFloat(hourly.lifted_index?.[i] || 0);
    const t2m   = parseFloat(hourly.temperature_2m?.[i] || 20);
    const td2m  = parseFloat(hourly.dew_point_2m?.[i] || 10);

    // Wind components at surface (10m) and ~1km (80m) and ~3km (120m)
    const ws10  = parseFloat(hourly.wind_speed_10m?.[i]    || 0);
    const wd10  = parseFloat(hourly.wind_direction_10m?.[i] || 0);
    const ws80  = parseFloat(hourly.wind_speed_80m?.[i]    || 0);
    const wd80  = parseFloat(hourly.wind_direction_80m?.[i] || 0);
    const ws120 = parseFloat(hourly.wind_speed_120m?.[i]   || 0);
    const wd120 = parseFloat(hourly.wind_direction_120m?.[i]|| 0);

    // U/V components
    const u10  = -ws10  * Math.sin(wd10  * Math.PI/180);
    const v10  = -ws10  * Math.cos(wd10  * Math.PI/180);
    const u80  = -ws80  * Math.sin(wd80  * Math.PI/180);
    const v80  = -ws80  * Math.cos(wd80  * Math.PI/180);
    const u120 = -ws120 * Math.sin(wd120 * Math.PI/180);
    const v120 = -ws120 * Math.cos(wd120 * Math.PI/180);

    // 0-1km shear (surface to 80m proxy, scaled to 1km)
    const shear01 = Math.sqrt((u80-u10)**2 + (v80-v10)**2) * 4.0;

    // 0-6km bulk shear (surface to 120m proxy, scaled to 6km)
    const shear06 = Math.sqrt((u120-u10)**2 + (v120-v10)**2) * 3.2;

    // SRH proxy — use 0-1km shear magnitude and directional change
    const dirChange = Math.abs(wd80 - wd10);
    const dirFactor = Math.min(dirChange > 180 ? 360 - dirChange : dirChange, 90) / 90;
    const srhProxy  = cape > 300 ? Math.min(shear01 * 12 * dirFactor + (cape/40), 400) : 0;

    // LCL proxy from T/Td spread (rough but useful)
    const lcl = Math.max(125 * (t2m - td2m), 400);

    // EHI
    const ehi = (cape * srhProxy) / 160000;

    // STP
    const stp = Math.max(
      Math.min(cape/1500, 2) *
      Math.min(srhProxy/150, 2) *
      Math.min((shear06 * 0.5144)/20, 1.5) *
      Math.max((2000 - lcl)/1000, 0) *
      Math.min(cin < 50 ? 1 : (200-cin)/150, 1),
      0
    );

    // UH proxy
    const uhProxy = (cape>1000 && shear06>30 && cin<100) ?
      Math.min((cape/100) * (shear06/40), 150) : 0;

    const params = {
      stp:   {...scoreSTP(stp),     val:stp,      label:stp.toFixed(1),              name:"STP"},
      srh:   {...scoreSRH(srhProxy),val:srhProxy, label:Math.round(srhProxy)+" m²/s²",name:"0–1km SRH"},
      cape:  {...scoreCAPE(cape),   val:cape,     label:Math.round(cape)+" J/kg",     name:"MLCAPE"},
      shear: {...scoreShear(shear06),val:shear06, label:Math.round(shear06)+" kt",    name:"0–6km Shear"},
      ehi:   {...scoreEHI(ehi),     val:ehi,      label:ehi.toFixed(1),               name:"EHI"},
      uh:    {...scoreUH(uhProxy),  val:uhProxy,  label:Math.round(uhProxy)+" m²/s²", name:"UH"}
    };

    const s = compositeScore(params);
    if (s > bestScore) {
      bestScore = s; bestParams = params; bestUTCHour = hour; bestIdx = i;
    }
  });

  if (!bestParams) return null;

  const peakLocal  = utcHourToLocal(bestUTCHour, targetTz);
  const startUTC   = Math.max(bestUTCHour - 2, 12);
  const endUTC     = Math.min(bestUTCHour + 2, 27) % 24;
  const startLocal = utcHourToLocal(startUTC, targetTz);
  const endLocal   = utcHourToLocal(endUTC, targetTz);
  const abbr       = tzAbbr(targetTz);

  return {
    score: parseFloat(bestScore.toFixed(1)),
    params: bestParams,
    window: {
      start:    startLocal,
      peak:     peakLocal,
      end:      endLocal,
      startUTC: `${startUTC.toString().padStart(2,'0')}Z`,
      peakUTC:  `${bestUTCHour.toString().padStart(2,'0')}Z`,
      endUTC:   `${endUTC.toString().padStart(2,'0')}Z`,
      tzAbbr:   abbr,
      timezone: targetTz
    }
  };
}

async function geocode(lat, lon) {
  try {
    const d = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    return {
      county: (d.address?.county||`${lat.toFixed(1)}°N`).replace(" County"," Co"),
      state:  d.address?.state_abbr||d.address?.state||""
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
    const p      = event.queryStringParameters||{};
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
      body: JSON.stringify({hasRisk:false, day, targets:[], spc:{maxProb,zones},
        message:"SPC risk exists but doesn't overlap your 800-mile radius"})
    };

    // 3. Sample up to 15 points spread across the risk area
    const stride = Math.max(1, Math.floor(spcPoints.length/15));
    const sample = spcPoints.filter((_,i)=>i%stride===0).slice(0,15);

    // 4. Score each point with NAM CONUS 3km data
    const results = [];
    for (const pt of sample) {
      const targetTz = await getTimezone(pt.lat, pt.lon);
      const hourly   = await fetchNAM(pt.lat, pt.lon, day);
      if (!hourly) continue;

      const best = scoreBestWindow(hourly, day, targetTz);
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
      body: JSON.stringify({hasRisk:true, day, spc:{maxProb,zones}, targets:[],
        message:"SPC risk found but NAM 3km parameters too weak to score targets"})
    };

    // 5. Sort by score, geocode top 5
    results.sort((a,b)=>b.score-a.score);
    const top5 = results.slice(0,5);
    for (let i=0; i<top5.length; i++) {
      const geo    = await geocode(top5[i].lat, top5[i].lon);
      top5[i].county = geo.county;
      top5[i].state  = geo.state;
      top5[i].rank   = i+1;
    }

    return {
      statusCode:200, headers,
      body: JSON.stringify({hasRisk:true, day, spc:{maxProb,zones}, targets:top5,
        model:"NAM CONUS 3km"})
    };

  } catch(err) {
    return {statusCode:500, headers, body:JSON.stringify({error:err.message})};
  }
};
