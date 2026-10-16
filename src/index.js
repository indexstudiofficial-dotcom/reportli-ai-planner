/**
 * ============================================================
 * LEAD RESEARCH PLANNER — NICHE FINDER WORKER
 * Version: 6.0.0
 * ============================================================
 *
 * PURPOSE
 * 1. Receive new applications from Supabase.
 * 2. Create the initial planner_runs task WITHOUT AI.
 * 3. Mark that initial task Completed immediately.
 * 4. Read company information from applications.
 * 5. Use Sarvam AI to discover exactly 10 customer niches.
 * 6. Normalize buying-intention scores to total exactly 100.
 * 7. Save the niches in customer_niches.
 * 8. Update applications.planner_status.
 *
 * NO REDDIT TASK CREATION.
 * NO APOLLO TASK CREATION.
 * NO is_active COLUMN.
 *
 * REQUIRED CLOUDFLARE SECRETS:
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 * ============================================================
 */

const VERSION = "6.0.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const INITIAL_TASK =
  "Analyze the company and find 10 customer niches";

const NICHE_WORKER_TYPE = "niche_finder";
const NICHE_SOURCE = "niche_finder";

const REQUEST_TIMEOUT_MS = 25000;

// ============================================================
// MAIN ROUTER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, apikey, x-webhook-secret",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
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
            purpose: "Customer niche discovery",
            ai_provider: "Sarvam AI",
            reddit_task_creation: false,
            apollo_task_creation: false,
            timestamp: new Date().toISOString(),
          },
          200,
          corsHeaders
        );
      }

      if (request.method === "POST" && path === "/webhook") {
        const body = await request.json();

        const applicationId =
          body.application_id ||
          body.record?.id ||
          body.id;

        if (!applicationId) {
          return jsonResponse(
            {
              success: false,
              error: "Missing application_id",
            },
            400,
            corsHeaders
          );
        }

        // Accept Supabase Database Webhook payloads and
        // direct POST requests containing application_id.
        const result = await processApplication(
          String(applicationId),
          env
        );

        return jsonResponse(result, 200, corsHeaders);
      }

      if (request.method === "POST" && path === "/test") {
        const body = await request.json();

        if (!body.application_id) {
          return jsonResponse(
            {
              success: false,
              error: "Provide application_id",
            },
            400,
            corsHeaders
          );
        }

        const result = await processApplication(
          String(body.application_id),
          env
        );

        return jsonResponse(result, 200, corsHeaders);
      }

      return jsonResponse(
        {
          success: false,
          error: "Route not found",
          available_routes: [
            "GET /health",
            "POST /webhook",
            "POST /test",
          ],
        },
        404,
        corsHeaders
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
        corsHeaders
      );
    }
  },
};

// ============================================================
// ENVIRONMENT VALIDATION
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
    throw new Error(
      `Missing Cloudflare secrets: ${missing.join(", ")}`
    );
  }
}

// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(
  env,
  table,
  options = {}
) {
  const {
    method = "GET",
    query = "",
    body = undefined,
    prefer = undefined,
  } = options;

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const url =
    `${baseUrl}/rest/v1/${table}` +
    (query ? `?${query}` : "");

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (prefer) {
    headers.Prefer = prefer;
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body),
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
        `Supabase ${method} ${table} failed ` +
        `(${response.status}): ${JSON.stringify(data)}`
      );
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Supabase request timed out: ${table}`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// FETCH APPLICATION
// Uses your actual applications table.
// ============================================================

async function getApplication(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,name,api_key,user_id,domain,company,planner_status",
    id: `eq.${applicationId}`,
    limit: "1",
  }).toString();

  const rows = await supabaseRequest(
    env,
    "applications",
    { query }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `Application not found: ${applicationId}`
    );
  }

  return rows[0];
}

// ============================================================
// UPDATE APPLICATION STATUS
// ============================================================

async function updateApplicationStatus(
  applicationId,
  status,
  env
) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,
  }).toString();

  return supabaseRequest(
    env,
    "applications",
    {
      method: "PATCH",
      query,
      body: {
        planner_status: status,
      },
      prefer: "return=minimal",
    }
  );
}

// ============================================================
// STEP 1: CREATE INITIAL PLANNER TASK WITHOUT AI
//
// This task is marked Completed immediately.
// Sarvam AI is NOT called by this function.
//
// Uses your supplied planner_runs schema.
// ============================================================

async function createInitialPlannerTask(
  application,
  env
) {
  // Check whether a previous webhook already created it.
  // This helps prevent duplicate tasks when Supabase retries.
  const query = new URLSearchParams({
    select: "id,status,task,created_at",
    application_id: `eq.${application.id}`,
    worker_type: `eq.${NICHE_WORKER_TYPE}`,
    source: `eq.${NICHE_SOURCE}`,
    task: `eq.${INITIAL_TASK}`,
    order: "created_at.desc",
    limit: "1",
  }).toString();

  const existing = await supabaseRequest(
    env,
    "planner_runs",
    { query }
  );

  if (Array.isArray(existing) && existing.length > 0) {
    console.log(
      "Initial planner task already exists:",
      existing[0].id
    );

    return existing[0];
  }

  const payload = {
    application_id: application.id,
    user_id: application.user_id ?? null,
    worker_type: NICHE_WORKER_TYPE,
    source: NICHE_SOURCE,
    task: INITIAL_TASK,
    pending_count: 0,
    error: null,
    niche: null,
    status: "Completed",
  };

  const rows = await supabaseRequest(
    env,
    "planner_runs",
    {
      method: "POST",
      query: "",
      body: payload,
      prefer: "return=representation",
    }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "Initial planner task was not returned by Supabase"
    );
  }

  console.log(
    "Initial planner task created and completed:",
    rows[0].id
  );

  return rows[0];
}

// ============================================================
// STEP 2: OPTIONAL COMPANY CONTEXT
//
// Reads business_data if available.
// Missing optional context will not stop niche discovery.
// ============================================================

async function getBusinessData(applicationId, env) {
  try {
    const query = new URLSearchParams({
      select: "field,data,source_url",
      application_id: `eq.${applicationId}`,
      limit: "30",
    }).toString();

    const rows = await supabaseRequest(
      env,
      "business_data",
      { query }
    );

    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn(
      "Optional business_data unavailable:",
      error.message
    );

    return [];
  }
}

// ============================================================
// BUILD COMPANY SUMMARY
// ============================================================

function buildCompanySummary(application, businessData) {
  const parts = [];

  if (application.name) {
    parts.push(`Application name: ${application.name}`);
  }

  if (application.company) {
    parts.push(`Company information: ${application.company}`);
  }

  if (application.domain) {
    parts.push(`Website/domain: ${application.domain}`);
  }

  if (Array.isArray(businessData) && businessData.length > 0) {
    const context = businessData
      .map((row) => {
        let value = row.data;

        if (typeof value !== "string") {
          value = JSON.stringify(value);
        }

        return (
          `Field: ${row.field}\n` +
          `Source: ${row.source_url || "Not provided"}\n` +
          `Data: ${(value || "").slice(0, 4000)}`
        );
      })
      .join("\n\n");

    parts.push(
      `Additional company information:\n${context.slice(0, 18000)}`
    );
  }

  const summary = parts.join("\n\n").trim();

  if (!summary) {
    throw new Error(
      "The application has no usable company information. " +
      "Provide company, name, or domain."
    );
  }

  return summary;
}

// ============================================================
// STEP 3: CALL SARVAM AI
//
// Sarvam generates niches only.
// It does not create planner_runs tasks.
// ============================================================

async function callSarvamForNiches(
  companySummary,
  env
) {
  const systemPrompt = `
You are a B2B market research strategist.

Your job is to identify the 10 most promising BROAD CUSTOMER
SEGMENTS for a company.

Use the company's actual information to decide which segments
are relevant.

CUSTOMER SEGMENT RULES:
- Return exactly 10 distinct customer segments.
- Prefer broad audience types, industries, business models,
  or professional groups.
- Examples of segment types include SaaS founders, freelancers,
  agencies, Shopify store owners, consultants, small businesses,
  e-commerce businesses, app developers, and marketing agencies.
- These are examples only. Do not blindly use irrelevant examples.
- Avoid overly specific product categories or long descriptive
  combinations unless the company genuinely serves that market.
