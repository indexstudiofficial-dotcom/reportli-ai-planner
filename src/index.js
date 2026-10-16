/**
 * ============================================================
 * LEAD RESEARCH PLANNER — NICHE FINDER WORKER
 * Version: 6.1.0
 * ============================================================
 * Flow:
 * 1. Receive application from Supabase webhook (INSERT only).
 * 2. Create initial planner_runs task (no AI) -> Completed.
 * 3. Ask Sarvam AI for 10 customer niches (retry, think-tag safe).
 * 4. Normalize buying_intention to total exactly 100.
 * 5. Save into customer_niches (with fallback insert).
 * 6. Update applications.planner_status.
 *
 * REQUIRED SECRETS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SARVAM_API_KEY
 * OPTIONAL: SARVAM_MODEL (default sarvam-105b)
 * ============================================================
 */

const VERSION = "6.1.0";
const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const DEFAULT_MODEL = "sarvam-105b";
const INITIAL_TASK = "Analyze the company and find 10 customer niches";
const NICHE_WORKER_TYPE = "niche_finder";
const NICHE_SOURCE = "niche_finder";

const SUPABASE_TIMEOUT_MS = 25000;
const SARVAM_TIMEOUT_MS = 28000;
const SARVAM_MAX_ATTEMPTS = 2;

// ============================================================
// ROUTER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, apikey, x-webhook-secret",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      validateEnvironment(env);

      if (request.method === "GET" && path === "/health") {
        return jsonResponse(
          {
            success: true,
            worker: "lead-research-planner",
            version: VERSION,
            model: env.SARVAM_MODEL || DEFAULT_MODEL,
            timestamp: new Date().toISOString(),
          },
          200,
          cors
        );
      }

      if (request.method === "POST" && path === "/webhook") {
        const body = await request.json();

        // Ignore UPDATE/DELETE events. Our own planner_status updates
        // would otherwise re-trigger this worker in a loop.
        if (body.type && String(body.type).toUpperCase() !== "INSERT") {
          return jsonResponse(
            { success: true, skipped: true, reason: `Ignored ${body.type}` },
            200,
            cors
          );
        }

        const applicationId =
          body.application_id || body.record?.id || body.id;

        if (!applicationId) {
          return jsonResponse(
            { success: false, error: "Missing application_id" },
            400,
            cors
          );
        }

        // Respond immediately (Supabase webhooks time out quickly),
        // and keep working in the background.
        ctx.waitUntil(
          processApplication(String(applicationId), env).catch((e) =>
            console.error("Background processing failed:", e.message)
          )
        );

        return jsonResponse(
          {
            success: true,
            accepted: true,
            application_id: String(applicationId),
            message: "Processing started",
          },
          202,
          cors
        );
      }

      // Synchronous route: returns the real error. Use this to debug.
      if (request.method === "POST" && path === "/test") {
        const body = await request.json();

        if (!body.application_id) {
          return jsonResponse(
            { success: false, error: "Provide application_id" },
            400,
            cors
          );
        }

        const result = await processApplication(
          String(body.application_id),
          env,
          { force: body.force === true }
        );

        return jsonResponse(result, 200, cors);
      }

      return jsonResponse(
        {
          success: false,
          error: "Route not found",
          available_routes: ["GET /health", "POST /webhook", "POST /test"],
        },
        404,
        cors
      );
    } catch (error) {
      console.error("Worker request failed:", error.message);

      return jsonResponse(
        {
          success: false,
          error: error.message || "Internal server error",
          version: VERSION,
        },
        500,
        cors
      );
    }
  },
};

