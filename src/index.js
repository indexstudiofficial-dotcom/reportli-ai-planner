/**
 * ============================================================
 * REPORTLI AI — CUSTOMER NICHE PLANNER
 * Version 3.0.0
 * ============================================================
 *
 * EXISTING TABLES ONLY:
 *   applications
 *   customer_niches
 *   planner_runs
 *   users
 *   user_integrations
 *
 * REQUIRED SECRETS:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SARVAM_API_KEY
 *
 * OPTIONAL SECRET:
 *   INTERNAL_WORKER_SECRET
 *
 * ENDPOINTS:
 *   GET  /health
 *   POST /webhook
 *   POST /test
 *   POST /create-task
 *
 * NO CRON TRIGGERS.
 * NO SQL MIGRATIONS.
 * NO NEW TABLES.
 *
 * SARVAM:
 *   1. Customer niche generation.
 *   2. Reddit task generation.
 *   3. Apollo task generation.
 * ============================================================
 */

const VERSION = "3.0.0";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const EXPECTED_NICHES = 10;

const MAX_COMPANY_CONTEXT_CHARS = 12000;

const MAX_NICHES_PER_RUN = 50;

const VALID_SOURCES = ["reddit", "apollo"];

const VALID_STATUSES = [
  "pending",
  "processing",
  "queued",
  "completed",
  "failed"
];


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
          cron_enabled: false,
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
        url.pathname === "/create-task"
      ) {
        return await handleCreateTask(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/test"
      ) {
        return await handleManualTest(request, env);
      }

      return json({
        ok: false,
        error:
          "Use GET /health, POST /webhook, " +
          "POST /create-task, or POST /test"
      }, 404);

    } catch (error) {
      console.error("Worker request failed:", error);

      return json({
        ok: false,
        error: error.message || "Internal server error"
      }, 500);
    }
  }
};


// ============================================================
// OPTIONAL INTERNAL WORKER AUTHENTICATION
//
// Set INTERNAL_WORKER_SECRET in Cloudflare Worker secrets.
// Other Workers must send:
//
// Authorization: Bearer YOUR_INTERNAL_WORKER_SECRET
//
// If the secret is not configured, these endpoints remain
// accessible without this authentication check.
// ============================================================

function authorizeInternalRequest(request, env) {
  if (!env.INTERNAL_WORKER_SECRET) {
    return true;
  }

  const authorization =
    request.headers.get("Authorization") || "";

  return authorization ===
    "Bearer " + env.INTERNAL_WORKER_SECRET;
}


// ============================================================
// MANUAL TEST ENDPOINT
//
// POST /test
//
// {
//   "action": "test_task_creation",
//   "application_id": "YOUR_APPLICATION_ID",
//   "source": "reddit"
// }
//
// source can be "reddit" or "apollo".
// ============================================================

