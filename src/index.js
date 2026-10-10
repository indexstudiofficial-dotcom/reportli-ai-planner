// ============================================================
// REPORTLI AI PLANNER WORKER
// File: src/index.js
//
// Required Cloudflare secrets:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
// Optional:
// WEBHOOK_SECRET
//
// Supabase tables:
// applications
// customer_niches
// business_data
// planner_runs
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const REQUIRED_NICHES = 10;
const MAX_SARVAM_ATTEMPTS = 2;

// ============================================================
// 1. MAIN WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    try {
      const url = new URL(request.url);

      // Health check
      if (request.method === "GET") {
        return jsonResponse({
          success: true,
          worker: "reportli-ai-planner",
          message: "Worker is running",
          request_id: requestId
        });
      }

      if (request.method !== "POST") {
        return jsonResponse(
          { success: false, error: "Method not allowed" },
          405
        );
      }

      // Optional shared-secret protection.
      // Configure WEBHOOK_SECRET only if the same secret
      // is also sent by your API tester / webhook.
      if (env.WEBHOOK_SECRET) {
        const suppliedSecret =
          request.headers.get("x-webhook-secret");

        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          return jsonResponse(
            {
              success: false,
              error: "Invalid webhook secret",
              request_id: requestId
            },
            401
          );
        }
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            success: false,
            error: "Request body must be valid JSON",
            request_id: requestId
          },
          400
        );
      }

      console.log("REQUEST RECEIVED", JSON.stringify({
        request_id: requestId,
        type: body.type || null,
        table: body.table || null,
        schema: body.schema || null,
        record_id: body.record?.id || null,
        manual_analysis: body.test_analysis === true
      }));

      // ------------------------------------------------------
      // MANUAL TEST: Analyze one application
      // ------------------------------------------------------

      if (body.test_analysis === true) {
        if (!body.application_id) {
          return jsonResponse(
            {
              success: false,
              error: "application_id is required",
              request_id: requestId
            },
            400
          );
        }

        const result = await analyzeApplication(
          body.application_id,
          env,
          requestId
        );

        return jsonResponse(result, result.success ? 200 : 500);
      }

      // ------------------------------------------------------
      // MANUAL TEST: Verify Supabase connection
      // ------------------------------------------------------

      if (body.test_supabase === true) {
        const result = await supabaseRequest(
          env,
          "/rest/v1/applications?select=id&limit=1",
          { method: "GET" }
        );

        return jsonResponse({
          success: true,
          message: "Supabase connection successful",
          rows_returned: result.length,
          request_id: requestId
        });
      }

      // ------------------------------------------------------
      // SUPABASE DATABASE WEBHOOK
      // ------------------------------------------------------

      const isSupabaseWebhook =
        Boolean(body.table) ||
        Boolean(body.record) ||
        Boolean(body.old_record);

      if (isSupabaseWebhook) {
        const result = await handleApplicationWebhook(
          body,
          env,
          requestId
        );

        // Do not silently acknowledge a failed INSERT event.
        return jsonResponse(
          result,
          result.success ? 200 : 500
        );
      }

      return jsonResponse(
        {
          success: false,
          error: "Unrecognized request payload",
          request_id: requestId,
          accepted_requests: [
            "Supabase applications INSERT webhook",
            "Manual test_analysis request",
            "Manual test_supabase request"
          ]
        },
        400
      );

    } catch (error) {
      console.error("UNHANDLED WORKER ERROR", JSON.stringify({
        request_id: requestId,
        error: errorMessage(error),
        stack: error?.stack || null
      }));

      return jsonResponse(
        {
          success: false,
          error: errorMessage(error),
          request_id: requestId
        },
        500
      );
    }
  },

  // ----------------------------------------------------------
  // CRON: Runs every 30 minutes
  // ----------------------------------------------------------

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledPlanner(env));
  }
};


// ============================================================
// 2. HANDLE SUPABASE WEBHOOK
// ============================================================

