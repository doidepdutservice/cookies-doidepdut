import fs from "fs";
import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import PQueue from "p-queue";
import HttpsProxyAgent from "https-proxy-agent";

const COOKIES_FILE = "./cookies.json";
const MAX_CONCURRENCY = 20;
const DELAY_MS = 100;

let cookies = fs.existsSync(COOKIES_FILE)
  ? JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"))
  : {};

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64").toString());
  } catch {
    return null;
  }
}

function extractPrivyToken(raw) {
  const parts = raw.split(";").map(x => x.trim());
  for (let p of parts) {
    const [k, v] = p.split("=");
    if (k === "privy-token") return v;
  }
  return null;
}

function isTokenAlmostExpired(token, thresholdSeconds = 600) {
  const data = decodeJwt(token);
  if (!data || !data.exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return data.exp - now <= thresholdSeconds;
}

async function refreshSingle(key, item) {
  const privyToken = extractPrivyToken(item.cookieRaw);
  if (!privyToken) return { key, ok: false, error: "No privy-token" };
  if (!isTokenAlmostExpired(privyToken)) return { key, ok: true, cookie: item.cookieRaw };

  try {
    const jar = new CookieJar();
    const axiosConfig = {
      jar,
      withCredentials: true,
      timeout: 15000,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": "Bearer " + privyToken,
        "privy-app-id": "cm6jesuxd00a9ojo0i9rlxudk",
        "origin": "https://quests.agnthub.ai",
        "referer": "https://quests.agnthub.ai/",
        "user-agent": item.userAgent || "Mozilla/5.0",
        "cookie": item.cookieRaw
      }
    };

    if (item.proxy) {
      axiosConfig.httpsAgent = new HttpsProxyAgent(item.proxy);
    }

    const client = wrapper(axios.create(axiosConfig));

    item.cookieRaw.split(";").forEach(c => {
      try { jar.setCookieSync(c.trim(), "https://privy.agnthub.ai"); } catch {}
    });

    await client.post(
      "https://privy.agnthub.ai/api/v1/sessions",
      { refresh_token: "deprecated" }
    );

    const newCookies = await jar.getCookies("https://privy.agnthub.ai");
    const newCookieRaw = newCookies.map(c => `${c.key}=${c.value}`).join("; ");

    return { key, ok: true, cookie: newCookieRaw };
  } catch (err) {
    return { key, ok: false, error: err.message || err };
  }
}

async function run() {
  const queue = new PQueue({ concurrency: MAX_CONCURRENCY });
  const keys = Object.keys(cookies);
  const results = [];

  console.log(`🔄 Refreshing ${keys.length} cookies with concurrency=${MAX_CONCURRENCY}`);

  for (const key of keys) {
    const item = cookies[key];
    queue.add(async () => {
      const result = await refreshSingle(key, item);
      results.push(result);
      console.log(`${result.ok ? "✔️" : "❌"} ${key} ${result.ok ? "refreshed" : result.error}`);
      await new Promise(r => setTimeout(r, DELAY_MS));
    });
  }

  await queue.onIdle();

  for (const r of results) {
    if (r.ok) cookies[r.key].cookieRaw = r.cookie;
  }

  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log("💾 Cookies updated and saved!");
}

run();