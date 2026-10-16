/**
 * Reportli AI Planner Worker
 * Version: 3.0.0
 *
 * Responsibilities:
 * 1. Receive new application webhooks.
 * 2. Create the initial planner_runs task.
 * 3. Generate 10 customer niches with Sarvam AI.
 * 4. Normalize buying-intention scores to exactly 100.
 * 5. Save niches to customer_niches.
 * 6. Update applications.planner_status.
 * 7. Save processing errors in planner_runs.error.
 *
 * Endpoints:
 * GET  /health
 * POST /webhook
 * POST /test
 *
 * Required Cloudflare secrets:
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 */

const WORKER_NAME = "reportli-ai-planner";
const WORKER_VERSION = "3.0.0";

const PLANNER_WORKER_TYPE = "niche_finder";
const PLANNER_SOURCE = "niche_finder";
const PLANNER_TASK_TEXT =
  "Analyze the company and find 10 customer niches";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const MAX_ERROR_LENGTH = 8000;
const MAX_BUSINESS_CONTEXT_LENGTH = 12000;

// ============================================================
// MAIN ROUTER
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, apikey",
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
      // ------------------------------------------------------
      // Health check
      // ------------------------------------------------------

      if (request.method === "GET" && path === "/health") {
        return jsonResponse(
          {
            success: true,
            worker: WORKER_NAME,
            version: WORKER_VERSION,
            status: "healthy",
          },
          200,
          corsHeaders
        );
      }

      // All processing endpoints require these secrets.
      validateEnvironment(env);

      // ------------------------------------------------------
      // Supabase Database Webhook
      // ------------------------------------------------------

      if (request.method === "POST" && path === "/webhook") {
        const payload = await readJsonBody(request);

        const applicationId =
          payload?.record?.id ??
          payload?.application?.id ??
          payload?.application_id;

        if (!applicationId) {
          return jsonResponse(
            {
              success: false,
              error:
                "Missing application ID. Expected record.id in the webhook payload.",
            },
            400,
            corsHeaders
          );
        }

        // Ignore events that are explicitly not INSERT events.
        if (
          payload?.type &&
          String(payload.type).toUpperCase() !== "INSERT"
        ) {
          return jsonResponse(
            {
              success: true,
              skipped: true,
              reason: "Event is not an INSERT event.",
            },
            200,
            corsHeaders
          );
        }

        const result = await processApplication(
          String(applicationId),
          env
        );

        return jsonResponse(result, 200, corsHeaders);
      }

      // ------------------------------------------------------
      // Manual test endpoint
      // ------------------------------------------------------

      if (request.method === "POST" && path === "/test") {
        const payload = await readJsonBody(request);

        if (!payload?.application_id) {
          return jsonResponse(
            {
              success: false,
              error: "application_id is required.",
            },
            400,
            corsHeaders
          );
        }

        const result = await processApplication(
          String(payload.application_id),
          env
        );

        return jsonResponse(result, 200, corsHeaders);
      }

      // ------------------------------------------------------
      // Unknown endpoint
      // ------------------------------------------------------

      return jsonResponse(
        {
          success: false,
          error: "Endpoint not found.",
          available_endpoints: [
            "GET /health",
            "POST /webhook",
            "POST /test",
          ],
        },
        404,
        corsHeaders
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      console.error("Worker request failed:", errorMessage);

      return jsonResponse(
        {
          success: false,
          worker: WORKER_NAME,
          error: errorMessage,
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
  const requiredSecrets = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ];

  const missing = requiredSecrets.filter(
    (key) => !env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare secrets: ${missing.join(", ")}`
    );
  }
}

// ============================================================
// HTTP RESPONSE HELPERS
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

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function getErrorMessage(error) {
  let message;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }

  return String(message || "Unknown error").slice(
    0,
    MAX_ERROR_LENGTH
  );
}

// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(
    `${baseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const responseText = await response.text();

  let responseData = null;

  if (responseText) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }
  }

  if (!response.ok) {
    const details =
      typeof responseData === "string"
        ? responseData
        : JSON.stringify(responseData);

    throw new Error(
      `Supabase ${options.method || "GET"} ${path} failed ` +
      `(${response.status}): ${details}`
    );
  }

  return responseData;
}

// ============================================================
// APPLICATION HELPERS
// ============================================================

async function getApplication(applicationId, env) {
  const query = new URLSearchParams({
    select:
      "id,name,company,domain,user_id,planner_status",
    id: `eq.${applicationId}`,
    limit: "1",
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `Application not found: ${applicationId}`
    );
  }

  return rows[0];
}

async function updateApplicationPlannerStatus(
  applicationId,
  status,
  env
) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,
  });

  await supabaseRequest(
    env,
    `applications?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        planner_status: status,
      }),
    }
  );
}

// ============================================================
// PLANNER TASK HELPERS
// ============================================================

async function findPlannerTask(applicationId, env) {
  const query = new URLSearchParams({
    select: "id,application_id,status,error,created_at",
    application_id: `eq.${applicationId}`,
    worker_type: `eq.${PLANNER_WORKER_TYPE}`,
    source: `eq.${PLANNER_SOURCE}`,
    task: `eq.${PLANNER_TASK_TEXT}`,
    order: "created_at.desc",
    limit: "1",
  });

  const rows = await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

async function createPlannerTask(application, env) {
  const rows = await supabaseRequest(
    env,
    "planner_runs",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          application_id: application.id,
          user_id: application.user_id || null,
          worker_type: PLANNER_WORKER_TYPE,
          source: PLANNER_SOURCE,
          task: PLANNER_TASK_TEXT,
          pending_count: 0,
          error: null,
          niche: null,

          // The initial planner task is marked Completed
          // immediately, as requested.
          status: "Completed",

          started_at: new Date().toISOString(),
        },
      ]),
    }
  );

  if (!Array.isArray(rows) || !rows[0]?.id) {
    throw new Error(
      "Planner task was not created or Supabase did not return its ID."
    );
  }

  return rows[0];
}

async function ensurePlannerTask(application, env) {
  const existing = await findPlannerTask(
    application.id,
    env
  );

  if (existing) {
    // Clear a previous error when a new attempt begins.
    // Keep the task's status unchanged.
    await updatePlannerTaskError(
      existing.id,
      null,
      env
    );

    return existing;
  }

  return await createPlannerTask(application, env);
}

// ============================================================
// IMPORTANT: SAVE ACTUAL ERRORS IN planner_runs.error
// ============================================================

async function updatePlannerTaskError(
  plannerTaskId,
  error,
  env
) {
  if (!plannerTaskId) {
    throw new Error(
      "Cannot update planner error because planner task ID is missing."
    );
  }

  const query = new URLSearchParams({
    id: `eq.${plannerTaskId}`,
  });

  const errorMessage =
    error === null || error === undefined
      ? null
      : getErrorMessage(error);

  await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        error: errorMessage,
      }),
    }
  );

  if (errorMessage) {
    console.error(
      "Saved error to planner_runs.error:",
      {
        plannerTaskId,
        error: errorMessage,
      }
    );
  }
}

// ============================================================
// OPTIONAL BUSINESS CONTEXT
// ============================================================

async function getBusinessData(
  applicationId,
  env
) {
  const query = new URLSearchParams({
    select: "field,data",
    application_id: `eq.${applicationId}`,
    limit: "30",
  });

  try {
    const rows = await supabaseRequest(
      env,
      `business_data?${query.toString()}`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return "";
    }

    const context = rows
      .map((row) => {
        let value;

        try {
          value =
            typeof row.data === "string"
              ? row.data
              : JSON.stringify(row.data);
        } catch {
          value = String(row.data);
        }

        return `${row.field || "business_information"}: ${value}`;
      })
      .join("\n");

    return context.slice(
      0,
      MAX_BUSINESS_CONTEXT_LENGTH
    );
  } catch (error) {
    // business_data is optional. A missing or inaccessible
    // optional table must not prevent niche discovery.
    console.warn(
      "Optional business_data context unavailable:",
      getErrorMessage(error)
    );

    return "";
  }
}

// ============================================================
// SARVAM AI: GENERATE CUSTOMER NICHES
// ============================================================

function buildNichePrompt(application, businessContext) {
  const companyName =
    application.company ||
    application.name ||
    "Unknown company";

  const domain = application.domain || "Not provided";

  return `
You are a B2B customer-market research expert.

Analyze this company and identify exactly 10 distinct,
relevant customer niches that the company could target.

COMPANY INFORMATION
Company name: ${companyName}
Application name: ${application.name || "Not provided"}
Domain: ${domain}

ADDITIONAL BUSINESS INFORMATION
${businessContext || "No additional business information provided."}

REQUIREMENTS
1. Return exactly 10 customer niches.
2. Make each niche relevant to the company's product,
   service, industry, and likely customers.
3. Prefer useful, actionable market segments.
4. Avoid repeating the same niche with slightly different wording.
5. Do not invent company facts.
6. Give each niche a positive numeric buying-intention weight.
7. The weights do not need to total 100; the application
   will normalize them.
8. Return valid JSON only. Do not include Markdown fences.

REQUIRED JSON FORMAT
{
  "niches": [
    {
      "niche_name": "A specific customer segment",
      "buying_intention": 10
    }
  ]
}
`.trim();
}

async function generateNiches(
  application,
  businessContext,
  env
) {
  const prompt = buildNichePrompt(
    application,
    businessContext
  );

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
          content:
            "You generate accurate, relevant customer niches and return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: {
        type: "json_object",
      },
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sarvam API failed with status ${response.status}: ` +
      responseText.slice(0, 3000)
    );
  }

  let responseData;

  try {
    responseData = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Sarvam returned an invalid API response: " +
      responseText.slice(0, 2000)
    );
  }

  const content =
    responseData?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Sarvam returned no message content."
    );
  }

  let parsed;

  if (typeof content === "string") {
    let cleanContent = content.trim();

    // Remove optional Markdown JSON fences.
    cleanContent = cleanContent
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      throw new Error(
        "Could not parse Sarvam's niche JSON: " +
        cleanContent.slice(0, 2000)
      );
    }
  } else if (typeof content === "object") {
    parsed = content;
  } else {
    throw new Error(
      "Sarvam returned an unsupported message format."
    );
  }

  const rawNiches = Array.isArray(parsed)
    ? parsed
    : parsed.niches;

  if (!Array.isArray(rawNiches)) {
    throw new Error(
      "Sarvam response does not contain a niches array."
    );
  }

  // Clean names and remove duplicate names.
  const uniqueNiches = [];
  const seenNames = new Set();

  for (const item of rawNiches) {
    const name = String(
      item?.niche_name ||
      item?.name ||
      item?.niche ||
      ""
    ).trim();

    if (!name) {
      continue;
    }

    const normalizedName = name.toLowerCase();

    if (seenNames.has(normalizedName)) {
      continue;
    }

    seenNames.add(normalizedName);

    const score = Number(
      item?.buying_intention ??
      item?.score ??
      1
    );

    uniqueNiches.push({
      niche_name: name,
      buying_intention:
        Number.isFinite(score) && score > 0
          ? score
          : 1,
    });
  }

  if (uniqueNiches.length !== 10) {
    throw new Error(
      `Sarvam returned ${uniqueNiches.length} unique valid niches; exactly 10 are required.`
    );
  }

  return normalizeBuyingIntent(uniqueNiches);
}

