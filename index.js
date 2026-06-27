const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.get('/status', (req, res) => {
  res.json({ status: 'Atleet Garmin Proxy actief ✓', tijd: new Date().toISOString() });
});

// Cookie jar
class CookieJar {
  constructor() { this.cookies = {}; }
  set(domain, cookieStr) {
    const base = domain.split('.').slice(-2).join('.');
    const main = cookieStr.split(';')[0].trim();
    const eq = main.indexOf('=');
    if (eq < 0) return;
    const name = main.substring(0, eq).trim();
    const val = main.substring(eq + 1).trim();
    if (!this.cookies[base]) this.cookies[base] = {};
    this.cookies[base][name] = val;
  }
  setFromHeaders(domain, headers) {
    const sc = headers['set-cookie'];
    if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => this.set(domain, c));
  }
  get(domain) {
    const base = domain.split('.').slice(-2).join('.');
    const all = {};
    Object.keys(this.cookies).forEach(d => {
      if (base.includes(d) || d.includes(base)) Object.assign(all, this.cookies[d]);
    });
    return Object.entries(all).map(([k,v]) => `${k}=${v}`).join('; ');
  }
  dump() { return JSON.stringify(this.cookies); }
}

function doRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const mod = (opts.protocol || 'https:') === 'http:' ? http : https;
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        location: res.headers['location'] || null,
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function parseUrl(url) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
  };
}

async function smartFetch(jar, url, options = {}, redirects = 0) {
  if (redirects > 12) throw new Error('Te veel redirects');
  const p = parseUrl(url);
  const cookies = jar.get(p.hostname);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    ...(cookies ? { 'Cookie': cookies } : {}),
    ...(options.headers || {}),
  };

  const res = await doRequest({
    protocol: p.protocol,
    hostname: p.hostname,
    port: p.port,
    path: p.path,
    method: options.method || 'GET',
    headers,
  }, options.body || null);

  jar.setFromHeaders(p.hostname, res.headers);

  // Follow redirect
  if (res.location && [301,302,303,307,308].includes(res.status)) {
    const next = res.location.startsWith('http') ? res.location : `${p.protocol}//${p.hostname}${res.location}`;
    console.log(`  → Redirect ${res.status} naar: ${next.substring(0, 80)}`);
    return smartFetch(jar, next, { headers: options.headers }, redirects + 1);
  }

  return res;
}

async function gcApi(jar, path) {
  const url = 'https://connect.garmin.com' + path;
  const p = parseUrl(url);
  const cookies = jar.get(p.hostname);
  const res = await doRequest({
    protocol: p.protocol,
    hostname: p.hostname,
    port: p.port,
    path: p.path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'NK': 'NT',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'nl-NL,nl;q=0.9',
      'Accept-Encoding': 'identity',
      'Referer': 'https://connect.garmin.com/modern/',
      'DI-Backend': 'connectapi.garmin.com',
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
  });
  jar.setFromHeaders(p.hostname, res.headers);
  if (res.status === 401) throw new Error('Sessie verlopen (401)');
  if (res.status === 403) throw new Error('Toegang geweigerd (403)');
  if (res.status >= 400) throw new Error(`HTTP ${res.status} voor ${path}`);
  try { return JSON.parse(res.body); } catch(e) { throw new Error(`Ongeldige JSON van ${path}`); }
}

