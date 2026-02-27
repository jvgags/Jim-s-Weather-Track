/* =========================================================
   JIM'S WEATHER TRACK — app.js
   Open-Meteo (forecast, free, no key) + Tomorrow.io (radar)
   ========================================================= */

// ─── CONFIG ───────────────────────────────────────────────
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_BASE    = 'https://geocoding-api.open-meteo.com/v1/search';

// Tomorrow.io key for radar tiles (loaded from localStorage)
let TOMORROW_KEY = localStorage.getItem('jwt_tomorrow_key') || 'YOUR_TOMORROW_IO_KEY';
// API_KEY kept for backwards compat with settings panel save logic
let API_KEY = localStorage.getItem('jwt_weatherapi_key') || '';

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
  loadSettings();
  setupEventListeners();
  setupSettings();
  setupModals();
  setupSidenav();
  // Show home view by default
  document.querySelectorAll('.view-panel').forEach(el => el.style.display = 'none');
  const home = document.getElementById('view-home');
  if (home) home.style.display = '';
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

// ─── SEARCH AUTOCOMPLETE (Open-Meteo geocoding) ──────────
async function fetchSuggestions() {
  const q = $('citySearch').value.trim();
  if (q.length < 2) { $('searchSuggestions').innerHTML = ''; return; }
  try {
    const res  = await fetch(`${GEOCODE_BASE}?name=${encodeURIComponent(q)}&count=5&language=en&format=json`);
    const data = await res.json();
    const box  = $('searchSuggestions');
    box.innerHTML = '';
    ((data && data.results) || []).forEach(item => {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      div.textContent = [item.name, item.admin1, item.country].filter(Boolean).join(', ');
      div.addEventListener('click', () => {
        $('citySearch').value = item.name;
        box.innerHTML = '';
        showLoading();
        fetchWeatherByLatLon(item.latitude, item.longitude, item.name, item.admin1, item.country);
      });
      box.appendChild(div);
    });
  } catch (e) { /* silent */ }
}

// ─── FETCH WEATHER ────────────────────────
async function fetchWeatherByLatLon(lat, lon, name, region, country) {
  state.lat = lat; state.lon = lon;
  if (name) state.locationName = [name, region, country].filter(Boolean).join(', ');
  await fetchWeatherData(lat, lon);
}