- Each niche must represent a meaningfully different audience.
- Do not invent company features, products, or services.
- Do not include generic audiences that have no plausible need
  for the company's product or service.
- Rank niches from highest to lowest purchase intent.
- buying_intention must be a positive integer score.
- Scores do not need to total 100; the worker will normalize them.
- Do not include explanations outside the JSON.
- Return valid JSON only.

Required JSON structure:
{
  "niches": [
    {
      "niche_name": "SaaS founders",
      "buying_intention": 20
    }
  ]
}

The niches array must contain exactly 10 objects.
`;

  const userPrompt = `
Analyze this company and find 10 customer niches.

COMPANY INFORMATION:
${companySummary}

Choose the segments most likely to need and pay for this
company's actual product or service.
`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(SARVAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": env.SARVAM_API_KEY,
      },
      body: JSON.stringify({
        model: SARVAM_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();

    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Sarvam returned invalid JSON response: ` +
        responseText.slice(0, 1000)
      );
    }

    if (!response.ok) {
      throw new Error(
        `Sarvam API error (${response.status}): ` +
        JSON.stringify(responseData).slice(0, 1500)
      );
    }

    const content =
      responseData?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(
        "Sarvam returned no message content: " +
        JSON.stringify(responseData).slice(0, 1500)
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

// ============================================================
// PARSE SARVAM JSON
// Supports JSON code fences and surrounding text.
// ============================================================

function parseModelJson(content) {
  if (typeof content !== "string") {
    if (content && typeof content === "object") {
      return content;
    }

    throw new Error(
      "Sarvam returned an unsupported content format"
    );
  }

  let cleaned = content.trim();

  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(
          cleaned.slice(start, end + 1)
        );
      } catch {
        // Throw the standard error below.
      }
    }

    throw new Error(
      "Sarvam's niche output was not valid JSON: " +
      cleaned.slice(0, 1000)
    );
  }
}

// ============================================================
// STEP 4: VALIDATE AND NORMALIZE SCORES
//
// Guarantees:
// - Exactly 10 unique niches.
// - Each score is a positive integer.
// - All scores add up to exactly 100.
// - Higher model scores retain higher relative priority.
// ============================================================

function normalizeNiches(modelOutput) {
  const rawNiches = Array.isArray(modelOutput)
    ? modelOutput
    : modelOutput?.niches;

  if (!Array.isArray(rawNiches)) {
    throw new Error(
      "Sarvam output must contain a niches array"
    );
  }

  const unique = [];
  const seen = new Set();

  for (const item of rawNiches) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const name = String(
      item.niche_name ||
      item.niche ||
      item.name ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");

    if (!name) {
      continue;
    }

    const key = name.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    let score = Number(item.buying_intention);

    if (!Number.isFinite(score) || score <= 0) {
      score = 1;
    }

    score = Math.min(score, 10000);

    unique.push({
      niche_name: name,
      original_score: score,
    });

    if (unique.length === 10) {
      break;
    }
  }

  if (unique.length !== 10) {
    throw new Error(
      `Sarvam returned only ${unique.length} unique niches. ` +
      "Exactly 10 unique niches are required. " +
      "Retry the request."
    );
  }

  // Sort by model-provided buying intention.
  unique.sort(
    (a, b) => b.original_score - a.original_score
  );

  // Give every niche at least 1 point.
  // Distribute the remaining 90 points proportionally.
  const remainingPoints = 90;

  const totalWeight = unique.reduce(
    (sum, item) => sum + item.original_score,
    0
  );

  const allocations = unique.map((item, index) => {
    const exact =
      (item.original_score / totalWeight) *
      remainingPoints;

    const floor = Math.floor(exact);

    return {
      index,
      score: floor + 1,
      remainder: exact - floor,
    };
  });

  let allocated = allocations.reduce(
    (sum, item) => sum + item.score,
    0
  );

  let remaining = 100 - allocated;

  const remainderOrder = [...allocations].sort(
    (a, b) => b.remainder - a.remainder
  );

  let pointer = 0;

  while (remaining > 0) {
    const target = remainderOrder[
      pointer % remainderOrder.length
    ];

    allocations[target.index].score += 1;

    remaining -= 1;
    pointer += 1;
  }

  const result = unique.map((item, index) => ({
    niche_name: item.niche_name,
    buying_intention: allocations[index].score,
  }));

  const finalTotal = result.reduce(
    (sum, item) => sum + item.buying_intention,
    0
  );

  if (
    result.length !== 10 ||
    finalTotal !== 100
  ) {
    throw new Error(
      `Niche score validation failed. ` +
      `Count: ${result.length}; total: ${finalTotal}`
    );
  }

  return result;
}

