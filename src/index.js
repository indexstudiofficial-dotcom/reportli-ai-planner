/**
 * ============================================================
 * COMPANY PLANNER WORKER — VERSION 11
 * ============================================================
 *
 * WORKFLOW
 *
 * 1. Create one company-analysis task.
 * 2. Generate and save 10 customer niches.
 * 3. Mark the analysis task completed.
 * 4. Wait 30 minutes.
 * 5. Create one niche task.
 * 6. Wait until that task finishes.
 * 7. Create the next task on a later run.
 *
 * IMPORTANT
 *
 * - planner_runs.task is plain TEXT.
 * - No integration-prompt rows are created.
 * - No planner_runs.status column is required.
 * - No customer_niches.is_active column is required.
 * - No SQL migration is required.
 *
 * REQUIRED ENVIRONMENT VARIABLES
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 *
 * OPTIONAL
 *
 * CRON_SECRET
 *
 * RECOMMENDED CRON
 *
 * Every 5 minutes.
 *
 * ============================================================
 */

const VERSION = "11.0.0";

const ANALYSIS_DELAY_MS = 30 * 60 * 1000;

const TARGET_NICHES = 10;

const TARGET_REDDIT_POSTS = 20;

const TARGET_APOLLO_LEADS = 20;


/* ============================================================
   1. CLOUDFLARE ENTRY POINTS
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return json({
        ok: true,
        worker: "company-planner-worker",
        version: VERSION
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/run"
    ) {
      if (
        env.CRON_SECRET &&
        request.headers.get("Authorization") !==
          `Bearer ${env.CRON_SECRET}`
      ) {
        return json(
          { ok: false, error: "Unauthorized" },
          401
        );
      }

      try {
        const result = await runPlanner(env);

        return json({
          ok: true,
          version: VERSION,
          result
        });
      } catch (error) {
        console.error("Planner error:", error);

        return json({
          ok: false,
          error: error.message
        }, 500);
      }
    }

    return json({
      error: "Not found",
      available_endpoints: [
        "GET /health",
        "POST /run"
      ]
    }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPlanner(env).catch(error => {
        console.error(
          "Scheduled planner error:",
          error
        );
      })
    );
  }
};


/* ============================================================
   2. GENERAL HELPERS
   ============================================================ */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}


function str(value) {
  return value == null
    ? ""
    : String(value).trim();
}


function norm(value) {
  return str(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
}


function parseDate(value) {
  const timestamp = Date.parse(value || "");

  return Number.isFinite(timestamp)
    ? timestamp
    : null;
}


function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}


function taskLines(values) {
  return values
    .filter(value => value !== null && value !== undefined)
    .join("\n");
}


/* ============================================================
   3. SUPABASE REST HELPERS
   ============================================================ */

