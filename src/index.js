// ============================================================
// REPORTLI AI PLANNER WORKER
// Version: 2.0
//
// Main workflow:
// 1. Receive Supabase webhook
// 2. Find newest application with planner_status = pending
// 3. Atomically claim it by changing pending -> working
// 4. Analyze company using Sarvam AI
// 5. Save company analysis to business_data
// 6. Generate and save 10 customer niches
// 7. Change planner_status -> completed
// 8. On error, change planner_status -> failed
//
// Scheduled workflow:
// Every 30 minutes, create Reddit research tasks for niches
// that do not have a recent research task.
// ============================================================


// ============================================================
// SECTION 1: MAIN ENTRY POINT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    try {
      const url = new URL(request.url);

      // ------------------------------------------------------
      // HEALTH CHECK
      // ------------------------------------------------------

      if (request.method === "GET") {
        return jsonResponse({
          success: true,
          worker: "reportli-ai-planner",
          version: "2.0",
          message: "Worker is running",
          timestamp: new Date().toISOString()
        });
      }

      // ------------------------------------------------------
      // POST ONLY
      // ------------------------------------------------------

      if (request.method !== "POST") {
        return jsonResponse({
          success: false,
          error: "Method not allowed"
        }, 405);
      }

      // ------------------------------------------------------
      // OPTIONAL WEBHOOK SECRET
      //
      // Configure WEBHOOK_SECRET in Cloudflare secrets if
      // you want the Worker to verify incoming webhook calls.
      //
      // Configure the Supabase webhook to send:
      // x-webhook-secret: YOUR_SECRET
      // ------------------------------------------------------

      if (env.WEBHOOK_SECRET) {
        const suppliedSecret = request.headers.get(
          "x-webhook-secret"
        );

        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          console.warn("Unauthorized webhook request", {
            requestId
          });

          return jsonResponse({
            success: false,
            error: "Unauthorized"
          }, 401);
        }
      }

      // ------------------------------------------------------
      // READ REQUEST BODY
      //
      // We don't depend on body.table, body.record, or
      // body.record.id for normal webhook processing.
      // Any valid JSON POST can trigger pending processing.
      // ------------------------------------------------------

      let body = {};

      const rawBody = await request.text();

      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return jsonResponse({
            success: false,
            request_id: requestId,
            error: "Request body must be valid JSON"
          }, 400);
        }
      }

      console.log("Incoming request", {
        requestId,
        userAgent: request.headers.get("user-agent"),
        manualTest: body.test_analysis === true,
        supabaseTest: body.test_supabase === true
      });

      // ------------------------------------------------------
      // MANUAL SUPABASE CONNECTION TEST
      //
      // POST:
      // { "test_supabase": true }
      // ------------------------------------------------------

      if (body.test_supabase === true) {
        const result = await testSupabase(env);

        return jsonResponse({
          success: true,
          request_id: requestId,
          ...result
        });
      }

      // ------------------------------------------------------
      // MANUAL ANALYSIS TEST
      //
      // POST:
      // {
      //   "test_analysis": true,
      //   "application_id": "YOUR_APPLICATION_ID"
      // }
      //
      // The application must be pending. It is claimed using
      // the same conditional update as normal processing.
      // ------------------------------------------------------

      if (body.test_analysis === true) {
        if (!body.application_id) {
          return jsonResponse({
            success: false,
            error: "application_id is required"
          }, 400);
        }

        const result = await processSpecificPendingApplication(
          String(body.application_id),
          env,
          requestId,
          "manual_test"
        );

        return jsonResponse(result, result.success ? 200 : 500);
      }

      // ------------------------------------------------------
      // NORMAL WEBHOOK
      //
      // The webhook body is only a signal to check the queue.
      // The Worker independently finds the newest pending row.
      // ------------------------------------------------------

      const result = await processNextPendingApplication(
        env,
        requestId
      );

      return jsonResponse(result, result.success ? 200 : 500);

    } catch (error) {
      console.error("Worker request failed", {
        message: error.message,
        stack: error.stack
      });

      return jsonResponse({
        success: false,
        error: error.message || "Internal server error"
      }, 500);
    }
  },


  // ==========================================================
  // SECTION 2: SCHEDULED TASK
  //
  // Runs according to the cron in wrangler.toml.
  // ==========================================================

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduledResearchPlanner(env).catch(error => {
        console.error("Scheduled planner failed", {
          message: error.message,
          stack: error.stack
        });
      })
    );
  }
};