// ============================================================
// NORMALIZE BUYING INTENTION TO EXACTLY 100
// ============================================================

function normalizeBuyingIntent(niches) {
  if (!Array.isArray(niches) || niches.length !== 10) {
    throw new Error(
      "Buying-intention normalization requires exactly 10 niches."
    );
  }

  const weights = niches.map((niche) => {
    const score = Number(niche.buying_intention);

    return Number.isFinite(score) && score > 0
      ? score
      : 1;
  });

  const totalWeight = weights.reduce(
    (sum, score) => sum + score,
    0
  );

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error(
      "Buying-intention weights are invalid."
    );
  }

  // Reserve one point for each niche, guaranteeing positive
  // integer scores. Distribute the remaining 90 points
  // proportionally using the largest-remainder method.
  const distributablePoints = 90;

  const allocations = weights.map((weight, index) => {
    const exact =
      (weight / totalWeight) * distributablePoints;

    const floor = Math.floor(exact);

    return {
      index,
      floor,
      remainder: exact - floor,
    };
  });

  let allocated = allocations.reduce(
    (sum, item) => sum + item.floor,
    0
  );

  allocations.sort(
    (a, b) => b.remainder - a.remainder
  );

  let index = 0;

  while (allocated < distributablePoints) {
    allocations[index].floor += 1;
    allocated += 1;
    index += 1;
  }

  const normalizedScores = new Array(10);

  for (const allocation of allocations) {
    normalizedScores[allocation.index] =
      allocation.floor + 1;
  }

  const normalized = niches.map((niche, i) => ({
    niche_name: niche.niche_name,
    buying_intention: normalizedScores[i],
  }));

  const finalTotal = normalized.reduce(
    (sum, niche) => sum + niche.buying_intention,
    0
  );

  if (
    finalTotal !== 100 ||
    normalized.some(
      (niche) => niche.buying_intention < 1
    )
  ) {
    throw new Error(
      "Buying-intention normalization failed validation."
    );
  }

  return normalized;
}

