/**
 * ============================================================
 * REPORTLI AI — CUSTOMER NICHE PLANNER + TASK SCHEDULER
 * Version 2.0.0
 * ============================================================
 *
 * EXISTING TABLES ONLY:
 *   applications
 *   customer_niches
 *   planner_runs
 *   users
 *   user_integrations
 *
 * SECRETS:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SARVAM_API_KEY
 *
 * ENDPOINTS:
 *   GET  /health
 *   POST /webhook
 *   POST /test
 *
 * SCHEDULE:
 *   Cloudflare Cron Trigger: */30 * * * *
 *
 * NO SQL MIGRATIONS.
 * NO NEW DATABASE TABLES.
 * NO PLANNER_SECRET.
 *
 * SARVAM IS USED ONLY FOR CUSTOMER NICHE GENERATION.
 * ============================================================
 */

const VERSION = "2.0.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const EXPECTED_NICHES = 10;

const MAX_NICHES_PER_RUN = 50;

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
        request.method === "POST" &&
        url.pathname === "/webhook"
      ) {
        return await handleWebhook(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/test"
      ) {
        return await handleManualTest(request, env);
      }

      return json({
        ok: false,
        error: "Use GET /health, POST /webhook, or POST /test"
      }, 404);

    } catch (error) {
      console.error("Worker request failed:", error);

      return json({
        ok: false,
        error: error.message || "Internal server error"
      }, 500);
    }
  },


  // ----------------------------------------------------------
  // CLOUDFLARE CRON TRIGGER
  // Runs every 30 minutes after the trigger is configured.
  // ----------------------------------------------------------

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduledTaskCreation(env)
    );
  }
};


// ============================================================
// MANUAL TEST ENDPOINT
// POST /test
//
// Example body:
// {
//   "action": "test_task_creation",
//   "application_id": "YOUR_APPLICATION_ID"
// }
//
// This runs task creation immediately for the specified app.
// It uses the same task creation logic as the Cron Trigger.
// ============================================================

async function handleManualTest(request, env) {
  const body = await request.json();

  if (body.action !== "test_task_creation") {
    return json({
      ok: false,
      error: "action must be test_task_creation"
    }, 400);
  }

  if (!body.application_id) {
    return json({
      ok: false,
      error: "application_id is required"
    }, 400);
  }

  const applicationId = String(body.application_id);

  const result = await createTasksForApplications(
    env,
    applicationId
  );

  return json({
    ok: true,
    mode: "manual_test",
    ...result
  });
}


// ============================================================
// SUPABASE APPLICATION WEBHOOK
//
// A new application triggers niche generation.
// ============================================================

async function handleWebhook(request, env) {
  const body = await request.json();

  const eventType = String(
    body.type || body.event || ""
  ).toUpperCase();

  if (
    eventType &&
    !eventType.includes("INSERT")
  ) {
    return json({
      ok: true,
      skipped: true,
      reason: "Not an INSERT event"
    });
  }

  const record =
    body.record ||
    body.application ||
    body;

  if (!record || !record.id) {
    return json({
      ok: false,
      error: "Application record with id is required"
    }, 400);
  }

  const app = await getLatestPendingApplication(env);

  if (!app) {
    return json({
      ok: true,
      processed: false,
      message: "No pending applications found"
    });
  }

  const claimed = await claimApplication(
    env,
    app.id
  );

  if (!claimed) {
    return json({
      ok: true,
      processed: false,
      message: "Application already claimed",
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
      "Niche generation failed:",
      claimed.id,
      error
    );

    await updateApplicationStatus(
      env,
      claimed.id,
      "failed"
    );

    return json({
      ok: false,
      application_id: claimed.id,
      error: error.message
    }, 500);
  }
}


// ============================================================
// LATEST PENDING APPLICATION
// ============================================================

async function getLatestPendingApplication(env) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?select=*" +
      "&planner_status=eq.pending" +
      "&order=created_at.desc" +
      "&limit=1"
  );

  return rows[0] || null;
}


// ============================================================
// CLAIM APPLICATION
// ============================================================

async function claimApplication(env, applicationId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?id=eq." + encodeURIComponent(applicationId) +
      "&planner_status=eq.pending",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: {
        planner_status: "processing"
      }
    }
  );

  return rows[0] || null;
}


// ============================================================
// GENERATE CUSTOMER NICHES
// ============================================================

