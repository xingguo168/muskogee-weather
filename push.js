#!/usr/bin/env node
// ==========================================================================
// Muskogee 天气 Slack 推送 - GitHub Actions 版本
//
// 跑在 GitHub Actions 服务器上(Node 20+),通过环境变量获取配置:
//   SLACK_WEBHOOK_URL  必填,Slack Incoming Webhook
//
// 用法:
//   SLACK_WEBHOOK_URL=https://hooks.slack.com/... node push.js
// ==========================================================================

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const MUSKOGEE_LAT = 35.7479;
const MUSKOGEE_LON = -95.3697;
const TIMEZONE = "America/Chicago";

// 简单的"带超时和重试"的 fetch 包装
async function fetchWithRetry(url, options = {}, { retries = 3, retryDelayMs = 5000, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[retry ${attempt}/${retries}] 等待 ${retryDelayMs}ms 后重试 ${url}`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      // 5xx / 429 视为可重试错误
      if (resp.status >= 500 || resp.status === 429) {
        const body = await resp.text().catch(() => "");
        lastErr = new Error(`HTTP ${resp.status} ${url} ${body.slice(0, 200)}`);
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error(`fetch failed: ${url}`);
}

// ----- WMO 代码翻译 -----
function weatherCodeToText(code) {
  const map = {
    0: "晴朗", 1: "大部晴朗", 2: "局部多云", 3: "阴天",
    45: "有雾", 48: "雾凇",
    51: "小毛毛雨", 53: "中等毛毛雨", 55: "大毛毛雨",
    56: "冻毛毛雨(轻)", 57: "冻毛毛雨(强)",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨(轻)", 67: "冻雨(强)",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨(小)", 81: "阵雨(中)", 82: "阵雨(大)",
    85: "阵雪(小)", 86: "阵雪(大)",
    95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"
  };
  return map[code] || `天气代码 ${code}`;
}

function weatherCodeToEmoji(code) {
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

function cToF(c) {
  return Math.round((c * 9) / 5 + 32);
}

// ----- WMO 派生的恶劣天气 -----
function detectSevereWeather(day) {
  const alerts = [];
  const code = day.code;
  if (code === 99) alerts.push("⛈️ 强雷暴 + 大冰雹");
  else if (code === 96) alerts.push("⛈️ 雷暴 + 小冰雹");
  else if (code === 95) alerts.push("⚡ 雷暴(可能有闪电)");
  if (code === 56 || code === 57) alerts.push("🧊 冻毛毛雨(路面易结冰)");
  if (code === 66 || code === 67) alerts.push("🧊 冻雨(路面易结冰)");
  if (code === 75 || code === 86) alerts.push("❄️ 大雪");
  else if (code === 73) alerts.push("❄️ 中雪");
  else if (code === 71 || code === 85) alerts.push("🌨️ 有降雪");
  else if (code === 77) alerts.push("🌨️ 雪粒");
  if (day.windMax >= 80) alerts.push(`💨 危险大风(最大 ${Math.round(day.windMax)} km/h)`);
  else if (day.windMax >= 60) alerts.push(`💨 大风(最大 ${Math.round(day.windMax)} km/h)`);
  if (day.tMax !== undefined && day.tMax >= 38) alerts.push(`🥵 酷热(最高 ${Math.round(day.tMax)}°C / ${cToF(day.tMax)}°F)`);
  if (day.tMin !== undefined && day.tMin <= -10) alerts.push(`🥶 严寒(最低 ${Math.round(day.tMin)}°C / ${cToF(day.tMin)}°F)`);
  return alerts;
}

// ----- NWS 预警 -----
const NWS_EVENT_ZH = {
  "Tornado Warning": "🌪️ 龙卷风警报(Warning)",
  "Tornado Watch": "🌪️ 龙卷风注意(Watch)",
  "Severe Thunderstorm Warning": "⛈️ 强雷暴警报",
  "Severe Thunderstorm Watch": "⛈️ 强雷暴注意",
  "Flash Flood Warning": "🌊 山洪警报",
  "Flash Flood Watch": "🌊 山洪注意",
  "Flood Warning": "🌊 洪水警报",
  "Flood Watch": "🌊 洪水注意",
  "Winter Storm Warning": "❄️ 冬季风暴警报",
  "Winter Storm Watch": "❄️ 冬季风暴注意",
  "Winter Weather Advisory": "❄️ 冬季天气提示",
  "Blizzard Warning": "❄️ 暴风雪警报",
  "Ice Storm Warning": "🧊 冰暴警报",
  "Freezing Rain Advisory": "🧊 冻雨提示",
  "High Wind Warning": "💨 大风警报",
  "High Wind Watch": "💨 大风注意",
  "Wind Advisory": "💨 大风提示",
  "Excessive Heat Warning": "🥵 极端高温警报",
  "Excessive Heat Watch": "🥵 极端高温注意",
  "Heat Advisory": "🥵 高温提示",
  "Wind Chill Warning": "🥶 风寒警报",
  "Wind Chill Advisory": "🥶 风寒提示",
  "Hard Freeze Warning": "🥶 严寒警报",
  "Freeze Warning": "🥶 霜冻警报",
  "Red Flag Warning": "🔥 火险警报",
  "Fire Weather Watch": "🔥 火险注意",
  "Dust Storm Warning": "🌪️ 沙尘暴警报",
  "Hurricane Warning": "🌀 飓风警报",
  "Tropical Storm Warning": "🌀 热带风暴警报",
  "Special Weather Statement": "📢 特别天气声明"
};

function translateNwsEvent(event) {
  if (!event) return "";
  return NWS_EVENT_ZH[event] || `⚠️ ${event}`;
}

async function fetchNwsAlerts() {
  const url = `https://api.weather.gov/alerts/active?point=${MUSKOGEE_LAT},${MUSKOGEE_LON}`;
  try {
    const resp = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "muskogee-weather-slack-actions/1.0 (github actions)",
        Accept: "application/geo+json"
      }
    });
    if (!resp.ok) {
      console.warn(`[nws] HTTP ${resp.status},放弃预警获取`);
      return [];
    }
    const data = await resp.json();
    const features = Array.isArray(data.features) ? data.features : [];
    const sevRank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
    features.sort(
      (a, b) =>
        (sevRank[a.properties?.severity] ?? 99) -
        (sevRank[b.properties?.severity] ?? 99)
    );
    return features.map((f) => ({
      event: f.properties?.event || "",
      severity: f.properties?.severity || "Unknown",
      headline: f.properties?.headline || "",
      expires: f.properties?.expires || "",
      areaDesc: f.properties?.areaDesc || ""
    }));
  } catch (err) {
    console.warn("[nws] fetch error:", err.message);
    return [];
  }
}

