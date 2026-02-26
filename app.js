/* =========================================================
   JIM'S WEATHER TRACK — app.js
   WeatherAPI.com (forecast) + Tomorrow.io (radar map tiles)
   ========================================================= */

// ─── CONFIG (overridden by localStorage settings) ─────────
const WEATHERAPI_BASE = 'https://api.weatherapi.com/v1';

// Keys & prefs loaded from localStorage (set via Settings panel)
let API_KEY      = localStorage.getItem('jwt_weatherapi_key') || 'YOUR_WEATHERAPI_KEY';
let TOMORROW_KEY = localStorage.getItem('jwt_tomorrow_key')   || 'YOUR_TOMORROW_IO_KEY';

// ─── STATE ────────────────────────────────
let state = {
  unit: localStorage.getItem('jwt_unit') || 'F',
  lat: null,
  lon: null,
  locationName: '',
  weatherData: null,
  radarFrames: [],
  radarLayer: null,
  radarLayers: [],
  radarMap: null,
  radarPlaying: false,
  radarFrameIndex: 0,
  radarPastCount: 0,
  radarTimer: null,
  hourLimit: 24,
};

// ─── DOM REFS ─────────────────────────────
const $ = id => document.getElementById(id);
const loadingScreen = $('loadingScreen');
const errorScreen   = $('errorScreen');
const contentGrid   = $('contentGrid');

// ─── INIT ─────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();        // apply saved theme, unit, keys first
  setupEventListeners();
  setupSettings();       // wire up settings panel
  setupModals();         // wire up expand/modal buttons
  initWeather();
});

function initWeather() {
  showLoading();
  // Check for a saved default location first
  const savedLat  = localStorage.getItem('jwt_lat');
  const savedLon  = localStorage.getItem('jwt_lon');
  const savedCity = localStorage.getItem('jwt_city');

  if (savedLat && savedLon) {
    fetchWeatherByLatLon(parseFloat(savedLat), parseFloat(savedLon));
  } else if (savedCity) {
    fetchWeatherByCity(savedCity);
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => fetchWeatherByLatLon(pos.coords.latitude, pos.coords.longitude),
      ()  => fetchWeatherByCity('New York')
    );
  } else {
    fetchWeatherByCity('New York');
  }
}

// ─── EVENT LISTENERS ──────────────────────
function setupEventListeners() {
  // Unit toggle
  $('unitToggle').addEventListener('click', () => {
    state.unit = state.unit === 'F' ? 'C' : 'F';
    $('unitToggle').textContent = state.unit === 'F' ? '°F / °C' : '°C / °F';
    if (state.weatherData) renderAll(state.weatherData);
  });

  // Locate me
  $('locateBtn').addEventListener('click', initWeather);

  // Search
  $('searchBtn').addEventListener('click', doSearch);
  $('citySearch').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('citySearch').addEventListener('input', debounce(fetchSuggestions, 300));

  // Close suggestions on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap') && !e.target.closest('.suggestions')) {
      $('searchSuggestions').innerHTML = '';
    }
  });

  // Hourly tabs
  document.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      state.hourLimit = parseInt(btn.dataset.hours);
      if (state.weatherData) renderHourly(state.weatherData);
    });
  });

  // Radar controls — Play toggles, Pause stops
  $('radarPlay').addEventListener('click', () => {
    if (state.radarPlaying) {
      stopRadarAnimation();
    } else {
      startRadarAnimation();
    }
  });
  $('radarPause').addEventListener('click', () => stopRadarAnimation());
}

function doSearch() {
  const q = $('citySearch').value.trim();
  if (q.length < 2) return;
  $('searchSuggestions').innerHTML = '';
  showLoading();
  fetchWeatherByCity(q);
}

