// ============================================================
// REPORTLI AI — CUSTOMER NICHE PLANNER + TASK SCHEDULER
// Version: 4.0.0
//
// Features:
// 1. No Cron Trigger.
// 2. No INTERNAL_WORKER_SECRET.
// 3. Creates 10 customer niches using Sarvam AI.
// 4. Assigns unique buying-intention scores.
// 5. Accepts POST /create-task.
// 6. Selects the highest-scoring pending niche.
// 7. Keeps Reddit and Apollo queues independent.
// 8. Saves tasks in planner_runs.
// 9. Marks the selected niche as queued.
// 10. Resets a source cycle after every niche is completed.
//
// Existing tables only:
// applications
// customer_niches
// planner_runs
// users
// user_integrations
// ============================================================

const VERSION = "4.0.0";

const SOURCES = {
  REDDIT: "reddit",
  APOLLO: "apollo"
};

const SOURCE_STATUS_FIELD = {
  reddit: "reddit_status",
  apollo: "apollo_status"
};

const SOURCE_WORKER_TYPE = {
  reddit: "reddit_research",
  apollo: "apollo_lead_generation"
};

// Unique descending scores.
// These are relative ranking scores, not calibrated probabilities.
const BUYING_INTENTION_SCORES = [
  100, 97, 94, 91, 88,
  85, 82, 79, 76, 73
];

const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];

// ============================================================
// MAIN REQUEST HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (!ALLOWED_METHODS.includes(request.method)) {
      return jsonResponse(
        { success: false, error: "Method not allowed" },
        405,
        corsHeaders
      );
    }

    try {
      validateEnvironment(env);

      // --------------------------------------------------------
      // HEALTH CHECK
      // GET /health
      // --------------------------------------------------------

      if (pathname === "/health" && request.method === "GET") {
        return jsonResponse(
          {
            success: true,
            worker: "reportli-customer-niche-planner",
            version: VERSION,
            cron_enabled: false,
            authentication_required: false,
            endpoints: [
              "GET /health",
              "POST /webhook",
              "POST /create-task",
              "POST /test"
            ]
          },
          200,
          corsHeaders
        );
      }

      // --------------------------------------------------------
      // CREATE NEXT SOURCE TASK
      // POST /create-task
      //
      // {
      //   "application_id": "YOUR_APPLICATION_ID",
      //   "source": "reddit"
      // }
      // --------------------------------------------------------

      if (
        pathname === "/create-task" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);

        const applicationId = String(
          body.application_id || ""
        ).trim();

        const source = normalizeSource(body.source);

        if (!applicationId) {
          return jsonResponse(
            {
              success: false,
              error: "application_id is required"
            },
            400,
            corsHeaders
          );
        }

        if (!source) {
          return jsonResponse(
            {
              success: false,
              error: 'source must be "reddit" or "apollo"'
            },
            400,
            corsHeaders
          );
        }

        const result = await createNextNicheTask(
          env,
          applicationId,
          source
        );

        return jsonResponse(
          result,
          result.success ? 200 : (result.http_status || 500),
          corsHeaders
        );
      }

      // --------------------------------------------------------
      // APPLICATION WEBHOOK
      //
      // Supports a Supabase Database Webhook payload:
      // { "record": { "id": "APPLICATION_ID" } }
      //
      // Also supports:
      // { "application_id": "APPLICATION_ID" }
      // --------------------------------------------------------

      if (
        pathname === "/webhook" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);

        const applicationId = String(
          body.application_id ||
          body.record?.id ||
          body.id ||
          ""
        ).trim();

        if (!applicationId) {
          return jsonResponse(
            {
              success: false,
              error:
                "Application ID missing. Provide application_id or record.id."
            },
            400,
            corsHeaders
          );
        }

        const result = await processApplication(
          env,
          applicationId
        );

        return jsonResponse(
          result,
          result.success ? 200 : (result.http_status || 500),
          corsHeaders
        );
      }

      // --------------------------------------------------------
      // MANUAL TEST ENDPOINT
      // POST /test
      //
      // Uses the same payload as /create-task.
      // --------------------------------------------------------

      if (
        pathname === "/test" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);

        const applicationId = String(
          body.application_id || ""
        ).trim();

        const source = normalizeSource(body.source);

        if (!applicationId || !source) {
          return jsonResponse(
            {
              success: false,
              error:
                'Provide application_id and source ("reddit" or "apollo").'
            },
            400,
            corsHeaders
          );
        }

        const result = await createNextNicheTask(
          env,
          applicationId,
          source
        );

        return jsonResponse(
          result,
          result.success ? 200 : (result.http_status || 500),
          corsHeaders
        );
      }

      return jsonResponse(
        {
          success: false,
          error: "Endpoint not found",
          available_endpoints: [
            "GET /health",
            "POST /webhook",
            "POST /create-task",
            "POST /test"
          ]
        },
        404,
        corsHeaders
      );
    } catch (error) {
      console.error("Worker request failed:", error);

      return jsonResponse(
        {
          success: false,
          error: error.message || "Internal server error"
        },
        500,
        corsHeaders
      );
    }
  }
};

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers
  });
}