// ============================================================
// CUSTOMER NICHE DATABASE HELPERS
// ============================================================

async function getExistingNiches(
  applicationId,
  env
) {
  const query = new URLSearchParams({
    select:
      "id,application_id,niche_name,buying_intention,reddit_status,created_at,updated_at,user_id,apollo_status",
    application_id: `eq.${applicationId}`,
    order: "buying_intention.desc",
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`
  );

  return Array.isArray(rows) ? rows : [];
}

async function deleteExistingNiches(
  applicationId,
  env
) {
  const query = new URLSearchParams({
    application_id: `eq.${applicationId}`,
  });

  await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
      },
    }
  );
}

async function saveNiches(
  application,
  niches,
  env
) {
  if (niches.length !== 10) {
    throw new Error(
      `Refusing to save ${niches.length} niches; exactly 10 are required.`
    );
  }

  const rows = niches.map((niche) => ({
    application_id: application.id,
    user_id: application.user_id || null,
    niche_name: niche.niche_name,
    buying_intention: niche.buying_intention,
    reddit_status: "pending",
    apollo_status: "pending",
  }));

  const savedRows = await supabaseRequest(
    env,
    "customer_niches",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(rows),
    }
  );

  if (!Array.isArray(savedRows) || savedRows.length !== 10) {
    throw new Error(
      `Expected 10 saved customer niches but received ${
        Array.isArray(savedRows) ? savedRows.length : 0
      }.`
    );
  }

  const total = savedRows.reduce(
    (sum, niche) =>
      sum + Number(niche.buying_intention || 0),
    0
  );

  if (total !== 100) {
    throw new Error(
      `Saved buying-intention total is ${total}, not 100.`
    );
  }

  return savedRows;
}

// ============================================================
// MAIN NICHE DISCOVERY FLOW
// ============================================================

async function processApplication(
  applicationId,
  env
) {
  let plannerTaskId = null;

  try {
    console.log(
      "Starting niche discovery for application:",
      applicationId
    );

    // 1. Load the application.
    const application = await getApplication(
      applicationId,
      env
    );

    // 2. Create or reuse the initial planner task.
    // Its status is Completed immediately, as requested.
    const plannerTask = await ensurePlannerTask(
      application,
      env
    );

    plannerTaskId = plannerTask.id;

    // 3. Mark the application as processing.
    await updateApplicationPlannerStatus(
      application.id,
      "processing",
      env
    );

    // 4. Check whether all 10 niches already exist.
    const existingNiches = await getExistingNiches(
      application.id,
      env
    );

    if (existingNiches.length === 10) {
      const existingTotal = existingNiches.reduce(
        (sum, niche) =>
          sum + Number(niche.buying_intention || 0),
        0
      );

      if (existingTotal !== 100) {
        throw new Error(
          `Existing niches total ${existingTotal}; expected 100.`
        );
      }

      await updateApplicationPlannerStatus(
        application.id,
        "completed",
        env
      );

      return {
        success: true,
        message:
          "Customer niches already exist; no duplicate niches were created.",
        application_id: application.id,
        planner_task_id: plannerTaskId,
        planner_task_status: plannerTask.status,
        niche_count: 10,
        buying_intention_total: 100,
        niches: existingNiches,
      };
    }

    // 5. Get optional scraped business information.
    const businessContext = await getBusinessData(
      application.id,
      env
    );

    // 6. Generate exactly 10 unique niches with Sarvam.
    const generatedNiches = await generateNiches(
      application,
      businessContext,
      env
    );

    // 7. If an incomplete set exists, replace it with a
    // complete set so the application ends with 10 niches.
    if (existingNiches.length > 0) {
      console.warn(
        `Found ${existingNiches.length} existing niches. Replacing the incomplete set.`
      );

      await deleteExistingNiches(
        application.id,
        env
      );
    }

    // 8. Save all 10 niches.
    const savedNiches = await saveNiches(
      application,
      generatedNiches,
      env
    );

    // 9. Mark the application as completed.
    await updateApplicationPlannerStatus(
      application.id,
      "completed",
      env
    );

    // 10. Clear any previous error after successful completion.
    await updatePlannerTaskError(
      plannerTaskId,
      null,
      env
    );

    console.log(
      "Niche discovery completed:",
      {
        applicationId: application.id,
        plannerTaskId,
        nicheCount: savedNiches.length,
        buyingIntentionTotal: 100,
      }
    );

    return {
      success: true,
      message: "Customer niche discovery completed",
      application_id: application.id,
      planner_task_id: plannerTaskId,
      planner_task_status: plannerTask.status,
      niche_count: savedNiches.length,
      buying_intention_total: 100,
      niches: savedNiches,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    console.error(
      "Customer niche discovery failed:",
      {
        applicationId,
        plannerTaskId,
        error: errorMessage,
      }
    );

    // IMPORTANT:
    // Save the actual failure in planner_runs.error.
    // Do not replace the original error if this update fails.
    if (plannerTaskId) {
      try {
        await updatePlannerTaskError(
          plannerTaskId,
          errorMessage,
          env
        );
      } catch (saveError) {
        console.error(
          "CRITICAL: Could not save the error in planner_runs.error:",
          {
            plannerTaskId,
            originalError: errorMessage,
            saveError: getErrorMessage(saveError),
          }
        );
      }
    } else {
      console.error(
        "No planner task ID is available; the error cannot be attached to a planner_runs row.",
        errorMessage
      );
    }

    // Mark the application as failed.
    try {
      await updateApplicationPlannerStatus(
        applicationId,
        "failed",
        env
      );
    } catch (statusError) {
      console.error(
        "Could not update applications.planner_status:",
        getErrorMessage(statusError)
      );
    }

    // Return the original failure to the caller.
    throw new Error(errorMessage);
  }
            }