// ─── SEARCH AUTOCOMPLETE ──────────────────
async function fetchSuggestions() {
  const q = $('citySearch').value.trim();
  if (q.length < 2) { $('searchSuggestions').innerHTML = ''; return; }
  try {
    const res = await fetch(`${WEATHERAPI_BASE}/search.json?key=${API_KEY}&q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const box = $('searchSuggestions');
    box.innerHTML = '';
    (data || []).slice(0, 5).forEach(item => {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      div.textContent = `${item.name}, ${item.region}, ${item.country}`;
      div.addEventListener('click', () => {
        $('citySearch').value = item.name;
        box.innerHTML = '';
        showLoading();
        fetchWeatherByLatLon(item.lat, item.lon);
      });
      box.appendChild(div);
    });
  } catch (e) { /* silent */ }
}

// ─── FETCH WEATHER ────────────────────────
async function fetchWeatherByLatLon(lat, lon) {
  state.lat = lat; state.lon = lon;
  await fetchWeatherData(`${lat},${lon}`);
}

async function fetchWeatherByCity(city) {
  await fetchWeatherData(city);
}

async function fetchWeatherData(query) {
  try {
    const [forecastRes, aqiRes] = await Promise.all([
      fetch(`${WEATHERAPI_BASE}/forecast.json?key=${API_KEY}&q=${encodeURIComponent(query)}&days=10&aqi=yes&alerts=no`),
      Promise.resolve(null)
    ]);

    if (!forecastRes.ok) throw new Error(`API error ${forecastRes.status}`);
    const data = await forecastRes.json();

    state.lat = data.location.lat;
    state.lon = data.location.lon;
    state.weatherData = data;

    renderAll(data);
    showContent();
    initRadarMap();
  } catch (err) {
    console.error(err);
    showError(err.message.includes('403') || err.message.includes('401')
      ? 'Invalid API key. Please add your WeatherAPI.com key in app.js.'
      : 'Failed to fetch weather data. Please check your connection or API key.');
  }
}

// ─── RENDER ALL ───────────────────────────
function renderAll(data) {
  renderHero(data);
  renderHourly(data);
  renderTenDay(data);
  renderExtras(data);
}

// ─── HERO ─────────────────────────────────
function renderHero(data) {
  const cur = data.current;
  const loc = data.location;
  const today = data.forecast.forecastday[0].day;
  const astro = data.forecast.forecastday[0].astro;

  $('heroCity').textContent = loc.name;
  $('heroRegion').textContent = `${loc.region ? loc.region + ', ' : ''}${loc.country}`;
  $('heroDate').textContent = formatDate(loc.localtime);
  $('heroTemp').textContent = temp(state.unit === 'F' ? cur.temp_f : cur.temp_c);
  $('heroCondition').textContent = cur.condition.text;
  $('heroIcon').textContent = conditionEmoji(cur.condition.code, cur.is_day);

  $('feelsLike').textContent = temp(state.unit === 'F' ? cur.feelslike_f : cur.feelslike_c);
  $('humidity').textContent = `${cur.humidity}%`;
  $('wind').textContent = `${state.unit === 'F' ? Math.round(cur.wind_mph) + ' mph' : Math.round(cur.wind_kph) + ' km/h'}`;
  $('uvIndex').textContent = uvLabel(cur.uv);
  $('visibility').textContent = `${state.unit === 'F' ? cur.vis_miles + ' mi' : cur.vis_km + ' km'}`;
  $('pressure').textContent = `${cur.pressure_mb} mb`;
  $('sunrise').textContent = astro.sunrise;
  $('sunset').textContent  = astro.sunset;
}

// ─── HOURLY ───────────────────────────────
function getHourlySlice(data) {
  const allHours = [];
  data.forecast.forecastday.forEach(day => day.hour.forEach(h => allHours.push(h)));
  const localtimeStr   = data.location.localtime;
  const [datePart, timePart] = localtimeStr.split(' ');
  const currentHour    = parseInt((timePart || '00:00').split(':')[0]);
  const currentHourStr = datePart + ' ' + String(currentHour).padStart(2,'0') + ':00';
  let startIdx = allHours.findIndex(h => h.time === currentHourStr);
  if (startIdx === -1) startIdx = 0;
  return allHours.slice(startIdx, startIdx + state.hourLimit);
}

function buildHourlyList(hours, listEl) {
  listEl.innerHTML = '';
  let lastDate = null;

  hours.forEach((h, i) => {
    const isNow = i === 0;
    const dt    = new Date(h.time_epoch * 1000);
    const u     = state.unit === 'F';

    // Day separator when date changes
    const dateStr = dt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (dateStr !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'hour-date-sep';
      sep.textContent = dateStr;
      listEl.appendChild(sep);
      lastDate = dateStr;
    }

    const timeLabel = isNow ? 'Now' : dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const t         = Math.round(u ? h.temp_f      : h.temp_c);
    const feels     = Math.round(u ? h.feelslike_f : h.feelslike_c);
    const windSpd   = u ? `${Math.round(h.wind_mph)} mph` : `${Math.round(h.wind_kph)} km/h`;
    const windGust  = u ? `${Math.round(h.gust_mph)} mph` : `${Math.round(h.gust_kph)} km/h`;
    const precipAmt = u ? `${h.precip_in} in`  : `${h.precip_mm} mm`;
    const dewPt     = Math.round(u ? h.dewpoint_f : h.dewpoint_c);
    const vis       = u ? `${h.vis_miles} mi`  : `${h.vis_km} km`;
    const rain      = h.chance_of_rain;
    const snow      = h.chance_of_snow;
    const isHour    = dt.getMinutes() === 0;

    const wrapper = document.createElement('div');
    wrapper.className = 'hour-wrapper' + (isNow ? ' now' : '') + (isHour ? ' on-hour' : '');

    const row = document.createElement('div');
    row.className = 'hour-row expandable';
    row.innerHTML = `
      <span class="hour-time ${isNow ? 'now-badge' : ''}">${timeLabel}</span>
      <span class="hour-temp-col">${t}°</span>
      <span class="hour-cond-col">
        <span class="hour-icon-sm">${conditionEmoji(h.condition.code, h.is_day)}</span>
        ${h.condition.text}
      </span>
      <span class="hour-rain-col">
        <span class="rain-bar-wrap"><span class="rain-bar" style="width:${rain}%"></span></span>
        ${rain}%
      </span>
      <span class="hour-humidity-col">${h.humidity}%</span>
      <span class="hour-wind-col">${windSpd}</span>
      <span class="hour-precip-col">${precipAmt}</span>
      <span class="hour-chevron">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    `;

    const panel = document.createElement('div');
    panel.className = 'hour-expand-wrap';
    panel.innerHTML = `
      <div class="hour-expand">
        <div class="hxs"><span>🌡 Feels Like</span><strong>${feels}°</strong></div>
        <div class="hxs"><span>🌧 Precip Amount</span><strong>${precipAmt}</strong></div>
        <div class="hxs"><span>💨 Wind</span><strong>${windSpd} ${h.wind_dir}</strong></div>
        <div class="hxs"><span>🔽 Pressure</span><strong>${h.pressure_mb} mb</strong></div>
        <div class="hxs"><span>☁️ Cloud Cover</span><strong>${h.cloud}%</strong></div>
        <div class="hxs"><span>💧 Dew Point</span><strong>${dewPt}°</strong></div>
        <div class="hxs"><span>🌞 UV Index</span><strong>${h.uv} of 11</strong></div>
        <div class="hxs"><span>👁 Visibility</span><strong>${vis}</strong></div>
        <div class="hxs"><span>💦 Humidity</span><strong>${h.humidity}%</strong></div>
        <div class="hxs"><span>💨 Wind Gust</span><strong>${windGust}</strong></div>
        ${snow > 0 ? `<div class="hxs"><span>❄️ Snow Chance</span><strong>${snow}%</strong></div>` : ''}
      </div>
    `;

    row.addEventListener('click', () => {
      const isOpen = wrapper.classList.contains('open');
      listEl.querySelectorAll('.hour-wrapper.open').forEach(w => w.classList.remove('open'));
      if (!isOpen) wrapper.classList.add('open');
    });

    wrapper.appendChild(row);
    wrapper.appendChild(panel);
    listEl.appendChild(wrapper);
  });
}

function renderHourly(data) {
  buildHourlyList(getHourlySlice(data), $('hourlyScroll'));
}

// ─── 10-DAY ───────────────────────────────
function buildDayExpandHTML(d, astro) {
  // Build the day/night detail panel HTML from a forecastday object
  const u = state.unit === 'F';
  const dayTemp   = Math.round(u ? d.day.maxtemp_f   : d.day.maxtemp_c);
  const nightTemp = Math.round(u ? d.day.mintemp_f   : d.day.mintemp_c);
  const wind      = u ? `${Math.round(d.day.maxwind_mph)} mph` : `${Math.round(d.day.maxwind_kph)} km/h`;
  const precip    = u ? `${d.day.totalprecip_in} in` : `${d.day.totalprecip_mm} mm`;
  const vis       = u ? `${d.day.avgvis_miles} mi`   : `${d.day.avgvis_km} km`;
  const snow      = d.day.totalsnow_cm > 0
    ? (u ? `${(d.day.totalsnow_cm/2.54).toFixed(1)} in` : `${d.day.totalsnow_cm} cm`)
    : null;

  return `
    <div class="day-expand">
      <div class="day-expand-halves">
        <div class="day-half day">
          <div class="day-half-header">
            <span class="day-half-label">Day</span>
            <span class="day-half-temp">${dayTemp}°</span>
            <span class="day-half-icon">${conditionEmoji(d.day.condition.code, 1)}</span>
          </div>
          <p class="day-half-desc">${d.day.condition.text}. High around ${dayTemp}°.</p>
          <div class="day-expand-stats">
            <div class="dxs"><span>💧 Rain chance</span><strong>${d.day.daily_chance_of_rain}%</strong></div>
            <div class="dxs"><span>💨 Max wind</span><strong>${wind}</strong></div>
            <div class="dxs"><span>🌊 Humidity</span><strong>${d.day.avghumidity}%</strong></div>
            <div class="dxs"><span>🌞 UV Index</span><strong>${d.day.uv} of 11</strong></div>
            <div class="dxs"><span>👁 Visibility</span><strong>${vis}</strong></div>
            ${snow ? `<div class="dxs"><span>❄️ Snow</span><strong>${snow}</strong></div>` : ''}
            <div class="dxs"><span>🌅 Sunrise</span><strong>${astro.sunrise}</strong></div>
            <div class="dxs"><span>🌇 Sunset</span><strong>${astro.sunset}</strong></div>
          </div>
        </div>
        <div class="day-half night">
          <div class="day-half-header">
            <span class="day-half-label">Night</span>
            <span class="day-half-temp">${nightTemp}°</span>
            <span class="day-half-icon">${conditionEmoji(d.day.condition.code, 0)}</span>
          </div>
          <p class="day-half-desc">${d.day.condition.text}. Low near ${nightTemp}°.</p>
          <div class="day-expand-stats">
            <div class="dxs"><span>❄️ Snow chance</span><strong>${d.day.daily_chance_of_snow}%</strong></div>
            <div class="dxs"><span>🌊 Humidity</span><strong>${d.day.avghumidity}%</strong></div>
            <div class="dxs"><span>🌙 UV Index</span><strong>0 of 11</strong></div>
            <div class="dxs"><span>🌙 Moonrise</span><strong>${astro.moonrise}</strong></div>
            <div class="dxs"><span>🌙 Moonset</span><strong>${astro.moonset}</strong></div>
            <div class="dxs"><span>${moonEmoji(astro.moon_phase)} Phase</span><strong>${astro.moon_phase}</strong></div>
          </div>
        </div>
      </div>
    </div>`;
}

function buildTenDayList(data, listEl) {
  const days = data.forecast.forecastday;
  listEl.innerHTML = '';

  const allLows  = days.map(d => state.unit === 'F' ? d.day.mintemp_f : d.day.mintemp_c);
  const allHighs = days.map(d => state.unit === 'F' ? d.day.maxtemp_f : d.day.maxtemp_c);
  const rangeMin = Math.min(...allLows);
  const rangeMax = Math.max(...allHighs);

  days.forEach((d, i) => {
    const date    = new Date(d.date + 'T12:00:00');
    const isToday = i === 0;
    const low     = Math.round(state.unit === 'F' ? d.day.mintemp_f : d.day.mintemp_c);
    const high    = Math.round(state.unit === 'F' ? d.day.maxtemp_f : d.day.maxtemp_c);
    const pct_start = ((low - rangeMin) / (rangeMax - rangeMin) * 100).toFixed(1);
    const pct_width = (((high - low)    / (rangeMax - rangeMin)) * 100).toFixed(1);
    const rain    = d.day.daily_chance_of_rain;
    const astro   = d.astro;

    // Wrapper holds both the summary row and the expandable panel
    const wrapper = document.createElement('div');
    wrapper.className = 'day-wrapper';

    const row = document.createElement('div');
    row.className = 'day-row expandable';
    row.innerHTML = `
      <span class="day-name ${isToday ? 'today' : ''}">${isToday ? 'Today' : fullDay(date)}</span>
      <span class="day-icon">${conditionEmoji(d.day.condition.code, 1)}</span>
      <div class="day-range-bar-wrap">
        <span class="day-low">${low}°</span>
        <div class="day-range-track">
          <div class="day-range-fill" style="left:${pct_start}%;width:${pct_width}%"></div>
        </div>
        <span class="day-high">${high}°</span>
      </div>
      <span class="day-precip">${rain > 0 ? '💧 ' + rain + '%' : ''}</span>
      <span class="day-chevron">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    `;

    const panel = document.createElement('div');
    panel.className = 'day-expand-wrap';
    panel.innerHTML = buildDayExpandHTML(d, astro);

    // Toggle expand on click
    row.addEventListener('click', () => {
      const isOpen = wrapper.classList.contains('open');
      // Close all other open rows in this list
      listEl.querySelectorAll('.day-wrapper.open').forEach(w => w.classList.remove('open'));
      if (!isOpen) wrapper.classList.add('open');
    });

    wrapper.appendChild(row);
    wrapper.appendChild(panel);
    listEl.appendChild(wrapper);
  });
}

function renderTenDay(data) {
  buildTenDayList(data, $('tendayList'));
}

// ─── EXTRAS ───────────────────────────────
function renderExtras(data) {
  const cur = data.current;
  const today = data.forecast.forecastday[0];

  // AQI
  const aqi = cur.air_quality ? Math.round(cur.air_quality['us-epa-index']) : null;
  if (aqi !== null && cur.air_quality) {
    const pm25 = Math.round(cur.air_quality.pm2_5);
    $('aqiNumber').textContent = pm25;
    $('aqiLabel').textContent = aqiLabel(aqi);
    const pct = Math.min((pm25 / 200) * 100, 100);
    $('aqiMarker').style.left = pct + '%';
  } else {
    $('aqiNumber').textContent = '—';
    $('aqiLabel').textContent = 'N/A';
  }

  // Wind
  const spd = state.unit === 'F' ? `${Math.round(cur.wind_mph)} mph` : `${Math.round(cur.wind_kph)} km/h`;
  const gust = state.unit === 'F' ? `${Math.round(cur.gust_mph)} mph` : `${Math.round(cur.gust_kph)} km/h`;
  $('windSpeed').textContent = spd;
  $('windGust').textContent  = gust;
  $('windDir').textContent   = cur.wind_dir;
  // Needle rotation: wind_degree = direction wind is FROM
  $('compassNeedle').style.transform = `translateX(-50%) translateY(-100%) rotate(${cur.wind_degree}deg)`;

  // Precip
  const precipAmt = state.unit === 'F' ? `${today.day.totalprecip_in} in` : `${today.day.totalprecip_mm} mm`;
  $('precipToday').textContent  = precipAmt;
  $('precipChance').textContent = `${today.day.daily_chance_of_rain}%`;
  const snow = state.unit === 'F' ? today.day.totalsnow_cm > 0 ? `${(today.day.totalsnow_cm / 2.54).toFixed(1)} in` : '0 in'
                                  : today.day.totalsnow_cm > 0 ? `${today.day.totalsnow_cm} cm` : '0 cm';
  $('snowDepth').textContent = snow;
  $('dewPoint').textContent = temp(state.unit === 'F' ? cur.dewpoint_f : cur.dewpoint_c);

  // Moon
  const astro = today.astro;
  $('moonPhaseName').textContent = astro.moon_phase;
  $('moonrise').textContent = astro.moonrise;
  $('moonset').textContent  = astro.moonset;
  $('moonIcon').textContent = moonEmoji(astro.moon_phase);
}

// ─── RADAR MAP ────────────────────────────
// Check if Leaflet loaded; show warning if not
function checkLeaflet() {
  if (typeof L === "undefined") {
    const mapDiv = document.getElementById("radarMap");
    if (mapDiv) mapDiv.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:24px;text-align:center;">
        <div style="font-size:2rem;">🗺️</div>
        <strong style="color:#0F172A;">Radar Map Unavailable</strong>
        <p style="color:#475569;font-size:0.85rem;max-width:320px;">
          Leaflet was blocked. Open via a local server:<br><br>
          <code style="background:#F1F5F9;padding:4px 8px;border-radius:4px;font-size:0.8rem;">
          python3 -m http.server 8080
          </code>
        </p>
      </div>`;
    return false;
  }
  return true;
}

// ─── TOMORROW.IO RADAR ────────────────────────────────────
// Tile URL format:
//   https://api.tomorrow.io/v4/map/tile/{z}/{x}/{y}/{field}/{timestamp}.png?apikey=KEY
//
// Fields used:
//   precipitationIntensity  — actual radar / precip (now + 6h forecast)
//
// We generate timestamps: Now, +1h, +2h, +3h, +4h, +5h, +6h (7 frames total)
// Each frame is a full Leaflet tile layer, pre-loaded at opacity 0.
// Animation simply toggles opacity — instant, no re-fetch lag.

function buildTomorrowFrames() {
  const frames = [];
  const nowMs  = Date.now();
  // Round down to nearest 5-min boundary for cleaner tiles
  const roundedNow = Math.floor(nowMs / (5 * 60 * 1000)) * (5 * 60 * 1000);

  // 1 past frame (10 min ago) so map isn't blank on load, then Now + 6 future hours
  const offsets = [-10, 0, 60, 120, 180, 240, 300, 360]; // minutes
  offsets.forEach(offsetMin => {
    const ts = new Date(roundedNow + offsetMin * 60 * 1000).toISOString();
    frames.push({ time: (roundedNow + offsetMin * 60 * 1000) / 1000, ts, isPast: offsetMin < 0 });
  });
  return frames;
}

async function initRadarMap() {
  if (!checkLeaflet()) return;

  stopRadarAnimation();
  if (state.radarMap) { state.radarMap.remove(); state.radarMap = null; }
  state.radarLayers = [];
  state.radarFrames = [];

  const map = L.map('radarMap', {
    center: [state.lat, state.lon],
    zoom: 7,
    zoomControl: true,
    attributionControl: false,
  });
  state.radarMap = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.65,
  }).addTo(map);

  L.circleMarker([state.lat, state.lon], {
    radius: 7, fillColor: '#2563EB', fillOpacity: 1, color: '#fff', weight: 2
  }).addTo(map);

  if (!TOMORROW_KEY || TOMORROW_KEY === 'YOUR_TOMORROW_IO_KEY') {
    showRadarKeyError();
    return;
  }

  try {
    const frames = buildTomorrowFrames();
    state.radarFrames    = frames;
    state.radarPastCount = frames.filter(f => f.isPast).length; // number of past frames

    // Pre-load ALL layers at opacity 0 — animation just toggles opacity, no re-fetch
    state.radarLayers = frames.map(frame => {
      const tileUrl = `https://api.tomorrow.io/v4/map/tile/{z}/{x}/{y}/precipitationIntensity/${frame.ts}.png?apikey=${TOMORROW_KEY}`;
      const layer = L.tileLayer(tileUrl, {
        opacity: 0, maxZoom: 12, tileSize: 256, zoomOffset: 0,
      });
      layer.addTo(map);
      return layer;
    });

    buildRadarTimeline();

    // Start on "Now" frame (first non-past frame)
    state.radarFrameIndex = state.radarPastCount;
    showRadarFrame(state.radarFrameIndex);
    startRadarAnimation();

  } catch (e) {
    console.error('Radar error:', e);
    showRadarError(e.message);
  }
}