async function handleApplicationWebhook(body, env, requestId) {
  const table = String(body.table || "");
  const schema = String(body.schema || "");
  const eventType = String(body.type || "").toUpperCase();

  // Supabase Database Webhooks normally provide body.record.
  // body.new is also accepted for compatible webhook formats.
  const record = body.record || body.new || null;

  console.log("WEBHOOK VALIDATION", JSON.stringify({
    request_id: requestId,
    event_type: eventType,
    schema,
    table,
    has_record: Boolean(record),
    record_id: record?.id || null
  }));

  if (table !== "applications") {
    console.log("WEBHOOK IGNORED: unexpected table", table);

    return {
      success: true,
      ignored: true,
      reason: "not_applications_table",
      request_id: requestId
    };
  }

  if (schema && schema !== "public") {
    console.log("WEBHOOK IGNORED: unexpected schema", schema);

    return {
      success: true,
      ignored: true,
      reason: "not_public_schema",
      request_id: requestId
    };
  }

  if (eventType !== "INSERT") {
    console.log("WEBHOOK IGNORED: unexpected event", eventType);

    return {
      success: true,
      ignored: true,
      reason: "not_insert_event",
      request_id: requestId
    };
  }

  if (!record?.id) {
    throw new Error(
      "Supabase applications INSERT webhook is missing record.id"
    );
  }

  console.log("APPLICATION WEBHOOK ACCEPTED", JSON.stringify({
    request_id: requestId,
    application_id: record.id,
    application_name: record.name || null
  }));

  return await analyzeApplication(
    record.id,
    env,
    requestId
  );
}


// ============================================================
// 3. ANALYZE APPLICATION AND DISCOVER NICHES
// ============================================================

async function analyzeApplication(applicationId, env, requestId) {
  let application = null;
  let failureRecorded = false;

  try {
    console.log("FETCHING APPLICATION", JSON.stringify({
      request_id: requestId,
      application_id: applicationId
    }));

    const applications = await supabaseRequest(
      env,
      "/rest/v1/applications" +
        "?id=eq." + encodeURIComponent(applicationId) +
        "&select=id,name,company,domain,user_id,planner_status" +
        "&limit=1",
      { method: "GET" }
    );

    application = applications?.[0];

    if (!application) {
      throw new Error(
        `Application not found in Supabase: ${applicationId}`
      );
    }

    console.log("APPLICATION FOUND", JSON.stringify({
      request_id: requestId,
      application_id: application.id,
      name: application.name,
      company: application.company,
      domain: application.domain,
      planner_status: application.planner_status
    }));

    // If already completed, do not run the initial discovery twice.
    // To test it again, reset planner_status in Supabase first.
    if (application.planner_status === "completed") {
      return {
        success: true,
        skipped: true,
        reason: "application_already_completed",
        application_id: applicationId,
        request_id: requestId
      };
    }

    await updateApplicationStatus(
      env,
      applicationId,
      "analyzing"
    );

    // --------------------------------------------------------
    // Create an initial planner run.
    // pending_count is used; no status column is required.
    // --------------------------------------------------------

    const plannerRunId = await createPlannerRun(
      env,
      application,
      "Discover 10 customer niches for this company",
      REQUIRED_NICHES,
      null
    );

    // --------------------------------------------------------
    // Call Sarvam AI
    // --------------------------------------------------------

    const companyAnalysis = await callSarvamForCompany(
      env,
      application
    );

    console.log("COMPANY ANALYSIS COMPLETED", JSON.stringify({
      request_id: requestId,
      application_id: applicationId
    }));

    // Save company analysis in business_data.
    await saveBusinessData(
      env,
      application,
      "company_analysis",
      companyAnalysis
    );

    // --------------------------------------------------------
    // Discover exactly 10 valid niches.
    // --------------------------------------------------------

    const niches = await discoverCustomerNiches(
      env,
      application,
      companyAnalysis
    );

    if (!Array.isArray(niches) || niches.length !== REQUIRED_NICHES) {
      throw new Error(
        `Expected ${REQUIRED_NICHES} niches; received ${
          Array.isArray(niches) ? niches.length : 0
        }`
      );
    }

    console.log("NICHE DISCOVERY COMPLETED", JSON.stringify({
      request_id: requestId,
      application_id: applicationId,
      niche_count: niches.length,
      niche_names: niches.map(n => n.niche_name)
    }));

    // --------------------------------------------------------
    // Save the niche records.
    // --------------------------------------------------------

    const savedNiches = await saveCustomerNiches(
      env,
      application,
      niches
    );

    // Verify persisted rows from Supabase.
    const verifyRows = await supabaseRequest(
      env,
      "/rest/v1/customer_niches" +
        "?application_id=eq." +
        encodeURIComponent(applicationId) +
        "&select=id,niche_name,buying_intention,niche_status" +
        "&niche_status=eq.active",
      { method: "GET" }
    );

    if (verifyRows.length < REQUIRED_NICHES) {
      throw new Error(
        `Niche verification failed: expected at least ${
          REQUIRED_NICHES
        } active niche rows, but found ${verifyRows.length}`
      );
    }

    // Mark the initial planner run complete only after
    // successfully saving and verifying the niches.
    if (plannerRunId) {
      await updatePlannerRun(
        env,
        plannerRunId,
        {
          pending_count: 0,
          error: null
        }
      );
    }

    await updateApplicationStatus(
      env,
      applicationId,
      "completed"
    );

    console.log("APPLICATION PROCESSING COMPLETED", JSON.stringify({
      request_id: requestId,
      application_id: applicationId,
      saved_niches: savedNiches.length,
      verified_active_niches: verifyRows.length
    }));

    return {
      success: true,
      message: "Company analyzed and customer niches saved",
      request_id: requestId,
      application_id: applicationId,
      saved_niches: savedNiches.length,
      verified_active_niches: verifyRows.length,
      niches: savedNiches
    };

  } catch (error) {
    const message = errorMessage(error);

    console.error("APPLICATION PROCESSING FAILED", JSON.stringify({
      request_id: requestId,
      application_id: applicationId,
      error: message,
      stack: error?.stack || null
    }));

    // Save the error in planner_runs.error.
    // Do not store the error in customer_niches.niche_name:
    // that column should contain a real niche name.
    try {
      await recordPlannerError(
        env,
        applicationId,
        application,
        message
      );

      failureRecorded = true;
    } catch (loggingError) {
      console.error("FAILED TO SAVE PLANNER ERROR", JSON.stringify({
        request_id: requestId,
        application_id: applicationId,
        original_error: message,
        logging_error: errorMessage(loggingError)
      }));
    }

    // Mark the application as failed.
    try {
      await updateApplicationStatus(
        env,
        applicationId,
        "failed"
      );
    } catch (statusError) {
      console.error("FAILED TO UPDATE APPLICATION STATUS", JSON.stringify({
        application_id: applicationId,
        error: errorMessage(statusError)
      }));
    }

    return {
      success: false,
      message: "Company analysis or niche discovery failed",
      request_id: requestId,
      application_id: applicationId,
      error: message,
      error_recorded: failureRecorded
    };
  }
}


