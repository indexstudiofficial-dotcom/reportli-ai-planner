/**
 * Lead Research Planner — Cloudflare Worker
 * Version: 5.0.0
 *
 * Required Cloudflare secrets:
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 *
 * Routes:
 * GET  /health
 * POST /webhook
 * POST /create-task
 * POST /test
 *
 * Request:
 * {
 *   "application_id": "YOUR_APPLICATION_ID",
 *   "source": "reddit"
 * }
 */

const VERSION = "5.0.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const ALLOWED_SOURCES = new Set([
  "reddit",
  "apollo"
]);

const STATUS_FIELD = {
  reddit: "reddit_status",
  apollo: "apollo_status"
};

// ============================================================
// 1. MAIN WORKER AND ROUTES
// ============================================================

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    const url = new URL(request.url);

    try {
      let result;

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        result = {
          success: true,
          worker: "lead-research-planner",
          version: VERSION
        };
      } else if (
        request.method === "POST" &&
        ["/create-task", "/test"].includes(url.pathname)
      ) {
        const body = await readJson(request);
        result = await createTask(env, body);
      } else if (
        request.method === "POST" &&
        url.pathname === "/webhook"
      ) {
        const body = await readJson(request);

        const applicationId = String(
          body.application_id ||
          body.record?.id ||
          body.id ||
          ""
        ).trim();

        if (!applicationId) {
          throw httpError(
            400,
            "application_id is required"
          );
        }

        result = await processApplication(
          env,
          applicationId
        );
      } else {
        throw httpError(
          404,
          "Route not found. Use GET /health, POST /webhook, or POST /create-task."
        );
      }

      return jsonResponse(result, 200, cors);

    } catch (error) {
      console.error("Worker error:", error);

      const status = Number(error?.status) || 500;

      return jsonResponse(
        {
          success: false,
          error: error?.message || String(error)
        },
        status,
        cors
      );
    }
  }
};

// ============================================================
// 2. GENERAL HELPERS
// ============================================================

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(
      400,
      "Request body must be valid JSON"
    );
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function jsonResponse(
  data,
  status = 200,
  extraHeaders = {}
) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders
      }
    }
  );
}

function requireEnv(env, name) {
  const value = env[name];

  if (!value || !String(value).trim()) {
    throw httpError(
      500,
      `Missing Worker secret: ${name}`
    );
  }

  return String(value).trim();
}

// ============================================================
// 3. SUPABASE REQUEST HELPER
// ============================================================