async function readJsonBody(request) {
  const text = await request.text();

  if (!text.trim()) {
    throw new Error("Request body is empty");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must contain valid JSON");
  }
}

function normalizeSource(value) {
  const source = String(value || "")
    .trim()
    .toLowerCase();

  if (source === SOURCES.REDDIT) return SOURCES.REDDIT;
  if (source === SOURCES.APOLLO) return SOURCES.APOLLO;

  return null;
}

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY"
  ];

  const missing = required.filter(
    key => !env[key] || !String(env[key]).trim()
  );

  if (missing.length > 0) {
    throw new Error(
      "Missing Cloudflare Worker environment variables: " +
      missing.join(", ")
    );
  }
}

// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const url = baseUrl + "/rest/v1" + path;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization":
      "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(options.headers || {})
  };

  const fetchOptions = {
    method: options.method || "GET",
    headers
  };

  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase REST error:",
      response.status,
      responseText
    );

    throw new Error(
      "Supabase request failed (" +
      response.status +
      "): " +
      responseText.slice(0, 1200)
    );
  }

  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

// ============================================================
// SARVAM AI HELPER
// ============================================================

async function callSarvamJson(
  env,
  systemPrompt,
  userPrompt,
  maxTokens = 3000
) {
  const response = await fetch(
    "https://api.sarvam.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "api-subscription-key": env.SARVAM_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sarvam-105b",
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: {
          type: "json_object"
        },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ]
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
      "Sarvam API failed (" +
      response.status +
      "): " +
      responseText.slice(0, 1200)
    );
  }

  let responseJson;

  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new Error("Sarvam returned an invalid API response");
  }

  const content =
    responseJson.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Sarvam returned an empty response");
  }

  if (typeof content === "object") {
    return content;
  }

  try {
    return JSON.parse(content);
  } catch {
    const cleaned = String(content)
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(
        "Sarvam did not return valid JSON: " +
        cleaned.slice(0, 500)
      );
    }
  }
}

// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const query =
    "?id=eq." +
    encodeURIComponent(applicationId) +
    "&select=*";

  const rows = await supabaseRequest(
    env,
    "/applications" + query
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

// ============================================================
// APPLICATION WEBHOOK PROCESSING
// ============================================================

async function processApplication(
  env,
  applicationId
) {
  const application = await getApplication(
    env,
    applicationId
  );

  if (!application) {
    return {
      success: false,
      http_status: 404,
      error: "Application not found",
      application_id: applicationId
    };
  }

  const existingNiches = await getCustomerNiches(
    env,
    applicationId
  );

  if (existingNiches.length >= 10) {
    await updateApplicationStatus(
      env,
      applicationId,
      "completed"
    );

    return {
      success: true,
      message:
        "Analyze the company and find 10 customer niches",
      application_id: applicationId,
      niches_count: existingNiches.length,
      already_created: true
    };
  }

  try {
    const generated = await generateCustomerNiches(
      env,
      application
    );

    const saved = await saveCustomerNiches(
      env,
      application,
      generated.niches
    );

    const finalNiches = await getCustomerNiches(
      env,
      applicationId
    );

    if (finalNiches.length < 10) {
      throw new Error(
        "Only " +
        finalNiches.length +
        " niches exist after saving. Expected 10."
      );
    }

    await updateApplicationStatus(
      env,
      applicationId,
      "completed"
    );

    return {
      success: true,
      message:
        "Analyze the company and find 10 customer niches",
      application_id: applicationId,
      niches_count: finalNiches.length,
      newly_saved: saved,
      niches: finalNiches.map(niche => ({
        id: niche.id,
        niche_name: niche.niche_name,
        buying_intention: niche.buying_intention
      }))
    };
  } catch (error) {
    console.error(
      "Application niche processing failed:",
      error
    );

    await updateApplicationStatus(
      env,
      applicationId,
      "failed"
    );

    throw error;
  }
}

// ============================================================
// UPDATE APPLICATION STATUS
// ============================================================

async function updateApplicationStatus(
  env,
  applicationId,
  status
) {
  await supabaseRequest(
    env,
    "/applications?id=eq." +
      encodeURIComponent(applicationId),
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=minimal"
      },
      body: {
        planner_status: status
      }
    }
  );
}

// ============================================================
// GET CUSTOMER NICHES
// ============================================================

async function getCustomerNiches(
  env,
  applicationId
) {
  const query =
    "?application_id=eq." +
    encodeURIComponent(applicationId) +
    "&select=*" +
    "&order=buying_intention.desc,created_at.asc";

  const rows = await supabaseRequest(
    env,
    "/customer_niches" + query
  );

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows;
}

// ============================================================
// GENERATE 10 CUSTOMER NICHES WITH SARVAM
// ============================================================

