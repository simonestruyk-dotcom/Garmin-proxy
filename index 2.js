const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Serve the Atleet app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// Health check
app.get('/status', (req, res) => {
  res.json({ status: 'Atleet Garmin Proxy actief ✓', tijd: new Date().toISOString() });
});

// Simple HTTP request helper using built-in https module
function doRequest(options, body) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          location: res.headers['location'] || null,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseUrl(url) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
  };
}

// Cookie jar (simple)
class CookieJar {
  constructor() { this.cookies = {}; }

  set(domain, cookieStr) {
    const pairs = cookieStr.split(';');
    const main = pairs[0].trim();
    const [name, ...rest] = main.split('=');
    if (!this.cookies[domain]) this.cookies[domain] = {};
    this.cookies[domain][name.trim()] = rest.join('=').trim();
  }

  setFromHeaders(domain, headers) {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookies.forEach(c => this.set(domain, c));
  }

  get(domain) {
    const all = {};
    Object.keys(this.cookies).forEach(d => {
      if (domain.includes(d) || d.includes(domain.split('.').slice(-2).join('.'))) {
        Object.assign(all, this.cookies[d]);
      }
    });
    return Object.entries(all).map(([k,v]) => `${k}=${v}`).join('; ');
  }
}

async function fetchWithCookies(jar, url, options = {}) {
  const parsed = parseUrl(url);
  const cookieStr = jar.get(parsed.hostname);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
    ...(cookieStr ? { 'Cookie': cookieStr } : {}),
    ...(options.headers || {}),
  };

  const reqOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    method: options.method || 'GET',
    headers,
  };

  let res = await doRequest(reqOptions, options.body || null);
  jar.setFromHeaders(parsed.hostname, res.headers);

  // Follow redirects
  let redirectCount = 0;
  while (res.location && redirectCount < 10) {
    redirectCount++;
    const nextUrl = res.location.startsWith('http') ? res.location : `https://${parsed.hostname}${res.location}`;
    const nextParsed = parseUrl(nextUrl);
    const nextCookies = jar.get(nextParsed.hostname);
    res = await doRequest({
      protocol: nextParsed.protocol,
      hostname: nextParsed.hostname,
      port: nextParsed.port,
      path: nextParsed.path,
      method: 'GET',
      headers: {
        'User-Agent': headers['User-Agent'],
        'Accept': headers['Accept'],
        ...(nextCookies ? { 'Cookie': nextCookies } : {}),
      },
    });
    jar.setFromHeaders(nextParsed.hostname, res.headers);
  }

  return res;
}