async function fetchWeatherByCity(city) {
  // Geocode first, then fetch weather
  try {
    const res  = await fetch(`${GEOCODE_BASE}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
    const data = await res.json();
    const r    = data.results && data.results[0];
    if (!r) throw new Error('Location not found: ' + city);
    state.locationName = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
    await fetchWeatherByLatLon(r.latitude, r.longitude, r.name, r.admin1, r.country);
  } catch (err) {
    console.error(err);
    showError('Location not found. Try a different city name.');
  }
}

async function fetchWeatherData(lat, lon) {
  try {
    // Open-Meteo: free, no key, NWS/GFS model for USA
    const params = new URLSearchParams({
      latitude:  lat,
      longitude: lon,
      timezone:  'auto',
      forecast_days: 10,
      current: [
        'temperature_2m','relative_humidity_2m','apparent_temperature',
        'is_day','precipitation','weather_code','cloud_cover',
        'wind_speed_10m','wind_direction_10m','wind_gusts_10m',
        'surface_pressure','visibility','dew_point_2m','uv_index',
      ].join(','),
      hourly: [
        'temperature_2m','apparent_temperature','relative_humidity_2m',
        'dew_point_2m','precipitation_probability','precipitation',
        'weather_code','cloud_cover','wind_speed_10m','wind_direction_10m',
        'wind_gusts_10m','visibility','uv_index','is_day','surface_pressure',
      ].join(','),
      daily: [
        'weather_code','temperature_2m_max','temperature_2m_min',
        'apparent_temperature_max','apparent_temperature_min',
        'sunrise','sunset','uv_index_max','precipitation_sum',
        'precipitation_probability_max','wind_speed_10m_max',
        'wind_gusts_10m_max','wind_direction_10m_dominant',
        'precipitation_hours','snowfall_sum','rain_sum',
        'showers_sum','daylight_duration','sunshine_duration',
      ].join(','),
      wind_speed_unit: 'mph',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'inch',
    });

    const res  = await fetch(`${OPEN_METEO_BASE}?${params}`);
    if (!res.ok) throw new Error('Open-Meteo error ' + res.status);
    const raw  = await res.json();

    // Reverse geocode for location name if not already set
    if (!state.locationName) {
      try {
        const gr = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
        const gd = await gr.json();
        const a  = gd.address || {};
        state.locationName = [a.city || a.town || a.village || a.hamlet, a.state, a.country_code?.toUpperCase()].filter(Boolean).join(', ');
      } catch(e) { state.locationName = `${lat.toFixed(2)}, ${lon.toFixed(2)}`; }
    }

    // Normalise into our internal data shape
    const data = normaliseOpenMeteo(raw, lat, lon);
    state.lat = lat; state.lon = lon;
    state.weatherData = data;

    renderAll(data);
    showContent();
    initRadarMap();
  } catch (err) {
    console.error(err);
    showError('Failed to fetch weather data. Please check your connection.');
  }
}

// ─── NORMALISE Open-Meteo → internal shape ─────────────────
// We convert Open-Meteo's flat arrays into structured objects
// that closely mirror what the render functions already expect.
function normaliseOpenMeteo(raw, lat, lon) {
  const tz       = raw.timezone;
  const cur      = raw.current;
  const hourly   = raw.hourly;
  const daily    = raw.daily;
  const nowLocal = new Date(cur.time); // local time per API timezone

  // Helper: celsius stored natively in °F thanks to temperature_unit=fahrenheit
  const cToF = v => v; // already in °F
  const mph   = v => v; // already in mph

  // Wind direction degrees → cardinal
  function degToDir(deg) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  // Moon phase from illumination fraction (0–1) using day of month heuristic
  function moonPhaseStr() {
    const synodic = 29.53058867;
    const known   = new Date('2000-01-06T18:14:00Z'); // known new moon
    const diff    = (Date.now() - known.getTime()) / 86400000;
    const phase   = (diff % synodic) / synodic;
    if (phase < 0.03 || phase > 0.97) return 'New Moon';
    if (phase < 0.22) return 'Waxing Crescent';
    if (phase < 0.28) return 'First Quarter';
    if (phase < 0.47) return 'Waxing Gibbous';
    if (phase < 0.53) return 'Full Moon';
    if (phase < 0.72) return 'Waning Gibbous';
    if (phase < 0.78) return 'Last Quarter';
    return 'Waning Crescent';
  }

  // Format time string "HH:MM" to "6:41 AM"
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Build hourly array (Open-Meteo gives 240 entries; we keep 48)
  const hours = hourly.time.map((t, i) => ({
    time:        t.replace('T', ' '),
    time_epoch:  new Date(t).getTime() / 1000,
    is_day:      hourly.is_day[i],
    temp_f:      hourly.temperature_2m[i],
    temp_c:      (hourly.temperature_2m[i] - 32) * 5/9,
    feelslike_f: hourly.apparent_temperature[i],
    feelslike_c: (hourly.apparent_temperature[i] - 32) * 5/9,
    humidity:    hourly.relative_humidity_2m[i],
    dewpoint_f:  hourly.dew_point_2m[i],
    dewpoint_c:  (hourly.dew_point_2m[i] - 32) * 5/9,
    chance_of_rain:  hourly.precipitation_probability[i] || 0,
    chance_of_snow:  0,
    precip_in:   hourly.precipitation[i] || 0,
    precip_mm:   (hourly.precipitation[i] || 0) * 25.4,
    cloud:       hourly.cloud_cover[i],
    wind_mph:    hourly.wind_speed_10m[i],
    wind_kph:    hourly.wind_speed_10m[i] * 1.60934,
    wind_dir:    degToDir(hourly.wind_direction_10m[i]),
    gust_mph:    hourly.wind_gusts_10m[i],
    gust_kph:    hourly.wind_gusts_10m[i] * 1.60934,
    vis_miles:   ((hourly.visibility[i] || 0) / 1609).toFixed(1),
    vis_km:      ((hourly.visibility[i] || 0) / 1000).toFixed(1),
    uv:          hourly.uv_index[i] || 0,
    pressure_mb: hourly.surface_pressure[i],
    condition: {
      code: hourly.weather_code[i],
      text: wmoText(hourly.weather_code[i]),
    },
  }));

  // Build 10-day forecast array
  const forecastday = daily.time.map((date, i) => {
    // For each day, find matching hourly slots
    const dayHours = hours.filter(h => h.time.startsWith(date));
    const sunriseStr = fmtTime(daily.sunrise[i]);
    const sunsetStr  = fmtTime(daily.sunset[i]);

    return {
      date,
      hour: dayHours,
      astro: {
        sunrise:    sunriseStr,
        sunset:     sunsetStr,
        moonrise:   '—',
        moonset:    '—',
        moon_phase: moonPhaseStr(),
      },
      day: {
        maxtemp_f:            daily.temperature_2m_max[i],
        maxtemp_c:            (daily.temperature_2m_max[i] - 32) * 5/9,
        mintemp_f:            daily.temperature_2m_min[i],
        mintemp_c:            (daily.temperature_2m_min[i] - 32) * 5/9,
        avghumidity:          Math.round(dayHours.reduce((s,h) => s + h.humidity, 0) / (dayHours.length || 1)),
        daily_chance_of_rain: daily.precipitation_probability_max[i] || 0,
        daily_chance_of_snow: 0,
        totalprecip_in:       (daily.precipitation_sum[i] || 0).toFixed(2),
        totalprecip_mm:       ((daily.precipitation_sum[i] || 0) * 25.4).toFixed(1),
        totalsnow_cm:         (daily.snowfall_sum[i] || 0) * 2.54,
        avgvis_miles:         dayHours.length ? (dayHours.reduce((s,h) => s + parseFloat(h.vis_miles), 0) / dayHours.length).toFixed(1) : '—',
        avgvis_km:            dayHours.length ? (dayHours.reduce((s,h) => s + parseFloat(h.vis_km), 0) / dayHours.length).toFixed(1) : '—',
        maxwind_mph:          daily.wind_speed_10m_max[i],
        maxwind_kph:          daily.wind_speed_10m_max[i] * 1.60934,
        uv:                   daily.uv_index_max[i] || 0,
        condition: {
          code: daily.weather_code[i],
          text: wmoText(daily.weather_code[i]),
        },
      },
    };
  });

  // Build current object
  const current = {
    temp_f:       cur.temperature_2m,
    temp_c:       (cur.temperature_2m - 32) * 5/9,
    feelslike_f:  cur.apparent_temperature,
    feelslike_c:  (cur.apparent_temperature - 32) * 5/9,
    humidity:     cur.relative_humidity_2m,
    dewpoint_f:   cur.dew_point_2m,
    dewpoint_c:   (cur.dew_point_2m - 32) * 5/9,
    wind_mph:     cur.wind_speed_10m,
    wind_kph:     cur.wind_speed_10m * 1.60934,
    wind_dir:     degToDir(cur.wind_direction_10m),
    wind_degree:  cur.wind_direction_10m,
    gust_mph:     cur.wind_gusts_10m,
    gust_kph:     cur.wind_gusts_10m * 1.60934,
    vis_miles:    ((cur.visibility || 0) / 1609).toFixed(1),
    vis_km:       ((cur.visibility || 0) / 1000).toFixed(1),
    pressure_mb:  cur.surface_pressure,
    is_day:       cur.is_day,
    uv:           cur.uv_index || 0,
    cloud:        cur.cloud_cover,
    air_quality:  null, // Open-Meteo AQI requires separate endpoint; show N/A
    condition: {
      code: cur.weather_code,
      text: wmoText(cur.weather_code),
    },
  };

  return {
    location: {
      name:      state.locationName.split(',')[0] || 'My Location',
      region:    state.locationName.split(',').slice(1,-1).join(',').trim(),
      country:   state.locationName.split(',').pop()?.trim() || '',
      lat, lon,
      localtime: cur.time.replace('T', ' '),
      tz_id:     tz,
    },
    current,
    forecast: { forecastday },
  };
}

// ─── WMO weather code → text & emoji ─────────────────────
// https://open-meteo.com/en/docs/weathercode
function wmoText(code) {
  const map = {
    0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
    45:'Foggy', 48:'Icy fog',
    51:'Light drizzle', 53:'Moderate drizzle', 55:'Dense drizzle',
    56:'Freezing drizzle', 57:'Heavy freezing drizzle',
    61:'Slight rain', 63:'Moderate rain', 65:'Heavy rain',
    66:'Light freezing rain', 67:'Heavy freezing rain',
    71:'Slight snow', 73:'Moderate snow', 75:'Heavy snow', 77:'Snow grains',
    80:'Slight showers', 81:'Moderate showers', 82:'Violent showers',
    85:'Slight snow showers', 86:'Heavy snow showers',
    95:'Thunderstorm', 96:'Thunderstorm w/ hail', 99:'Thunderstorm w/ heavy hail',
  };
  return map[code] || 'Unknown';
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

  // For today, calculate high/low from remaining future hours only
  // to avoid midnight temps inflating today's "high"
  const localtimeStr   = data.location.localtime;
  const [datePart, timePart] = localtimeStr.split(' ');
  const currentHour    = parseInt((timePart || '00:00').split(':')[0]);
  const currentHourStr = datePart + ' ' + String(currentHour).padStart(2,'0') + ':00';

  function todayRemainingHighLow(day) {
    const futureHours = day.hour.filter(h => h.time >= currentHourStr);
    if (!futureHours.length) return null;
    const temps = futureHours.map(h => state.unit === 'F' ? h.temp_f : h.temp_c);
    return { high: Math.max(...temps), low: Math.min(...temps) };
  }

  const allLows  = days.map((d, i) => {
    if (i === 0) { const r = todayRemainingHighLow(d); if (r) return r.low; }
    return state.unit === 'F' ? d.day.mintemp_f : d.day.mintemp_c;
  });
  const allHighs = days.map((d, i) => {
    if (i === 0) { const r = todayRemainingHighLow(d); if (r) return r.high; }
    return state.unit === 'F' ? d.day.maxtemp_f : d.day.maxtemp_c;
  });
  const rangeMin = Math.min(...allLows);
  const rangeMax = Math.max(...allHighs);

  days.forEach((d, i) => {
    const date    = new Date(d.date + 'T12:00:00');
    const isToday = i === 0;
    let low, high;
    if (isToday) {
      const r = todayRemainingHighLow(d);
      low  = Math.round(r ? r.low  : (state.unit === 'F' ? d.day.mintemp_f : d.day.mintemp_c));
      high = Math.round(r ? r.high : (state.unit === 'F' ? d.day.maxtemp_f : d.day.maxtemp_c));
    } else {
      low  = Math.round(state.unit === 'F' ? d.day.mintemp_f : d.day.mintemp_c);
      high = Math.round(state.unit === 'F' ? d.day.maxtemp_f : d.day.maxtemp_c);
    }
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
    zoom: 8,
    zoomControl: true,
    attributionControl: false,
  });
  state.radarMap = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.75,
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
    stopRadarAnimation(); // start paused on Now — user clicks Play to animate

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
  const t = new Date(frame.time * 1000);
  const timeStr = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffMin > 0) return timeStr;
  return timeStr;
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

// WMO weather code → emoji
function conditionEmoji(code, isDay) {
  const day = isDay !== 0;
  if (code === 0)            return day ? '☀️' : '🌙';
  if (code === 1)            return day ? '🌤️' : '🌤️';
  if (code === 2)            return day ? '⛅' : '⛅';
  if (code === 3)            return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57)   return '🌦️';
  if (code >= 61 && code <= 67)   return '🌧️';
  if (code >= 71 && code <= 77)   return '🌨️';
  if (code >= 80 && code <= 82)   return '🌦️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95)            return '⛈️';
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
  const theme = localStorage.getItem('jwt_theme') || 'dark';
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
  // Remove all theme classes
  body.classList.remove(
    'theme-dark','theme-light','theme-sunset','theme-forest',
    'theme-storm','theme-aurora','theme-desert','theme-ocean'
  );
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    body.classList.add(prefersDark ? 'theme-dark' : 'theme-light');
  } else if (theme && theme !== 'auto') {
    body.classList.add('theme-' + theme);
  } else {
    body.classList.add('theme-dark');
  }
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
    if (weatherKey)  { localStorage.setItem('jwt_weatherapi_key', weatherKey);  API_KEY = weatherKey; } // kept for future use
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
  const theme = localStorage.getItem('jwt_theme') || 'dark';
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

// ═══════════════════════════════════════════════════════
// SIDENAV & VIEW ROUTING
// ═══════════════════════════════════════════════════════

let currentView = 'home';
let monthlyOffset = 0; // months offset from today for monthly view

// Solo radar state (Radar view's independent map)
let soloRadar = {
  map: null, layers: [], frames: [],
  pastCount: 0, frameIndex: 0,
  playing: false, timer: null,
};

function setupSidenav() {
  const btn     = document.getElementById('hamburgerBtn');
  const nav     = document.getElementById('sidenav');
  const overlay = document.getElementById('sidenavOverlay');
  const shell   = document.getElementById('pageShell');

  function openNav() {
    nav.classList.add('open');
    overlay.classList.add('open');
    btn.classList.add('open');
    shell.classList.add('nav-open');
  }
  function closeNav() {
    nav.classList.remove('open');
    overlay.classList.remove('open');
    btn.classList.remove('open');
    shell.classList.remove('nav-open');
  }

  btn.addEventListener('click', () => nav.classList.contains('open') ? closeNav() : openNav());
  overlay.addEventListener('click', closeNav);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });

  // Nav item clicks
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.view);
      // On mobile, close the nav after selection
      if (window.innerWidth < 900) closeNav();
    });
  });
}

function navigateTo(view) {
  if (view === currentView) return;
  currentView = view;

  // Update active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  // Hide all view panels
  document.querySelectorAll('.view-panel').forEach(el => el.style.display = 'none');

  // Show target panel
  const panel = document.getElementById('view-' + view);
  if (panel) panel.style.display = '';

  // Populate view-specific content
  if (view === 'themes') { renderThemesPage(); return; }
  if (state.weatherData) {
    if (view === 'today')   renderTodayView(state.weatherData);
    if (view === 'hourly')  renderHourlySolo(state.weatherData);
    if (view === 'tenday')  renderTendaySolo(state.weatherData);
    if (view === 'monthly') renderMonthlyView(state.weatherData);
    if (view === 'radar')   initSoloRadar();
  }

  // Destroy solo radar if leaving radar view
  if (view !== 'radar') destroySoloRadar();
}

// ── TODAY VIEW ────────────────────────────────────────
function renderTodayView(data) {
  const grid = document.querySelector('#view-today .today-grid');
  if (!grid) return;
  // Clone the hero card and extras from home view
  grid.innerHTML = '';
  const heroClone   = document.querySelector('#view-home .hero-card');
  const extrasClone = document.querySelector('#view-home .extras-row');
  if (heroClone)   grid.appendChild(heroClone.cloneNode(true));
  if (extrasClone) grid.appendChild(extrasClone.cloneNode(true));
}

// ── HOURLY SOLO VIEW ──────────────────────────────────
function renderHourlySolo(data) {
  const list = document.getElementById('hourlyScrollSolo');
  if (!list) return;
  buildHourlyList(getHourlySlice(data), list);

  // Wire solo pill tabs
  document.querySelectorAll('[data-solo]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-solo]').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      state.hourLimit = parseInt(btn.dataset.hours);
      buildHourlyList(getHourlySlice(data), list);
    });
  });
}

// ── 10-DAY SOLO VIEW ──────────────────────────────────
function renderTendaySolo(data) {
  const list = document.getElementById('tendayListSolo');
  if (list) buildTenDayList(data, list);
}

// ── MONTHLY VIEW ──────────────────────────────────────
function renderMonthlyView(data) {
  const container = document.getElementById('monthlyGrid');
  if (!container) return;

  const now   = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + monthlyOffset, 1);
  const year  = target.getFullYear();
  const month = target.getMonth();

  // Add nav controls (only once per render)
  const card = container.closest('.card');
  let navEl = card.querySelector('.monthly-nav');
  if (!navEl) {
    navEl = document.createElement('div');
    navEl.className = 'monthly-nav';
    navEl.innerHTML = `
      <button class="monthly-nav-btn" id="monthPrev">&#8249;</button>
      <h3></h3>
      <button class="monthly-nav-btn" id="monthNext">&#8250;</button>
    `;
    card.querySelector('.card-header').after(navEl);
    document.getElementById('monthPrev').addEventListener('click', () => { monthlyOffset--; renderMonthlyView(state.weatherData); });
    document.getElementById('monthNext').addEventListener('click', () => { monthlyOffset++; renderMonthlyView(state.weatherData); });
  }
  navEl.querySelector('h3').textContent = target.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow    = new Date(year, month, 1).getDay(); // 0=Sun
  const today       = new Date();

  // Get forecast data for available days
  const forecastByDate = {};
  if (data && data.forecast) {
    data.forecast.forecastday.forEach(d => { forecastByDate[d.date] = d; });
  }

  container.innerHTML = '';

  // Day-of-week headers
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'monthly-dow';
    el.textContent = d;
    container.appendChild(el);
  });

  // Empty cells before first day
  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'monthly-cell empty';
    container.appendChild(el);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = (day === today.getDate() && month === today.getMonth() && year === today.getFullYear());
    const fc      = forecastByDate[dateStr];

    const cell = document.createElement('div');
    cell.className = 'monthly-cell' + (isToday ? ' today' : '');

    const high = fc ? Math.round(state.unit === 'F' ? fc.day.maxtemp_f : fc.day.maxtemp_c) : '—';
    const low  = fc ? Math.round(state.unit === 'F' ? fc.day.mintemp_f : fc.day.mintemp_c) : '—';
    const icon = fc ? conditionEmoji(fc.day.condition.code, 1) : '';
    const rain = fc && fc.day.daily_chance_of_rain > 0 ? `💧${fc.day.daily_chance_of_rain}%` : '';

    cell.innerHTML = `
      <div class="mc-day">${day}</div>
      ${icon ? `<div class="mc-icon">${icon}</div>` : ''}
      <div class="mc-high">${high}°</div>
      <div class="mc-low">${low}°</div>
      ${rain ? `<div class="mc-precip">${rain}</div>` : ''}
    `;
    container.appendChild(cell);
  }
}

// ── SOLO RADAR ────────────────────────────────────────
async function initSoloRadar() {
  if (!checkLeaflet()) return;
  destroySoloRadar();

  const map = L.map('radarMapSolo', {
    center: [state.lat || 40.7, state.lon || -74.0],
    zoom: 8, zoomControl: true, attributionControl: false,
  });
  soloRadar.map = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.75,
  }).addTo(map);

  if (state.lat && state.lon) {
    L.circleMarker([state.lat, state.lon], {
      radius: 8, fillColor: '#2563EB', fillOpacity: 1, color: '#fff', weight: 2,
    }).addTo(map);
  }

  if (!TOMORROW_KEY || TOMORROW_KEY === 'YOUR_TOMORROW_IO_KEY') {
    showRadarKeyError(); return;
  }

  const frames = buildTomorrowFrames();
  soloRadar.frames    = frames;
  soloRadar.pastCount = frames.filter(f => f.isPast).length;

  soloRadar.layers = frames.map(frame => {
    const tileUrl = `https://api.tomorrow.io/v4/map/tile/{z}/{x}/{y}/precipitationIntensity/${frame.ts}.png?apikey=${TOMORROW_KEY}`;
    const layer = L.tileLayer(tileUrl, { opacity: 0, maxZoom: 12, tileSize: 256 });
    layer.addTo(map);
    return layer;
  });

  // Timeline
  const tl = document.getElementById('radarTimelineSolo');
  tl.innerHTML = '';
  frames.forEach((frame, i) => {
    if (i === soloRadar.pastCount) {
      const pin = document.createElement('div');
      pin.className = 'radar-now-pin'; tl.appendChild(pin);
    }
    const dot = document.createElement('div');
    dot.className = 'radar-frame-dot ' + (i < soloRadar.pastCount ? 'past' : 'future');
    dot.title = radarFrameLabel(frame);
    dot.addEventListener('click', () => { stopSoloRadar(); soloRadar.frameIndex = i; showSoloRadarFrame(i); });
    tl.appendChild(dot);
  });

  soloRadar.frameIndex = soloRadar.pastCount;
  showSoloRadarFrame(soloRadar.frameIndex);
  stopSoloRadar(); // start paused

  // Wire play/pause
  document.getElementById('radarPlaySolo').addEventListener('click', () => {
    soloRadar.playing ? stopSoloRadar() : startSoloRadar();
  });
  document.getElementById('radarPauseSolo').addEventListener('click', stopSoloRadar);
}