function showRadarKeyError() {
  const mapDiv = document.getElementById('radarMap');
  if (!mapDiv) return;
  mapDiv.style.position = 'relative';
  const msg = document.createElement('div');
  msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.92);z-index:999;flex-direction:column;gap:10px;padding:24px;text-align:center;';
  msg.innerHTML = `
    <span style="font-size:2rem">🔑</span>
    <strong style="color:#0F172A;font-size:1rem;">Tomorrow.io API Key Required</strong>
    <p style="color:#475569;font-size:0.82rem;max-width:300px;line-height:1.5;">
      Get a free key at <strong>app.tomorrow.io/development/keys</strong><br>
      then open <code style="background:#F1F5F9;padding:2px 6px;border-radius:4px;">app.js</code>
      and replace <code style="background:#F1F5F9;padding:2px 6px;border-radius:4px;">YOUR_TOMORROW_IO_KEY</code>
    </p>`;
  mapDiv.appendChild(msg);
}

function showRadarError(msg) {
  const mapDiv = document.getElementById('radarMap');
  if (!mapDiv) return;
  mapDiv.style.position = 'relative';
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.85);z-index:999;flex-direction:column;gap:8px;padding:20px;text-align:center;';
  el.innerHTML = '<span style="font-size:2rem">📡</span><strong>Radar unavailable</strong><span style="font-size:0.8rem;color:#64748B;">' + msg + '</span>';
  mapDiv.appendChild(el);
}