function supabaseBase(env) {
  return requireEnv(
    env,
    "SUPABASE_URL"
  ).replace(/\/+$/, "");
}

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const key = requireEnv(
    env,
    "SUPABASE_SERVICE_ROLE_KEY"
  );

  const response = await fetch(
    `${supabaseBase(env)}${path}`,
    {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw httpError(
      502,
      `Supabase request failed (${response.status}): ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

// ============================================================
// 4. GET APPLICATION DETAILS
// ============================================================

async function getApplication(
  env,
  applicationId
) {
  const rows = await supabaseRequest(
    env,
    `/rest/v1/applications?id=eq.${encodeURIComponent(
      applicationId
    )}&select=*&limit=1`
  );

  if (!Array.isArray(rows) || !rows[0]) {
    throw httpError(
      404,
      `Application not found: ${applicationId}`
    );
  }

  return rows[0];
}

// ============================================================
// 5. GET OPTIONAL BUSINESS KNOWLEDGE
// ============================================================

async function getBusinessData(
  env,
  applicationId
) {
  try {
    const rows = await supabaseRequest(
      env,
      `/rest/v1/business_data?application_id=eq.${encodeURIComponent(
        applicationId
      )}&select=field,data&limit=100`
    );

    return Array.isArray(rows) ? rows : [];

  } catch (error) {
    console.log(
      "Could not read business_data; continuing with application fields:",
      error.message
    );

    return [];
  }
}

function appSummary(app, businessData) {
  const known = {
    id: app.id,
    name: app.name || null,
    company:
      app.company ||
      app.company_name ||
      null,
    description:
      app.description ||
      app.business_description ||
      null,
    industry:
      app.industry ||
      app.category ||
      null,
    domain:
      app.domain ||
      app.website_url ||
      app.website ||
      null
  };

  const extra = businessData.map(row => ({
    field: row.field,
    data: row.data
  }));

  return {
    application: known,
    business_data: extra
  };
}

// ============================================================
// 6. SARVAM AI CALL — IMPROVED ERROR HANDLING
// ============================================================

async function callSarvam(
  env,
  prompt,
  options = {}
) {
  const apiKey = requireEnv(
    env,
    "SARVAM_API_KEY"
  );

  const maxTokens =
    options.maxTokens || 4096;

  const response = await fetch(
    SARVAM_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey
      },
      body: JSON.stringify({
        model: "sarvam-105b",

        messages: [
          {
            role: "system",
            content:
              "Follow the user's instructions exactly. Return only the requested output. Do not invent factual findings."
          },
          {
            role: "user",
            content: prompt
          }
        ],

        // Request no additional reasoning effort.
        reasoning_effort: null,

        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false
      })
    }
  );

  // Read the body once so API errors remain visible.
  const raw = await response.text();

  let payload;

  try {
    payload = raw
      ? JSON.parse(raw)
      : null;
  } catch {
    throw httpError(
      502,
      `Sarvam returned non-JSON (${response.status}): ${raw.slice(
        0,
        1200
      )}`
    );
  }

  if (!response.ok) {
    throw httpError(
      502,
      `Sarvam API error (${response.status}): ${JSON.stringify(
        payload
      ).slice(0, 1600)}`
    );
  }

  const choice =
    payload?.choices?.[0];

  const message =
    choice?.message;

  const content =
    message?.content;

  if (
    typeof content === "string" &&
    content.trim()
  ) {
    return content.trim();
  }

  // Do not hide the underlying API response.
  console.error(
    "Sarvam returned no message content:",
    JSON.stringify(payload).slice(0, 3000)
  );

  throw httpError(
    502,
    `Sarvam returned no message content. finish_reason=${
      choice?.finish_reason ?? "missing"
    }; usage=${JSON.stringify(
      payload?.usage ?? null
    )}; response=${JSON.stringify(
      payload
    ).slice(0, 1800)}`
  );
}

// ============================================================
// 7. PARSE JSON RETURNED BY SARVAM
// ============================================================

function parseJsonFromModel(text) {
  const trimmed = String(
    text || ""
  ).trim();

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {}

  const firstObject =
    withoutFence.indexOf("{");

  const lastObject =
    withoutFence.lastIndexOf("}");

  if (
    firstObject >= 0 &&
    lastObject > firstObject
  ) {
    try {
      return JSON.parse(
        withoutFence.slice(
          firstObject,
          lastObject + 1
        )
      );
    } catch {}
  }

  const firstArray =
    withoutFence.indexOf("[");

  const lastArray =
    withoutFence.lastIndexOf("]");

  if (
    firstArray >= 0 &&
    lastArray > firstArray
  ) {
    try {
      return JSON.parse(
        withoutFence.slice(
          firstArray,
          lastArray + 1
        )
      );
    } catch {}
  }

  throw httpError(
    502,
    `Sarvam response was not valid JSON: ${withoutFence.slice(
      0,
      1000
    )}`
  );
}

// ============================================================
// 8. GENERATE CUSTOMER NICHES
// ============================================================

async function ensureNiches(
  env,
  app,
  businessData = []
) {
  const applicationId =
    String(app.id);

  const existing = await supabaseRequest(
    env,
    `/rest/v1/customer_niches?application_id=eq.${encodeURIComponent(
      applicationId
    )}&select=*&order=created_at.asc`
  );

  if (
    Array.isArray(existing) &&
    existing.length > 0
  ) {
    return {
      created: 0,
      niches: existing
    };
  }

  const summary = appSummary(
    app,
    businessData
  );

  const prompt = `
Create exactly 10 distinct customer niches for this business.

Return ONLY valid JSON in this format:
{
  "niches": [
    {
      "niche_name": "Example customer niche",
      "buying_intention": 85
    }
  ]
}

buying_intention must be an integer from 1 to 100.
Higher scores mean stronger likely need and purchase intent.
Do not add explanations or extra fields.

Business data:
${JSON.stringify(summary).slice(0, 16000)}
`;

  const output = await callSarvam(
    env,
    prompt,
    {
      maxTokens: 4096
    }
  );

  const parsed =
    parseJsonFromModel(output);

  if (!Array.isArray(parsed.niches)) {
    throw httpError(
      502,
      "Sarvam niche response must contain a niches array"
    );
  }

  const used = new Set();

  const niches = parsed.niches
    .map((item, index) => ({
      niche_name: String(
        item?.niche_name ||
        item?.name ||
        ""
      ).trim(),

      buying_intention: Math.max(
        1,
        Math.min(
          100,
          Math.round(
            Number(
              item?.buying_intention ??
              item?.score ??
              (100 - index * 3)
            )
          )
        )
      )
    }))
    .filter(item => {
      const key =
        item.niche_name.toLowerCase();

      if (!key || used.has(key)) {
        return false;
      }

      used.add(key);
      return true;
    })
    .slice(0, 10);

  if (niches.length < 1) {
    throw httpError(
      502,
      "Sarvam did not return any valid niche names"
    );
  }

  const rows = niches.map(niche => ({
    application_id: applicationId,
    niche_name: niche.niche_name,
    buying_intention:
      niche.buying_intention,
    reddit_status: "pending",
    apollo_status: "pending",
    is_active: true,

    ...(app.user_id
      ? { user_id: app.user_id }
      : {})
  }));

  const inserted = await supabaseRequest(
    env,
    "/rest/v1/customer_niches",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(rows)
    }
  );

  return {
    created: Array.isArray(inserted)
      ? inserted.length
      : rows.length,
    niches: inserted || rows
  };
}

// ============================================================
// 9. PROCESS APPLICATION WEBHOOK
// ============================================================

async function processApplication(
  env,
  applicationId
) {
  const app = await getApplication(
    env,
    applicationId
  );

  const businessData =
    await getBusinessData(
      env,
      applicationId
    );

  const result = await ensureNiches(
    env,
    app,
    businessData
  );

  return {
    success: true,
    application_id: applicationId,

    message: result.created
      ? "Customer niches created"
      : "Customer niches already exist",

    niches_created: result.created,
    niches: result.niches
  };
}

// ============================================================
// 10. BUILD DOWNSTREAM TASK PROMPTS
// ============================================================

function taskPrompt(
  source,
  app,
  niche
) {
  const base = `
Create one ${
    source === "reddit"
      ? "Reddit research"
      : "Apollo lead-generation"
  } task for this niche: ${niche.niche_name}.

Business:
${app.company || app.name || "Not provided"}

Return ONLY valid JSON with these keys:
task_id, worker, objective, niche, target_audience, instructions, limits.

This is an instruction for a downstream worker, not research results.
Do not invent findings.
`;

  if (source === "reddit") {
    return `${base}

Requirements:
- worker must be "reddit_research".
- Research relevant public Reddit posts and discussions.
- Find real customer problems related to this niche.
- Prefer posts from the last 7 days.
- Target up to 20 relevant new posts when available.
- Prioritize buying intent, dissatisfaction, and requests for solutions.
- Identify recurring pain points and customers' own language.
- Consider SaaS, startups, Entrepreneur, indiehackers, and sales communities.
- Explore other relevant communities when useful.
- Include source URLs in the downstream findings.
- Never invent posts, quotes, users, URLs, or engagement metrics.
- limits must include published_within_days=7 and target_new_posts=20.
`;
  }

  return `${base}

Requirements:
- worker must be "apollo_lead_generation".
- Find and qualify real prospects using the connected Apollo integration.
- Prioritize fit and likely buying intent.
- Do not invent contacts, companies, emails, job titles, or enrichment data.
- Include search criteria and qualification rules.
- If Apollo is not connected, stop and report that the connection is required.
`;
}

// ============================================================
// 11. CREATE REDDIT OR APOLLO TASK
// ============================================================

async function createTask(
  env,
  body
) {
  const applicationId = String(
    body?.application_id || ""
  ).trim();

  const source = String(
    body?.source || ""
  ).trim().toLowerCase();

  if (!applicationId) {
    throw httpError(
      400,
      "application_id is required"
    );
  }

  if (!ALLOWED_SOURCES.has(source)) {
    throw httpError(
      400,
      'source must be "reddit" or "apollo"'
    );
  }

  const app = await getApplication(
    env,
    applicationId
  );

  const statusField =
    STATUS_FIELD[source];

  let niches = await supabaseRequest(
    env,
    `/rest/v1/customer_niches?application_id=eq.${encodeURIComponent(
      applicationId
    )}&is_active=eq.true&${statusField}=eq.pending&select=*&order=buying_intention.desc,created_at.asc&limit=1`
  );

  // Legacy rows may have is_active set to NULL.
  if (
    !Array.isArray(niches) ||
    niches.length === 0
  ) {
    niches = await supabaseRequest(
      env,
      `/rest/v1/customer_niches?application_id=eq.${encodeURIComponent(
        applicationId
      )}&${statusField}=eq.pending&select=*&order=buying_intention.desc,created_at.asc&limit=1`
    );
  }

  // If no pending niches remain, start a new cycle.
  if (
    !Array.isArray(niches) ||
    niches.length === 0
  ) {
    const all = await supabaseRequest(
      env,
      `/rest/v1/customer_niches?application_id=eq.${encodeURIComponent(
        applicationId
      )}&is_active=eq.true&select=*&order=updated_at.asc,created_at.asc`
    );

    if (
      !Array.isArray(all) ||
      all.length === 0
    ) {
      throw httpError(
        404,
        "No customer niches found. Run POST /webhook first to generate niches."
      );
    }

    await resetSourceCycle(
      env,
      applicationId,
      source,
      all
    );

    niches = await supabaseRequest(
      env,
      `/rest/v1/customer_niches?application_id=eq.${encodeURIComponent(
        applicationId
      )}&${statusField}=eq.pending&select=*&order=buying_intention.desc,created_at.asc&limit=1`
    );
  }

  if (
    !Array.isArray(niches) ||
    !niches[0]
  ) {
    throw httpError(
      409,
      `No ${source} niche is available to queue`
    );
  }

  const niche = niches[0];

  // Claim the niche to reduce duplicate tasks.
  const claimed = await supabaseRequest(
    env,
    `/rest/v1/customer_niches?id=eq.${encodeURIComponent(
      niche.id
    )}&${statusField}=eq.pending`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        [statusField]: "processing"
      })
    }
  );

  if (
    !Array.isArray(claimed) ||
    claimed.length === 0
  ) {
    throw httpError(
      409,
      "This niche was already claimed by another request. Retry once."
    );
  }

  try {
    const prompt = taskPrompt(
      source,
      app,
      niche
    );

    const modelText = await callSarvam(
      env,
      prompt,
      {
        maxTokens: 4096
      }
    );

    const parsed =
      parseJsonFromModel(modelText);

    const task = {
      task_id: String(
        parsed.task_id ||
        `${source}_${Date.now()}_${String(
          niche.id
        ).slice(0, 8)}`
      ),

      worker:
        source === "reddit"
          ? "reddit_research"
          : "apollo_lead_generation",

      objective: String(
        parsed.objective ||
        (
          source === "reddit"
            ? "Research real customer problems in public Reddit discussions"
            : "Find and qualify relevant prospects"
        )
      ),

      niche: String(
        parsed.niche ||
        niche.niche_name
      ),

      target_audience:
        parsed.target_audience ??
        [niche.niche_name],

      instructions:
        parsed.instructions ??
        (
          source === "reddit"
            ? "Research public Reddit posts, prefer the last 7 days, target up to 20 posts, prioritize buying intent and recurring pain points, include source URLs, and never invent findings."
            : "Use the connected Apollo integration to find and qualify real prospects. Do not invent contact data."
        ),

      limits:
        parsed.limits ??
        (
          source === "reddit"
            ? {
                published_within_days: 7,
                target_new_posts: 20
              }
            : {
                do_not_invent_contact_data: true
              }
        )
    };

    // Save task in planner_runs.
    const row = {
      application_id: applicationId,
      user_id: app.user_id || null,

      worker_type:
        source === "reddit"
          ? "reddit_research"
          : "apollo_lead_generation",

      source,
      task: JSON.stringify(task),
      pending_count: 1,
      error: null,
      niche: niche.niche_name
    };

    const inserted = await supabaseRequest(
      env,
      "/rest/v1/planner_runs",
      {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify(row)
      }
    );

    // Mark the niche as queued after saving the task.
    await supabaseRequest(
      env,
      `/rest/v1/customer_niches?id=eq.${encodeURIComponent(
        niche.id
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          [statusField]: "queued"
        })
      }
    );

    return {
      success: true,
      application_id: applicationId,
      source,
      niche: niche.niche_name,
      task,

      planner_run: Array.isArray(inserted)
        ? inserted[0]
        : inserted
    };

  } catch (error) {
    // Restore the niche so a failed request does not leave it processing.
    try {
      await supabaseRequest(
        env,
        `/rest/v1/customer_niches?id=eq.${encodeURIComponent(
          niche.id
        )}`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            [statusField]: "pending"
          })
        }
      );
    } catch (restoreError) {
      console.error(
        "Failed to restore niche status:",
        restoreError.message
      );
    }

    throw error;
  }
}

// ============================================================
// 12. RESET STATUS CYCLE
// ============================================================

async function resetSourceCycle(
  env,
  applicationId,
  source,
  niches
) {
  const statusField =
    STATUS_FIELD[source];

  const activeNiches = (niches || [])
    .filter(
      niche => niche.is_active !== false
    )
    .sort((a, b) => {
      const timeA =
        Date.parse(
          a.updated_at ||
          a.created_at ||
          ""
        ) || 0;

      const timeB =
        Date.parse(
          b.updated_at ||
          b.created_at ||
          ""
        ) || 0;

      if (timeA !== timeB) {
        return timeA - timeB;
      }

      return String(a.id).localeCompare(
        String(b.id)
      );
    });

  if (activeNiches.length === 0) {
    throw httpError(
      404,
      `No active niches available for ${source}`
    );
  }

  for (const niche of activeNiches) {
    await supabaseRequest(
      env,
      `/rest/v1/customer_niches?id=eq.${encodeURIComponent(
        niche.id
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          [statusField]: "pending"
        })
      }
    );
  }

  console.log(
    "Source cycle reset:",
    source,
    applicationId,
    "Niches:",
    activeNiches.length
  );
        }
