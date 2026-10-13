/**
 * ============================================================
 * REPORTLI AI — CUSTOMER NICHE PLANNER
 * Version 1.0
 * ============================================================
 *
 * EXISTING TABLES ONLY:
 *   applications
 *   customer_niches
 *   planner_runs
 *   user_integrations
 *   users
 *
 * SECRETS:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SARVAM_API_KEY
 *
 * NO PLANNER_SECRET.
 * NO SQL MIGRATIONS.
 * NO NEW DATABASE TABLES.
 * NO CRON REQUIRED FOR THIS WORKER.
 *
 * TRIGGER:
 *   Supabase applications INSERT webhook
 *
 * PURPOSE:
 *   Select the latest pending application, generate 10
 *   customer niches using Sarvam AI, and save the results.
 *
 * Reddit and Apollo task scheduling is handled by your
 * existing worker.
 * ============================================================
 */

const VERSION = "1.0.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const EXPECTED_NICHES = 10;

const MAX_COMPANY_CONTEXT_CHARS = 12000;


// ============================================================
// MAIN ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return json({
          ok: true,
          worker: "reportli-customer-niche-planner",
          version: VERSION,
          timestamp: new Date().toISOString()
        });
      }

      if (
        request.method !== "POST" ||
        url.pathname !== "/webhook"
      ) {
        return json(
          {
            ok: false,
            error: "Use POST /webhook or GET /health"
          },
          404
        );
      }

      return await handleWebhook(request, env);

    } catch (error) {
      console.error("Planner error:", error);

      return json(
        {
          ok: false,
          error: error.message || "Internal server error"
        },
        500
      );
    }
  }
};


// ============================================================
// HANDLE APPLICATION WEBHOOK
// ============================================================

async function handleWebhook(request, env) {
  /*
   * Read the webhook body to validate that this is an
   * application INSERT event.
   *
   * IMPORTANT:
   * We intentionally select the latest pending application
   * from the database instead of blindly processing the
   * application contained in the webhook.
   */

  const body = await request.json();

  const eventType = String(
    body.type ||
    body.event ||
    ""
  ).toUpperCase();

  if (
    eventType &&
    !eventType.includes("INSERT")
  ) {
    return json({
      ok: true,
      skipped: true,
      reason: "This is not an INSERT event"
    });
  }

  const record = body.record || body.application || body;

  if (!record || !record.id) {
    return json(
      {
        ok: false,
        error: "Webhook does not contain an application record"
      },
      400
    );
  }

  console.log(
    "Application webhook received:",
    record.id
  );

  /*
   * Only process the latest pending application.
   */

  const app = await getLatestPendingApplication(env);

  if (!app) {
    return json({
      ok: true,
      processed: false,
      message: "No pending applications found"
    });
  }

  /*
   * Atomically attempt to claim the application by changing
   * planner_status from pending to processing.
   *
   * Only one concurrent request should successfully change
   * the row from pending to processing.
   */

  const claimed = await claimApplication(
    env,
    app.id
  );

  if (!claimed) {
    return json({
      ok: true,
      processed: false,
      message: "Application was already claimed",
      application_id: app.id
    });
  }

  try {
    const result = await processApplication(
      env,
      claimed
    );

    return json({
      ok: true,
      ...result
    });

  } catch (error) {
    console.error(
      "Application processing failed:",
      app.id,
      error
    );

    /*
     * Mark the application as failed so it is not repeatedly
     * selected as pending without an explicit retry.
     *
     * Change this back to pending manually if you want to retry
     * the same application.
     */

    try {
      await updateApplicationStatus(
        env,
        app.id,
        "failed"
      );
    } catch (statusError) {
      console.error(
        "Could not update failure status:",
        statusError
      );
    }

    return json(
      {
        ok: false,
        application_id: app.id,
        error: error.message
      },
      500
    );
  }
}


// ============================================================
// GET THE LATEST PENDING APPLICATION
// ============================================================

async function getLatestPendingApplication(env) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?select=*" +
      "&planner_status=eq.pending" +
      "&order=created_at.desc" +
      "&limit=1",
    {
      method: "GET"
    }
  );

  return rows.length ? rows[0] : null;
}


// ============================================================
// CLAIM APPLICATION
// ============================================================

async function claimApplication(env, applicationId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?id=eq." +
      encodeURIComponent(applicationId) +
      "&planner_status=eq.pending",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        planner_status: "processing"
      })
    }
  );

  /*
   * An empty response means another request may already
   * have claimed this application.
   */

  return rows.length ? rows[0] : null;
}


// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(env, app) {
  const applicationId = String(app.id);

  console.log(
    "Processing latest pending application:",
    applicationId
  );

  // ----------------------------------------------------------
  // STEP 1: Check whether niches already exist.
  // ----------------------------------------------------------

  const existingNiches = await getNiches(
    env,
    applicationId
  );

  if (existingNiches.length >= EXPECTED_NICHES) {
    const completedAt = new Date().toISOString();

    await createCompletionRecord(
      env,
      app,
      completedAt,
      "Existing niches were already present"
    );

    await updateApplicationStatus(
      env,
      applicationId,
      "completed"
    );

    return {
      message: "Existing customer niches found",
      application_id: applicationId,
      niches_found: existingNiches.length,
      planner_status: "completed"
    };
  }

  // ----------------------------------------------------------
  // STEP 2: Build company context.
  // ----------------------------------------------------------

  const companyContext = buildCompanyContext(app);

  // ----------------------------------------------------------
  // STEP 3: Call Sarvam AI.
  //
  // SARVAM_API_KEY is used only for niche generation.
  // ----------------------------------------------------------

  const generated = await generateCustomerNiches(
    env,
    companyContext
  );

  // ----------------------------------------------------------
  // STEP 4: Validate the generated niches.
  // ----------------------------------------------------------

  const validatedNiches = validateNiches(generated);

  // ----------------------------------------------------------
  // STEP 5: Save the niches.
  //
  // Preserve existing niches if this is a retry after a
  // partially completed save.
  // ----------------------------------------------------------

  const savedNiches = await saveNiches(
    env,
    app,
    validatedNiches
  );

  if (savedNiches.length < EXPECTED_NICHES) {
    throw new Error(
      "Could not save all 10 unique customer niches. " +
      "Saved or found: " + savedNiches.length
    );
  }

  // ----------------------------------------------------------
  // STEP 6: Record completion time.
  //
  // The completion record uses the existing planner_runs
  // table. The task remains plain text, not JSON.
  // ----------------------------------------------------------

  const completedAt = new Date().toISOString();

  await createCompletionRecord(
    env,
    app,
    completedAt,
    "Sarvam AI generated and saved 10 customer niches"
  );

  // ----------------------------------------------------------
  // STEP 7: Mark the application completed.
  // ----------------------------------------------------------

  await updateApplicationStatus(
    env,
    applicationId,
    "completed"
  );

  console.log(
    "Customer niche generation completed:",
    applicationId
  );

  return {
    message: "Customer niches generated successfully",
    application_id: applicationId,
    company: app.name || app.company || app.domain || null,
    niches_saved: savedNiches.length,
    planner_status: "completed",
    analysis_completed_at: completedAt
  };
}


// ============================================================
// BUILD COMPANY CONTEXT
// ============================================================

function buildCompanyContext(app) {
  const context = {
    application_id: app.id,
    company_name: app.company || app.name || "",
    application_name: app.name || "",
    domain: app.domain || "",
    application_status: app.status || ""
  };

  return JSON.stringify(context).slice(
    0,
    MAX_COMPANY_CONTEXT_CHARS
  );
}


// ============================================================
// GENERATE CUSTOMER NICHES USING SARVAM AI
// ============================================================

async function generateCustomerNiches(env, companyContext) {
  if (!env.SARVAM_API_KEY) {
    throw new Error(
      "Missing SARVAM_API_KEY Cloudflare secret"
    );
  }

  const systemPrompt = `
You are a B2B market research strategist.

Your task is to identify exactly 10 distinct and useful
customer niches for the company described by the user.

Rules:
1. Return exactly 10 unique niches.
2. Each niche must be a specific, identifiable customer segment.
3. Prefer segments likely to need or buy the company's product.
4. Do not invent company facts.
5. Avoid duplicate or nearly identical niches.
6. buying_intention must be an integer from 1 to 10.
7. Higher buying_intention means stronger expected purchase intent.
8. Return valid JSON only.
9. Do not include markdown fences or commentary.

Required JSON shape:
{
  "niches": [
    {
      "niche_name": "Specific customer segment",
      "buying_intention": 8
    }
  ]
}
`.trim();

  const userPrompt = `
Identify 10 customer niches for this company.

Company context:
${companyContext}

Return exactly 10 distinct niches in the required JSON format.
`.trim();

  const response = await fetch(
    SARVAM_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": env.SARVAM_API_KEY
      },
      body: JSON.stringify({
        model: SARVAM_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ],
        temperature: 0.2,
        max_tokens: 4096,
        response_format: {
          type: "json_object"
        }
      })
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      "Sarvam API error:",
      response.status,
      responseText
    );

    throw new Error(
      "Sarvam API returned HTTP " + response.status
    );
  }

  let responseBody;

  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Sarvam returned an invalid API response"
    );
  }

  const content =
    responseBody.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Sarvam response did not contain message content"
    );
  }

  let parsed;

  try {
    parsed = typeof content === "string"
      ? JSON.parse(content)
      : content;
  } catch {
    throw new Error(
      "Sarvam did not return valid niche JSON"
    );
  }

  if (!parsed || !Array.isArray(parsed.niches)) {
    throw new Error(
      "Sarvam response is missing the niches array"
    );
  }

  return parsed.niches;
}


// ============================================================
// VALIDATE NICHES
// ============================================================

