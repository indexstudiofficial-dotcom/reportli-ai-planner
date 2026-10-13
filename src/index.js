/**
 * ============================================================
 * REPORTLI AI PLANNER
 * Version 7.0
 * ============================================================
 *
 * WORKFLOW:
 *
 * 1. Receive an application ID.
 * 2. Load application details from Supabase.
 * 3. Analyze the company with Sarvam AI.
 * 4. Save company analysis in business_data.
 * 5. Generate and save up to 10 customer niches.
 * 6. Select the highest-priority enabled niche.
 * 7. Create a Reddit research task.
 * 8. Wait for Reddit research to complete.
 * 9. Create an Apollo lead-generation task.
 * 10. Wait for Apollo to complete.
 * 11. Move to the next niche.
 *
 * ENVIRONMENT VARIABLES:
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 *
 * SCHEDULE:
 * Every 30 minutes
 * ============================================================
 */

const VERSION = "7.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const ALLOWED_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed"
]);

const BUYING_INTENTION_DEFAULTS = [
  10, 9, 8, 7, 6, 5, 4, 3, 2, 1
];


// ============================================================
// MAIN ENTRY POINT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      validateEnvironment(env);

      if (request.method === "GET") {
        return jsonResponse({
          ok: true,
          worker: "reportli-ai-planner",
          version: VERSION,
          status: "healthy"
        }, 200, corsHeaders);
      }

      if (request.method !== "POST") {
        return jsonResponse({
          ok: false,
          error: "Method not allowed. Use POST."
        }, 405, corsHeaders);
      }

      const body = await request.json();

      // Manual execution:
      // { "application_id": "app_123" }
      if (body.application_id) {
        const result = await processApplication(
          String(body.application_id),
          env
        );

        return jsonResponse({
          ok: true,
          version: VERSION,
          result
        }, 200, corsHeaders);
      }

      // Optional shared-secret protection for webhook calls.
      if (env.WEBHOOK_SECRET) {
        const suppliedSecret =
          request.headers.get("x-webhook-secret");

        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          return jsonResponse({
            ok: false,
            error: "Unauthorized"
          }, 401, corsHeaders);
        }
      }

      // Process applications waiting for planning.
      const applications = await supabaseRequest(
        env,
        "/applications?select=id,planner_status" +
        "&planner_status=in.(pending,working)" +
        "&limit=20"
      );

      const results = [];

      for (const application of applications) {
        try {
          const result = await processApplication(
            application.id,
            env
          );

          results.push(result);
        } catch (error) {
          console.error(
            "Application processing failed:",
            application.id,
            error.message
          );

          results.push({
            application_id: application.id,
            ok: false,
            error: error.message
          });
        }
      }

      return jsonResponse({
        ok: true,
        version: VERSION,
        processed: results.length,
        results
      }, 200, corsHeaders);

    } catch (error) {
      console.error("Planner request failed:", {
        message: error.message
      });

      const status = error.status || 500;

      return jsonResponse({
        ok: false,
        error: error.message,
        version: VERSION
      }, status, corsHeaders);
    }
  },


  // ==========================================================
  // SCHEDULED TRIGGER
  // ==========================================================

  async scheduled(event, env, ctx) {
    validateEnvironment(env);

    ctx.waitUntil(runScheduledPlanner(env));
  }
};


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY"
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(
        `Missing required environment variable: ${key}`
      );
    }
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
      ...extraHeaders
    }
  });
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

  const url = `${baseUrl}/rest/v1${path}`;

  const response = await fetch(url, {
    method: options.method || "GET",

    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,

      "Authorization":
        `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

      "Content-Type": "application/json",

      "Prefer":
        options.prefer || "return=representation",

      ...(options.headers || {})
    },

    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

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
    const error = new Error(
      `Supabase HTTP ${response.status} on ${path}: ` +
      `${typeof data === "string"
        ? data
        : JSON.stringify(data)}`
    );

    error.status = response.status;

    throw error;
  }

  return data;
}


// ============================================================
// APPLICATION PROCESSING
// ============================================================

async function processApplication(applicationId, env) {
  console.log("Processing application:", applicationId);

  const applications = await supabaseRequest(
    env,
    `/applications?select=*&id=eq.${encodeURIComponent(applicationId)}&limit=1`
  );

  const application = applications?.[0];

  if (!application) {
    throw new Error(
      `Application not found: ${applicationId}`
    );
  }

  await updateApplicationStatus(
    applicationId,
    "working",
    env
  );

  // Step 1: Ensure company analysis and customer niches exist.
  await ensureCompanyAnalysis(application, env);

  // Step 2: Get the saved niches.
  const niches = await getNiches(applicationId, env);

  const enabledNiches = niches
    .filter(niche => niche.is_active !== false)
    .sort((a, b) => {
      const scoreA = Number(a.buying_intention || 0);
      const scoreB = Number(b.buying_intention || 0);

      return scoreB - scoreA;
    });

  if (enabledNiches.length === 0) {
    await updateApplicationStatus(
      applicationId,
      "completed",
      env
    );

    return {
      application_id: applicationId,
      status: "completed",
      message: "No enabled customer niches found."
    };
  }

  // Step 3: Process the first unfinished niche.
  for (const niche of enabledNiches) {
    const redditStatus = normalizeStatus(
      niche.reddit_status
    );

    const apolloStatus = normalizeStatus(
      niche.apollo_status
    );

    // Skip niches already fully completed.
    if (
      redditStatus === "completed" &&
      apolloStatus === "completed"
    ) {
      continue;
    }

    // Reddit must finish before Apollo.
    if (redditStatus !== "completed") {
      return await processRedditStage(
        application,
        niche,
        env
      );
    }

    // Apollo runs only after Reddit is complete.
    if (apolloStatus !== "completed") {
      return await processApolloStage(
        application,
        niche,
        env
      );
    }
  }

  // Every enabled niche has completed both stages.
  await updateApplicationStatus(
    applicationId,
    "completed",
    env
  );

  return {
    application_id: applicationId,
    status: "completed",
    message:
      "All enabled niches completed Reddit and Apollo processing."
  };
}


// ============================================================
// COMPANY ANALYSIS + NICHE GENERATION
// ============================================================

async function ensureCompanyAnalysis(application, env) {
  const applicationId = application.id;

  const existing = await getBusinessData(
    applicationId,
    "company_analysis",
    env
  );

  const existingNiches = await getNiches(
    applicationId,
    env
  );

  // If both already exist, do not spend Sarvam credits again.
  if (
    existing &&
    existingNiches.length > 0
  ) {
    return;
  }

  const companyContext = {
    name: application.name || "",
    company: application.company || "",
    domain: application.domain || ""
  };

  const prompt = `
You are the business research planner for Reportli AI.

Analyze the company using only the supplied company details.
Do not invent facts about the business.

Generate a concise company analysis and 10 useful customer niches
that could realistically buy this company's product or service.

Return valid JSON only, with this structure:

{
  "company_analysis": {
    "business_summary": "string",
    "product_or_service": "string",
    "target_audience": ["string"],
    "value_proposition": "string"
  },
  "niches": [
    {
      "niche_name": "short niche name",
      "buying_intention": 10
    }
  ]
}

Rules:
- Return exactly 10 niches.
- Each niche name must be short, ideally 1 to 4 words.
- Niches must be meaningfully different.
- buying_intention must be an integer from 1 to 10.
- Higher values mean higher expected buying intent.
- Do not return markdown or text outside JSON.
- If information is missing, acknowledge uncertainty.
- Do not fabricate company facts.

Company details:
${JSON.stringify(companyContext)}
`;

  const aiResult = await callSarvam(prompt, env);

  const analysis = aiResult.company_analysis;
  const niches = Array.isArray(aiResult.niches)
    ? aiResult.niches
    : [];

  if (!analysis || niches.length === 0) {
    throw new Error(
      "Sarvam did not return a valid company analysis and niche list."
    );
  }

  // Save company analysis without assuming a unique constraint.
  await saveBusinessData(
    applicationId,
    "company_analysis",
    analysis,
    env
  );

  // Save niches. Existing niches are updated, not duplicated.
  await saveCustomerNiches(
    application,
    niches,
    env
  );
}


// ============================================================
// SARVAM AI REQUEST
// ============================================================

async function callSarvam(prompt, env) {
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
          content:
            "Return valid JSON only. Do not invent facts."
        },
        {
          role: "user",
          content: prompt
        }
      ],

      temperature: 0.2,

      max_tokens: 4096,

      reasoning_effort: null,

      response_format: {
        type: "json_object"
      }
    })
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (response.status === 402) {
    const error = new Error(
      "Sarvam API has no credits available. Add credits before retrying."
    );

    error.status = 402;

    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam API HTTP ${response.status}: ${text.slice(0, 1000)}`
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      "Sarvam returned empty content. Check its token limit and response."
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      "Sarvam returned invalid JSON: " +
      content.slice(0, 500)
    );
  }

  return parsed;
}