app.post('/garmin/sync', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord vereist' });
  }

  const jar = new CookieJar();

  try {
    console.log('🔐 Inloggen voor:', email);

    // Step 1: Get SSO page
    const ssoUrl = 'https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&webhost=olaxpw-conctmodern005&source=https%3A%2F%2Fconnect.garmin.com%2Fsignin&redirectAfterAccountLoginUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&redirectAfterAccountCreationUrl=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F&gauthHost=https%3A%2F%2Fsso.garmin.com%2Fsso&locale=en_US&id=gauth-widget&clientId=GarminConnect&rememberMeShown=true&rememberMeChecked=false&createAccountShown=true&openCreateAccount=false&consumeServiceTicket=false&initialFocus=true&embedWidget=false&generateExtraServiceTicket=true&generateTwoExtraServiceTickets=false&generateNoServiceTicket=false&globalOptInShown=true&globalOptInChecked=false&mobile=false&connectLegalTerms=true&showPassword=true';

    const ssoRes = await fetchWithCookies(jar, ssoUrl);
    const csrfMatch = ssoRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) throw new Error('Garmin SSO niet bereikbaar of CSRF niet gevonden');
    const csrf = csrfMatch[1];
    console.log('✓ CSRF token verkregen');

    // Step 2: Login POST
    const formBody = `username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&embed=false&_csrf=${encodeURIComponent(csrf)}`;
    const loginRes = await fetchWithCookies(jar, ssoUrl, {
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

    if (loginRes.body.includes('Invalid') || loginRes.body.includes('incorrect')) {
      throw new Error('Onjuist e-mailadres of wachtwoord');
    }

    const ticketMatch = (loginRes.body + (loginRes.location || '')).match(/ticket=([A-Za-z0-9_-]+)/);
    if (!ticketMatch) throw new Error('Geen ticket na login — controleer je gegevens');
    const ticket = ticketMatch[1];
    console.log('✓ Ticket:', ticket.substring(0, 10) + '...');

    // Step 3: Session
    await fetchWithCookies(jar, `https://connect.garmin.com/modern/?ticket=${ticket}`);
    console.log('✓ Sessie aangemaakt');

    // Helper
    const gcFetch = async (path) => {
      const url = 'https://connect.garmin.com' + path;
      const parsed = parseUrl(url);
      const cookies = jar.get(parsed.hostname);
      const r = await doRequest({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'NK': 'NT',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': 'https://connect.garmin.com/modern/',
          ...(cookies ? { 'Cookie': cookies } : {}),
        },
      });
      jar.setFromHeaders(parsed.hostname, r.headers);
      if (r.status >= 400) throw new Error(`HTTP ${r.status} voor ${path}`);
      return JSON.parse(r.body);
    };

    const today = new Date().toISOString().split('T')[0];
    const result = { date: today, synced: [] };

    // Profile (for displayName)
    let displayName = email.split('@')[0];
    try {
      const profile = await gcFetch('/proxy/userprofile-service/socialProfile');
      displayName = profile.displayName || displayName;
      result.profile = { displayName, fullName: profile.fullName };
      console.log('✓ Profiel:', displayName);
    } catch(e) { console.log('⚠️ Profiel:', e.message); }

    // Daily
    try {
      const daily = await gcFetch(`/proxy/usersummary-service/usersummary/daily/${today}?calendarDate=${today}`);
      result.daily = {
        stappen: daily.totalSteps || 0,
        stress: daily.averageStressLevel || 0,
        kcalVerbrand: daily.activeKilocalories || 0,
        bmr: daily.bmrKilocalories || 0,
      };
      result.synced.push(`👟 ${(daily.totalSteps||0).toLocaleString()} stappen`);
      console.log('✓ Dagdata');
    } catch(e) { console.log('⚠️ Dagdata:', e.message); result.daily = null; }

    // Sleep
    try {
      const sleep = await gcFetch(`/proxy/wellness-service/wellness/dailySleepData/${displayName}?date=${today}&nonSleepBufferMinutes=60`);
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
      const hr = await gcFetch(`/proxy/wellness-service/wellness/dailyHeartRate/${displayName}?date=${today}`);
      result.hartslag = { rhr: hr.restingHeartRate||0, max: hr.maxHeartRate||0 };
      result.synced.push(`💓 ${hr.restingHeartRate||'–'} bpm`);
      console.log('✓ Hartslag:', hr.restingHeartRate);
    } catch(e) { console.log('⚠️ Hartslag:', e.message); result.hartslag = null; }

    // HRV
    try {
      const hrv = await gcFetch(`/proxy/hrv-service/hrv/${today}`);
      if (hrv?.hrvSummary) {
        result.hrv = {
          nachtelijk: hrv.hrvSummary.lastNight||0,
          status: hrv.hrvSummary.status||'',
          weeklyAvg: hrv.hrvSummary.weeklyAvg||0,
        };
        result.synced.push(`📊 HRV ${result.hrv.nachtelijk}ms`);
        console.log('✓ HRV:', result.hrv.nachtelijk);
      }
    } catch(e) { console.log('⚠️ HRV:', e.message); result.hrv = null; }

    // VO2max
    try {
      const vo2 = await gcFetch(`/proxy/metrics-service/metrics/maxmet/weekly/${today}?includeAllActivities=false&includeMultiSportActivities=false`);
      if (vo2?.allMetrics?.metricsMap) {
        const map = vo2.allMetrics.metricsMap;
        const val = (map.VO2_MAX_RUNNING||map.VO2_MAX_CYCLING||[])[0]?.value;
        if (val) { result.vo2max = val; result.synced.push(`🫁 VO2max ${val}`); }
        console.log('✓ VO2max:', val);
      }
    } catch(e) { console.log('⚠️ VO2max:', e.message); }

    // Activities
    try {
      const acts = await gcFetch('/proxy/activitylist-service/activities/search/activities?limit=30&start=0');
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

    console.log('✅ Sync klaar');
    res.json(result);

  } catch(err) {
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Garmin proxy op poort ${PORT}`));