// ============================================================
// 4. COMPANY ANALYSIS WITH SARVAM AI
// ============================================================

async function callSarvamForCompany(env, application) {
  const companyName =
    application.company ||
    application.name ||
    "Unknown company";

  const prompt = `
Analyze this company using only the information provided.

Company name: ${companyName}
Application name: ${application.name || ""}
Website/domain: ${application.domain || "Not provided"}

Return valid JSON with these keys:
{
  "company_name": "string",
  "business_summary": "string",
  "products_or_services": ["string"],
  "target_customers": ["string"],
  "problems_solved": ["string"],
  "business_model": "string",
  "potential_customer_types": ["string"],
  "known_information": ["string"],
  "assumptions": ["string"]
}

Rules:
- Do not invent verified company facts.
- If information is missing, say so.
- Mark uncertain conclusions as assumptions.
- Return JSON only.
`;

  const result = await callSarvamJson(env, prompt);

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Sarvam returned invalid company analysis JSON");
  }

  if (!result.company_name || !result.business_summary) {
    throw new Error(
      "Sarvam company analysis is missing company_name or business_summary"
    );
  }

  return result;
}


// ============================================================
// 5. DISCOVER EXACTLY 10 CUSTOMER NICHES
// ============================================================

async function discoverCustomerNiches(env, application, analysis) {
  const prompt = `
You are a B2B customer niche research planner.

Analyze the company and propose exactly 10 distinct customer niches.

COMPANY:
${JSON.stringify({
  name: application.name,
  company: application.company,
  domain: application.domain,
  analysis
})}

Return this exact JSON structure:
{
  "niches": [
    {
      "niche_name": "Specific customer segment",
      "buying_intention": 75
    }
  ]
}

Requirements:
1. Return exactly 10 niches.
2. Every niche_name must be a specific, meaningful customer segment.
3. Each niche_name must be a non-empty string.
4. buying_intention must be an integer from 0 to 100.
5. Do not repeat the same niche using different wording.
6. Prioritize segments that plausibly have the problem this company solves.
7. Do not use generic labels such as "everyone" or "all businesses".
8. Do not include explanations outside the JSON.
9. Do not invent company facts.
10. Do not include IDs, SQL, markdown, or database instructions.
`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SARVAM_ATTEMPTS; attempt++) {
    try {
      console.log("CALLING SARVAM FOR NICHES", JSON.stringify({
        application_id: application.id,
        attempt
      }));

      const result = await callSarvamJson(env, prompt);

      const rawNiches = Array.isArray(result)
        ? result
        : result?.niches;

      if (!Array.isArray(rawNiches)) {
        throw new Error(
          "Sarvam response does not contain a niches array"
        );
      }

      const normalized = rawNiches
        .map(item => {
          const name = String(
            item?.niche_name ||
            item?.name ||
            ""
          ).trim();

          const score = Number(item?.buying_intention);

          if (!name) return null;

          return {
            niche_name: name,
            buying_intention:
              Number.isFinite(score)
                ? Math.max(0, Math.min(100, Math.round(score)))
                : 50
          };
        })
        .filter(Boolean);

      // Remove duplicates, ignoring capitalization and whitespace.
      const unique = [];
      const seen = new Set();

      for (const niche of normalized) {
        const key = niche.niche_name.toLowerCase().replace(/\s+/g, " ");

        if (!seen.has(key)) {
          seen.add(key);
          unique.push(niche);
        }
      }

      if (unique.length !== REQUIRED_NICHES) {
        throw new Error(
          `Sarvam returned ${unique.length} unique valid niches; exactly ${REQUIRED_NICHES} are required`
        );
      }

      return unique;

    } catch (error) {
      lastError = error;

      console.error("NICHE GENERATION ATTEMPT FAILED", JSON.stringify({
        application_id: application.id,
        attempt,
        error: errorMessage(error)
      }));
    }
  }

  throw new Error(
    `Customer niche generation failed after ${MAX_SARVAM_ATTEMPTS} attempts: ${
      errorMessage(lastError)
    }`
  );
}