// ============================================================
// BUSINESS DATA HELPERS
// ============================================================

async function getBusinessData(
  applicationId,
  field,
  env
) {
  const rows = await supabaseRequest(
    env,
    `/business_data?select=*&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}&limit=1`
  );

  return rows?.[0] || null;
}


async function saveBusinessData(
  applicationId,
  field,
  data,
  env
) {
  const existing = await getBusinessData(
    applicationId,
    field,
    env
  );

  if (existing) {
    await supabaseRequest(
      env,
      `/business_data?id=eq.${encodeURIComponent(existing.id)}`,
      {
        method: "PATCH",
        body: {
          data,
          updated_at: new Date().toISOString()
        }
      }
    );

    return;
  }

  await supabaseRequest(
    env,
    "/business_data",
    {
      method: "POST",
      body: {
        application_id: applicationId,
        field,
        data
      }
    }
  );
}


// ============================================================
// CUSTOMER NICHE HELPERS
// ============================================================

async function getNiches(applicationId, env) {
  return await supabaseRequest(
    env,
    `/customer_niches?select=*&application_id=eq.${encodeURIComponent(applicationId)}` +
    "&order=created_at.asc&limit=200"
  );
}


async function saveCustomerNiches(
  application,
  generatedNiches,
  env
) {
  const applicationId = application.id;

  const existingNiches = await getNiches(
    applicationId,
    env
  );

  const existingByName = new Map();

  for (const niche of existingNiches) {
    existingByName.set(
      normalizeName(niche.niche_name),
      niche
    );
  }

  const seen = new Set();

  for (let i = 0; i < generatedNiches.length; i++) {
    const item = generatedNiches[i];

    if (!item || typeof item.niche_name !== "string") {
      continue;
    }

    const name = item.niche_name.trim().slice(0, 150);

    if (!name) continue;

    const normalized = normalizeName(name);

    if (seen.has(normalized)) continue;

    seen.add(normalized);

    const rawScore = Number(item.buying_intention);

    const score = Number.isFinite(rawScore)
      ? Math.min(10, Math.max(1, Math.round(rawScore)))
      : BUYING_INTENTION_DEFAULTS[
          i % BUYING_INTENTION_DEFAULTS.length
        ];

    const old = existingByName.get(normalized);

    if (old) {
      // Do not overwrite progress when regenerating niches.
      // Keep the current active setting and task statuses.
      await supabaseRequest(
        env,
        `/customer_niches?id=eq.${encodeURIComponent(old.id)}`,
        {
          method: "PATCH",
          body: {
            buying_intention: score,
            updated_at: new Date().toISOString()
          }
        }
      );

      continue;
    }

    const row = {
      application_id: applicationId,
      niche_name: name,
      buying_intention: score,
      reddit_status: "pending",
      apollo_status: "pending",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (application.user_id) {
      row.user_id = application.user_id;
    }

    await supabaseRequest(
      env,
      "/customer_niches",
      {
        method: "POST",
        body: row
      }
    );
  }
}


// ============================================================
// REDDIT STAGE
// ============================================================

async function processRedditStage(
  application,
  niche,
  env
) {
  const applicationId = application.id;

  const integration = await getConnectedIntegration(
    applicationId,
    "reddit",
    env
  );

  if (!integration) {
    return {
      application_id: applicationId,
      niche: niche.niche_name,
      status: "waiting_for_integration",
      required_integration: "reddit",
      message:
        "Connect Reddit before this niche can proceed."
    };
  }

  const existingRun = await findNicheRun(
    applicationId,
    niche.id,
    "reddit",
    env
  );

  if (existingRun) {
    if (isRunCompleted(existingRun)) {
      await updateNicheStatus(
        niche.id,
        "reddit_status",
        "completed",
        env
      );

      return {
        application_id: applicationId,
        niche: niche.niche_name,
        status: "reddit_completed",
        message:
          "Reddit task is complete. Apollo will be scheduled next."
      };
    }

    if (isRunFailed(existingRun)) {
      await updateNicheStatus(
        niche.id,
        "reddit_status",
        "failed",
        env
      );

      return {
        application_id: applicationId,
        niche: niche.niche_name,
        status: "reddit_failed",
        message:
          "The existing Reddit task failed. Review it before retrying."
      };
    }

    await updateNicheStatus(
      niche.id,
      "reddit_status",
      "running",
      env
    );

    return {
      application_id: applicationId,
      niche: niche.niche_name,
      status: "reddit_running",
      message:
        "Waiting for the existing Reddit task to finish."
    };
  }

  const task = {
    task_id: crypto.randomUUID(),
    worker: "reddit_research",
    application_id: applicationId,
    niche: niche.niche_name,
    niche_id: String(niche.id),
    objective:
      `Research customer problems, buying signals, and discussions relevant to ${niche.niche_name}.`,
    target_audience: [niche.niche_name],
    problem_categories: [
      "customer_problems",
      "lead_generation",
      "customer_acquisition",
      "product_needs",
      "buying_intent"
    ],
    published_within_days: 7,
    target_new_posts: 20,
    created_at: new Date().toISOString()
  };

  await createPlannerRun({
    application_id: applicationId,
    niche: String(niche.id),
    worker_type: "research",
    source: "reddit",
    task,
    pending_count: 1
  }, env);

  await updateNicheStatus(
    niche.id,
    "reddit_status",
    "running",
    env
  );

  return {
    application_id: applicationId,
    niche: niche.niche_name,
    status: "reddit_task_created",
    task_id: task.task_id
  };
}


// ============================================================
// APOLLO STAGE
// ============================================================

async function processApolloStage(
  application,
  niche,
  env
) {
  const applicationId = application.id;

  const integration = await getConnectedIntegration(
    applicationId,
    "apollo",
    env
  );

  if (!integration) {
    return {
      application_id: applicationId,
      niche: niche.niche_name,
      status: "waiting_for_integration",
      required_integration: "apollo",
      message:
        "Reddit is complete. Connect Apollo to continue."
    };
  }

  const existingRun = await findNicheRun(
    applicationId,
    niche.id,
    "apollo",
    env
  );

  if (existingRun) {
    if (isRunCompleted(existingRun)) {
      await updateNicheStatus(
        niche.id,
        "apollo_status",
        "completed",
        env
      );

      return {
        application_id: applicationId,
        niche: niche.niche_name,
        status: "apollo_completed",
        message:
          "Apollo is complete. The next scheduled run can process another niche."
      };
    }

    if (isRunFailed(existingRun)) {
      await updateNicheStatus(
        niche.id,
        "apollo_status",
        "failed",
        env
      );

      return {
        application_id: applicationId,
        niche: niche.niche_name,
        status: "apollo_failed",
        message:
          "The existing Apollo task failed. Review it before retrying."
      };
    }

    await updateNicheStatus(
      niche.id,
      "apollo_status",
      "running",
      env
    );

    return {
      application_id: applicationId,
      niche: niche.niche_name,
      status: "apollo_running",
      message:
        "Waiting for the existing Apollo task to finish."
    };
  }

  // Safety: do not create Apollo until Reddit is complete.
  if (
    normalizeStatus(niche.reddit_status) !== "completed"
  ) {
    return {
      application_id: applicationId,
      niche: niche.niche_name,
      status: "waiting_for_reddit"
    };
  }

  const task = {
    task_id: crypto.randomUUID(),
    worker: "apollo_lead_generation",
    application_id: applicationId,
    niche: niche.niche_name,
    niche_id: String(niche.id),
    objective:
      `Find and qualify relevant prospects for the customer niche "${niche.niche_name}".`,
    target_audience: [niche.niche_name],
    qualification_criteria: [
      "Relevant to the target niche",
      "Likely to need the product or service",
      "Prefer business contacts with useful company context"
    ],
    use_reddit_research: true,
    created_at: new Date().toISOString()
  };

  await createPlannerRun({
    application_id: applicationId,
    niche: String(niche.id),
    worker_type: "lead_generation",
    source: "apollo",
    task,
    pending_count: 1
  }, env);

  await updateNicheStatus(
    niche.id,
    "apollo_status",
    "running",
    env
  );

  return {
    application_id: applicationId,
    niche: niche.niche_name,
    status: "apollo_task_created",
    task_id: task.task_id
  };
}


// ============================================================
// CONNECTED INTEGRATIONS
// ============================================================

async function getConnectedIntegration(
  applicationId,
  integrationName,
  env
) {
  const rows = await supabaseRequest(
    env,
    `/user_integrations?select=id,integration_id,status,application_id` +
    `&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&integration_id=eq.${encodeURIComponent(integrationName)}` +
    "&status=eq.connected&limit=1"
  );

  return rows?.[0] || null;
}


// ============================================================
// PLANNER RUN HELPERS
// ============================================================

async function findNicheRun(
  applicationId,
  nicheId,
  source,
  env
) {
  const rows = await supabaseRequest(
    env,
    `/planner_runs?select=*&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&niche=eq.${encodeURIComponent(String(nicheId))}` +
    `&source=eq.${encodeURIComponent(source)}` +
    "&order=created_at.desc&limit=10"
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  // Ignore unrelated planner/system runs.
  const relevant = rows.filter(row => {
    if (source === "reddit") {
      return row.worker_type === "research";
    }

    if (source === "apollo") {
      return row.worker_type === "lead_generation";
    }

    return false;
  });

  return relevant[0] || null;
}


async function createPlannerRun(payload, env) {
  await supabaseRequest(
    env,
    "/planner_runs",
    {
      method: "POST",
      body: payload
    }
  );
}


function isRunCompleted(run) {
  const status = String(run.status || "").toLowerCase();

  if (status === "completed" || status === "complete") {
    return true;
  }

  return (
    Number(run.pending_count) === 0 &&
    status !== "failed" &&
    status !== "error"
  );
}


function isRunFailed(run) {
  const status = String(run.status || "").toLowerCase();

  return (
    status === "failed" ||
    status === "error"
  );
}


// ============================================================
// STATUS UPDATES
// ============================================================

async function updateNicheStatus(
  nicheId,
  column,
  status,
  env
) {
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`Invalid niche status: ${status}`);
  }

  if (
    column !== "reddit_status" &&
    column !== "apollo_status"
  ) {
    throw new Error(`Invalid status column: ${column}`);
  }

  await supabaseRequest(
    env,
    `/customer_niches?id=eq.${encodeURIComponent(nicheId)}`,
    {
      method: "PATCH",
      body: {
        [column]: status,
        updated_at: new Date().toISOString()
      }
    }
  );
}