// ============================================================
// HELPERS
// ============================================================

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ];

  const missing = required.filter(
    (key) => !env[key] || !String(env[key]).trim()
  );

  if (missing.length > 0) {
    throw new Error(`Missing Cloudflare secrets: ${missing.join(", ")}`);
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

async function supabaseRequest(env, table, options = {}) {
  const { method = "GET", query = "", body, prefer } = options;

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const url = `${baseUrl}/rest/v1/${table}` + (query ? `?${query}` : "");

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  };

  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw_response: text };
      }
    }

    if (!response.ok) {
      throw new Error(
        `Supabase ${method} ${table} failed (${response.status}): ${JSON.stringify(data)}`
      );
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Supabase request timed out: ${table}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// APPLICATIONS
// ============================================================

async function getApplication(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,name,api_key,user_id,domain,company,planner_status",
    id: `eq.${applicationId}`,
    limit: "1",
  }).toString();

  const rows = await supabaseRequest(env, "applications", { query });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Application not found: ${applicationId}`);
  }

  return rows[0];
}

async function updateApplicationStatus(applicationId, status, env) {
  const query = new URLSearchParams({ id: `eq.${applicationId}` }).toString();

  return supabaseRequest(env, "applications", {
    method: "PATCH",
    query,
    body: { planner_status: status },
    prefer: "return=minimal",
  });
}

// ============================================================
// PLANNER RUNS (initial task, no AI)
// ============================================================

async function createInitialPlannerTask(application, env) {
  const query = new URLSearchParams({
    select: "id,status,task,created_at",
    application_id: `eq.${application.id}`,
    worker_type: `eq.${NICHE_WORKER_TYPE}`,
    source: `eq.${NICHE_SOURCE}`,
    task: `eq.${INITIAL_TASK}`,
    order: "created_at.desc",
    limit: "1",
  }).toString();

  const existing = await supabaseRequest(env, "planner_runs", { query });

  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }

  const now = new Date().toISOString();

  // application_id and user_id are TEXT in planner_runs, so cast to string.
  const payload = {
    application_id: String(application.id),
    user_id: application.user_id != null ? String(application.user_id) : null,
    worker_type: NICHE_WORKER_TYPE,
    source: NICHE_SOURCE,
    task: INITIAL_TASK,
    pending_count: 0,
    error: null,
    niche: null,
    status: "Completed",
    created_at: now,
    started_at: now,
  };

  const rows = await supabaseRequest(env, "planner_runs", {
    method: "POST",
    body: payload,
    prefer: "return=representation",
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Initial planner task was not returned by Supabase");
  }

  return rows[0];
}

async function recordPlannerError(taskId, message, env) {
  if (!taskId) return;

  try {
    const query = new URLSearchParams({ id: `eq.${taskId}` }).toString();

    await supabaseRequest(env, "planner_runs", {
      method: "PATCH",
      query,
      body: { error: String(message).slice(0, 2000) },
      prefer: "return=minimal",
    });
  } catch (e) {
    console.warn("Could not record planner error:", e.message);
  }
}

// ============================================================
// COMPANY CONTEXT
// ============================================================

async function getBusinessData(applicationId, env) {
  try {
    const query = new URLSearchParams({
      select: "field,data,source_url",
      application_id: `eq.${applicationId}`,
      limit: "30",
    }).toString();

    const rows = await supabaseRequest(env, "business_data", { query });
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn("Optional business_data unavailable:", error.message);
    return [];
  }
}

function buildCompanySummary(application, businessData) {
  const parts = [];

  if (application.name) parts.push(`Application name: ${application.name}`);
  if (application.company)
    parts.push(`Company information: ${application.company}`);
  if (application.domain) parts.push(`Website/domain: ${application.domain}`);

  if (Array.isArray(businessData) && businessData.length > 0) {
    const context = businessData
      .map((row) => {
        let value = row.data;
        if (typeof value !== "string") value = JSON.stringify(value);

        return (
          `Field: ${row.field}\n` +
          `Source: ${row.source_url || "Not provided"}\n` +
          `Data: ${(value || "").slice(0, 4000)}`
        );
      })
      .join("\n\n");

    parts.push(`Additional company information:\n${context.slice(0, 18000)}`);
  }

  const summary = parts.join("\n\n").trim();

  if (!summary) {
    throw new Error(
      "The application has no usable company information. Provide company, name, or domain."
    );
  }

  return summary;
}

// ============================================================
// SARVAM AI
// ============================================================

const SYSTEM_PROMPT = `You are a B2B market research strategist.

Identify the 10 most promising BROAD CUSTOMER SEGMENTS for the company.

RULES:
- Return exactly 10 distinct customer segments.
- Prefer broad audience types, industries, business models or professional groups
  (e.g. SaaS founders, freelancers, agencies, Shopify store owners, consultants,
  small businesses, app developers). Examples only; use what fits the company.
- Each niche must be a meaningfully different audience.
- Do not invent company features, products or services.
- Do not include audiences with no plausible need for the company's offering.
- Rank from highest to lowest purchase intent.
- buying_intention must be a positive integer. Scores need not total 100.
- Keep thinking short. Output ONLY the JSON object, no explanation.

Required JSON structure:
{"niches":[{"niche_name":"SaaS founders","buying_intention":20}]}