app.post('/garmin/sync', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord vereist' });

  const jar = new CookieJar();

  try {
    console.log('\n🔐 Login poging voor:', email);

    // Step 1: Get Garmin SSO page
    const ssoBase = 'https://sso.garmin.com/sso/signin';
    const ssoParams = '?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F' +
      '&webhost=olaxpw-conctmodern005' +
      '&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin' +
      '&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F' +
      '&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F' +
      '&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso' +
      '&locale=nl_NL' +
      '&id=gauth-widget' +
      '&clientId=GarminConnect' +
      '&rememberMeShown=true&rememberMeChecked=false' +
      '&createAccountShown=true&openCreateAccount=false' +
      '&consumeServiceTicket=false' +
      '&initialFocus=true&embedWidget=false' +
      '&generateExtraServiceTicket=true' +
      '&generateTwoExtraServiceTickets=false' +
      '&generateNoServiceTicket=false' +
      '&globalOptInShown=true&globalOptInChecked=false' +
      '&mobile=false&connectLegalTerms=true&showPassword=true';

    const ssoUrl = ssoBase + ssoParams;
    console.log('1. SSO pagina ophalen…');
    const ssoRes = await smartFetch(jar, ssoUrl);

    if (ssoRes.status !== 200) throw new Error(`SSO pagina: HTTP ${ssoRes.status}`);

    const csrfMatch = ssoRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      // Try alternate pattern
      const alt = ssoRes.body.match(/"_csrf"\s*:\s*"([^"]+)"/);
      if (!alt) {
        console.log('SSO body (eerste 500 tekens):', ssoRes.body.substring(0, 500));
        throw new Error('CSRF token niet gevonden in SSO pagina');
      }
      csrfMatch = alt;
    }
    const csrf = csrfMatch[1];
    console.log('✓ CSRF:', csrf.substring(0, 12) + '…');

    // Step 2: POST credentials
    console.log('2. Inloggen…');
    const formBody = [
      `username=${encodeURIComponent(email)}`,
      `password=${encodeURIComponent(password)}`,
      `embed=false`,
      `_csrf=${encodeURIComponent(csrf)}`,
    ].join('&');

    const loginRes = await smartFetch(jar, ssoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody).toString(),
        'Origin': 'https://sso.garmin.com',
        'Referer': ssoUrl,
        'NK': 'NT',
      },
      body: formBody,
    });

    const loginBody = loginRes.body + (loginRes.location || '');

    if (loginBody.toLowerCase().includes('invalid') ||
        loginBody.toLowerCase().includes('incorrect') ||
        loginBody.toLowerCase().includes('fout') ||
        loginBody.toLowerCase().includes('error')) {
      throw new Error('Onjuist e-mailadres of wachtwoord');
    }

    // Extract ticket
    const ticketMatch = loginBody.match(/[?&]ticket=([ST]-[A-Za-z0-9_-]+)/);
    if (!ticketMatch) {
      const ticketMatch2 = loginBody.match(/ticket=([A-Za-z0-9_-]{20,})/);
      if (!ticketMatch2) {
        console.log('Login response (eerste 800):', loginBody.substring(0, 800));
        throw new Error('Geen ticket gevonden na login — controleer je gegevens of check je e-mail voor een beveiligingsmail van Garmin');
      }
      var ticket = ticketMatch2[1];
    } else {
      var ticket = ticketMatch[1];
    }
    console.log('✓ Ticket:', ticket.substring(0, 15) + '…');

    // Step 3: Redeem ticket
    console.log('3. Sessie aanmaken…');
    await smartFetch(jar, `https://connect.garmin.com/modern/?ticket=${ticket}`);
    console.log('✓ Sessie aangemaakt');
    console.log('  Cookies:', jar.dump().substring(0, 200));

    // Step 4: Fetch data
    const today = new Date().toISOString().split('T')[0];
    const result = { date: today, synced: [] };

    // Profile
    let displayName = email.split('@')[0];
    try {
      const profile = await gcApi(jar, '/proxy/userprofile-service/socialProfile');
      displayName = profile.displayName || displayName;
      result.profile = { displayName, fullName: profile.fullName };
      console.log('✓ Profiel:', displayName);
    } catch(e) { console.log('⚠️ Profiel:', e.message); }

    // Daily summary
    try {
      const daily = await gcApi(jar, `/proxy/usersummary-service/usersummary/daily/${today}?calendarDate=${today}`);
      result.daily = {
        stappen: daily.totalSteps || 0,
        stress: daily.averageStressLevel || 0,
        kcalVerbrand: daily.activeKilocalories || 0,
        bmr: daily.bmrKilocalories || 0,
      };
      result.synced.push(`👟 ${(daily.totalSteps||0).toLocaleString()} stappen`);
      console.log('✓ Dagdata, stappen:', daily.totalSteps);
    } catch(e) { console.log('⚠️ Dagdata:', e.message); result.daily = null; }

    // Sleep
    try {
      const sleep = await gcApi(jar, `/proxy/wellness-service/wellness/dailySleepData/${displayName}?date=${today}&nonSleepBufferMinutes=60`);
      if (sleep?.dailySleepDTO) {
        const s = sleep.dailySleepDTO;
        result.sleep = {
          duur: Math.round((s.sleepTimeSeconds||0)/360)/10,
          diepe: Math.round((s.deepSleepSeconds||0)/60),
          lichte: Math.round((s.lightSleepSeconds||0)/60),
          rem: Math.round((s.remSleepSeconds||0)/60),
          score: s.sleepScores?.overall?.value || 0,
        };
        result.synced.push(`😴 ${result.sleep.duur}u slaap`);
        console.log('✓ Slaap:', result.sleep.duur + 'u');
      }
    } catch(e) { console.log('⚠️ Slaap:', e.message); result.sleep = null; }

    // Heart rate
    try {
      const hr = await gcApi(jar, `/proxy/wellness-service/wellness/dailyHeartRate/${displayName}?date=${today}`);
      result.hartslag = { rhr: hr.restingHeartRate||0, max: hr.maxHeartRate||0 };
      result.synced.push(`💓 ${hr.restingHeartRate||'–'} bpm`);
      console.log('✓ RHR:', hr.restingHeartRate);
    } catch(e) { console.log('⚠️ Hartslag:', e.message); result.hartslag = null; }

    // HRV
    try {
      const hrv = await gcApi(jar, `/proxy/hrv-service/hrv/${today}`);
      if (hrv?.hrvSummary) {
        result.hrv = {
          nachtelijk: hrv.hrvSummary.lastNight||0,
          status: hrv.hrvSummary.status||'',
          weeklyAvg: hrv.hrvSummary.weeklyAvg||0,
        };
        result.synced.push(`📊 HRV ${result.hrv.nachtelijk}ms`);
        console.log('✓ HRV:', result.hrv.nachtelijk + 'ms');
      }
    } catch(e) { console.log('⚠️ HRV:', e.message); result.hrv = null; }

    // VO2max
    try {
      const vo2 = await gcApi(jar, `/proxy/metrics-service/metrics/maxmet/weekly/${today}?includeAllActivities=false&includeMultiSportActivities=false`);
      if (vo2?.allMetrics?.metricsMap) {
        const map = vo2.allMetrics.metricsMap;
        const val = (map.VO2_MAX_RUNNING||map.VO2_MAX_CYCLING||[])[0]?.value;
        if (val) { result.vo2max = val; result.synced.push(`🫁 VO2max ${val}`); }
        console.log('✓ VO2max:', val);
      }
    } catch(e) { console.log('⚠️ VO2max:', e.message); }

    // Activities
    try {
      const acts = await gcApi(jar, '/proxy/activitylist-service/activities/search/activities?limit=30&start=0');
      if (Array.isArray(acts)) {
        const sportMap = {
          'running':'🏃 Hardlopen','trail_running':'🏃 Hardlopen',
          'cycling':'🚴 Fietsen','indoor_cycling':'🚴 Fietsen',
          'strength_training':'🏋️ Gym','fitness_equipment':'🏋️ Gym',
          'hiit':'⚡ HIIT/Hyrox','cardio_training':'⚡ HIIT/Hyrox',
          'walking':'🚶 Wandelen','swimming':'🏊 Zwemmen',
        };
        result.activiteiten = acts.map(a => ({
          garmin_id: a.activityId,
          naam: a.activityName||'',
          sport: sportMap[a.activityType?.typeKey?.toLowerCase()]||'🏃 Sport',
          datum: a.startTimeLocal||a.beginTimestamp,
          duur: Math.round((a.duration||0)/60),
          afstand: parseFloat(((a.distance||0)/1000).toFixed(2)),
          hartslag: a.averageHR||0,
          maxHartslag: a.maxHR||0,
          kcalVerbrand: a.calories||0,
        }));
        result.synced.push(`🏃 ${acts.length} activiteiten`);
        console.log('✓ Activiteiten:', acts.length);
      }
    } catch(e) { console.log('⚠️ Activiteiten:', e.message); result.activiteiten = []; }

    console.log('✅ Sync klaar:', result.synced.join(', '));
    res.json(result);

  } catch(err) {
    console.error('❌ Fout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Atleet Garmin proxy op poort ${PORT}`));