// ============================================================
// 6. CALL SARVAM AND PARSE JSON SAFELY
// ============================================================

async function callSarvamJson(env, prompt) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing Cloudflare secret: SARVAM_API_KEY");
  }

  const response = await fetch(SARVAM_URL, {
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
          content: "Return valid JSON only. Do not use markdown fences."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 4096
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sarvam API HTTP ${response.status}: ${responseText.slice(0, 2000)}`
    );
  }

  let payload;

  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Sarvam API returned invalid response JSON: ${responseText.slice(0, 1000)}`
    );
  }

  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      `Sarvam response has no message content: ${JSON.stringify(payload).slice(0, 1000)}`
    );
  }

  return parseModelJson(content);
}


function parseModelJson(content) {
  let text = String(content).trim();

  // Remove optional Markdown fences.
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    // Recover the outermost JSON object if text surrounds it.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Throw a useful error below.
      }
    }

    throw new Error(
      `Could not parse Sarvam JSON response: ${text.slice(0, 1500)}`
    );
  }
}


// ============================================================
// 7. SAVE CUSTOMER NICHES
// ============================================================

async function saveCustomerNiches(env, application, niches) {
  if (!Array.isArray(niches) || niches.length !== REQUIRED_NICHES) {
    throw new Error(
      `Refusing to save niches: expected ${REQUIRED_NICHES}, got ${
        Array.isArray(niches) ? niches.length : 0
      }`
    );
  }

  const applicationId = String(application.id);

  // Load existing rows for this application to avoid
  // repeatedly inserting the same niche names.
  const existing = await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?application_id=eq." + encodeURIComponent(applicationId) +
      "&select=id,niche_name",
    { method: "GET" }
  );

  const existingNames = new Set(
    existing.map(row =>
      String(row.niche_name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    )
  );

  const rows = niches
    .filter(niche => {
      const key = niche.niche_name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

      return !existingNames.has(key);
    })
    .map(niche => ({
      id: crypto.randomUUID(),
      application_id: applicationId,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention,
      niche_status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user_id: application.user_id
        ? String(application.user_id)
        : null
    }));

  if (rows.length > 0) {
    console.log("INSERTING CUSTOMER NICHES", JSON.stringify({
      application_id: applicationId,
      rows_to_insert: rows.length
    }));

    // Return representation so we can verify the database write.
    const inserted = await supabaseRequest(
      env,
      "/rest/v1/customer_niches",
      {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: rows
      }
    );

    console.log("CUSTOMER NICHES INSERT RESULT", JSON.stringify({
      application_id: applicationId,
      inserted_count: inserted.length,
      inserted_names: inserted.map(row => row.niche_name)
    }));
  } else {
    console.log("NO NEW NICHE ROWS TO INSERT", JSON.stringify({
      application_id: applicationId,
      existing_rows: existing.length
    }));
  }

  // Return the actual saved rows, not just the AI output.
  const saved = await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?application_id=eq." + encodeURIComponent(applicationId) +
      "&select=id,niche_name,buying_intention,niche_status" +
      "&niche_status=eq.active",
    { method: "GET" }
  );

  if (saved.length < REQUIRED_NICHES) {
    throw new Error(
      `Database verification failed: only ${saved.length} active niches exist for application ${applicationId}`
    );
  }

  return saved;
}