function validateNiches(niches) {
  const unique = new Map();

  for (const item of niches) {
    if (!item || typeof item.niche_name !== "string") {
      continue;
    }

    const name = item.niche_name.trim();

    if (!name) {
      continue;
    }

    const score = Number(item.buying_intention);

    if (
      !Number.isInteger(score) ||
      score < 1 ||
      score > 10
    ) {
      continue;
    }

    const key = name.toLowerCase();

    if (!unique.has(key)) {
      unique.set(key, {
        niche_name: name,
        buying_intention: score
      });
    }
  }

  const result = Array.from(unique.values());

  if (result.length !== EXPECTED_NICHES) {
    throw new Error(
      "Sarvam must return exactly 10 unique, valid niches. " +
      "Received " + result.length + "."
    );
  }

  return result;
}


// ============================================================
// GET EXISTING NICHES
// ============================================================

async function getNiches(env, applicationId) {
  return await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?select=*" +
      "&application_id=eq." +
      encodeURIComponent(applicationId) +
      "&order=created_at.asc",
    {
      method: "GET"
    }
  );
}


// ============================================================
// SAVE CUSTOMER NICHES
// ============================================================

async function saveNiches(env, app, generatedNiches) {
  const applicationId = String(app.id);

  const existing = await getNiches(
    env,
    applicationId
  );

  const existingNames = new Set(
    existing.map(item =>
      String(item.niche_name || "")
        .trim()
        .toLowerCase()
    )
  );

  const saved = [...existing];

  for (const niche of generatedNiches) {
    if (saved.length >= EXPECTED_NICHES) {
      break;
    }

    const key = niche.niche_name.toLowerCase();

    if (existingNames.has(key)) {
      continue;
    }

    const payload = {
      application_id: applicationId,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention,
      reddit_status: "pending",
      apollo_status: "pending",
      is_active: true,
      user_id: app.user_id || null
    };

    const rows = await supabaseRequest(
      env,
      "/rest/v1/customer_niches",
      {
        method: "POST",
        headers: {
          "Prefer": "return=representation"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!rows.length) {
      throw new Error(
        "Supabase did not return the inserted niche: " +
        niche.niche_name
      );
    }

    saved.push(rows[0]);
    existingNames.add(key);
  }

  return saved;
}


// ============================================================
// CREATE ANALYSIS COMPLETION RECORD
// ============================================================

async function createCompletionRecord(
  env,
  app,
  completedAt,
  details
) {
  /*
   * Store the analysis completion time in a plain-text task.
   *
   * This is a completed marker, not an execution task.
   * pending_count = 0 prevents the execution worker from
   * treating it as a pending task.
   */

  const taskText =
    "Customer niche analysis completed for " +
    String(app.company || app.name || app.domain || app.id) +
    ".\n" +
    "RESULT: " + details + "\n" +
    "COMPLETED AT: " + completedAt;

  /*
   * Avoid creating a second completion marker when a webhook
   * is delivered more than once.
   */

  const existing = await supabaseRequest(
    env,
    "/rest/v1/planner_runs" +
      "?select=id" +
      "&application_id=eq." +
      encodeURIComponent(String(app.id)) +
      "&worker_type=eq.planner" +
      "&source=eq.system" +
      "&task=ilike." +
      encodeURIComponent(
        "Customer niche analysis completed for%"
      ) +
      "&limit=1",
    {
      method: "GET"
    }
  );

  if (existing.length) {
    return existing[0];
  }

  const rows = await supabaseRequest(
    env,
    "/rest/v1/planner_runs",
    {
      method: "POST",
      headers: {
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        application_id: String(app.id),
        user_id: app.user_id || null,
        worker_type: "planner",
        source: "system",
        task: taskText,
        pending_count: 0,
        error: null,
        niche: null
      })
    }
  );

  if (!rows.length) {
    throw new Error(
      "Could not create analysis completion record"
    );
  }

  return rows[0];
}


// ============================================================
// UPDATE APPLICATION PLANNER STATUS
// ============================================================

async function updateApplicationStatus(
  env,
  applicationId,
  plannerStatus
) {
  return await supabaseRequest(
    env,
    "/rest/v1/applications?id=eq." +
      encodeURIComponent(String(applicationId)),
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        planner_status: plannerStatus
      })
    }
  );
}


// ============================================================
// SUPABASE REST CLIENT
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL) {
    throw new Error(
      "Missing SUPABASE_URL Cloudflare secret"
    );
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY Cloudflare secret"
    );
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const headers = new Headers(
    options.headers || {}
  );

  headers.set(
    "apikey",
    env.SUPABASE_SERVICE_ROLE_KEY
  );

  headers.set(
    "Authorization",
    "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (options.body !== undefined) {
    headers.set(
      "Content-Type",
      "application/json"
    );
  }

  const response = await fetch(
    baseUrl + path,
    {
      ...options,
      headers
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase API error:",
      response.status,
      text
    );

    throw new Error(
      "Supabase returned HTTP " + response.status
    );
  }

  if (!text) {
    return [];
  }

  return JSON.parse(text);
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