// ============================================================
// STEP 5: READ EXISTING NICHES
// Uses the actual customer_niches schema.
// ============================================================

async function getExistingNiches(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,niche_name,buying_intention,reddit_status,apollo_status",
    application_id: `eq.${applicationId}`,
    order: "buying_intention.desc",
  }).toString();

  const rows = await supabaseRequest(
    env,
    "customer_niches",
    { query }
  );

  return Array.isArray(rows) ? rows : [];
}

// ============================================================
// STEP 6: SAVE NICHES
//
// No is_active column is used.
// ============================================================

async function saveNiches(
  application,
  niches,
  env
) {
  const payload = niches.map((niche) => ({
    application_id: application.id,
    user_id: application.user_id ?? null,
    niche_name: niche.niche_name,
    buying_intention: niche.buying_intention,
    reddit_status: "pending",
    apollo_status: "pending",
  }));

  const rows = await supabaseRequest(
    env,
    "customer_niches",
    {
      method: "POST",
      body: payload,
      prefer: "return=representation",
    }
  );

  if (!Array.isArray(rows) || rows.length !== 10) {
    throw new Error(
      "Supabase did not confirm saving all 10 niches"
    );
  }

  console.log(
    `Saved ${rows.length} niches for application ${application.id}`
  );

  return rows;
}

// ============================================================
// STEP 7: PROCESS APPLICATION
//
// Workflow:
// A. Fetch application.
// B. Create initial task without AI.
// C. Mark that task Completed immediately.
// D. Check whether niches already exist.
// E. Read company information.
// F. Generate niches with Sarvam.
// G. Normalize scores.
// H. Save niches.
// I. Update application status.
// ============================================================

async function processApplication(
  applicationId,
  env
) {
  console.log(
    "Starting niche discovery for application:",
    applicationId
  );

  const application = await getApplication(
    applicationId,
    env
  );

  // FIRST TASK: created and marked Completed WITHOUT AI.
  const initialTask = await createInitialPlannerTask(
    application,
    env
  );

  // The initial task stays Completed even if AI fails.
  // Its status represents completion of task creation,
  // not completion of niche generation.

  // If niches already exist, avoid duplicate insertion.
  const existingNiches = await getExistingNiches(
    application.id,
    env
  );

  if (existingNiches.length >= 10) {
    await updateApplicationStatus(
      application.id,
      "completed",
      env
    );

    return {
      success: true,
      message: "Niches already exist; no duplicates inserted",
      application_id: application.id,
      planner_task_id: initialTask.id,
      planner_task_status: initialTask.status,
      niche_count: existingNiches.length,
      niches: existingNiches,
    };
  }

  try {
    await updateApplicationStatus(
      application.id,
      "processing",
      env
    );

    // Read optional website/business data.
    const businessData = await getBusinessData(
      application.id,
      env
    );

    const companySummary = buildCompanySummary(
      application,
      businessData
    );

    // Sarvam is called only after the initial task exists.
    const modelOutput = await callSarvamForNiches(
      companySummary,
      env
    );

    const niches = normalizeNiches(modelOutput);

    const savedNiches = await saveNiches(
      application,
      niches,
      env
    );

    await updateApplicationStatus(
      application.id,
      "completed",
      env
    );

    console.log(
      `Niche discovery completed for ${application.id}`
    );

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
    console.error(
      "Niche discovery failed:",
      error.message
    );

    // The initial planner task remains Completed.
    // Record the AI processing failure on the application.
    try {
      await updateApplicationStatus(
        application.id,
        "failed",
        env
      );
    } catch (statusError) {
      console.error(
        "Could not update application failure status:",
        statusError.message
      );
    }

    throw new Error(
      `Initial planner task ${initialTask.id} was created ` +
      `with status Completed, but niche discovery failed: ` +
      error.message
    );
  }
        }