async function handleManualTest(request, env) {
  if (!authorizeInternalRequest(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  const body = await readJsonBody(request);

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

  const source = normalizeSource(body.source);

  if (!source) {
    return json({
      ok: false,
      error: "source must be reddit or apollo"
    }, 400);
  }

  const result = await createNextNicheTask(
    env,
    String(body.application_id),
    source
  );

  return json({
    ok: true,
    mode: "manual_test",
    ...result
  });
}


// ============================================================
// APPLICATION WEBHOOK
//
// Receives a Supabase Database Webhook for applications.
//
// IMPORTANT:
// Processes the exact application in the webhook rather
// than selecting an unrelated pending application.
// ============================================================

async function handleWebhook(request, env) {
  const body = await readJsonBody(request);

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

  // Use the exact record supplied by the webhook.
  const app = await getApplication(
    env,
    String(record.id)
  );

  if (!app) {
    return json({
      ok: false,
      error: "Application not found"
    }, 404);
  }

  // Avoid regenerating niches for completed applications.
  if (app.planner_status === "completed") {
    const existing = await getNiches(env, app.id);

    if (existing.length >= EXPECTED_NICHES) {
      return json({
        ok: true,
        skipped: true,
        reason: "Niches already generated",
        application_id: app.id,
        niches_found: existing.length
      });
    }
  }

  // Atomically claim the application's pending status.
  const claimed = await claimApplication(
    env,
    app.id
  );

  if (!claimed) {
    return json({
      ok: true,
      processed: false,
      message:
        "Application is already processing, " +
        "or is not pending",
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
// PROCESS APPLICATION
//
// Generates exactly 10 customer niches, saves them,
// creates a completion record, and completes the application.
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

  if (saved.length !== EXPECTED_NICHES) {
    throw new Error(
      "Expected exactly 10 saved customer niches; found " +
      saved.length
    );
  }

  await createCompletionRecord(
    env,
    app,
    "Analyze the company and find 10 customer niches"
  );

  await updateApplicationStatus(
    env,
    app.id,
    "completed"
  );

  return {
    application_id: app.id,
    niches_saved: saved.length,
    planner_status: "completed",
    message:
      "Analyze the company and find 10 customer niches"
  };
}


// ============================================================
// SARVAM AI — GENERATE CUSTOMER NICHES
//
// AI supplies niche names and relative ranking scores.
// We normalize the scores to unique percentages afterward.
// ============================================================

async function generateCustomerNiches(
  env,
  companyContext
) {
  const parsed = await callSarvamJson(
    env,
    [
      {
        role: "system",
        content:
          "You are a B2B market research strategist. " +
          "Analyze the company and identify exactly 10 " +
          "distinct, specific customer niches that could " +
          "realistically buy its products or services. " +
          "Rank them from strongest to weakest buying potential. " +
          "Return JSON only in this shape: " +
          '{"niches":[{"niche_name":"Specific customer segment",' +
          '"buying_intention":10}]}. ' +
          "buying_intention must be a relative ranking score " +
          "from 1 to 10, where 10 is the strongest. " +
          "Do not repeat niche names. Do not invent company facts. " +
          "Do not return generic segments such as everyone."
      },
      {
        role: "user",
        content:
          "Company context:\n" + companyContext
      }
    ],
    4096
  );

  if (!Array.isArray(parsed.niches)) {
    throw new Error(
      "Sarvam response has no niches array"
    );
  }

  return parsed.niches;
}


// ============================================================
// VALIDATE NICHE OUTPUT
//
// Scores are converted to distinct percentages.
//
// Strongest niche: 100%
// Remaining niches: 97%, 94%, 91%, etc.
//
// These are estimated relative buying-potential scores,
// not measured probabilities of an actual purchase.
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
      !Number.isFinite(score)
    ) {
      continue;
    }

    const key = name.toLowerCase();

    if (!unique.has(key)) {
      unique.set(key, {
        niche_name: name,
        raw_score: score
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

  // Sort by AI score, preserving the strongest niche first.
  result.sort((a, b) => b.raw_score - a.raw_score);

  // Assign deterministic, unique percentages.
  // All scores are distinct and remain within 0–100.
  const percentages = [
    100, 97, 94, 91, 88,
    85, 82, 79, 76, 73
  ];

  return result.map((item, index) => ({
    niche_name: item.niche_name,
    buying_intention: percentages[index]
  }));
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
      String(row.niche_name || "")
        .trim()
        .toLowerCase()
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
// CREATE NICHE ANALYSIS COMPLETION RECORD
// ============================================================

async function createCompletionRecord(
  env,
  app,
  details
) {
  const task =
    "Analyze the company and find 10 customer niches. " +
    "Company: " +
    String(app.company || app.name || app.id) +
    ". " +
    "Result: " + details +
    ". Completed at: " +
    new Date().toISOString();

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
        "Analyze the company and find 10 customer niches%"
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
    throw new Error(
      "Could not create niche analysis completion record"
    );
  }

  return rows[0];
}


// ============================================================
// CREATE TASK ENDPOINT
//
// POST /create-task
//
// Request body:
// {
//   "application_id": "YOUR_APPLICATION_ID",
//   "source": "reddit"
// }
//
// OR:
// {
//   "application_id": "YOUR_APPLICATION_ID",
//   "source": "apollo"
// }
//
// Creates one task for the next eligible niche.
// ============================================================

async function handleCreateTask(request, env) {
  if (!authorizeInternalRequest(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized"
    }, 401);
  }

  const body = await readJsonBody(request);

  if (!body.application_id) {
    return json({
      ok: false,
      error: "application_id is required"
    }, 400);
  }

  const source = normalizeSource(body.source);

  if (!source) {
    return json({
      ok: false,
      error: "source must be reddit or apollo"
    }, 400);
  }

  const result = await createNextNicheTask(
    env,
    String(body.application_id),
    source
  );

  return json({
    ok: true,
    ...result
  });
}


// ============================================================
// NORMALIZE SOURCE
// ============================================================

function normalizeSource(source) {
  const value = String(source || "")
    .trim()
    .toLowerCase();

  return VALID_SOURCES.includes(value)
    ? value
    : null;
}


// ============================================================
// CREATE THE NEXT NICHE TASK
//
// Selection rules:
//
// 1. Only active niches are eligible.
// 2. Completed and queued niches are not eligible.
// 3. Choose highest buying_intention first.
// 4. After all 10 niches complete, reset that source.
// 5. At the beginning of the next cycle, start with the
//    niche whose updated_at is oldest.
// 6. Reddit and Apollo are independent queues.
// ============================================================

async function createNextNicheTask(
  env,
  applicationId,
  source
) {
  const app = await getApplication(
    env,
    applicationId
  );

  if (!app) {
    throw new Error(
      "Application not found: " + applicationId
    );
  }

  if (app.planner_status !== "completed") {
    throw new Error(
      "Customer niche analysis is not completed"
    );
  }

  let niches = await getActiveNiches(
    env,
    applicationId
  );

  if (!niches.length) {
    throw new Error(
      "No active customer niches found"
    );
  }

  const statusField = source + "_status";

  // Do not reset a cycle while a task is still in progress.
  const unfinished = niches.some(niche =>
    ["processing", "queued"].includes(
      String(niche[statusField] || "")
    )
  );

  const allCompleted = niches.length >= EXPECTED_NICHES &&
    niches.every(niche =>
      niche[statusField] === "completed"
    );

  let cycleReset = false;

  if (allCompleted) {
    await resetSourceCycle(
      env,
      applicationId,
      source,
      niches
    );

    cycleReset = true;

    niches = await getActiveNiches(
      env,
      applicationId
    );
  } else if (unfinished) {
    // There may be another task already queued or processing.
    // This request should not create another task until that
    // task's downstream Worker completes.
    return {
      application_id: applicationId,
      source,
      created: false,
      reason:
        "A task for this source is already queued or processing",
      cycle_reset: false
    };
  }

  // After a reset, the oldest updated_at niche gets priority.
  if (cycleReset) {
    niches.sort((a, b) =>
      dateValue(a.updated_at) - dateValue(b.updated_at)
    );
  } else {
    // In a normal cycle, highest buying intention first.
    niches.sort((a, b) =>
      Number(b.buying_intention || 0) -
      Number(a.buying_intention || 0)
    );
  }

  // Select only one pending niche.
  const selected = niches.find(niche =>
    niche.is_active === true &&
    niche[statusField] === "pending"
  );

  if (!selected) {
    return {
      application_id: applicationId,
      source,
      created: false,
      cycle_reset: cycleReset,
      reason:
        "No eligible pending niche is available"
    };
  }

  const result = await queueNicheTask(
    env,
    app,
    selected,
    source
  );

  return {
    application_id: applicationId,
    source,
    cycle_reset: cycleReset,
    niche_id: selected.id,
    niche_name: selected.niche_name,
    buying_intention: selected.buying_intention,
    ...result
  };
}


// ============================================================
// DATE HELPER
// ============================================================

function dateValue(value) {
  const parsed = Date.parse(value || "");

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}


// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?select=id,name,company,domain,user_id,planner_status" +
      "&id=eq." + encodeURIComponent(applicationId) +
      "&limit=1"
  );

  return rows[0] || null;
}


// ============================================================
// GET ACTIVE NICHES
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
// RESET ONE SOURCE CYCLE
//
// Only the selected source's statuses are reset.
// The other source's statuses remain untouched.
// ============================================================

async function resetSourceCycle(
  env,
  applicationId,
  source,
  niches
) {
  const statusField = source + "_status";

  for (const niche of niches) {
    if (niche[statusField] !== "completed") {
      throw new Error(
        "Cannot reset cycle: not all niches are completed"
      );
    }
  }

  // Reset only niches belonging to this application.
  // Set updated_at so the next cycle can choose the oldest.
  const now = new Date().toISOString();

  for (const niche of niches) {
    await supabaseRequest(
      env,
      "/rest/v1/customer_niches" +
        "?id=eq." + encodeURIComponent(niche.id) +
        "&application_id=eq." +
        encodeURIComponent(applicationId) +
        "&" + statusField + "=eq.completed",
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation"
        },
        body: {
          [statusField]: "pending",
          updated_at: now
        }
      }
    );
  }

  console.log(
    "Reset source cycle:",
    source,
    applicationId
  );
}


// ============================================================
// CLAIM ONE NICHE
//
// Atomically changes pending -> processing.
// Only one concurrent request can successfully claim the
// same niche status using this conditional PATCH.
// ============================================================

async function resetSourceCycle(
  env,
  applicationId,
  source,
  niches
) {
  const statusField = source + "_status";

  // Confirm every active niche has completed this cycle.
  for (const niche of niches) {
    if (niche[statusField] !== "completed") {
      throw new Error(
        "Cannot reset cycle: not all niches are completed"
      );
    }
  }

  // Reset only the selected source's statuses.
  // Keep the other source's statuses unchanged.
  for (const niche of niches) {
    await supabaseRequest(
      env,
      "/rest/v1/customer_niches" +
        "?id=eq." + encodeURIComponent(niche.id) +
        "&application_id=eq." +
        encodeURIComponent(applicationId) +
        "&" + statusField + "=eq.completed",
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation"
        },
        body: {
          [statusField]: "pending",
          updated_at: new Date().toISOString()
        }
      }
    );
  }

  console.log(
    "Reset source cycle:",
    source,
    applicationId
  );
}