async function processApplication(env, app) {
  const existing = await getNiches(env, app.id);

  if (existing.length >= EXPECTED_NICHES) {
    await updateApplicationStatus(
      env,
      app.id,
      "completed"
    );

    return {
      application_id: app.id,
      niches_found: existing.length,
      planner_status: "completed"
    };
  }

  const companyContext = JSON.stringify({
    application_id: app.id,
    company_name: app.company || app.name || "",
    application_name: app.name || "",
    domain: app.domain || ""
  }).slice(0, MAX_COMPANY_CONTEXT_CHARS);

  const generated = await generateCustomerNiches(
    env,
    companyContext
  );

  const niches = validateNiches(generated);

  const saved = await saveNiches(
    env,
    app,
    niches
  );

  if (saved.length < EXPECTED_NICHES) {
    throw new Error(
      "Could not save 10 unique customer niches"
    );
  }

  await createCompletionRecord(
    env,
    app,
    "Sarvam AI generated and saved 10 customer niches"
  );

  await updateApplicationStatus(
    env,
    app.id,
    "completed"
  );

  return {
    application_id: app.id,
    niches_saved: saved.length,
    planner_status: "completed"
  };
}


// ============================================================
// SARVAM AI — NICHE GENERATION ONLY
// ============================================================

async function generateCustomerNiches(
  env,
  companyContext
) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY");
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
          content:
            "Identify exactly 10 distinct customer niches " +
            "for the company. Return valid JSON only in this " +
            'shape: {"niches":[{"niche_name":"Specific segment",' +
            '"buying_intention":8}]}. Each score must be an ' +
            "integer from 1 to 10. Avoid duplicates and do not " +
            "invent company facts."
        },
        {
          role: "user",
          content: "Company context:\n" + companyContext
        }
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: {
        type: "json_object"
      }
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(
      "Sarvam error:",
      response.status,
      responseText
    );

    throw new Error(
      "Sarvam API returned HTTP " + response.status
    );
  }

  const apiResult = JSON.parse(responseText);

  const content =
    apiResult.choices?.[0]?.message?.content;

  const parsed = typeof content === "string"
    ? JSON.parse(content)
    : content;

  if (!parsed || !Array.isArray(parsed.niches)) {
    throw new Error("Sarvam response has no niches array");
  }

  return parsed.niches;
}


// ============================================================
// VALIDATE NICHE OUTPUT
// ============================================================

function validateNiches(niches) {
  const unique = new Map();

  for (const item of niches) {
    if (typeof item?.niche_name !== "string") {
      continue;
    }

    const name = item.niche_name.trim();
    const score = Number(item.buying_intention);

    if (
      !name ||
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
      "Expected 10 unique valid niches; received " +
      result.length
    );
  }

  return result;
}


// ============================================================
// READ CUSTOMER NICHES
// ============================================================

async function getNiches(env, applicationId) {
  return await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?select=*" +
      "&application_id=eq." +
      encodeURIComponent(applicationId) +
      "&order=created_at.asc"
  );
}


// ============================================================
// SAVE CUSTOMER NICHES
// ============================================================

async function saveNiches(env, app, generated) {
  const existing = await getNiches(env, app.id);

  const names = new Set(
    existing.map(row =>
      String(row.niche_name || "").trim().toLowerCase()
    )
  );

  const saved = [...existing];

  for (const niche of generated) {
    if (saved.length >= EXPECTED_NICHES) {
      break;
    }

    const key = niche.niche_name.toLowerCase();

    if (names.has(key)) {
      continue;
    }

    const rows = await supabaseRequest(
      env,
      "/rest/v1/customer_niches",
      {
        method: "POST",
        headers: {
          "Prefer": "return=representation"
        },
        body: {
          application_id: String(app.id),
          niche_name: niche.niche_name,
          buying_intention: niche.buying_intention,
          reddit_status: "pending",
          apollo_status: "pending",
          is_active: true,
          user_id: app.user_id || null
        }
      }
    );

    if (!rows.length) {
      throw new Error(
        "Inserted niche was not returned by Supabase"
      );
    }

    saved.push(rows[0]);
    names.add(key);
  }

  return saved;
}


// ============================================================
// CREATE COMPLETION MARKER
// ============================================================

async function createCompletionRecord(
  env,
  app,
  details
) {
  const task =
    "Customer niche analysis completed for " +
    String(app.company || app.name || app.id) +
    ". RESULT: " + details +
    ". COMPLETED AT: " + new Date().toISOString();

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
      "&limit=1"
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
      body: {
        application_id: String(app.id),
        user_id: app.user_id || null,
        worker_type: "planner",
        source: "system",
        task,
        pending_count: 0,
        error: null,
        niche: null
      }
    }
  );

  if (!rows.length) {
    throw new Error("Could not create completion record");
  }

  return rows[0];
}


// ============================================================
// CRON + MANUAL TEST — SHARED TASK CREATION
//
// Cron calls this every 30 minutes.
// POST /test calls this immediately for one application.
//
// Only saved, active niches are used.
// Sarvam is NOT called here.
// ============================================================