function buildRadarTimeline() {
  const tl = $('radarTimeline');
  tl.innerHTML = '';
  const pastCount = state.radarPastCount || 0;

  state.radarFrames.forEach((frame, i) => {
    // Insert NOW pin at boundary between past and present
    if (i === pastCount) {
      const nowPin = document.createElement('div');
      nowPin.className = 'radar-now-pin';
      nowPin.title = 'Now';
      tl.appendChild(nowPin);
    }
    const dot = document.createElement('div');
    dot.className = 'radar-frame-dot ' + (i < pastCount ? 'past' : 'future');
    dot.id = 'rfd-' + i;
    dot.title = radarFrameLabel(frame);
    dot.addEventListener('click', () => {
      stopRadarAnimation();
      state.radarFrameIndex = i;
      showRadarFrame(i);
    });
    tl.appendChild(dot);
  });
}

function radarFrameLabel(frame) {
  const now = Date.now() / 1000;
  const diffMin = Math.round((frame.time - now) / 60);
  if (Math.abs(diffMin) <= 6) return 'Now';
  if (diffMin > 0) return '+' + diffMin + ' min';
  return Math.abs(diffMin) + ' min ago';
}

function showRadarFrame(index) {
  if (!state.radarMap || !state.radarLayers || !state.radarLayers.length) return;
  const pastCount = state.radarPastCount || 0;
  const isFuture  = index > pastCount;
  const isNow     = index === pastCount;

  state.radarLayers.forEach((layer, i) => {
    layer.setOpacity(i === index ? 0.7 : 0);
  });

  const frame = state.radarFrames[index];
  const label = radarFrameLabel(frame);
  let prefix = isNow ? '📡 Now' : isFuture ? '🔮 Forecast ' + label : '📡 ' + label;
  $('radarTimeLabel').textContent = prefix;

  document.querySelectorAll('.radar-frame-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
    dot.classList.toggle('dimmed', false);
  });
}