The niches array must contain exactly 10 objects.`;

async function callSarvamOnce(companySummary, env, attempt) {
  const userPrompt =
    `Analyze this company and find 10 customer niches.\n\n` +
    `COMPANY INFORMATION:\n${companySummary}\n\n` +
    `Choose the segments most likely to need and pay for this company's ` +
    `actual product or service. Return JSON only.` +
    (attempt > 1
      ? `\n\nIMPORTANT: Your previous answer was unusable. Return exactly 10 unique niches as valid JSON only.`
      : "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SARVAM_TIMEOUT_MS);

  try {
    const response = await fetch(SARVAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": env.SARVAM_API_KEY,
        Authorization: `Bearer ${env.SARVAM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.SARVAM_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        // Reasoning models spend tokens on <think> first. 4096 could be
        // used up before any JSON was written, so allow much more.
        max_tokens: 8192,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Sarvam returned non-JSON response (${response.status}): ${responseText.slice(0, 800)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Sarvam API error (${response.status}): ${JSON.stringify(responseData).slice(0, 1200)}`
      );
    }

    const message = responseData?.choices?.[0]?.message;
    const content = message?.content || message?.reasoning_content || "";

    if (!content) {
      throw new Error(
        `Sarvam returned no content (finish_reason: ${
          responseData?.choices?.[0]?.finish_reason
        }): ${JSON.stringify(responseData).slice(0, 800)}`
      );
    }

    return parseModelJson(content);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Sarvam AI request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Calls Sarvam and validates the niches. Retries once if unusable.
async function getNichesFromSarvam(companySummary, env) {
  let lastError;

  for (let attempt = 1; attempt <= SARVAM_MAX_ATTEMPTS; attempt++) {
    try {
      const output = await callSarvamOnce(companySummary, env, attempt);
      return normalizeNiches(output);
    } catch (error) {
      lastError = error;
      console.warn(`Sarvam attempt ${attempt} failed:`, error.message);
    }
  }

  throw lastError;
}

// ============================================================
// PARSE MODEL OUTPUT
// Handles <think> blocks, code fences, surrounding text and
// truncated JSON (recovers completed niche objects).
// ============================================================

function parseModelJson(content) {
  if (typeof content !== "string") {
    if (content && typeof content === "object") return content;
    throw new Error("Sarvam returned an unsupported content format");
  }

  let cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // closed think blocks
    .replace(/<think>[\s\S]*$/i, "") // unclosed think block
    .replace(/^[\s\S]*?<\/think>/i, "") // stray closing tag
    .trim();

  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  // Last resort: pull out individual niche objects (handles truncation).
  const recovered = [];
  const regex =
    /"niche_name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"buying_intention"\s*:\s*"?(\d+(?:\.\d+)?)"?/g;

  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    recovered.push({
      niche_name: match[1].replace(/\\"/g, '"'),
      buying_intention: Number(match[2]),
    });
  }

  if (recovered.length > 0) return { niches: recovered };

  throw new Error(
    "Sarvam's niche output was not valid JSON: " + cleaned.slice(0, 800)
  );
}

// ============================================================
// VALIDATE + NORMALIZE (exactly 10 niches, total exactly 100)
// ============================================================

function normalizeNiches(modelOutput) {
  const rawNiches = Array.isArray(modelOutput)
    ? modelOutput
    : modelOutput?.niches;

  if (!Array.isArray(rawNiches)) {
    throw new Error("Sarvam output must contain a niches array");
  }

  const unique = [];
  const seen = new Set();

  for (const item of rawNiches) {
    if (!item) continue;

    const name =
      typeof item === "string"
        ? item
        : String(item.niche_name || item.niche || item.name || "");

    const cleanName = name.trim().replace(/\s+/g, " ").slice(0, 200);
    if (!cleanName) continue;

    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let score = Number(
      typeof item === "object" ? item.buying_intention : 1
    );
    if (!Number.isFinite(score) || score <= 0) score = 1;
    score = Math.min(score, 10000);

    unique.push({ niche_name: cleanName, original_score: score });

    if (unique.length === 10) break;
  }

  if (unique.length !== 10) {
    throw new Error(
      `Sarvam returned only ${unique.length} unique niches; exactly 10 required`
    );
  }

  unique.sort((a, b) => b.original_score - a.original_score);

  // Every niche gets 1 point; the other 90 are shared proportionally.
  const totalWeight = unique.reduce((s, i) => s + i.original_score, 0);

  const allocations = unique.map((item, index) => {
    const exact = (item.original_score / totalWeight) * 90;
    const floor = Math.floor(exact);
    return { index, score: floor + 1, remainder: exact - floor };
  });

  let remaining = 100 - allocations.reduce((s, a) => s + a.score, 0);

  const order = [...allocations].sort((a, b) => b.remainder - a.remainder);

  let pointer = 0;
  while (remaining > 0) {
    allocations[order[pointer % order.length].index].score += 1;
    remaining -= 1;
    pointer += 1;
  }

  const result = unique.map((item, index) => ({
    niche_name: item.niche_name,
    buying_intention: allocations[index].score,
  }));

  const total = result.reduce((s, i) => s + i.buying_intention, 0);

  if (result.length !== 10 || total !== 100) {
    throw new Error(
      `Niche score validation failed. Count: ${result.length}; total: ${total}`
    );
  }

  return result;
}

// ============================================================
// CUSTOMER NICHES
// ============================================================

async function getExistingNiches(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,niche_name,buying_intention",
    application_id: `eq.${applicationId}`,
    order: "buying_intention.desc",
  }).toString();

  const rows = await supabaseRequest(env, "customer_niches", { query });
  return Array.isArray(rows) ? rows : [];
}