async function generateCustomerNiches(
  env,
  application
) {
  const companyInfo = {
    application_name: application.name || "",
    company: application.company || "",
    domain: application.domain || "",
    description:
      application.description ||
      application.company_description ||
      "",
    industry: application.industry || "",
    target_audience:
      application.target_audience || "",
    existing_data: {
      website: application.website || "",
      business_type: application.business_type || ""
    }
  };

  const systemPrompt = `
You are an expert B2B customer research strategist.

Your task is to discover exactly 10 distinct customer niches
for the supplied company.

Rules:
1. Return valid JSON only.
2. Do not invent company facts.
3. Niches must be meaningfully different.
4. Prefer specific customer segments with clear problems.
5. Estimate relative buying intention, not a guaranteed probability.
6. Return exactly 10 niches.
7. Each niche must have a unique integer buying_intention.
8. buying_intention must be between 1 and 100.
9. Sort niches from highest buying intention to lowest.
10. Do not include markdown.

Use this JSON shape:
{
  "niches": [
    {
      "niche_name": "Specific customer segment",
      "description": "Why this segment is relevant",
      "pain_points": ["Pain point 1", "Pain point 2"],
      "buying_reason": "Why they might buy this company's product"
    }
  ]
}
`;

  const userPrompt = `
Analyze this company and identify exactly 10 customer niches.

Company information:
${JSON.stringify(companyInfo, null, 2)}

Return the 10 best customer niches in JSON.
`;

  const result = await callSarvamJson(
    env,
    systemPrompt,
    userPrompt,
    4000
  );

  if (!Array.isArray(result.niches)) {
    throw new Error(
      "Sarvam did not return a niches array"
    );
  }

  if (result.niches.length < 10) {
    throw new Error(
      "Sarvam returned fewer than 10 niches"
    );
  }

  const unique = [];
  const seen = new Set();

  for (const item of result.niches) {
    const name = String(
      item.niche_name || ""
    ).trim();

    const normalized = name.toLowerCase();

    if (!name || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    unique.push({
      niche_name: name,
      description: String(
        item.description || ""
      ).trim(),
      pain_points: Array.isArray(item.pain_points)
        ? item.pain_points.map(String)
        : [],
      buying_reason: String(
        item.buying_reason || ""
      ).trim()
    });

    if (unique.length === 10) {
      break;
    }
  }

  if (unique.length !== 10) {
    throw new Error(
      "Could not obtain 10 unique customer niches"
    );
  }

  // Assign fixed unique descending scores to ensure
  // stable ranking even if Sarvam returns repeated scores.
  unique.forEach((niche, index) => {
    niche.buying_intention =
      BUYING_INTENTION_SCORES[index];
  });

  return {
    niches: unique
  };
}

// ============================================================
// SAVE CUSTOMER NICHES
//
// No new tables and no SQL migrations.
// Existing niches are preserved.
// ============================================================

async function saveCustomerNiches(
  env,
  application,
  niches
) {
  const applicationId = application.id;

  const existing = await getCustomerNiches(
    env,
    applicationId
  );

  const existingNames = new Set(
    existing.map(niche =>
      String(niche.niche_name || "")
        .trim()
        .toLowerCase()
    )
  );

  let savedCount = 0;

  for (let i = 0; i < niches.length; i++) {
    const niche = niches[i];

    const normalizedName =
      niche.niche_name.toLowerCase();

    if (existingNames.has(normalizedName)) {
      continue;
    }

    const now = new Date().toISOString();

    const row = {
      application_id: applicationId,
      user_id: application.user_id || null,
      niche_name: niche.niche_name,
      buying_intention:
        BUYING_INTENTION_SCORES[i],
      reddit_status: "pending",
      apollo_status: "pending",
      is_active: true,
      created_at: now,
      updated_at: now
    };

    await supabaseRequest(
      env,
      "/customer_niches",
      {
        method: "POST",
        headers: {
          "Prefer": "return=minimal"
        },
        body: row
      }
    );

    existingNames.add(normalizedName);
    savedCount++;
  }

  return savedCount;
}

// ============================================================
// CREATE NEXT TASK FOR A SOURCE
// ============================================================

async function createNextNicheTask(
  env,
  applicationId,
  source
) {
  const application = await getApplication(
    env,
    applicationId
  );

  if (!application) {
    return {
      success: false,
      http_status: 404,
      error: "Application not found",
      application_id: applicationId
    };
  }

  let niches = await getCustomerNiches(
    env,
    applicationId
  );

  if (niches.length === 0) {
    return {
      success: false,
      http_status: 409,
      error:
        "No customer niches exist. Run POST /webhook first.",
      application_id: applicationId
    };
  }

  const statusField =
    SOURCE_STATUS_FIELD[source];

  // A niche with status pending is eligible.
  // Other queued/processing tasks do not prevent this
  // request from selecting the next pending niche.
  let pending = niches.filter(niche =>
    String(niche[statusField] || "pending")
      .toLowerCase() === "pending" &&
    niche.is_active !== false
  );

  // If all niches are completed for this source,
  // reset the cycle and begin again from the oldest
  // updated_at niche.
  if (pending.length === 0) {
    const allCompleted = niches.every(niche =>
      String(niche[statusField] || "pending")
        .toLowerCase() === "completed" ||
      niche.is_active === false
    );

    if (allCompleted) {
      await resetSourceCycle(
        env,
        applicationId,
        source,
        niches
      );

      niches = await getCustomerNiches(
        env,
        applicationId
      );

      pending = niches.filter(niche =>
        String(niche[statusField] || "pending")
          .toLowerCase() === "pending" &&
        niche.is_active !== false
      );
    }
  }

  if (pending.length === 0) {
    const inProgress = niches.filter(niche => {
      const status = String(
        niche[statusField] || "pending"
      ).toLowerCase();

      return status === "queued" ||
        status === "processing";
    });

    if (inProgress.length > 0) {
      return {
        success: false,
        http_status: 409,
        error:
          "No pending niches remain for this source. " +
          "Some tasks are still queued or processing.",
        source,
        in_progress_count: inProgress.length
      };
    }

    return {
      success: false,
      http_status: 409,
      error:
        "No eligible niches are available for this source.",
      source
    };
  }

  // Highest buying intention first.
  pending.sort((a, b) => {
    const scoreDifference =
      Number(b.buying_intention || 0) -
      Number(a.buying_intention || 0);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    const timeA = Date.parse(
      a.updated_at || a.created_at || ""
    ) || 0;

    const timeB = Date.parse(
      b.updated_at || b.created_at || ""
    ) || 0;

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    return String(a.id).localeCompare(String(b.id));
  });

  const selectedNiche = pending[0];

  return queueNicheTask(
    env,
    application,
    selectedNiche,
    source
  );
}

// ============================================================
// CLAIM NICHE, GENERATE TASK, SAVE TASK, MARK QUEUED
// ============================================================

async function queueNicheTask(
  env,
  application,
  niche,
  source
) {
  const statusField =
    SOURCE_STATUS_FIELD[source];

  const applicationId = application.id;
  const now = new Date().toISOString();

  // Claim the niche conditionally.
  // Only one request can successfully change pending
  // to processing if the database update is atomic.
  const claimed = await supabaseRequest(
    env,
    "/customer_niches?id=eq." +
      encodeURIComponent(niche.id) +
      "&application_id=eq." +
      encodeURIComponent(applicationId) +
      "&" + statusField + "=eq.pending",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: {
        [statusField]: "processing",
        updated_at: now
      }
    }
  );

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return {
      success: false,
      http_status: 409,
      error:
        "This niche was already claimed by another request. Retry.",
      source,
      niche: niche.niche_name
    };
  }

  try {
    const task = await generateSourceTask(
      env,
      application,
      niche,
      source
    );

    // task is saved as plain text.
    const taskText = String(task).trim();

    if (!taskText) {
      throw new Error(
        "Sarvam generated an empty task"
      );
    }

    const plannerRun = {
      application_id: applicationId,
      user_id: application.user_id || null,
      worker_type: SOURCE_WORKER_TYPE[source],
      source: "system",
      task: taskText,
      pending_count: 1,
      error: null,
      niche: niche.niche_name,
      created_at: new Date().toISOString(),
      started_at: null
    };

    const inserted = await supabaseRequest(
      env,
      "/planner_runs",
      {
        method: "POST",
        headers: {
          "Prefer": "return=representation"
        },
        body: plannerRun
      }
    );

    // Only mark queued after planner_runs insert succeeds.
    const updated = await supabaseRequest(
      env,
      "/customer_niches?id=eq." +
        encodeURIComponent(niche.id) +
        "&application_id=eq." +
        encodeURIComponent(applicationId) +
        "&" + statusField + "=eq.processing",
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation"
        },
        body: {
          [statusField]: "queued",
          updated_at: new Date().toISOString()
        }
      }
    );

    if (!Array.isArray(updated) || updated.length === 0) {
      console.error(
        "Task inserted but niche status did not update:",
        niche.id,
        source
      );

      return {
        success: true,
        warning:
          "Task was saved, but the niche status update did not return a row.",
        application_id: applicationId,
        source,
        niche: niche.niche_name,
        task,
        planner_run: Array.isArray(inserted)
          ? inserted[0] || null
          : inserted
      };
    }

    return {
      success: true,
      message: "Task created successfully",
      application_id: applicationId,
      source,
      niche: niche.niche_name,
      buying_intention: niche.buying_intention,
      status: "queued",
      task,
      planner_run: Array.isArray(inserted)
        ? inserted[0] || null
        : inserted
    };
  } catch (error) {
    console.error(
      "Task creation failed:",
      source,
      niche.niche_name,
      error
    );

    // Return the niche to pending so the next request
    // can retry after a temporary AI or database failure.
    try {
      await supabaseRequest(
        env,
        "/customer_niches?id=eq." +
          encodeURIComponent(niche.id) +
          "&application_id=eq." +
          encodeURIComponent(applicationId) +
          "&" + statusField + "=eq.processing",
        {
          method: "PATCH",
          headers: {
            "Prefer": "return=minimal"
          },
          body: {
            [statusField]: "pending",
            updated_at: new Date().toISOString()
          }
        }
      );
    } catch (resetError) {
      console.error(
        "Could not return niche to pending:",
        resetError
      );
    }

    throw error;
  }
}