// ============================================================
// SECTION 3: JSON RESPONSE HELPER
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}


// ============================================================
// SECTION 4: SUPABASE REST API HELPER
// ============================================================

function getSupabaseConfig(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL secret");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY secret");
  }

  return {
    url: env.SUPABASE_URL.replace(/\/+$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY
  };
}


async function supabaseRequest(env, path, options = {}) {
  const config = getSupabaseConfig(env);

  const response = await fetch(
    `${config.url}/rest/v1/${path}`,
    {
      method: options.method || "GET",

      headers: {
        "apikey": config.key,
        "Authorization": `Bearer ${config.key}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(options.prefer
          ? { "Prefer": options.prefer }
          : {}),
        ...(options.headers || {})
      },

      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {})
    }
  );

  const responseText = await response.text();

  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  if (!response.ok) {
    console.error("Supabase API error", {
      path,
      status: response.status,
      response: data
    });

    throw new Error(
      `Supabase API error ${response.status}: ` +
      `${typeof data === "string"
        ? data
        : JSON.stringify(data)}`
    );
  }

  return data;
}


// ============================================================
// SECTION 5: SUPABASE CONNECTION TEST
// ============================================================

async function testSupabase(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,name,planner_status&limit=1"
  );

  return {
    message: "Supabase connection successful",
    rows_returned: Array.isArray(rows) ? rows.length : 0
  };
}


// ============================================================
// SECTION 6: FIND THE NEWEST PENDING APPLICATION
// ============================================================

async function getNewestPendingApplication(env) {
  const query = new URLSearchParams({
    select: [
      "id",
      "name",
      "api_key",
      "status",
      "user_id",
      "created_at",
      "domain",
      "company",
      "planner_status"
    ].join(","),

    planner_status: "eq.pending",

    // Newest created_at first.
    // Rows with null created_at are placed last.
    order: "created_at.desc.nullslast,id.desc",

    limit: "1"
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}


// ============================================================
// SECTION 7: ATOMIC APPLICATION CLAIM
//
// This is the important concurrency fix.
//
// The Worker first reads the newest pending row.
// It then updates the row only if planner_status is STILL
// pending.
//
// The database update acts as a compare-and-set operation.
// Only one competing request can successfully claim the row.
//
// A claim is successful only when Supabase returns the
// updated row.
// ============================================================

async function claimApplication(applicationId, env) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,
    planner_status: "eq.pending",
    select: "id,name,api_key,status,user_id,created_at,domain,company,planner_status"
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`,
    {
      method: "PATCH",

      body: {
        planner_status: "working"
      },

      prefer: "return=representation"
    }
  );

  if (!Array.isArray(rows) || rows.length !== 1) {
    return null;
  }

  return rows[0];
}


// ============================================================
// SECTION 8: PROCESS NEXT PENDING APPLICATION
//
// If another webhook has already claimed the newest row,
// retry and look for the next pending row.
//
// A small retry limit avoids an endless loop if requests
// arrive simultaneously.
// ============================================================

async function processNextPendingApplication(env, requestId) {
  const MAX_CLAIM_ATTEMPTS = 5;

  for (
    let attempt = 1;
    attempt <= MAX_CLAIM_ATTEMPTS;
    attempt++
  ) {
    const application =
      await getNewestPendingApplication(env);

    if (!application) {
      console.log("No pending applications", {
        requestId
      });

      return {
        success: true,
        request_id: requestId,
        message: "No pending applications",
        processed: false
      };
    }

    console.log("Attempting to claim application", {
      requestId,
      applicationId: application.id,
      attempt
    });

    const claimed = await claimApplication(
      application.id,
      env
    );

    if (!claimed) {
      console.log("Application was claimed by another request", {
        requestId,
        applicationId: application.id
      });

      continue;
    }

    return await processClaimedApplication(
      claimed,
      env,
      requestId,
      "webhook"
    );
  }

  return {
    success: true,
    request_id: requestId,
    message:
      "No application claimed after retries. " +
      "Another request may be processing pending applications.",
    processed: false
  };
}


// ============================================================
// SECTION 9: MANUAL TEST — CLAIM A SPECIFIC PENDING ROW
// ============================================================

async function processSpecificPendingApplication(
  applicationId,
  env,
  requestId,
  source
) {
  const claimed = await claimApplication(
    applicationId,
    env
  );

  if (!claimed) {
    return {
      success: false,
      request_id: requestId,
      application_id: applicationId,
      error:
        "Application was not claimed. It may not exist, " +
        "may not be pending, or may already be processing."
    };
  }

  return await processClaimedApplication(
    claimed,
    env,
    requestId,
    source
  );
}


// ============================================================
// SECTION 10: PROCESS THE CLAIMED APPLICATION
// ============================================================

async function processClaimedApplication(
  application,
  env,
  requestId,
  source
) {
  const applicationId = application.id;

  let plannerRunId = null;

  console.log("Application claimed", {
    requestId,
    applicationId,
    name: application.name,
    source
  });

  try {
    // --------------------------------------------------------
    // Create a planner_runs record
    // --------------------------------------------------------

    const runRows = await supabaseRequest(
      env,
      "planner_runs?select=id",
      {
        method: "POST",

        body: {
          application_id: applicationId,
          user_id: application.user_id || null,
          worker_type: "company_planner",
          source,
          task:
            "Analyze company, generate customer niches, " +
            "and save results",
          pending_count: 10,
          error: null,
          started_at: new Date().toISOString()
        },

        prefer: "return=representation"
      }
    );

    if (
      Array.isArray(runRows) &&
      runRows.length > 0
    ) {
      plannerRunId = runRows[0].id;
    }

    // --------------------------------------------------------
    // Step 1: Analyze company
    // --------------------------------------------------------

    const companyAnalysis = await analyzeCompany(
      application,
      env
    );

    console.log("Company analysis completed", {
      requestId,
      applicationId
    });

    // --------------------------------------------------------
    // Step 2: Save company analysis
    // --------------------------------------------------------

    await saveBusinessData(
      applicationId,
      "company_analysis",
      companyAnalysis,
      env
    );

    // --------------------------------------------------------
    // Step 3: Generate customer niches
    // --------------------------------------------------------

    const generatedNiches = await generateCustomerNiches(
      application,
      companyAnalysis,
      env
    );

    console.log("Customer niches generated", {
      requestId,
      applicationId,
      generatedCount: generatedNiches.length
    });

    // --------------------------------------------------------
    // Step 4: Save 10 active niches
    // --------------------------------------------------------

    const savedResult = await saveCustomerNiches(
      application,
      generatedNiches,
      env
    );

    // --------------------------------------------------------
    // Step 5: Verify at least 10 active niches exist
    // --------------------------------------------------------

    const activeNiches = await getActiveNiches(
      applicationId,
      env
    );

    if (activeNiches.length < 10) {
      throw new Error(
        `Only ${activeNiches.length} active niches exist. ` +
        "At least 10 are required."
      );
    }

    // --------------------------------------------------------
    // Step 6: Complete planner run
    // --------------------------------------------------------

    if (plannerRunId) {
      await updatePlannerRun(
        plannerRunId,
        {
          pending_count: 0,
          error: null
        },
        env
      );
    }

    // --------------------------------------------------------
    // Step 7: Mark application completed
    // --------------------------------------------------------

    await updateApplicationStatus(
      applicationId,
      "completed",
      env
    );

    console.log("Application processing completed", {
      requestId,
      applicationId,
      activeNiches: activeNiches.length
    });

    return {
      success: true,
      request_id: requestId,
      application_id: applicationId,
      planner_status: "completed",
      company_analysis_saved: true,
      generated_niches: generatedNiches.length,
      inserted_niches: savedResult.inserted,
      active_niches: activeNiches.length
    };

  } catch (error) {
    console.error("Application processing failed", {
      requestId,
      applicationId,
      message: error.message,
      stack: error.stack
    });

    // --------------------------------------------------------
    // Record the failure in planner_runs
    // --------------------------------------------------------

    if (plannerRunId) {
      try {
        await updatePlannerRun(
          plannerRunId,
          {
            pending_count: 0,
            error: String(error.message || error).slice(0, 5000)
          },
          env
        );
      } catch (logError) {
        console.error(
          "Could not update planner_runs error",
          logError.message
        );
      }
    }

    // --------------------------------------------------------
    // Mark application failed
    // --------------------------------------------------------

    try {
      await updateApplicationStatus(
        applicationId,
        "failed",
        env
      );
    } catch (statusError) {
      console.error(
        "Could not mark application failed",
        statusError.message
      );
    }

    return {
      success: false,
      request_id: requestId,
      application_id: applicationId,
      planner_status: "failed",
      error: error.message || "Processing failed"
    };
  }
}


// ============================================================
// SECTION 11: UPDATE APPLICATION STATUS
// ============================================================

async function updateApplicationStatus(
  applicationId,
  status,
  env
) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,
    select: "id,planner_status"
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`,
    {
      method: "PATCH",

      body: {
        planner_status: status
      },

      prefer: "return=representation"
    }
  );

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(
      `Could not update application ${applicationId} ` +
      `to planner_status=${status}`
    );
  }

  return rows[0];
}


// ============================================================
// SECTION 12: UPDATE PLANNER RUN
// ============================================================

async function updatePlannerRun(
  plannerRunId,
  updates,
  env
) {
  const query = new URLSearchParams({
    id: `eq.${plannerRunId}`,
    select: "id"
  });

  return await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`,
    {
      method: "PATCH",
      body: updates,
      prefer: "return=representation"
    }
  );
}