async function runScheduledTaskCreation(env) {
  console.log(
    "Scheduled task creation started:",
    new Date().toISOString()
  );

  try {
    const result = await createTasksForApplications(env);

    console.log(
      "Scheduled task creation finished:",
      JSON.stringify(result)
    );

    return result;

  } catch (error) {
    console.error(
      "Scheduled task creation failed:",
      error
    );

    throw error;
  }
}


// ============================================================
// FIND APPLICATIONS AND QUEUE THEIR PENDING NICHE TASKS
// ============================================================

async function createTasksForApplications(
  env,
  onlyApplicationId = null
) {
  const apps = onlyApplicationId
    ? await getApplication(env, onlyApplicationId)
    : await getCompletedApplications(env);

  const totals = {
    applications_checked: apps.length,
    niches_checked: 0,
    reddit_tasks_created: 0,
    apollo_tasks_created: 0,
    duplicates_skipped: 0,
    failures: []
  };

  for (const app of apps) {
    const niches = await getActiveNiches(
      env,
      app.id
    );

    for (const niche of niches) {
      totals.niches_checked++;

      // Process each worker independently so a Reddit
      // failure does not prevent Apollo from being queued.

      for (const kind of ["reddit", "apollo"]) {
        const statusField = kind + "_status";

        if (niche[statusField] !== "pending") {
          continue;
        }

        try {
          const result = await queueNicheTask(
            env,
            app,
            niche,
            kind
          );

          if (result.created) {
            if (kind === "reddit") {
              totals.reddit_tasks_created++;
            } else {
              totals.apollo_tasks_created++;
            }
          } else {
            totals.duplicates_skipped++;
          }

        } catch (error) {
          console.error(
            "Task creation failed:",
            kind,
            niche.id,
            error
          );

          totals.failures.push({
            application_id: app.id,
            niche_id: niche.id,
            worker_type: kind,
            error: error.message
          });
        }
      }
    }
  }

  return totals;
}


// ============================================================
// GET COMPLETED APPLICATIONS
// ============================================================

async function getCompletedApplications(env) {
  return await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?select=id,name,company,domain,user_id,planner_status" +
      "&planner_status=eq.completed" +
      "&order=created_at.desc" +
      "&limit=100"
  );
}


// ============================================================
// GET ONE APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?select=id,name,company,domain,user_id,planner_status" +
      "&id=eq." + encodeURIComponent(applicationId) +
      "&limit=1"
  );

  if (!rows.length) {
    throw new Error(
      "Application not found: " + applicationId
    );
  }

  return rows;
}


// ============================================================
// GET ACTIVE NICHES FOR AN APPLICATION
// ============================================================

async function getActiveNiches(env, applicationId) {
  return await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?select=*" +
      "&application_id=eq." +
      encodeURIComponent(applicationId) +
      "&is_active=eq.true" +
      "&order=created_at.asc" +
      "&limit=" + MAX_NICHES_PER_RUN
  );
}


// ============================================================
// CLAIM ONE NICHE STATUS
//
// Atomically changes pending -> processing.
// ============================================================

async function claimNicheStatus(
  env,
  niche,
  kind
) {
  const statusField = kind + "_status";

  const rows = await supabaseRequest(
    env,
    "/rest/v1/customer_niches" +
      "?id=eq." + encodeURIComponent(niche.id) +
      "&" + statusField + "=eq.pending",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: {
        [statusField]: "processing",
        updated_at: new Date().toISOString()
      }
    }
  );

  return rows[0] || null;
}


// ============================================================
// UPDATE NICHE STATUS
// ============================================================

async function updateNicheStatus(
  env,
  nicheId,
  kind,
  status
) {
  const statusField = kind + "_status";

  return await supabaseRequest(
    env,
    "/rest/v1/customer_niches?id=eq." +
      encodeURIComponent(nicheId),
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation"
      },
      body: {
        [statusField]: status,
        updated_at: new Date().toISOString()
      }
    }
  );
}


// ============================================================
// CHECK FOR EXISTING TASK
//
// One task per application + niche + worker type.
// ============================================================

async function findExistingTask(
  env,
  app,
  niche,
  kind
) {
  const workerType = kind === "reddit"
    ? "reddit_research"
    : "apollo";

  const rows = await supabaseRequest(
    env,
    "/rest/v1/planner_runs" +
      "?select=id" +
      "&application_id=eq." +
      encodeURIComponent(String(app.id)) +
      "&worker_type=eq." +
      encodeURIComponent(workerType) +
      "&source=eq.system" +
      "&niche=eq." +
      encodeURIComponent(String(niche.niche_name)) +
      "&limit=1"
  );

  return rows[0] || null;
}