function showSoloRadarFrame(index) {
  if (!soloRadar.map || !soloRadar.layers.length) return;
  const isFuture = index > soloRadar.pastCount;
  const isNow    = index === soloRadar.pastCount;
  soloRadar.layers.forEach((l, i) => l.setOpacity(i === index ? 0.7 : 0));
  const label = radarFrameLabel(soloRadar.frames[index]);
  document.getElementById('radarTimeLabelSolo').textContent =
    isNow ? '📡 Now' : isFuture ? '🔮 Forecast ' + label : '📡 ' + label;
  document.querySelectorAll('#radarTimelineSolo .radar-frame-dot').forEach((d, i) => d.classList.toggle('active', i === index));
}

function startSoloRadar() {
  stopSoloRadar();
  soloRadar.playing = true;
  document.getElementById('radarPlaySolo').classList.add('active');
  document.getElementById('radarPauseSolo').classList.remove('active');
  const loopStart = soloRadar.pastCount, loopEnd = soloRadar.frames.length - 1;
  soloRadar.frameIndex = loopStart; showSoloRadarFrame(loopStart);
  function tick() {
    if (!soloRadar.playing) return;
    if (soloRadar.frameIndex >= loopEnd) {
      soloRadar.timer = setTimeout(() => { if (!soloRadar.playing) return; soloRadar.frameIndex = loopStart; showSoloRadarFrame(loopStart); soloRadar.timer = setTimeout(tick, 800); }, 2500);
    } else { soloRadar.frameIndex++; showSoloRadarFrame(soloRadar.frameIndex); soloRadar.timer = setTimeout(tick, 800); }
  }
  soloRadar.timer = setTimeout(tick, 800);
}