function startRadarAnimation() {
  stopRadarAnimation();
  if (!state.radarFrames.length) return;

  state.radarPlaying = true;
  $('radarPlay').classList.add('active');
  $('radarPause').classList.remove('active');

  const loopStart = state.radarPastCount;          // "Now" frame
  const loopEnd   = state.radarFrames.length - 1;  // last future frame (+6h)

  state.radarFrameIndex = loopStart;
  showRadarFrame(state.radarFrameIndex);

  function tick() {
    if (!state.radarPlaying) return;
    if (state.radarFrameIndex >= loopEnd) {
      // Pause 2.5s on last frame then loop back to Now
      state.radarTimer = setTimeout(() => {
        if (!state.radarPlaying) return;
        state.radarFrameIndex = loopStart;
        showRadarFrame(state.radarFrameIndex);
        state.radarTimer = setTimeout(tick, 800);
      }, 2500);
    } else {
      state.radarFrameIndex++;
      showRadarFrame(state.radarFrameIndex);
      state.radarTimer = setTimeout(tick, 800);
    }
  }
  state.radarTimer = setTimeout(tick, 800);
}

function stopRadarAnimation() {
  state.radarPlaying = false;
  clearTimeout(state.radarTimer);
  state.radarTimer = null;
  $('radarPlay').classList.remove('active');
  $('radarPause').classList.add('active');
}