// ============================================================
// GENERATE A REDDIT OR APOLLO TASK USING SARVAM
// ============================================================

async function generateSourceTask(
  env,
  application,
  niche,
  source
) {
  const companyInfo = {
    name: application.name || "",
    company: application.company || "",
    domain: application.domain || "",
    description:
      application.description ||
      application.company_description ||
      "",
    industry: application.industry || ""
  };

  const nicheInfo = {
    niche_name: niche.niche_name,
    buying_intention: niche.buying_intention
  };

  const systemPrompt = `
You are Reportli AI's task planner.

Create exactly one practical task for a downstream worker.
Return valid JSON only, using this shape:
{
  "task": "Plain-text task instructions"
}

Rules:
- The task value must be plain text, not a JSON object.
- Do not claim any research has already been completed.
- Do not invent facts about the company.
- Focus only on the provided niche.
- Make the task executable by a downstream worker.
- Do not include markdown fences.
`;

  let sourceInstructions;

  if (source === "reddit") {
    sourceInstructions = `
Create a Reddit research task.

The task should tell the downstream worker to:
- Research relevant public Reddit posts and discussions.
- Look for recent, real customer problems related to this niche.
- Prioritize posts showing buying intent, dissatisfaction, or requests for solutions.
- Identify recurring pain points and the language customers use.
- Avoid inventing posts, quotes, users, URLs, or engagement metrics.
- Return source URLs for findings.
- Target up to 20 relevant new posts where available.
- Focus on posts from the last 7 days when possible.
- Consider relevant communities such as SaaS, startups, Entrepreneur,
  indiehackers, and sales, but do not restrict research to them if better
  relevant communities exist.
`;
  } else {
    sourceInstructions = `
Create a B2B lead-generation task for an Apollo-connected worker.

The task should tell the downstream worker to:
- Identify companies and contacts relevant to this niche.
- Define useful company and role filters.
- Prioritize likely buyers and decision-makers.
- Use the connected provider and its available credits.
- Do not invent names, email addresses, company facts, or contact details.
- Record source and verification information when available.
- Do not send outreach unless another system explicitly authorizes it.
`;
  }

  const userPrompt = `
Company:
${JSON.stringify(companyInfo, null, 2)}

Selected niche:
${JSON.stringify(nicheInfo, null, 2)}

Source:
${source}

Task requirements:
${sourceInstructions}

Return one JSON object containing a single "task" string.
`;

  const result = await callSarvamJson(
    env,
    systemPrompt,
    userPrompt,
    1800
  );

  const task = String(result.task || "").trim();

  if (!task) {
    throw new Error(
      "Sarvam did not return a task string"
    );
  }

  return task;
}

// ============================================================
// RESET SOURCE CYCLE
//
// When all active niches are completed for a source:
// 1. Sort by their previous updated_at values.
// 2. Reset that source's statuses to pending.
// 3. Assign increasing timestamps in that order.
// 4. The oldest niche therefore remains first in the new cycle.
//
// The other source's status is never modified.
// ============================================================

async function resetSourceCycle(
  env,
  applicationId,
  source,
  niches
) {
  const statusField = SOURCE_STATUS_FIELD[source];

  const activeNiches = niches
    .filter(niche => niche.is_active !== false)
    .sort((a, b) => {
      const timeA =
        Date.parse(a.updated_at || a.created_at || "") || 0;

      const timeB =
        Date.parse(b.updated_at || b.created_at || "") || 0;

      if (timeA !== timeB) {
        return timeA - timeB;
      }

      return String(a.id).localeCompare(String(b.id));
    });

  if (activeNiches.length === 0) {
    console.log(
      "No active niches available to reset:",
      applicationId,
      source
    );
    return;
  }

  for (const niche of activeNiches) {
    await supabaseRequest(
      env,
      `/rest/v1/customer_niches?id=eq.${encodeURIComponent(niche.id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
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
