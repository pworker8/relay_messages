import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { REST, Routes, WebhookClient } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { DISCORD_TOKEN, RELAY_ROUTS } = process.env;

if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
const STATE_FILE = path.join(__dirname, "lastMessageIds.json");

// --- utils ---
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {}
  return fallback;
}
function saveJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- load config/state ---
let routes;
try {
  // [{ source: "123", target: "456" | "https://discord.com/api/webhooks/..." }]
  routes = JSON.parse(RELAY_ROUTS || "[]");
} catch (err) {
  console.error("❌ Failed to parse RELAY_ROUTS JSON:", err.message);
  process.exit(1);
}

if (!Array.isArray(routes) || routes.length === 0) {
  console.error("❌ No valid routes in RELAY_ROUTS variable");
  process.exit(1);
}

const lastMap = loadJson(STATE_FILE, {}); // { [sourceId]: lastId }

(async () => {
  try {
    for (const { source, target } of routes) {
      if (!source || !target) continue;

      const lastId = lastMap[source] || null;
      const options = lastId ? { after: lastId, limit: 100 } : { limit: 100 };

      console.log(`\n=== Route: ${source} -> ${target} ===`);
      console.log(`Fetching messages with options:`, options);

      // GET messages via REST (no Gateway)
      const fetched = await rest.get(Routes.channelMessages(source), { query: options });

  	  // Sort ASC by snowflake so we send oldest→newest and can save the max id
	  const sorted = [...fetched].sort((a, b) => {
	    const A = BigInt(a.id);
	    const B = BigInt(b.id);
	    return A < B ? -1 : A > B ? 1 : 0;
	  });
	  
      console.log(`Fetched ${sorted.length} new messages`);

      // Helper to send to target (webhook or channel ID)
      async function sendToTarget(payload) {
        if (typeof target === "string" && target.startsWith("https://discord.com/api/webhooks/")) {
          const webhook = new WebhookClient({ url: target });
          await webhook.send({ ...payload, allowed_mentions: { parse: [] } });
          await webhook.destroy?.();
        } else {
          await rest.post(Routes.channelMessages(String(target)), {
            body: { ...payload, allowed_mentions: { parse: [] } },
          });
        }
      }

      let maxId = lastId ? BigInt(lastId) : 0n;

      for (const msg of sorted) {
        const id = msg.id;
        if (!id) continue;

        const idBig = BigInt(id);
        // Guard: even if API ever includes the boundary item, don't resend
        if (lastId && idBig <= BigInt(lastId)) continue;

        const content = (msg.content || "").trim();
        const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

        if (!content && embeds.length === 0 && attachments.length === 0) {
          if (idBig > maxId) maxId = idBig;
          continue;
        }

        // Build payload
        let finalContent = content;
        if (attachments.length) {
          const urls = attachments.map((a) => a?.url).filter(Boolean);
          if (urls.length) finalContent = [finalContent, ...urls].filter(Boolean).join("\n");
        }

        const payload = {
          ...(finalContent && { content: finalContent }),
          ...(embeds.length && { embeds: embeds.slice(0, 10) }),
        };

        console.log(`Relaying message ${id} -> ${target}`);
        await sendToTarget(payload);

        if (idBig > maxId) maxId = idBig;
        await sleep(200);
      }

      if (maxId > (lastId ? BigInt(lastId) : 0n)) {
        lastMap[source] = String(maxId);
        console.log(`Updated lastId for ${source}: ${lastId} -> ${lastMap[source]}`);
      } else {
        console.log(`No advance for ${source} (lastId stays ${lastId ?? "null"})`);
      }
    }

    console.log("\nSaving state...");
    saveJsonAtomic(STATE_FILE, lastMap);
  } catch (err) {
    console.error("Relay error:", err);
  } finally {
    console.log("Done (no Gateway connection used).");
  }
})();