// ─── UI STATE HELPERS ─────────────────────
function showLoading() {
  loadingScreen.style.display = 'flex';
  errorScreen.style.display = 'none';
  contentGrid.style.display = 'none';
}
function showContent() {
  loadingScreen.style.display = 'none';
  errorScreen.style.display = 'none';
  contentGrid.style.display = 'grid';
}
function showError(msg) {
  loadingScreen.style.display = 'none';
  contentGrid.style.display = 'none';
  errorScreen.style.display = 'flex';
  $('errorMsg').textContent = msg;
}

// ─── FORMAT HELPERS ───────────────────────
function temp(val) { return `${Math.round(val)}°`; }
function formatHour(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}${ampm}`;
}
function formatTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDate(str) {
  return new Date(str).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
function fullDay(d) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function uvLabel(uv) {
  if (uv <= 2) return `${uv} Low`;
  if (uv <= 5) return `${uv} Mod`;
  if (uv <= 7) return `${uv} High`;
  if (uv <= 10) return `${uv} V.High`;
  return `${uv} Ext`;
}

function aqiLabel(index) {
  const labels = ['', 'Good', 'Moderate', 'Unhealthy (Sensitive)', 'Unhealthy', 'Very Unhealthy', 'Hazardous'];
  return labels[index] || 'Unknown';
}

function moonEmoji(phase) {
  const map = {
    'New Moon': '🌑', 'Waxing Crescent': '🌒', 'First Quarter': '🌓',
    'Waxing Gibbous': '🌔', 'Full Moon': '🌕', 'Waning Gibbous': '🌖',
    'Last Quarter': '🌗', 'Waning Crescent': '🌘',
  };
  return map[phase] || '🌙';
}

// Weather condition code → emoji
// WeatherAPI condition codes: https://www.weatherapi.com/docs/weather_conditions.json
function conditionEmoji(code, isDay) {
  if (!code) return '🌡️';
  const day = isDay !== 0;
  if (code === 1000) return day ? '☀️' : '🌙';
  if (code === 1003) return day ? '🌤️' : '🌤️';
  if (code === 1006 || code === 1009) return '☁️';
  if ([1030,1135,1147].includes(code)) return '🌫️';
  if ([1063,1150,1153,1180,1183].includes(code)) return '🌦️';
  if ([1186,1189,1192,1195,1198,1201,1240,1243,1246].includes(code)) return '🌧️';
  if ([1066,1069,1072,1204,1207,1210,1213,1216,1219,1222,1225,1237,1249,1252,1255,1258,1261,1264].includes(code)) return '🌨️';
  if ([1087,1273,1276,1279,1282].includes(code)) return '⛈️';
  if (code === 1114 || code === 1117) return '🌬️';
  return '🌡️';
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// ─── WINDOW RESIZE: Redraw chart ──────────
window.addEventListener('resize', debounce(() => {
  if (state.weatherData) renderHourly(state.weatherData);
}, 300));

// ═══════════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════════

function loadSettings() {
  // Apply saved theme
  const theme = localStorage.getItem('jwt_theme') || 'light';
  applyTheme(theme);

  // Apply saved unit
  const unit = localStorage.getItem('jwt_unit') || 'F';
  state.unit = unit;
  const btn = document.getElementById('unitToggle');
  if (btn) btn.textContent = unit === 'F' ? '°F / °C' : '°C / °F';

  // Re-read keys in case they were updated
  API_KEY      = localStorage.getItem('jwt_weatherapi_key') || 'YOUR_WEATHERAPI_KEY';
  TOMORROW_KEY = localStorage.getItem('jwt_tomorrow_key')   || 'YOUR_TOMORROW_IO_KEY';
}

function applyTheme(theme) {
  const body = document.body;
  body.classList.remove('theme-dark', 'theme-light');
  if (theme === 'dark') {
    body.classList.add('theme-dark');
  } else if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) body.classList.add('theme-dark');
  }
  // Mark the active theme button
  document.querySelectorAll('.theme-btn[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function setupSettings() {
  const panel   = document.getElementById('settingsPanel');
  const overlay = document.getElementById('settingsOverlay');
  const openBtn = document.getElementById('settingsBtn');
  const closeBtn = document.getElementById('settingsClose');
  const saveBtn  = document.getElementById('settingsSave');

  // Open
  openBtn.addEventListener('click', () => {
    populateSettingsForm();
    panel.classList.add('open');
    overlay.classList.add('open');
    openBtn.classList.add('active');
  });

  // Close
  function closePanel() {
    panel.classList.remove('open');
    overlay.classList.remove('open');
    openBtn.classList.remove('active');
  }
  closeBtn.addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // Show/hide key toggles
  document.querySelectorAll('.key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '👁' : '🙈';
    });
  });

  // Theme buttons
  document.querySelectorAll('.theme-btn[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn[data-theme]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTheme(btn.dataset.theme);
    });
  });

  // Unit buttons
  document.querySelectorAll('.theme-btn[data-unit]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn[data-unit]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Save current GPS location
  document.getElementById('s_saveLocation').addEventListener('click', () => {
    const status = document.getElementById('s_locationStatus');
    status.textContent = 'Getting location…';
    if (!navigator.geolocation) {
      status.textContent = '⚠ Geolocation not supported';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        localStorage.setItem('jwt_lat', pos.coords.latitude);
        localStorage.setItem('jwt_lon', pos.coords.longitude);
        localStorage.removeItem('jwt_city');
        document.getElementById('s_defaultCity').value = '';
        status.textContent = `✅ Saved (${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)})`;
      },
      () => { status.textContent = '⚠ Could not get location'; }
    );
  });

  // Save & Apply
  saveBtn.addEventListener('click', () => {
    const weatherKey   = document.getElementById('s_weatherKey').value.trim();
    const tomorrowKey  = document.getElementById('s_tomorrowKey').value.trim();
    const defaultCity  = document.getElementById('s_defaultCity').value.trim();
    const activeTheme  = document.querySelector('.theme-btn[data-theme].active');
    const activeUnit   = document.querySelector('.theme-btn[data-unit].active');

    // Save keys
    if (weatherKey)  { localStorage.setItem('jwt_weatherapi_key', weatherKey);  API_KEY = weatherKey; }
    if (tomorrowKey) { localStorage.setItem('jwt_tomorrow_key',   tomorrowKey); TOMORROW_KEY = tomorrowKey; }

    // Save city (clears saved GPS if city is typed)
    if (defaultCity) {
      localStorage.setItem('jwt_city', defaultCity);
      localStorage.removeItem('jwt_lat');
      localStorage.removeItem('jwt_lon');
    }

    // Save theme
    const theme = activeTheme ? activeTheme.dataset.theme : 'light';
    localStorage.setItem('jwt_theme', theme);
    applyTheme(theme);

    // Save unit
    if (activeUnit) {
      const unit = activeUnit.dataset.unit;
      localStorage.setItem('jwt_unit', unit);
      state.unit = unit;
      document.getElementById('unitToggle').textContent = unit === 'F' ? '°F / °C' : '°C / °F';
      if (state.weatherData) renderAll(state.weatherData);
    }

    // Flash saved message
    const msg = document.getElementById('settingsSavedMsg');
    msg.textContent = '✅ Saved!';
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 2500);

    // If keys changed, reload weather & radar
    const needsReload = weatherKey || tomorrowKey || defaultCity;
    if (needsReload) {
      setTimeout(() => {
        closePanel();
        initWeather();
        if (tomorrowKey && state.radarMap) initRadarMap();
      }, 600);
    }
  });
}

function populateSettingsForm() {
  // Pre-fill saved values (mask keys as placeholder dots)
  const wKey = localStorage.getItem('jwt_weatherapi_key') || '';
  const tKey = localStorage.getItem('jwt_tomorrow_key')   || '';
  const city = localStorage.getItem('jwt_city') || '';
  const theme = localStorage.getItem('jwt_theme') || 'light';
  const unit  = localStorage.getItem('jwt_unit')  || 'F';
  const savedLat = localStorage.getItem('jwt_lat');
  const savedLon = localStorage.getItem('jwt_lon');

  const wInput = document.getElementById('s_weatherKey');
  const tInput = document.getElementById('s_tomorrowKey');
  if (wInput) { wInput.value = wKey; wInput.type = 'password'; }
  if (tInput) { tInput.value = tKey; tInput.type = 'password'; }

  const cityInput = document.getElementById('s_defaultCity');
  if (cityInput) cityInput.value = city;

  const statusEl = document.getElementById('s_locationStatus');
  if (statusEl && savedLat && savedLon && !city) {
    statusEl.textContent = `📍 Saved: (${parseFloat(savedLat).toFixed(3)}, ${parseFloat(savedLon).toFixed(3)})`;
  } else if (statusEl) {
    statusEl.textContent = '';
  }

  // Mark active theme & unit buttons
  document.querySelectorAll('.theme-btn[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  document.querySelectorAll('.theme-btn[data-unit]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === unit);
  });
}

// ═══════════════════════════════════════════════════════
// MODALS — Expand cards into full-screen popups
// ═══════════════════════════════════════════════════════

// Separate radar state for the modal map so it doesn't
// conflict with the main dashboard radar
let modalRadar = {
  map: null, layers: [], frames: [],
  pastCount: 0, frameIndex: 0,
  playing: false, timer: null,
};

function setupModals() {
  const backdrop = document.getElementById('modalBackdrop');

  // Wire up all expand buttons
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.modal));
  });

  // Wire up all close buttons
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });

  // Close on backdrop click
  backdrop.addEventListener('click', closeAllModals);

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllModals();
  });

  // Modal hourly pill tabs
  document.querySelectorAll('[data-modal-pills]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-modal-pills]').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      state.hourLimit = parseInt(btn.dataset.hours);
      if (state.weatherData) renderHourlyModal(state.weatherData);
    });
  });

  // Modal radar play/pause
  document.getElementById('radarPlayModal').addEventListener('click', () => {
    if (modalRadar.playing) stopModalRadar(); else startModalRadar();
  });
  document.getElementById('radarPauseModal').addEventListener('click', () => stopModalRadar());
}

function openModal(modalId) {
  const modal    = document.getElementById(modalId);
  const backdrop = document.getElementById('modalBackdrop');
  if (!modal) return;

  backdrop.classList.add('open');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Populate content
  if (modalId === 'hourlyModal' && state.weatherData) {
    renderHourlyModal(state.weatherData);
  } else if (modalId === 'tendayModal' && state.weatherData) {
    renderTenDayModal(state.weatherData);
  } else if (modalId === 'radarModal') {
    // Slight delay so the modal finishes its CSS transition before Leaflet sizes the map
    setTimeout(() => initModalRadar(), 120);
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove('open');
  document.getElementById('modalBackdrop').classList.remove('open');
  document.body.style.overflow = '';
  if (modalId === 'radarModal') destroyModalRadar();
}

function closeAllModals() {
  document.querySelectorAll('.modal.open').forEach(m => {
    m.classList.remove('open');
    if (m.id === 'radarModal') destroyModalRadar();
  });
  document.getElementById('modalBackdrop').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Hourly Modal ──────────────────────────────────────
function renderHourlyModal(data) {
  buildHourlyList(getHourlySlice(data), document.getElementById('hourlyScrollModal'));
}

// ── 10-Day Modal ──────────────────────────────────────
function renderTenDayModal(data) {
  buildTenDayList(data, document.getElementById('tendayListModal'));
}

// ── Radar Modal ───────────────────────────────────────
async function initModalRadar() {
  if (!checkLeaflet()) return;
  destroyModalRadar();

  const map = L.map('radarMapModal', {
    center: [state.lat || 40.7, state.lon || -74.0],
    zoom: 6,
    zoomControl: true,
    attributionControl: false,
  });
  modalRadar.map = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.65,
  }).addTo(map);

  if (state.lat && state.lon) {
    L.circleMarker([state.lat, state.lon], {
      radius: 8, fillColor: '#2563EB', fillOpacity: 1, color: '#fff', weight: 2,
    }).addTo(map);
  }

  if (!TOMORROW_KEY || TOMORROW_KEY === 'YOUR_TOMORROW_IO_KEY') {
    showRadarKeyError(); return;
  }

  try {
    const frames = buildTomorrowFrames();
    modalRadar.frames    = frames;
    modalRadar.pastCount = frames.filter(f => f.isPast).length;

    modalRadar.layers = frames.map(frame => {
      const tileUrl = `https://api.tomorrow.io/v4/map/tile/{z}/{x}/{y}/precipitationIntensity/${frame.ts}.png?apikey=${TOMORROW_KEY}`;
      const layer = L.tileLayer(tileUrl, { opacity: 0, maxZoom: 12, tileSize: 256 });
      layer.addTo(map);
      return layer;
    });

    buildModalRadarTimeline();
    modalRadar.frameIndex = modalRadar.pastCount;
    showModalRadarFrame(modalRadar.frameIndex);
    startModalRadar();
  } catch(e) {
    console.error('Modal radar error:', e);
  }
}