async function saveNiches(application, niches, env) {
  const full = niches.map((niche) => ({
    application_id: application.id,
    user_id: application.user_id ?? null,
    niche_name: niche.niche_name,
    buying_intention: niche.buying_intention,
    reddit_status: "pending",
    apollo_status: "pending",
  }));

  let rows;

  try {
    rows = await supabaseRequest(env, "customer_niches", {
      method: "POST",
      body: full,
      prefer: "return=representation",
    });
  } catch (firstError) {
    console.warn(
      "Full customer_niches insert failed, retrying minimal columns:",
      firstError.message
    );

    // Fallback: if a status column or constraint is the problem,
    // save only the core columns so the niches are never lost.
    const minimal = niches.map((niche) => ({
      application_id: application.id,
      user_id: application.user_id ?? null,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention,
    }));

    try {
      rows = await supabaseRequest(env, "customer_niches", {
        method: "POST",
        body: minimal,
        prefer: "return=representation",
      });
    } catch (secondError) {
      throw new Error(
        `customer_niches insert failed. Full insert: ${firstError.message} | ` +
          `Minimal insert: ${secondError.message}`
      );
    }
  }

  if (!Array.isArray(rows) || rows.length !== 10) {
    throw new Error("Supabase did not confirm saving all 10 niches");
  }

  return rows;
}

// ============================================================
// MAIN PROCESS
// ============================================================

async function processApplication(applicationId, env, opts = {}) {
  const { force = false } = opts;

  console.log("Starting niche discovery for application:", applicationId);

  const application = await getApplication(applicationId, env);

  const initialTask = await createInitialPlannerTask(application, env);

  const existingNiches = await getExistingNiches(application.id, env);

  if (existingNiches.length >= 10 && !force) {
    await updateApplicationStatus(application.id, "completed", env);

    return {
      success: true,
      message: "Niches already exist; no duplicates inserted",
      application_id: application.id,
      planner_task_id: initialTask.id,
      niche_count: existingNiches.length,
      niches: existingNiches,
    };
  }

  try {
    await updateApplicationStatus(application.id, "processing", env);

    const businessData = await getBusinessData(application.id, env);
    const companySummary = buildCompanySummary(application, businessData);

    const niches = await getNichesFromSarvam(companySummary, env);

    // Partial leftovers (1-9 rows from an earlier failed run) would
    // otherwise create duplicates, so clear them first.
    if (existingNiches.length > 0) {
      const delQuery = new URLSearchParams({
        application_id: `eq.${application.id}`,
      }).toString();

      await supabaseRequest(env, "customer_niches", {
        method: "DELETE",
        query: delQuery,
        prefer: "return=minimal",
      });
    }

    const savedNiches = await saveNiches(application, niches, env);

    await updateApplicationStatus(application.id, "completed", env);

    return {
      success: true,
      message: "Customer niche discovery completed",
      application_id: application.id,
      planner_task_id: initialTask.id,
      planner_task_status: "Completed",
      niche_count: savedNiches.length,
      buying_intention_total: savedNiches.reduce(
        (sum, item) => sum + item.buying_intention,
        0
      ),
      niches: savedNiches,
    };
  } catch (error) {
    console.error("Niche discovery failed:", error.message);

    await recordPlannerError(initialTask.id, error.message, env);

    try {
      await updateApplicationStatus(application.id, "failed", env);
    } catch (statusError) {
      console.error(
        "Could not update application failure status:",
        statusError.message
      );
    }

    throw new Error(
      `Niche discovery failed (planner task ${initialTask.id}): ${error.message}`
    );
  }
}