// ============================================================
// 8. SAVE COMPANY ANALYSIS IN business_data
// ============================================================

async function saveBusinessData(env, application, field, data) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/business_data" +
      "?on_conflict=application_id,field",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: [{
        application_id: String(application.id),
        field,
        data,
        updated_at: new Date().toISOString()
      }]
    }
  );

  console.log("BUSINESS DATA SAVED", JSON.stringify({
    application_id: application.id,
    field,
    returned_rows: rows.length
  }));

  return rows;
}


// ============================================================
// 9. UPDATE APPLICATION STATUS
// ============================================================

async function updateApplicationStatus(env, applicationId, status) {
  await supabaseRequest(
    env,
    "/rest/v1/applications?id=eq." +
      encodeURIComponent(String(applicationId)),
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: {
        planner_status: status
      }
    }
  );

  console.log("APPLICATION STATUS UPDATED", JSON.stringify({
    application_id: applicationId,
    planner_status: status
  }));
}


// ============================================================
// 10. CREATE PLANNER RUN
// ============================================================

async function createPlannerRun(
  env,
  application,
  task,
  pendingCount,
  error
) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/planner_runs",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: [{
        id: crypto.randomUUID(),
        application_id: String(application.id),
        user_id: application.user_id
          ? String(application.user_id)
          : null,
        worker_type: "planner",
        source: "system",
        task,
        pending_count: pendingCount,
        error: error || null,
        niche_id: null,
        created_at: new Date().toISOString()
      }]
    }
  );

  const id = rows?.[0]?.id;

  if (!id) {
    throw new Error(
      "Failed to create planner_runs record: no row was returned"
    );
  }

  return id;
}


// ============================================================
// 11. UPDATE PLANNER RUN
// ============================================================

async function updatePlannerRun(env, runId, updates) {
  await supabaseRequest(
    env,
    "/rest/v1/planner_runs?id=eq." +
      encodeURIComponent(String(runId)),
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: updates
    }
  );
}


// ============================================================
// 12. RECORD ERRORS IN planner_runs.error
// ============================================================

async function recordPlannerError(
  env,
  applicationId,
  application,
  error
) {
  const safeError = String(error || "Unknown error").slice(0, 8000);

  console.error("RECORDING PLANNER ERROR", JSON.stringify({
    application_id: applicationId,
    error: safeError
  }));

  // A new error record is created so errors are not lost
  // if a previous planner run cannot be found.
  await createPlannerRun(
    env,
    application || {
      id: applicationId,
      user_id: null
    },
    "Customer niche discovery failed",
    0,
    safeError
  );
}