function buildModalRadarTimeline() {
  const tl = document.getElementById('radarTimelineModal');
  tl.innerHTML = '';
  const pastCount = modalRadar.pastCount;

  modalRadar.frames.forEach((frame, i) => {
    if (i === pastCount) {
      const pin = document.createElement('div');
      pin.className = 'radar-now-pin';
      tl.appendChild(pin);
    }
    const dot = document.createElement('div');
    dot.className = 'radar-frame-dot ' + (i < pastCount ? 'past' : 'future');
    dot.id = 'mrfd-' + i;
    dot.title = radarFrameLabel(frame);
    dot.addEventListener('click', () => {
      stopModalRadar();
      modalRadar.frameIndex = i;
      showModalRadarFrame(i);
    });
    tl.appendChild(dot);
  });
}

function showModalRadarFrame(index) {
  if (!modalRadar.map || !modalRadar.layers.length) return;
  const pastCount = modalRadar.pastCount;
  const isFuture  = index > pastCount;
  const isNow     = index === pastCount;

  modalRadar.layers.forEach((layer, i) => layer.setOpacity(i === index ? 0.7 : 0));

  const frame = modalRadar.frames[index];
  const label = radarFrameLabel(frame);
  document.getElementById('radarTimeLabelModal').textContent =
    isNow ? '📡 Now' : isFuture ? '🔮 Forecast ' + label : '📡 ' + label;

  document.querySelectorAll('#radarTimelineModal .radar-frame-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
  });
}