async function updateApplicationStatus(
  applicationId,
  status,
  env
) {
  await supabaseRequest(
    env,
    `/applications?id=eq.${encodeURIComponent(applicationId)}`,
    {
      method: "PATCH",
      body: {
        planner_status: status
      }
    }
  );
}


function normalizeStatus(value) {
  const status = String(value || "pending")
    .trim()
    .toLowerCase();

  // Legacy values from before the column rename.
  if (status === "active") return "pending";
  if (status === "inactive") return "pending";

  if (ALLOWED_STATUSES.has(status)) {
    return status;
  }

  return "pending";
}


function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}


// ============================================================
// SCHEDULED PLANNER
// ============================================================

async function runScheduledPlanner(env) {
  console.log("Running scheduled Reportli AI Planner");

  const applications = await supabaseRequest(
    env,
    "/applications?select=id,planner_status" +
    "&planner_status=in.(pending,working)" +
    "&limit=20"
  );

  for (const application of applications) {
    try {
      const result = await processApplication(
        application.id,
        env
      );

      console.log(
        "Scheduled planner result:",
        JSON.stringify(result)
      );
    } catch (error) {
      console.error(
        "Scheduled planner failed:",
        application.id,
        error.message
      );

      // Do not mark the whole application failed just because
      // one temporary API call failed. Keep it eligible for retry.
      if (error.status === 402) {
        console.error(
          "Sarvam credits are exhausted. Planner will need credits before retrying."
        );
      }
    }
  }
  }