function getConfig(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("SUPABASE_URL is missing");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  return {
    url: env.SUPABASE_URL.replace(/\/+$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY
  };
}


async function db(env, table, options = {}) {
  const cfg = getConfig(env);

  const url = new URL(
    `${cfg.url}/rest/v1/${table}`
  );

  for (const [key, value] of Object.entries(
    options.query || {}
  )) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    Accept: "application/json"
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const raw = await response.text();

  let result = null;

  try {
    result = raw ? JSON.parse(raw) : null;
  } catch {
    result = raw;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${table}: ${response.status} ${raw}`
    );
  }

  return result;
}


async function select(env, table, query) {
  const result = await db(env, table, { query });

  return Array.isArray(result)
    ? result
    : [];
}


async function insert(env, table, rows) {
  return await db(env, table, {
    method: "POST",
    query: {
      select: "*"
    },
    body: rows,
    prefer: "return=representation"
  });
}


async function update(env, table, query, changes) {
  return await db(env, table, {
    method: "PATCH",
    query,
    body: changes,
    prefer: "return=representation"
  });
}


/* ============================================================
   4. APPLICATIONS
   ============================================================ */

async function getApplications(env) {
  return await select(env, "applications", {
    select: [
      "id",
      "name",
      "user_id",
      "company",
      "domain",
      "created_at",
      "planner_status"
    ].join(","),
    order: "created_at.asc",
    limit: "500"
  });
}


/* ============================================================
   5. COMPANY CONTEXT
   ============================================================ */

async function getCompanyContext(env, app) {
  const parts = [
    `Company name: ${str(app.name) || "Unknown company"}`
  ];

  if (app.company) {
    parts.push(`Company information: ${app.company}`);
  }

  if (app.domain) {
    parts.push(`Domain: ${app.domain}`);
  }

  try {
    const rows = await select(env, "business_data", {
      select: "field,data",
      application_id: `eq.${app.id}`,
      limit: "100"
    });

    for (const row of rows) {
      let value = row.data;

      if (typeof value !== "string") {
        value = JSON.stringify(value ?? "");
      }

      parts.push(
        `${row.field}: ${str(value).slice(0, 2000)}`
      );
    }
  } catch (error) {
    console.warn(
      "Optional business data unavailable:",
      errorMessage(error)
    );
  }

  return parts.join("\n").slice(0, 12000);
}


/* ============================================================
   6. GENERATE CUSTOMER NICHES
   ============================================================ */

/*
 * This is rule-based generation, not an AI API call.
 *
 * You can replace this function with your Sarvam planner
 * later without changing the one-task-at-a-time workflow.
 */

function generateNiches(app, context) {
  const profile = norm([
    app.name,
    app.company,
    app.domain,
    context
  ].join(" "));

  if (
    /saas|software|developer|programming|bug|error|monitoring|web app|next\.?js|react|api|no.code|vibe.cod|replit|lovable|cursor|vercel/.test(profile)
  ) {
    return [
      ["Vibe-coding and no-code founders", 10],
      ["Early-stage SaaS founders", 10],
      ["Indie hackers building SaaS products", 9],
      ["Solo software developers", 9],
      ["Software development agencies", 9],
      ["React and Next.js developers", 8],
      ["DevOps and platform engineers", 8],
      ["Engineering managers at small SaaS companies", 8],
      ["Startup CTOs and technical co-founders", 8],
      ["B2B SaaS product teams", 7]
    ];
  }

  if (
    /lead generation|lead gen|prospecting|cold email|outreach|sales automation|crm/.test(profile)
  ) {
    return [
      ["Early-stage B2B SaaS founders", 10],
      ["Small B2B sales teams", 10],
      ["Lead generation agencies", 9],
      ["Outbound sales agencies", 9],
      ["Solo sales consultants", 9],
      ["Founder-led sales teams", 8],
      ["B2B marketing agencies", 8],
      ["Recruitment agencies", 8],
      ["Small business development teams", 7],
      ["B2B service providers", 7]
    ];
  }

  if (
    /shopify|ecommerce|e-commerce|online store|retail/.test(profile)
  ) {
    return [
      ["Small Shopify store owners", 10],
      ["Direct-to-consumer brands", 10],
      ["Growing online retailers", 9],
      ["Subscription commerce brands", 9],
      ["Marketplace sellers", 8],
      ["Independent fashion brands", 8],
      ["Beauty and skincare stores", 8],
      ["Home and lifestyle stores", 7],
      ["Multi-product online retailers", 7],
      ["E-commerce marketing agencies", 7]
    ];
  }

  return [
    ["Small and medium-sized businesses", 10],
    ["Early-stage startup founders", 10],
    ["Solo entrepreneurs", 9],
    ["Small B2B service businesses", 9],
    ["Growing digital-first businesses", 8],
    ["Professional service firms", 8],
    ["Business consultants", 8],
    ["Small marketing agencies", 7],
    ["Online businesses and creators", 7],
    ["Operations managers at growing companies", 7]
  ];
}


/* ============================================================
   7. PARSE OLD TASK FORMATS
   ============================================================ */

/*
 * Older versions may have stored JSON inside the TEXT column.
 * We parse it only to identify legacy tasks.
 *
 * All newly created task descriptions are ordinary text.
 */

function parseLegacyJson(value) {
  const source = str(value);

  if (!source.startsWith("{")) {
    return null;
  }

  try {
    const result = JSON.parse(source);

    return result &&
      typeof result === "object" &&
      !Array.isArray(result)
      ? result
      : null;
  } catch {
    return null;
  }
}


function getState(task) {
  const match = str(task).match(
    /^STATE:\s*(.+)$/im
  );

  return match
    ? norm(match[1])
    : "";
}


function isAnalysisTask(row) {
  const task = str(row.task).toLowerCase();

  if (
    /task type:\s*company_analysis/i.test(task) ||
    /action:\s*generate_customer_niches/i.test(task) ||
    /"action"\s*:\s*"generate_customer_niches"/i.test(task) ||
    /"worker"\s*:\s*"company_analysis"/i.test(task)
  ) {
    return true;
  }

  const legacy = parseLegacyJson(row.task);

  if (!legacy) {
    return false;
  }

  return (
    legacy.action === "generate_customer_niches" ||
    legacy.worker === "company_analysis" ||
    legacy.task_type === "company_analysis"
  );
}


/* ============================================================
   8. READ PLANNER TASKS
   ============================================================ */

async function getPlannerRows(env, applicationId) {
  return await select(env, "planner_runs", {
    select: [
      "id",
      "application_id",
      "user_id",
      "worker_type",
      "source",
      "task",
      "pending_count",
      "error",
      "niche",
      "created_at",
      "started_at"
    ].join(","),
    application_id: `eq.${applicationId}`,
    worker_type: "eq.planner",
    source: "eq.system",
    order: "created_at.asc",
    limit: "500"
  });
}


/* ============================================================
   9. RETIRE LEGACY AUTO-GENERATED TASKS
   ============================================================ */

/*
 * Old versions may have created:
 *
 * - 10 Reddit tasks
 * - 10 Apollo tasks
 * - 2 integration prompts
 *
 * This function retires recognizable legacy-generated tasks.
 *
 * It does NOT delete rows.
 * It does NOT retire new plain-text tasks.
 *
 * If you have other Workers that execute legacy tasks, make
 * sure they also ignore rows with pending_count = 0.
 */

function isLegacyAutoGeneratedTask(row) {
  const legacy = parseLegacyJson(row.task);

  if (!legacy) {
    return false;
  }

  if (
    legacy.type === "integration_prompt" ||
    legacy.task_type === "integration_prompt"
  ) {
    return (
      row.worker_type === "planner" &&
      row.source === "system"
    );
  }

  const worker = norm(legacy.worker);
  const source = norm(row.source);

  return (
    (
      worker === "reddit_research" &&
      source === "reddit"
    ) ||
    (
      worker === "apollo_lead_generation" &&
      source === "apollo"
    )
  );
}


async function retireLegacyTasks(env, appId) {
  const rows = await getExecutionTasks(env, appId);

  let retired = 0;

  for (const row of rows) {
    if (!isLegacyAutoGeneratedTask(row)) {
      continue;
    }

    if (Number(row.pending_count) === 0) {
      continue;
    }

    const oldTask = parseLegacyJson(row.task) || {};

    const oldWorker = str(oldTask.worker || oldTask.type);

    const replacementText = taskLines([
      "TASK TYPE: legacy_task",
      `APPLICATION ID: ${appId}`,
      `PREVIOUS WORKER: ${oldWorker || "unknown"}`,
      "STATE: superseded",
      "REASON: Replaced by sequential company planner.",
      `RETIRED AT: ${new Date().toISOString()}`
    ]);

    await update(
      env,
      "planner_runs",
      { id: `eq.${row.id}` },
      {
        task: replacementText,
        pending_count: 0,
        error: null
      }
    );

    retired++;
  }

  return retired;
}


/* ============================================================
   10. CREATE ONE COMPANY-ANALYSIS TASK
   ============================================================ */

async function createAnalysisTask(env, app) {
  const rows = await getPlannerRows(env, app.id);

  const existing = rows.find(isAnalysisTask);

  if (existing) {
    return {
      created: false,
      row: existing
    };
  }

  const companyName = str(app.name) || "Unnamed company";

  const task = taskLines([
    "TASK TYPE: company_analysis",
    `APPLICATION ID: ${app.id}`,
    `COMPANY NAME: ${companyName}`,
    `OBJECTIVE: Analyze the company and find 10 customer niches for ${companyName}.`,
    "ACTION: generate_customer_niches",
    `TARGET NICHES: ${TARGET_NICHES}`,
    "STATE: pending"
  ]);

  const result = await insert(env, "planner_runs", [
    {
      application_id: app.id,
      user_id: app.user_id || null,
      worker_type: "planner",
      source: "system",
      task,
      pending_count: 1,
      error: null,
      niche: null
    }
  ]);

  if (!result || !result[0]) {
    throw new Error(
      "Failed to insert company-analysis task"
    );
  }

  return {
    created: true,
    row: result[0]
  };
}


/* ============================================================
   11. SAVE CUSTOMER NICHES
   ============================================================ */

async function saveNiches(env, app, context) {
  const generated = generateNiches(app, context);

  const existing = await select(env, "customer_niches", {
    select: "id,niche_name",
    application_id: `eq.${app.id}`,
    limit: "500"
  });

  const existingNames = new Set(
    existing.map(row => norm(row.niche_name))
  );

  const newRows = generated
    .filter(([name]) => !existingNames.has(norm(name)))
    .slice(0, TARGET_NICHES)
    .map(([name, score]) => ({
      application_id: app.id,
      niche_name: name,
      buying_intention: score,
      reddit_status: "pending",
      apollo_status: "pending",
      user_id: app.user_id || null
    }));

  if (newRows.length > 0) {
    await insert(env, "customer_niches", newRows);
  }

  return await select(env, "customer_niches", {
    select: [
      "id",
      "niche_name",
      "buying_intention",
      "reddit_status",
      "apollo_status",
      "user_id",
      "created_at"
    ].join(","),
    application_id: `eq.${app.id}`,
    order: "created_at.asc",
    limit: "500"
  });
}


/* ============================================================
   12. PROCESS COMPANY ANALYSIS
   ============================================================ */

async function processAnalysis(env, app, row) {
  const state = getState(row.task);

  if (
    state === "completed" &&
    Number(row.pending_count) === 0
  ) {
    return {
      completed: true,
      already_completed: true
    };
  }

  if (
    state === "failed" ||
    state === "superseded"
  ) {
    return {
      completed: false,
      blocked: true
    };
  }

  /*
   * Do not restart an analysis task that is already working.
   * A task that is stuck in working needs investigation rather
   * than another insert or repeated processing.
   */
  if (state === "working") {
    return {
      completed: false,
      already_working: true
    };
  }

  if (Number(row.pending_count) === 0) {
    return {
      completed: false,
      blocked: true
    };
  }

  const startedAt =
    row.started_at || new Date().toISOString();

  const companyName =
    str(app.name) || "Unnamed company";

  const workingText = taskLines([
    "TASK TYPE: company_analysis",
    `APPLICATION ID: ${app.id}`,
    `COMPANY NAME: ${companyName}`,
    `OBJECTIVE: Analyze the company and find 10 customer niches for ${companyName}.`,
    "ACTION: generate_customer_niches",
    `TARGET NICHES: ${TARGET_NICHES}`,
    "STATE: working",
    `STARTED AT: ${startedAt}`
  ]);

  await update(
    env,
    "planner_runs",
    { id: `eq.${row.id}` },
    {
      task: workingText,
      started_at: startedAt,
      pending_count: 1,
      error: null
    }
  );

  try {
    const context = await getCompanyContext(env, app);

    const niches = await saveNiches(
      env,
      app,
      context
    );

    const completedAt = new Date().toISOString();

    const completedText = taskLines([
      "TASK TYPE: company_analysis",
      `APPLICATION ID: ${app.id}`,
      `COMPANY NAME: ${companyName}`,
      `OBJECTIVE: Analyze the company and find 10 customer niches for ${companyName}.`,
      "ACTION: generate_customer_niches",
      `TARGET NICHES: ${TARGET_NICHES}`,
      "STATE: completed",
      `STARTED AT: ${startedAt}`,
      `COMPLETED AT: ${completedAt}`,
      `TOTAL NICHES SAVED: ${niches.length}`
    ]);

    await update(
      env,
      "planner_runs",
      { id: `eq.${row.id}` },
      {
        task: completedText,
        pending_count: 0,
        error: null,
        started_at: startedAt
      }
    );

    await update(
      env,
      "applications",
      { id: `eq.${app.id}` },
      {
        planner_status: "working"
      }
    );

    return {
      completed: true,
      completed_at: completedAt,
      niches_saved: niches.length
    };
  } catch (error) {
    const message = errorMessage(error);

    await update(
      env,
      "planner_runs",
      { id: `eq.${row.id}` },
      {
        task: taskLines([
          "TASK TYPE: company_analysis",
          `APPLICATION ID: ${app.id}`,
          `COMPANY NAME: ${companyName}`,
          "STATE: failed",
          `ERROR: ${message}`
        ]),
        pending_count: 0,
        error: message,
        started_at: startedAt
      }
    );

    throw error;
  }
}


/* ============================================================
   13. INTEGRATION CHECK
   ============================================================ */

async function getIntegrations(env, app) {
  let rows = [];

  try {
    rows = await select(env, "user_integrations", {
      select: [
        "id",
        "user_id",
        "application_id",
        "integration_id",
        "connection_id",
        "status"
      ].join(","),
      application_id: `eq.${app.id}`,
      status: "eq.connected",
      limit: "200"
    });
  } catch (error) {
    console.warn(
      "Application integration lookup failed:",
      errorMessage(error)
    );
  }

  /*
   * Include user-level integrations only when there is no
   * application-specific integration record.
   */

  if (app.user_id) {
    try {
      const userRows = await select(
        env,
        "user_integrations",
        {
          select: [
            "id",
            "user_id",
            "application_id",
            "integration_id",
            "connection_id",
            "status"
          ].join(","),
          user_id: `eq.${app.user_id}`,
          application_id: "is.null",
          status: "eq.connected",
          limit: "200"
        }
      );

      rows = rows.concat(userRows);
    } catch (error) {
      console.warn(
        "User integration lookup failed:",
        errorMessage(error)
      );
    }
  }

  const unique = [
    ...new Map(
      rows.map(row => [row.id, row])
    ).values()
  ];

  const names = unique.map(row =>
    norm(row.integration_id)
  );

  return {
    reddit: names.some(name =>
      name.includes("reddit")
    ),

    apollo: names.some(name =>
      name.includes("apollo")
    )
  };
}


/* ============================================================
   14. READ EXECUTION TASKS
   ============================================================ */

async function getExecutionTasks(env, appId) {
  return await select(env, "planner_runs", {
    select: [
      "id",
      "application_id",
      "user_id",
      "worker_type",
      "source",
      "task",
      "pending_count",
      "error",
      "niche",
      "created_at",
      "started_at"
    ].join(","),
    application_id: `eq.${appId}`,
    order: "created_at.asc",
    limit: "1000"
  });
}


function isExecutionTask(row) {
  return (
    row.worker_type === "research" ||
    row.worker_type === "lead_generation"
  );
}


function isNewPlainTextTask(row) {
  return /^TASK TYPE:\s*niche_execution/im.test(
    str(row.task)
  );
}


/* ============================================================
   15. RECONCILE COMPLETED TASKS
   ============================================================ */

/*
 * The external Reddit/Apollo executor should set:
 *
 * pending_count = 0
 *
 * when processing finishes.
 *
 * If a task has finished but its niche status remains running,
 * this function updates the status accordingly.
 */

function extractTaskValue(task, label) {
  const escaped = label.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const match = str(task).match(
    new RegExp(
      `^${escaped}:\\s*(.+)$`,
      "im"
    )
  );

  return match ? str(match[1]) : "";
}


async function reconcileFinishedTasks(env, appId) {
  const rows = await getExecutionTasks(env, appId);

  for (const row of rows) {
    if (!isNewPlainTextTask(row)) {
      continue;
    }

    if (Number(row.pending_count) !== 0) {
      continue;
    }

    const nicheId = extractTaskValue(
      row.task,
      "NICHE ID"
    );

    const source = norm(
      extractTaskValue(row.task, "SOURCE")
    );

    if (!nicheId) {
      continue;
    }

    const statusColumn =
      source === "reddit"
        ? "reddit_status"
        : source === "apollo"
          ? "apollo_status"
          : null;

    if (!statusColumn) {
      continue;
    }

    const niches = await select(
      env,
      "customer_niches",
      {
        select: "id,reddit_status,apollo_status",
        id: `eq.${nicheId}`,
        limit: "1"
      }
    );

    const niche = niches[0];

    if (!niche) {
      continue;
    }

    const currentStatus = norm(
      niche[statusColumn]
    );

    if (currentStatus !== "running") {
      continue;
    }

    const finalStatus = row.error
      ? "failed"
      : "completed";

    await update(
      env,
      "customer_niches",
      { id: `eq.${nicheId}` },
      {
        [statusColumn]: finalStatus
      }
    );
  }
}


/* ============================================================
   16. CHECK FOR AN ACTIVE TASK
   ============================================================ */

async function hasActiveTask(env, appId) {
  const rows = await getExecutionTasks(env, appId);

  return rows.some(row => {
    if (!isNewPlainTextTask(row)) {
      return false;
    }

    if (Number(row.pending_count) === 0) {
      return false;
    }

    const state = getState(row.task);

    return (
      state === "pending" ||
      state === "working"
    );
  });
}


/* ============================================================
   17. SELECT THE NEXT NICHE
   ============================================================ */

async function getNextNiche(env, appId, source) {
  const statusColumn =
    source === "reddit"
      ? "reddit_status"
      : "apollo_status";

  const niches = await select(
    env,
    "customer_niches",
    {
      select: [
        "id",
        "application_id",
        "niche_name",
        "buying_intention",
        "reddit_status",
        "apollo_status",
        "user_id",
        "created_at"
      ].join(","),
      application_id: `eq.${appId}`,
      order: "created_at.asc",
      limit: "500"
    }
  );

  for (const niche of niches) {
    if (
      norm(niche[statusColumn]) === "pending"
    ) {
      return niche;
    }
  }

  return null;
}


/* ============================================================
   18. AVOID DUPLICATE NICHE TASKS
   ============================================================ */

async function taskAlreadyExists(
  env,
  appId,
  nicheId,
  source
) {
  const rows = await getExecutionTasks(env, appId);

  return rows.some(row => {
    if (!isNewPlainTextTask(row)) {
      return false;
    }

    if (norm(row.source) !== norm(source)) {
      return false;
    }

    const existingNicheId = extractTaskValue(
      row.task,
      "NICHE ID"
    );

    return existingNicheId === String(nicheId);
  });
}


/* ============================================================
   19. CREATE EXACTLY ONE NICHE TASK
   ============================================================ */

async function createOneNicheTask(
  env,
  app,
  niche,
  source
) {
  /*
   * Final safety check.
   * Never insert a second task for the same niche/source.
   */

  const duplicate = await taskAlreadyExists(
    env,
    app.id,
    niche.id,
    source
  );

  if (duplicate) {
    return {
      created: false,
      reason: "Task already exists"
    };
  }

  const reddit = source === "reddit";

  const workerType = reddit
    ? "research"
    : "lead_generation";

  const workerName = reddit
    ? "reddit_research"
    : "apollo_lead_generation";

  const companyName =
    str(app.name) || "Your company";

  const objective = reddit
    ? `Research customer problems, needs, and buying signals among ${niche.niche_name} relevant to ${companyName}.`
    : `Find qualified prospects in the ${niche.niche_name} segment who may benefit from ${companyName}.`;

  const startedAt = new Date().toISOString();

  const task = taskLines([
    "TASK TYPE: niche_execution",
    `APPLICATION ID: ${app.id}`,
    `COMPANY NAME: ${companyName}`,
    `NICHE ID: ${niche.id}`,
    `NICHE NAME: ${niche.niche_name}`,
    `WORKER: ${workerName}`,
    `SOURCE: ${source}`,
    `OBJECTIVE: ${objective}`,
    `TARGET AUDIENCE: ${niche.niche_name}`,
    reddit
      ? "PROBLEM CATEGORIES: customer_problems, customer_acquisition, buying_intent, competitor_complaints"
      : "QUALIFICATION: match customer niche and require business relevance",
    reddit
      ? "PUBLISHED WITHIN DAYS: 7"
      : `TARGET LEADS: ${TARGET_APOLLO_LEADS}`,
    reddit
      ? `TARGET NEW POSTS: ${TARGET_REDDIT_POSTS}`
      : null,
    `REQUIRES INTEGRATION: ${source}`,
    "STATE: working",
    `STARTED AT: ${startedAt}`
  ]);

  /*
   * Reserve this niche first so another normal run won't
   * select the same pending niche.
   */

  await update(
    env,
    "customer_niches",
    { id: `eq.${niche.id}` },
    {
      [reddit ? "reddit_status" : "apollo_status"]:
        "running"
    }
  );

  try {
    const result = await insert(
      env,
      "planner_runs",
      [
        {
          application_id: app.id,
          user_id: app.user_id || null,
          worker_type: workerType,
          source,
          task,
          pending_count: 1,
          error: null,
          niche: niche.niche_name,
          started_at: startedAt
        }
      ]
    );

    if (!result || !result[0]) {
      throw new Error(
        "Niche task insertion returned no row"
      );
    }

    return {
      created: true,
      row: result[0]
    };
  } catch (error) {
    /*
     * If insertion fails, restore the niche to pending
     * so it can be retried on a later run.
     */

    await update(
      env,
      "customer_niches",
      { id: `eq.${niche.id}` },
      {
        [reddit ? "reddit_status" : "apollo_status"]:
          "pending"
      }
    );

    throw error;
  }
}


/* ============================================================
   20. FIND THE ANALYSIS COMPLETION TIME
   ============================================================ */

function getAnalysisCompletedAt(row) {
  const value = extractTaskValue(
    row.task,
    "COMPLETED AT"
  );

  return parseDate(value);
}


/* ============================================================
   21. PROCESS ONE APPLICATION
   ============================================================ */

async function processApplication(
  env,
  app,
  summary
) {
  /*
   * A. Retire recognizable old JSON-generated tasks.
   *
   * They are marked inactive; their rows are not deleted.
   */

  const retired = await retireLegacyTasks(
    env,
    app.id
  );

  summary.legacy_tasks_retired += retired;


  /*
   * B. Ensure exactly one analysis task exists.
   */

  const analysisResult = await createAnalysisTask(
    env,
    app
  );

  if (analysisResult.created) {
    summary.analysis_tasks_created++;
  }

  let analysisRow = analysisResult.row;

  let analysisState = getState(analysisRow.task);


  /*
   * C. Process a pending analysis task.
   *
   * Return immediately after creating/processing it.
   * Do not create a niche task during the same run.
   */

  if (
    analysisResult.created ||
    analysisState === "pending"
  ) {
    const result = await processAnalysis(
      env,
      app,
      analysisRow
    );

    if (result.completed && !result.already_completed) {
      summary.analysis_tasks_completed++;
      summary.niches_saved += result.niches_saved || 0;
    }

    return;
  }


  /*
   * D. An analysis that is working or failed cannot
   * trigger niche-task creation.
   */

  if (
    analysisState === "working" ||
    analysisState === "failed" ||
    analysisState === "superseded"
  ) {
    summary.analysis_not_ready++;
    return;
  }


  /*
   * E. Verify that the analysis really completed.
   */

  if (
    analysisState !== "completed" ||
    Number(analysisRow.pending_count) !== 0
  ) {
    summary.analysis_not_ready++;
    return;
  }

  const completedAt = getAnalysisCompletedAt(
    analysisRow
  );

  if (!completedAt) {
    summary.errors.push({
      application_id: app.id,
      error: "Analysis completion timestamp is missing"
    });

    return;
  }


  /*
   * F. Wait 30 minutes after company analysis.
   */

  if (
    Date.now() <
    completedAt + ANALYSIS_DELAY_MS
  ) {
    summary.waiting_for_30_minutes++;
    return;
  }


  /*
   * G. Reconcile any completed execution task.
   */

  await reconcileFinishedTasks(
    env,
    app.id
  );


  /*
   * H. Never create another task while one is active.
   */

  if (await hasActiveTask(env, app.id)) {
    summary.waiting_for_active_task++;
    return;
  }


  /*
   * I. Read connected integrations.
   *
   * No integration prompts are inserted.
   */

  const integrations = await getIntegrations(
    env,
    app
  );


  /*
   * J. Choose ONE source and ONE niche.
   *
   * Reddit is prioritized until all Reddit niches
   * are completed. Apollo follows afterward.
   *
   * If Reddit is not connected, Apollo may be used first.
   */

  let source = null;
  let niche = null;

  if (integrations.reddit) {
    niche = await getNextNiche(
      env,
      app.id,
      "reddit"
    );

    if (niche) {
      source = "reddit";
    }
  }

  if (!niche && integrations.apollo) {
    niche = await getNextNiche(
      env,
      app.id,
      "apollo"
    );

    if (niche) {
      source = "apollo";
    }
  }


  /*
   * K. No usable integration or no remaining niche.
   */

  if (!source || !niche) {
    if (
      !integrations.reddit &&
      !integrations.apollo
    ) {
      summary.waiting_for_integration++;
    } else {
      summary.no_pending_niches++;
    }

    return;
  }


  /*
   * L. Create only ONE task and then return.
   */

  const created = await createOneNicheTask(
    env,
    app,
    niche,
    source
  );

  if (created.created) {
    summary.niche_tasks_created++;

    summary.created_tasks.push({
      application_id: app.id,
      niche: niche.niche_name,
      source
    });
  } else {
    summary.duplicate_tasks_skipped++;
  }
}


/* ============================================================
   22. MAIN PLANNER
   ============================================================ */

async function runPlanner(env) {
  const apps = await getApplications(env);

  const summary = {
    version: VERSION,
    applications_checked: 0,
    analysis_tasks_created: 0,
    analysis_tasks_completed: 0,
    niches_saved: 0,
    niche_tasks_created: 0,
    legacy_tasks_retired: 0,
    waiting_for_30_minutes: 0,
    waiting_for_active_task: 0,
    waiting_for_integration: 0,
    analysis_not_ready: 0,
    no_pending_niches: 0,
    duplicate_tasks_skipped: 0,
    created_tasks: [],
    errors: []
  };

  for (const app of apps) {
    try {
      summary.applications_checked++;

      await processApplication(
        env,
        app,
        summary
      );
    } catch (error) {
      console.error(
        `Application ${app.id} failed:`,
        error
      );

      summary.errors.push({
        application_id: app.id,
        error: errorMessage(error)
      });
    }
  }

  return summary;
}