// ----- Open-Meteo -----
async function fetchWeather() {
  const params = new URLSearchParams({
    latitude: MUSKOGEE_LAT,
    longitude: MUSKOGEE_LON,
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
      "precipitation_sum",
      "wind_speed_10m_max",
      "sunrise",
      "sunset"
    ].join(","),
    current: "temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timezone: TIMEZONE,
    forecast_days: 2
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const resp = await fetchWithRetry(url);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  return await resp.json();
}

// ----- 消息格式化 -----
function formatMessage(data, nwsAlerts = []) {
  const daily = data.daily;
  const current = data.current;

  const today = {
    date: daily.time[0],
    code: daily.weather_code[0],
    tMax: daily.temperature_2m_max[0],
    tMin: daily.temperature_2m_min[0],
    rainProb: daily.precipitation_probability_max[0],
    rainSum: daily.precipitation_sum[0],
    windMax: daily.wind_speed_10m_max[0],
    sunrise: daily.sunrise[0],
    sunset: daily.sunset[0]
  };
  const tomorrow = {
    date: daily.time[1],
    code: daily.weather_code[1],
    tMax: daily.temperature_2m_max[1],
    tMin: daily.temperature_2m_min[1],
    rainProb: daily.precipitation_probability_max[1],
    rainSum: daily.precipitation_sum[1],
    windMax: daily.wind_speed_10m_max[1]
  };

  const sunriseTime = today.sunrise.split("T")[1] || "";
  const sunsetTime = today.sunset.split("T")[1] || "";
  const todayAlerts = detectSevereWeather(today);
  const tomorrowAlerts = detectSevereWeather(tomorrow);

  const lines = [];
  lines.push(`*🌎 Muskogee 天气预报* (${today.date})`);

  if (nwsAlerts && nwsAlerts.length > 0) {
    lines.push("");
    lines.push("🚨 *NWS 官方预警(当前生效)*");
    for (const a of nwsAlerts) {
      const label = translateNwsEvent(a.event);
      const sevTag =
        a.severity === "Extreme" ? " [极端]" :
        a.severity === "Severe"  ? " [严重]" : "";
      lines.push(`• ${label}${sevTag}`);
      if (a.headline) {
        const h = a.headline.length > 140 ? a.headline.slice(0, 140) + "…" : a.headline;
        lines.push(`  _${h}_`);
      }
    }
  }

  if (todayAlerts.length > 0 || tomorrowAlerts.length > 0) {
    lines.push("");
    lines.push("⚠️ *天气警告*");
    if (todayAlerts.length > 0) lines.push(`• 今天: ${todayAlerts.join(" / ")}`);
    if (tomorrowAlerts.length > 0) lines.push(`• 明天: ${tomorrowAlerts.join(" / ")}`);
  }

  lines.push("");
  lines.push(`*今天* ${weatherCodeToEmoji(today.code)} ${weatherCodeToText(today.code)}`);
  lines.push(`• 气温: ${Math.round(today.tMin)}°C ~ ${Math.round(today.tMax)}°C (${cToF(today.tMin)}°F ~ ${cToF(today.tMax)}°F)`);
  if ((today.rainProb ?? 0) > 20) {
    lines.push(`• 降水概率: ${today.rainProb}%, 累计降水: ${today.rainSum ?? 0} mm`);
  }
  lines.push(`• 最大风速: ${Math.round(today.windMax)} km/h`);
  lines.push(`• 日出 ${sunriseTime} / 日落 ${sunsetTime}`);
  if (current) {
    lines.push(
      `• 当前: ${Math.round(current.temperature_2m)}°C, ` +
        `湿度 ${current.relative_humidity_2m}%, ` +
        `风速 ${Math.round(current.wind_speed_10m)} km/h`
    );
  }
  lines.push("");
  lines.push(`*明天* ${weatherCodeToEmoji(tomorrow.code)} ${weatherCodeToText(tomorrow.code)} (${tomorrow.date})`);
  lines.push(`• 气温: ${Math.round(tomorrow.tMin)}°C ~ ${Math.round(tomorrow.tMax)}°C (${cToF(tomorrow.tMin)}°F ~ ${cToF(tomorrow.tMax)}°F)`);
  if ((tomorrow.rainProb ?? 0) > 20) {
    lines.push(`• 降水概率: ${tomorrow.rainProb}%, 累计降水: ${tomorrow.rainSum ?? 0} mm`);
  }
  lines.push(`• 最大风速: ${Math.round(tomorrow.windMax)} km/h`);

  return lines.join("\n");
}

// ----- Slack 推送 -----
async function postToSlack(webhookUrl, text) {
  const resp = await fetchWithRetry(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Slack 推送失败: HTTP ${resp.status} ${errBody}`);
  }
}

// 获取当前在 Muskogee(America/Chicago) 时区下的小时数
// 用 Intl.DateTimeFormat 自动处理夏令时切换,无需写死偏移量
function getMuskogeeHour() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    hour12: false
  });
  // formatToParts 返回 [{type:'hour', value:'7'}, ...]
  const parts = fmt.formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour");
  // 注意: en-US 在午夜可能返回 "24" 而不是 "0",需要 mod 24
  return parseInt(hourPart.value, 10) % 24;
}

// 主入口
async function main() {
  if (!SLACK_WEBHOOK_URL) {
    console.error("缺少环境变量 SLACK_WEBHOOK_URL");
    process.exit(1);
  }

  // 时区检查: 只在 Muskogee 当地 7 点(允许 ±0 小时容差)才真正推送
  // GitHub Actions 设了两条 cron(UTC 12 / UTC 13),分别覆盖夏令时和冬令时
  // 不匹配的那条会在这里被拦下来
  // 手动触发时(workflow_dispatch),FORCE_RUN=1 跳过此检查方便测试
  if (!process.env.FORCE_RUN) {
    const localHour = getMuskogeeHour();
    if (localHour !== 7) {
      console.log(
        `当前 Muskogee 时区是 ${localHour} 点,不是 7 点,跳过本次执行(这是 cron 双触发的预期行为)`
      );
      return;
    }
    console.log(`Muskogee 当地时间 7 点,开始推送`);
  } else {
    console.log("FORCE_RUN=1,跳过时区检查");
  }

  console.log("[1/3] 获取 Open-Meteo 天气数据...");
  const [data, nwsAlerts] = await Promise.all([fetchWeather(), fetchNwsAlerts()]);
  console.log(`        NWS 当前生效预警: ${nwsAlerts.length} 条`);

  console.log("[2/3] 格式化消息...");
  const message = formatMessage(data, nwsAlerts);
  console.log("---- message preview ----");
  console.log(message);
  console.log("-------------------------");

  console.log("[3/3] 推送到 Slack...");
  await postToSlack(SLACK_WEBHOOK_URL, message);
  console.log("✅ 推送成功");
}

main().catch((err) => {
  console.error("❌ 推送失败:", err);
  process.exit(1);
});