function stopSoloRadar() {
  soloRadar.playing = false;
  clearTimeout(soloRadar.timer); soloRadar.timer = null;
  const p = document.getElementById('radarPlaySolo');
  const u = document.getElementById('radarPauseSolo');
  if (p) p.classList.remove('active');
  if (u) u.classList.add('active');
}

function destroySoloRadar() {
  stopSoloRadar();
  if (soloRadar.map) { soloRadar.map.remove(); soloRadar.map = null; }
  soloRadar.layers = []; soloRadar.frames = [];
  const tl = document.getElementById('radarTimelineSolo');
  const md = document.getElementById('radarMapSolo');
  if (tl) tl.innerHTML = '';
  if (md) md.innerHTML = '';
}

// ═══════════════════════════════════════════════════════
// THEMES PAGE
// ═══════════════════════════════════════════════════════

const THEMES = [
  {
    id: 'dark',
    name: 'Midnight',
    desc: 'Deep navy · Electric cyan',
    accent: '#38bdf8',
    bg: 'linear-gradient(145deg, #04111f 0%, #071e3d 45%, #0c2d5c 100%)',
    heroBg: 'linear-gradient(135deg, #071e3d 0%, #0f3d7a 50%, #1a5fa8 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(56,189,248,0.9),transparent)',
    icon: '⛅', temp: '46°', cond: 'Partly Cloudy',
    stats: [['Feels','38°'],['Wind','12 mph'],['Humidity','62%'],['UV','Low']],
  },
  {
    id: 'light',
    name: 'Daylight',
    desc: 'Crisp white · Vivid blue',
    accent: '#2563EB',
    bg: 'linear-gradient(145deg, #dbeafe 0%, #eff6ff 50%, #bfdbfe 100%)',
    heroBg: 'linear-gradient(135deg, #1e3a8a 0%, #2563eb 55%, #3b82f6 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(147,197,253,1),transparent)',
    icon: '☀️', temp: '72°', cond: 'Sunny',
    stats: [['Feels','69°'],['Wind','8 mph'],['Humidity','42%'],['UV','High']],
  },
  {
    id: 'auto',
    name: 'Auto',
    desc: 'Follows system preference',
    accent: '#94a3b8',
    bg: 'linear-gradient(145deg, #0f172a 0%, #1e3a5f 45%, #c8d9f0 100%)',
    heroBg: 'linear-gradient(135deg, #0f172a 0%, #1e40af 55%, #93c5fd 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(148,163,184,0.9),transparent)',
    icon: '🌤️', temp: '58°', cond: 'Mostly Clear',
    stats: [['Feels','54°'],['Wind','6 mph'],['Humidity','52%'],['UV','Med']],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    desc: 'Molten orange · Deep crimson',
    accent: '#fb923c',
    bg: 'linear-gradient(145deg, #1a0205 0%, #5c1008 40%, #b83010 70%, #e05515 100%)',
    heroBg: 'linear-gradient(135deg, #5c0a05 0%, #b83010 50%, #f97316 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(253,186,116,1),rgba(244,63,94,0.7),transparent)',
    icon: '🌅', temp: '61°', cond: 'Clear Evening',
    stats: [['Feels','57°'],['Wind','5 mph'],['Humidity','38%'],['UV','None']],
  },
  {
    id: 'forest',
    name: 'Forest',
    desc: 'Vivid emerald · Ancient moss',
    accent: '#22c55e',
    bg: 'linear-gradient(145deg, #010d04 0%, #053a15 40%, #0d6124 70%, #15803d 100%)',
    heroBg: 'linear-gradient(135deg, #012008 0%, #0d6124 50%, #16a34a 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(134,239,172,1),rgba(163,230,53,0.7),transparent)',
    icon: '🌲', temp: '54°', cond: 'Misty',
    stats: [['Feels','50°'],['Wind','3 mph'],['Humidity','88%'],['UV','Low']],
  },
  {
    id: 'storm',
    name: 'Storm',
    desc: 'Crackling gold · Deep charcoal',
    accent: '#fde047',
    bg: 'linear-gradient(145deg, #050607 0%, #0f1117 40%, #1c2030 70%, #252a38 100%)',
    heroBg: 'linear-gradient(135deg, #0a0b10 0%, #1c2030 55%, #2d3340 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(253,224,71,1),rgba(250,204,21,0.7),transparent)',
    icon: '⛈️', temp: '39°', cond: 'Thunderstorm',
    stats: [['Feels','33°'],['Wind','28 mph'],['Humidity','95%'],['UV','None']],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    desc: 'Northern lights · Violet cosmos',
    accent: '#2dd4bf',
    bg: 'linear-gradient(145deg, #010509 0%, #082e2a 35%, #16104a 65%, #0d1f3c 100%)',
    heroBg: 'linear-gradient(135deg, #04101a 0%, #0f3333 40%, #2d1060 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(45,212,191,1),rgba(167,139,250,0.8),transparent)',
    icon: '🌌', temp: '28°', cond: 'Clear Night',
    stats: [['Feels','22°'],['Wind','7 mph'],['Humidity','45%'],['UV','None']],
  },
  {
    id: 'desert',
    name: 'Desert',
    desc: 'Scorched gold · Terracotta fire',
    accent: '#fbbf24',
    bg: 'linear-gradient(145deg, #0a0300 0%, #451a00 38%, #a04010 65%, #c47820 100%)',
    heroBg: 'linear-gradient(135deg, #3d1500 0%, #8c3a0e 50%, #d97706 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(253,224,71,1),rgba(239,68,68,0.6),transparent)',
    icon: '☀️', temp: '98°', cond: 'Blazing Sun',
    stats: [['Feels','105°'],['Wind','14 mph'],['Humidity','8%'],['UV','Extreme']],
  },
  {
    id: 'ocean',
    name: 'Ocean',
    desc: 'Abyssal navy · Bioluminescent cyan',
    accent: '#22d3ee',
    bg: 'linear-gradient(145deg, #00050e 0%, #001830 38%, #003d5c 65%, #005070 100%)',
    heroBg: 'linear-gradient(135deg, #000c1a 0%, #003352 50%, #006888 100%)',
    shimmer: 'linear-gradient(90deg,transparent,rgba(34,211,238,1),rgba(165,243,252,0.7),transparent)',
    icon: '🌊', temp: '67°', cond: 'Coastal Breeze',
    stats: [['Feels','63°'],['Wind','18 mph'],['Humidity','76%'],['UV','Med']],
  },
];