function startModalRadar() {
  stopModalRadar();
  if (!modalRadar.frames.length) return;
  modalRadar.playing = true;
  document.getElementById('radarPlayModal').classList.add('active');
  document.getElementById('radarPauseModal').classList.remove('active');

  const loopStart = modalRadar.pastCount;
  const loopEnd   = modalRadar.frames.length - 1;
  modalRadar.frameIndex = loopStart;
  showModalRadarFrame(modalRadar.frameIndex);

  function tick() {
    if (!modalRadar.playing) return;
    if (modalRadar.frameIndex >= loopEnd) {
      modalRadar.timer = setTimeout(() => {
        if (!modalRadar.playing) return;
        modalRadar.frameIndex = loopStart;
        showModalRadarFrame(modalRadar.frameIndex);
        modalRadar.timer = setTimeout(tick, 800);
      }, 2500);
    } else {
      modalRadar.frameIndex++;
      showModalRadarFrame(modalRadar.frameIndex);
      modalRadar.timer = setTimeout(tick, 800);
    }
  }
  modalRadar.timer = setTimeout(tick, 800);
}

function stopModalRadar() {
  modalRadar.playing = false;
  clearTimeout(modalRadar.timer);
  modalRadar.timer = null;
  const playBtn  = document.getElementById('radarPlayModal');
  const pauseBtn = document.getElementById('radarPauseModal');
  if (playBtn)  playBtn.classList.remove('active');
  if (pauseBtn) pauseBtn.classList.add('active');
}

function destroyModalRadar() {
  stopModalRadar();
  if (modalRadar.map) { modalRadar.map.remove(); modalRadar.map = null; }
  modalRadar.layers = []; modalRadar.frames = [];
  const tl = document.getElementById('radarTimelineModal');
  if (tl) tl.innerHTML = '';
  const mapDiv = document.getElementById('radarMapModal');
  if (mapDiv) mapDiv.innerHTML = '';
}