// ============================================================
// SECTION 13: SARVAM AI REQUEST
// ============================================================

async function callSarvam(
  messages,
  env,
  maxTokens = 4096
) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY secret");
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    90000
  );

  let response;

  try {
    response = await fetch(
      "https://api.sarvam.ai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": env.SARVAM_API_KEY
        },

        body: JSON.stringify({
          model: "sarvam-105b",
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: {
            type: "json_object"
          }
        }),

        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Sarvam returned a non-JSON response: ` +
      responseText.slice(0, 1000)
    );
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam API error ${response.status}: ` +
      JSON.stringify(data).slice(0, 2000)
    );
  }

  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Sarvam returned no message content"
    );
  }

  return parseModelJson(content);
}


// ============================================================
// SECTION 14: PARSE JSON RETURNED BY SARVAM
// ============================================================

function parseModelJson(content) {
  if (typeof content === "object" && content !== null) {
    return content;
  }

  if (typeof content !== "string") {
    throw new Error(
      "Sarvam returned an unsupported content format"
    );
  }

  let cleaned = content.trim();

  // Remove a Markdown JSON code fence if present.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(
      "Could not parse Sarvam JSON: " +
      cleaned.slice(0, 1500)
    );
  }
}


// ============================================================
// SECTION 15: COMPANY ANALYSIS
// ============================================================