function renderThemesPage() {
  const grid = document.getElementById('themesGrid');
  if (!grid) return;
  const currentTheme = localStorage.getItem('jwt_theme') || 'dark';
  grid.innerHTML = '';

  THEMES.forEach(t => {
    const card = document.createElement('div');
    card.className = 'theme-card' + (t.id === currentTheme ? ' active' : '');
    card.style.setProperty('--tc-accent', t.accent);

    const statHtml = t.stats.map(([label, val]) => `
      <div class="tc-stat">
        <span class="tc-stat-label">${label}</span>
        <span class="tc-stat-val">${val}</span>
      </div>`).join('');

    card.innerHTML = `
      <!-- Checkmark badge -->
      <div class="tc-check">✓</div>

      <!-- Background -->
      <div class="tc-bg" style="background:${t.bg}"></div>

      <!-- Top shimmer line -->
      <div class="tc-shimmer" style="background:${t.shimmer}"></div>

      <!-- Hero zone -->
      <div class="tc-hero" style="background:${t.heroBg}">
        <div class="tc-hero-left">
          <div class="tc-city">Birdsboro</div>
          <div class="tc-date">Pennsylvania, US</div>
        </div>
        <div class="tc-hero-right">
          <div class="tc-icon">${t.icon}</div>
          <div class="tc-temp">${t.temp}</div>
          <div class="tc-cond">${t.cond}</div>
        </div>
      </div>

      <!-- Stat chips -->
      <div class="tc-stats">${statHtml}</div>

      <!-- Name footer -->
      <div class="tc-footer">
        <div>
          <div class="tc-name">${t.name}</div>
          <div class="tc-desc">${t.desc}</div>
        </div>
        <div class="tc-dot" style="background:${t.accent};box-shadow:0 0 10px ${t.accent}"></div>
      </div>
    `;

    card.addEventListener('click', () => {
      localStorage.setItem('jwt_theme', t.id);
      applyTheme(t.id);
      grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });

    grid.appendChild(card);
  });
}