// ============================================================
// CREATE ONE REDDIT OR APOLLO TASK
// ============================================================

async function queueNicheTask(
  env,
  app,
  niche,
  kind
) {
  const statusField = kind + "_status";

  // Claim first to prevent simultaneous Cron/manual requests
  // from creating the same task.

  const claimed = await claimNicheStatus(
    env,
    niche,
    kind
  );

  if (!claimed) {
    return {
      created: false,
      reason: "Already claimed or no longer pending"
    };
  }

  try {
    // If a prior attempt inserted the task but failed while
    // updating the niche status, recover without duplicating.

    const existing = await findExistingTask(
      env,
      app,
      niche,
      kind
    );

    if (existing) {
      await updateNicheStatus(
        env,
        niche.id,
        kind,
        "queued"
      );

      return {
        created: false,
        recovered_existing_task: true
      };
    }

    const task = kind === "reddit"
      ? buildRedditTask(app, niche)
      : buildApolloTask(app, niche);

    const workerType = kind === "reddit"
      ? "reddit_research"
      : "apollo";

    const rows = await supabaseRequest(
      env,
      "/rest/v1/planner_runs",
      {
        method: "POST",
        headers: {
          "Prefer": "return=representation"
        },
        body: {
          application_id: String(app.id),
          user_id: niche.user_id || app.user_id || null,
          worker_type: workerType,
          source: "system",
          task: JSON.stringify(task),
          pending_count: 1,
          error: null,
          niche: niche.niche_name
        }
      }
    );

    if (!rows.length) {
      throw new Error(
        "Supabase did not return the created task record"
      );
    }

    await updateNicheStatus(
      env,
      niche.id,
      kind,
      "queued"
    );

    console.log(
      "Task created:",
      workerType,
      niche.niche_name,
      rows[0].id
    );

    return {
      created: true,
      planner_run_id: rows[0].id
    };

  } catch (error) {
    // Do not permanently strand a niche in processing
    // when a task insertion or status update fails.

    try {
      await updateNicheStatus(
        env,
        niche.id,
        kind,
        "pending"
      );
    } catch (resetError) {
      console.error(
        "Could not reset niche status:",
        resetError
      );
    }

    throw error;
  }
}


// ============================================================
// BUILD REDDIT TASK
// No Sarvam API call.
// ============================================================

function buildRedditTask(app, niche) {
  return {
    task_id: "reddit_" + niche.id,
    application_id: String(app.id),
    niche_id: String(niche.id),
    worker: "reddit_research",
    objective:
      "Research recent customer problems, complaints, " +
      "buying signals, and unmet needs for this customer niche.",
    company: {
      name: app.company || app.name || "",
      domain: app.domain || ""
    },
    target_audience: niche.niche_name,
    buying_intention: niche.buying_intention,
    problem_categories: [
      "lead_generation",
      "customer_acquisition",
      "sales",
      "outreach",
      "workflow_automation",
      "unmet_customer_needs"
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
    instructions:
      "Research only publicly available posts. " +
      "Extract source URLs, the customer problem, " +
      "evidence of buying intent, and a concise summary. " +
      "Do not invent posts or evidence."
  };
}


// ============================================================
// BUILD APOLLO TASK
// No Sarvam API call.
// ============================================================

function buildApolloTask(app, niche) {
  return {
    task_id: "apollo_" + niche.id,
    application_id: String(app.id),
    niche_id: String(niche.id),
    worker: "apollo",
    objective:
      "Find and qualify relevant business leads for this " +
      "customer niche using the connected Apollo integration.",
    company: {
      name: app.company || app.name || "",
      domain: app.domain || ""
    },
    target_audience: niche.niche_name,
    buying_intention: niche.buying_intention,
    lead_target_count: 50,
    preferred_fields: [
      "full_name",
      "job_title",
      "company_name",
      "work_email",
      "linkedin_url",
      "company_website",
      "location"
    ],
    instructions:
      "Use the user's connected Apollo integration if available. " +
      "Respect integration permissions and API limits. " +
      "Do not invent contacts or email addresses. " +
      "Save source and enrichment evidence for each lead. " +
      "Do not send outreach emails unless a separate " +
      "authorized workflow explicitly requests it."
  };
}


// ============================================================
// SUPABASE REST CLIENT
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const headers = new Headers(options.headers || {});

  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);

  headers.set(
    "Authorization",
    "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
  );

  let requestBody = options.body;

  if (requestBody !== undefined) {
    headers.set("Content-Type", "application/json");

    if (typeof requestBody !== "string") {
      requestBody = JSON.stringify(requestBody);
    }
  }

  const response = await fetch(
    baseUrl + path,
    {
      method: options.method || "GET",
      headers,
      body: requestBody
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase error:",
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