async function analyzeCompany(application, env) {
  const name = application.name || "";
  const domain = application.domain || "";
  const company = application.company || "";

  const prompt = `
You are a careful B2B company research analyst.

Analyze the company using ONLY the information supplied below.

Application name: ${name}
Website/domain: ${domain}
Company information: ${company}

Do not invent company facts.
If information is missing, use null or an empty array.
Distinguish supplied facts from reasonable hypotheses.

Return valid JSON with this structure:

{
  "business_name": "string or null",
  "website": "string or null",
  "business_description": "string",
  "industry": "string or null",
  "products_or_services": ["string"],
  "target_customers": ["string"],
  "customer_problems": ["string"],
  "value_proposition": "string",
  "business_model": "string or null",
  "known_facts": ["string"],
  "assumptions": ["string"],
  "missing_information": ["string"]
}

Return JSON only.
`;

  const result = await callSarvam(
    [
      {
        role: "system",
        content:
          "Return accurate structured JSON. " +
          "Never invent factual claims."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    env,
    4096
  );

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    throw new Error(
      "Company analysis is not a JSON object"
    );
  }

  return result;
}


// ============================================================
// SECTION 16: SAVE COMPANY ANALYSIS TO business_data
//
// Requires a unique constraint on:
// (application_id, field)
//
// The upsert updates the existing field instead of creating
// duplicate company_analysis rows.
// ============================================================

async function saveBusinessData(
  applicationId,
  field,
  data,
  env
) {
  const query = new URLSearchParams({
    on_conflict: "application_id,field",
    select: "application_id,field"
  });

  return await supabaseRequest(
    env,
    `business_data?${query.toString()}`,
    {
      method: "POST",

      body: {
        application_id: applicationId,
        field,
        data,
        ai_status: "completed",
        updated_at: new Date().toISOString()
      },

      prefer: "resolution=merge-duplicates,return=representation"
    }
  );
}


// ============================================================
// SECTION 17: GENERATE CUSTOMER NICHES
// ============================================================

async function generateCustomerNiches(
  application,
  companyAnalysis,
  env
) {
  const prompt = `
You are a B2B customer niche research planner.

Use the company analysis below to generate exactly 10
meaningfully different potential customer niches.

Company:
${JSON.stringify(companyAnalysis)}

Application:
${JSON.stringify({
  name: application.name,
  domain: application.domain,
  company: application.company
})}

A niche should be a specific type of customer, not a broad
industry alone.

Prefer niches with:
- A clear business problem
- A plausible need for this company's product or service
- A reachable decision-maker
- A plausible reason to purchase

Do not claim that demand has been verified.
Do not invent real companies or people.
Do not generate duplicate or near-duplicate niches.

Return valid JSON in this exact structure:

{
  "niches": [
    {
      "niche_name": "Specific customer niche",
      "buying_intention": 7
    }
  ]
}

Rules:
- Return exactly 10 niches.
- niche_name must be a non-empty string.
- buying_intention must be an integer from 1 to 10.
- Do not include explanations outside the JSON.
`;

  const result = await callSarvam(
    [
      {
        role: "system",
        content:
          "You create structured customer research plans. " +
          "Return valid JSON only."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    env,
    4096
  );

  if (!Array.isArray(result.niches)) {
    throw new Error(
      "Sarvam response does not contain a niches array"
    );
  }

  const uniqueNiches = [];
  const seen = new Set();

  for (const item of result.niches) {
    if (!item || typeof item.niche_name !== "string") {
      continue;
    }

    const name = item.niche_name.trim();

    if (!name) {
      continue;
    }

    const normalized = normalizeNicheName(name);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    const rawScore = Number(item.buying_intention);

    const score = Number.isFinite(rawScore)
      ? Math.max(1, Math.min(10, Math.round(rawScore)))
      : 5;

    uniqueNiches.push({
      niche_name: name,
      buying_intention: score
    });
  }

  if (uniqueNiches.length < 10) {
    throw new Error(
      `Sarvam returned only ${uniqueNiches.length} ` +
      "unique valid niches; 10 are required"
    );
  }

  return uniqueNiches.slice(0, 10);
}


// ============================================================
// SECTION 18: NORMALIZE NICHE NAMES FOR DUPLICATE CHECKS
// ============================================================

function normalizeNicheName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


// ============================================================
// SECTION 19: GET EXISTING ACTIVE NICHES
// ============================================================

async function getActiveNiches(applicationId, env) {
  const query = new URLSearchParams({
    select:
      "id,application_id,niche_name,buying_intention,niche_status,user_id,created_at",
    application_id: `eq.${applicationId}`,
    niche_status: "eq.active",
    order: "created_at.asc"
  });

  const rows = await supabaseRequest(
    env,
    `customer_niches?${query.toString()}`
  );

  return Array.isArray(rows) ? rows : [];
}


// ============================================================
// SECTION 20: SAVE CUSTOMER NICHES
//
// This preserves existing active niches and adds new unique
// ones until the application has at least 10 active niches.
//
// Assumes the customer_niches columns provided:
// id, application_id, niche_name, buying_intention,
// niche_status, created_at, updated_at, user_id.
// ============================================================

async function saveCustomerNiches(
  application,
  generatedNiches,
  env
) {
  const applicationId = application.id;

  const existing = await getActiveNiches(
    applicationId,
    env
  );

  const existingNames = new Set(
    existing.map(row =>
      normalizeNicheName(row.niche_name)
    )
  );

  const rowsToInsert = [];

  // If fewer than 10 active niches exist, fill the gap.
  const slotsNeeded = Math.max(
    0,
    10 - existing.length
  );

  for (const niche of generatedNiches) {
    if (rowsToInsert.length >= slotsNeeded) {
      break;
    }

    const normalized = normalizeNicheName(
      niche.niche_name
    );

    if (!normalized || existingNames.has(normalized)) {
      continue;
    }

    existingNames.add(normalized);

    rowsToInsert.push({
      application_id: applicationId,
      user_id: application.user_id || null,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention,
      niche_status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  if (rowsToInsert.length > 0) {
    await supabaseRequest(
      env,
      "customer_niches?select=id,niche_name,niche_status",
      {
        method: "POST",
        body: rowsToInsert,
        prefer: "return=representation"
      }
    );
  }

  return {
    existing: existing.length,
    inserted: rowsToInsert.length
  };
}


// ============================================================
// SECTION 21: SCHEDULED RESEARCH PLANNER
//
// Runs every 30 minutes.
//
// For each eligible application:
// 1. Get active customer niches.
// 2. Check whether each niche has a recent Reddit task.
// 3. If not, create a planner_runs task.
//
// A niche will not get another task if it has a Reddit task
// created within the previous 7 days.
// ============================================================

async function runScheduledResearchPlanner(env) {
  console.log("Scheduled research planner started");

  const applications = await getEligibleApplications(env);

  let tasksCreated = 0;

  for (const application of applications) {
    try {
      const niches = await getActiveNiches(
        application.id,
        env
      );

      for (const niche of niches) {
        try {
          const recentTask = await hasRecentRedditTask(
            application.id,
            niche.id,
            env
          );

          if (recentTask) {
            continue;
          }

          await createRedditResearchTask(
            application,
            niche,
            env
          );

          tasksCreated++;

        } catch (error) {
          console.error("Could not schedule niche", {
            applicationId: application.id,
            nicheId: niche.id,
            message: error.message
          });
        }
      }

    } catch (error) {
      console.error("Could not process application for cron", {
        applicationId: application.id,
        message: error.message
      });
    }
  }

  console.log("Scheduled research planner finished", {
    applicationsChecked: applications.length,
    tasksCreated
  });

  return {
    applicationsChecked: applications.length,
    tasksCreated
  };
}


// ============================================================
// SECTION 22: GET APPLICATIONS ELIGIBLE FOR RESEARCH
// ============================================================

async function getEligibleApplications(env) {
  const query = new URLSearchParams({
    select: "id,name,user_id,domain,company,planner_status",

    // Only completed applications should enter research.
    planner_status: "eq.completed",

    order: "created_at.asc",
    limit: "100"
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`
  );

  return Array.isArray(rows) ? rows : [];
}


// ============================================================
// SECTION 23: CHECK FOR RECENT REDDIT TASK
// ============================================================

async function hasRecentRedditTask(
  applicationId,
  nicheId,
  env
) {
  const cutoff = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const query = new URLSearchParams({
    select: "id",
    application_id: `eq.${applicationId}`,
    niche_id: `eq.${nicheId}`,
    worker_type: "eq.reddit_research",
    created_at: `gte.${cutoff}`,
    limit: "1"
  });

  const rows = await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length > 0;
}


// ============================================================
// SECTION 24: CREATE REDDIT RESEARCH TASK
// ============================================================

async function createRedditResearchTask(
  application,
  niche,
  env
) {
  const taskId =
    "research_" +
    Date.now() +
    "_" +
    crypto.randomUUID().slice(0, 8);

  const task = {
    task_id: taskId,
    company_id: application.id,
    application_id: application.id,

    worker: "reddit_research",

    objective:
      "Find customer problems, buying signals, and " +
      "opportunities relevant to this customer niche.",

    target_audience: [
      niche.niche_name
    ],

    problem_categories: [
      "lead_generation",
      "cold_email",
      "customer_acquisition",
      "outreach_personalization",
      "lead_qualification"
    ],

    research_sources: [
      "Reddit"
    ],

    subreddits: [
      "SaaS",
      "Entrepreneur",
      "startups",
      "indiehackers",
      "sales"
    ],

    published_within_days: 7,
    target_new_posts: 20,

    niche_id: niche.id,

    company: {
      name: application.name || null,
      domain: application.domain || null,
      description: application.company || null
    },

    niche: {
      name: niche.niche_name,
      buying_intention: niche.buying_intention
    },

    created_at: new Date().toISOString()
  };

  await supabaseRequest(
    env,
    "planner_runs",
    {
      method: "POST",

      body: {
        application_id: application.id,
        user_id: application.user_id || null,
        worker_type: "reddit_research",
        source: "scheduled_planner",
        task: JSON.stringify(task),
        pending_count: 0,
        error: null,
        niche_id: niche.id
      },

      prefer: "return=representation"
    }
  );

  console.log("Reddit research task created", {
    applicationId: application.id,
    nicheId: niche.id,
    taskId
  });
          }