// ============================================================
// 13. SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing Cloudflare secret: SUPABASE_URL");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing Cloudflare secret: SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const url = baseUrl + path;

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    ...(options.headers || {})
  };

  const fetchOptions = {
    method: options.method || "GET",
    headers
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const responseText = await response.text();

  if (!response.ok) {
    // Include the actual PostgREST error message.
    // This will be captured by the calling function.
    throw new Error(
      `Supabase HTTP ${response.status} ${options.method || "GET"} ${path}: ${
        responseText.slice(0, 3000)
      }`
    );
  }

  if (!responseText.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed : parsed;
  } catch {
    throw new Error(
      `Supabase returned invalid JSON for ${path}: ${responseText.slice(0, 1000)}`
    );
  }
}


// ============================================================
// 14. SCHEDULED PLANNER
//
// Runs every 30 minutes.
// Creates one planner task per active niche per interval,
// skipping niches that already have a recent task.
// ============================================================

async function runScheduledPlanner(env) {
  console.log("SCHEDULED PLANNER STARTED");

  try {
    const applications = await supabaseRequest(
      env,
      "/rest/v1/applications" +
        "?status=eq.active" +
        "&planner_status=eq.completed" +
        "&select=id,name,company,domain,user_id" +
        "&limit=100",
      { method: "GET" }
    );

    for (const application of applications) {
      try {
        const niches = await supabaseRequest(
          env,
          "/rest/v1/customer_niches" +
            "?application_id=eq." +
            encodeURIComponent(String(application.id)) +
            "&niche_status=eq.active" +
            "&select=id,niche_name,buying_intention" +
            "&order=buying_intention.desc" +
            "&limit=10",
          { method: "GET" }
        );

        if (!niches.length) {
          console.log("NO ACTIVE NICHES", application.id);
          continue;
        }

        const thirtyMinutesAgo = new Date(
          Date.now() - 30 * 60 * 1000
        ).toISOString();

        const recentRuns = await supabaseRequest(
          env,
          "/rest/v1/planner_runs" +
            "?application_id=eq." +
            encodeURIComponent(String(application.id)) +
            "&created_at=gte." +
            encodeURIComponent(thirtyMinutesAgo) +
            "&select=niche_id",
          { method: "GET" }
        );

        const recentNicheIds = new Set(
          recentRuns
            .map(row => row.niche_id)
            .filter(Boolean)
        );

        const nextNiche = niches.find(
          niche => !recentNicheIds.has(niche.id)
        );

        if (!nextNiche) {
          console.log("ALL NICHES ALREADY PLANNED RECENTLY", {
            application_id: application.id
          });
          continue;
        }

        const task = [
          "Research customer niche:",
          nextNiche.niche_name,
          "for company:",
          application.company || application.name,
          ". Find customer problems, buying signals, and relevant prospects."
        ].join(" ");

        await supabaseRequest(
          env,
          "/rest/v1/planner_runs",
          {
            method: "POST",
            headers: {
              Prefer: "return=representation"
            },
            body: [{
              id: crypto.randomUUID(),
              application_id: String(application.id),
              user_id: application.user_id
                ? String(application.user_id)
                : null,
              worker_type: "reddit_research",
              source: "planner",
              task,
              pending_count: 1,
              error: null,
              niche_id: nextNiche.id,
              created_at: new Date().toISOString()
            }]
          }
        );

        console.log("SCHEDULED TASK CREATED", JSON.stringify({
          application_id: application.id,
          niche_id: nextNiche.id,
          niche_name: nextNiche.niche_name
        }));

      } catch (error) {
        console.error("SCHEDULED APPLICATION FAILED", JSON.stringify({
          application_id: application.id,
          error: errorMessage(error)
        }));

        try {
          await recordPlannerError(
            env,
            application.id,
            application,
            errorMessage(error)
          );
        } catch (loggingError) {
          console.error("SCHEDULED ERROR RECORDING FAILED", {
            application_id: application.id,
            error: errorMessage(loggingError)
          });
        }
      }
    }

    console.log("SCHEDULED PLANNER FINISHED", JSON.stringify({
      applications_checked: applications.length
    }));

  } catch (error) {
    console.error("SCHEDULED PLANNER FAILED", JSON.stringify({
      error: errorMessage(error),
      stack: error?.stack || null
    }));
  }
}


// ============================================================
// 15. RESPONSE HELPERS
// ============================================================

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}


function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
    }
