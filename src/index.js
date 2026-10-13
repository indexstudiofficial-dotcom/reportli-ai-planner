/**
 * ============================================================
 * COMPANY PLANNER WORKER
 * ============================================================
 *
 * PURPOSE
 *
 * 1. Create one company-analysis task per application.
 * 2. Generate and save 10 customer niches.
 * 3. Wait 30 minutes after analysis completes.
 * 4. Create only ONE niche task at a time.
 * 5. Prefer Reddit research when Reddit is connected.
 * 6. Use Apollo when Reddit is unavailable and Apollo is connected.
 * 7. Wait for the current task to finish before creating another.
 *
 * EXISTING TABLES
 *
 * applications
 * business_data
 * customer_niches
 * planner_runs
 * user_integrations
 *
 * REQUIRED CLOUDFLARE ENVIRONMENT VARIABLES
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 *
 * OPTIONAL
 *
 * CRON_SECRET
 *
 * IMPORTANT
 *
 * planner_runs does not have a status column.
 * The task's JSON contains its state.
 * started_at records when a task starts.
 * pending_count is set to 1 while work is pending and 0
 * when the task has completed or failed.
 *
 * ============================================================
 */

const ANALYSIS_DELAY_MS = 30 * 60 * 1000;

const TARGET_NICHE_COUNT = 10;

const TARGET_REDDIT_POSTS = 20;

const TARGET_APOLLO_LEADS = 20;

const MAX_CONTEXT_CHARS = 12000;


/* ============================================================
   SECTION 1 — CLOUDFLARE WORKER ENTRY POINTS
   ============================================================ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "company-planner-worker",
        version: "9.0.0",
        time: new Date().toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) {
        return jsonResponse(
          { error: "Unauthorized" },
          401
        );
      }

      try {
        const result = await runPlanner(env);

        return jsonResponse({
          ok: true,
          result
        });
      } catch (error) {
        console.error("Planner run failed:", error);

        return jsonResponse(
          {
            ok: false,
            error: error.message || "Planner run failed"
          },
          500
        );
      }
    }

    return jsonResponse(
      {
        error: "Not found",
        endpoints: {
          health: "GET /health",
          run: "POST /run"
        }
      },
      404
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPlanner(env).catch(error => {
        console.error("Scheduled planner run failed:", error);
      })
    );
  }
};


/* ============================================================
   SECTION 2 — GENERAL HELPERS
   ============================================================ */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}


function authorized(request, env) {
  // If CRON_SECRET is configured, require it for manual POST calls.
  // Cloudflare scheduled events do not pass through this check.
  if (!env.CRON_SECRET) {
    return true;
  }

  return (
    request.headers.get("Authorization") ===
    `Bearer ${env.CRON_SECRET}`
  );
}


function getSupabaseConfig(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL environment variable");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY environment variable"
    );
  }

  return {
    url: env.SUPABASE_URL.replace(/\/+$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY
  };
}


function parseJson(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}


function cleanString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}


function normalize(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function makeTaskId(prefix, applicationId, suffix = "") {
  const cleanAppId = cleanString(applicationId)
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const cleanSuffix = suffix
    ? `_${String(suffix).replace(/[^a-zA-Z0-9_-]/g, "_")}`
    : "";

  return `${prefix}_${cleanAppId}${cleanSuffix}`;
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ============================================================
   SECTION 3 — SUPABASE REST CLIENT
   ============================================================ */

async function supabaseRequest(
  env,
  table,
  {
    method = "GET",
    query = {},
    body = undefined,
    prefer = undefined
  } = {}
) {
  const config = getSupabaseConfig(env);

  const url = new URL(
    `${config.url}/rest/v1/${table}`
  );

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  const headers = {
    "apikey": config.key,
    "Authorization": `Bearer ${config.key}`,
    "Accept": "application/json"
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (prefer) {
    headers["Prefer"] = prefer;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const responseText = await response.text();

  let result = null;

  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = responseText;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${method} ${table} failed: ` +
      `${response.status} ${responseText}`
    );
  }

  return result;
}


async function selectRows(env, table, query = {}) {
  const result = await supabaseRequest(env, table, {
    method: "GET",
    query
  });

  return Array.isArray(result) ? result : [];
}


async function insertRows(env, table, rows) {
  if (!rows || rows.length === 0) {
    return [];
  }

  const result = await supabaseRequest(env, table, {
    method: "POST",
    query: {
      select: "*"
    },
    body: rows,
    prefer: "return=representation"
  });

  return Array.isArray(result) ? result : [];
}


async function updateRows(env, table, query, changes) {
  return await supabaseRequest(env, table, {
    method: "PATCH",
    query,
    body: changes,
    prefer: "return=representation"
  });
}


/* ============================================================
   SECTION 4 — READ APPLICATIONS
   ============================================================ */

async function getApplications(env) {
  // Do not select only the newest application.
  // Every application gets its own analysis task if it lacks one.

  return await selectRows(env, "applications", {
    select: "id,name,user_id,domain,company,planner_status,created_at",
    order: "created_at.asc"
  });
}


/* ============================================================
   SECTION 5 — READ COMPANY KNOWLEDGE
   ============================================================ */

function extractBusinessDataText(row) {
  const field = cleanString(row.field);
  const data = parseJson(row.data, row.data);

  let value = "";

  if (typeof data === "string") {
    value = data;
  } else {
    value = JSON.stringify(data ?? "");
  }

  return `${field}: ${value}`;
}


async function getCompanyContext(env, application) {
  const parts = [];

  if (application.name) {
    parts.push(`Company name: ${application.name}`);
  }

  if (application.company) {
    parts.push(`Company information: ${application.company}`);
  }

  if (application.domain) {
    parts.push(`Company domain: ${application.domain}`);
  }

  try {
    const businessRows = await selectRows(env, "business_data", {
      select: "field,data",
      application_id: `eq.${application.id}`,
      order: "created_at.asc"
    });

    for (const row of businessRows) {
      const line = extractBusinessDataText(row);

      if (line) {
        parts.push(line);
      }
    }
  } catch (error) {
    // business_data is optional for this workflow.
    // Continue using the application's name and company fields.
    console.warn(
      "Could not read business_data for",
      application.id,
      error.message
    );
  }

  return parts.join("\n").slice(0, MAX_CONTEXT_CHARS);
}


/* ============================================================
   SECTION 6 — RULE-BASED NICHE GENERATOR
   ============================================================ */

/*
 * This version uses JavaScript rules and the available company
 * information. It does not call an AI API.
 *
 * If you later want Sarvam to produce the niche JSON, this
 * function can be replaced without changing the task workflow.
 */

function generateNiches(application, companyContext) {
  const companyName =
    cleanString(application.name) || "this company";

  const profile = normalize(
    `${companyName} ${application.company || ""} ` +
    `${application.domain || ""} ${companyContext}`
  );

  let candidates = [];

  /* ----------------------------------------------------------
     A. SOFTWARE, DEVELOPER TOOLS, BUG MONITORING
     ---------------------------------------------------------- */

  if (
    /saas|software|developer|programming|bug|error|monitoring|\
application|web app|next\.?js|react|api|no.code|vibe.cod|\
replit|lovable|cursor|vercel/.test(profile)
  ) {
    candidates = [
      {
        name: "Vibe-coding and no-code founders",
        score: 10
      },
      {
        name: "Early-stage SaaS founders",
        score: 10
      },
      {
        name: "Indie hackers and solo developers",
        score: 9
      },
      {
        name: "Small software development agencies",
        score: 9
      },
      {
        name: "Next.js and React application founders",
        score: 9
      },
      {
        name: "SaaS CTOs and engineering leads",
        score: 8
      },
      {
        name: "Bootstrapped SaaS teams",
        score: 8
      },
      {
        name: "Founders launching apps on Vercel or Replit",
        score: 8
      },
      {
        name: "API-first software startups",
        score: 7
      },
      {
        name: "Small B2B SaaS product teams",
        score: 7
      }
    ];
  }

  /* ----------------------------------------------------------
     B. LEAD GENERATION, SALES, OUTREACH
     ---------------------------------------------------------- */

  else if (
    /lead generation|lead gen|prospect|sales|cold email|\
outreach|crm|marketing automation/.test(profile)
  ) {
    candidates = [
      { name: "Early-stage B2B SaaS founders", score: 10 },
      { name: "Small B2B sales teams", score: 10 },
      { name: "Outbound sales agencies", score: 9 },
      { name: "Lead generation agencies", score: 9 },
      { name: "Solo sales consultants", score: 9 },
      { name: "Recruitment and staffing firms", score: 8 },
      { name: "B2B marketing agencies", score: 8 },
      { name: "Founder-led sales teams", score: 8 },
      { name: "Small business development teams", score: 7 },
      { name: "B2B service providers", score: 7 }
    ];
  }

  /* ----------------------------------------------------------
     C. E-COMMERCE
     ---------------------------------------------------------- */

  else if (
    /ecommerce|e-commerce|shopify|online store|retail|\
shopping cart|product catalog/.test(profile)
  ) {
    candidates = [
      { name: "Small Shopify store owners", score: 10 },
      { name: "Direct-to-consumer brands", score: 10 },
      { name: "Growing online retailers", score: 9 },
      { name: "Multi-product e-commerce businesses", score: 9 },
      { name: "Small marketplace sellers", score: 8 },
      { name: "Subscription commerce brands", score: 8 },
      { name: "Independent fashion brands", score: 8 },
      { name: "Beauty and skincare e-commerce brands", score: 7 },
      { name: "Home and lifestyle online stores", score: 7 },
      { name: "E-commerce marketing agencies", score: 7 }
    ];
  }

  /* ----------------------------------------------------------
     D. HEALTHCARE AND CLINICS
     ---------------------------------------------------------- */

  else if (
    /clinic|dental|dentist|healthcare|medical|doctor|\
hospital|patient|practice management/.test(profile)
  ) {
    candidates = [
      { name: "Independent dental clinics", score: 10 },
      { name: "Small private medical practices", score: 10 },
      { name: "Multi-location clinic operators", score: 9 },
      { name: "Dental practice managers", score: 9 },
      { name: "Healthcare service businesses", score: 8 },
      { name: "Specialist medical clinics", score: 8 },
      { name: "Physiotherapy and rehabilitation clinics", score: 8 },
      { name: "Diagnostic centers", score: 7 },
      { name: "Healthcare marketing agencies", score: 7 },
      { name: "Private healthcare administrators", score: 7 }
    ];
  }

  /* ----------------------------------------------------------
     E. GENERAL BUSINESS FALLBACK
     ---------------------------------------------------------- */

  else {
    candidates = [
      { name: "Small and medium-sized businesses", score: 10 },
      { name: "Early-stage startup founders", score: 10 },
      { name: "Solo entrepreneurs and independent operators", score: 9 },
      { name: "Small B2B service businesses", score: 9 },
      { name: "Growing digital-first businesses", score: 8 },
      { name: "Small professional service firms", score: 8 },
      { name: "Business consultants and advisors", score: 8 },
      { name: "Small marketing agencies", score: 7 },
      { name: "Online businesses and creators", score: 7 },
      { name: "Operations managers at growing companies", score: 7 }
    ];
  }

  // Include the company name in the analysis result, not in every
  // niche name. Keep exactly ten distinct candidate niches.

  const seen = new Set();

  return candidates
    .filter(item => {
      const key = normalize(item.name);

      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .slice(0, TARGET_NICHE_COUNT)
    .map((item, index) => ({
      niche_name: item.name,
      buying_intention: Math.min(
        10,
        Math.max(1, Number(item.score) || 7)
      ),
      rank: index + 1
    }));
}


/* ============================================================
   SECTION 7 — FIND OR CREATE THE SINGLE ANALYSIS TASK
   ============================================================ */

async function getPlannerRowsForApplication(env, applicationId) {
  return await selectRows(env, "planner_runs", {
    select: "id,application_id,user_id,worker_type,source,task,niche,pending_count,error,created_at,started_at",
    application_id: `eq.${applicationId}`,
    worker_type: "eq.planner",
    source: "eq.system",
    order: "created_at.asc"
  });
}


function isAnalysisTask(row) {
  const task = parseJson(row.task, {});

  return (
    task.action === "generate_customer_niches" ||
    task.worker === "company_analysis" ||
    task.task_type === "company_analysis"
  );
}


async function createAnalysisTask(env, application) {
  const existingRows = await getPlannerRowsForApplication(
    env,
    application.id
  );

  const existingAnalysisTask = existingRows.find(isAnalysisTask);

  if (existingAnalysisTask) {
    return {
      created: false,
      row: existingAnalysisTask
    };
  }

  const companyName =
    cleanString(application.name) || "Unnamed company";

  const task = {
    task_id: makeTaskId(
      "analyze",
      application.id
    ),

    application_id: application.id,

    company_name: companyName,

    worker: "company_analysis",

    action: "generate_customer_niches",

    objective:
      `Analyze the company and find 10 customer niches for ${companyName}.`,

    target_niches: TARGET_NICHE_COUNT,

    state: "pending",

    created_at: new Date().toISOString()
  };

  const inserted = await insertRows(env, "planner_runs", [
    {
      application_id: application.id,
      user_id: application.user_id || null,
      worker_type: "planner",
      source: "system",
      task: JSON.stringify(task),
      niche: null,
      pending_count: 1,
      error: null
    }
  ]);

  const row = inserted[0];

  if (!row) {
    throw new Error(
      `Could not create analysis task for ${application.id}`
    );
  }

  return {
    created: true,
    row
  };
}


/* ============================================================
   SECTION 8 — UPDATE TASK STATE
   ============================================================ */

async function updatePlannerTask(
  env,
  row,
  task,
  {
    pendingCount = row.pending_count,
    error = row.error,
    startedAt = row.started_at
  } = {}
) {
  const changes = {
    task: JSON.stringify(task),
    pending_count: pendingCount,
    error: error || null
  };

  if (startedAt) {
    changes.started_at = startedAt;
  }

  return await updateRows(
    env,
    "planner_runs",
    {
      id: `eq.${row.id}`
    },
    changes
  );
}


/* ============================================================
   SECTION 9 — SAVE TEN CUSTOMER NICHES
   ============================================================ */

async function getExistingNiches(env, applicationId) {
  return await selectRows(env, "customer_niches", {
    select: "id,application_id,niche_name,buying_intention,reddit_status,apollo_status,user_id,created_at",
    application_id: `eq.${applicationId}`,
    order: "created_at.asc"
  });
}


async function saveTenNiches(
  env,
  application,
  companyContext
) {
  const generated = generateNiches(
    application,
    companyContext
  );

  const existing = await getExistingNiches(
    env,
    application.id
  );

  const existingNames = new Set(
    existing.map(row => normalize(row.niche_name))
  );

  const missing = generated.filter(item => {
    return !existingNames.has(normalize(item.niche_name));
  });

  // Do not depend on an is_active column or a unique constraint.
  // Existing names are checked before insertion.
  const rowsToInsert = missing.map(item => ({
    application_id: application.id,

    niche_name: item.niche_name,

    // Scores are 1-10 for compatibility with older constraints.
    buying_intention: item.buying_intention,

    reddit_status: "pending",

    apollo_status: "pending",

    user_id: application.user_id || null
  }));

  if (rowsToInsert.length > 0) {
    await insertRows(
      env,
      "customer_niches",
      rowsToInsert
    );
  }

  const allNiches = await getExistingNiches(
    env,
    application.id
  );

  return {
    generated_count: generated.length,
    inserted_count: rowsToInsert.length,
    total_saved: allNiches.length,
    niches: allNiches
  };
}


/* ============================================================
   SECTION 10 — PROCESS ANALYSIS TASK
   ============================================================ */

async function processAnalysisTask(
  env,
  application,
  row
) {
  let task = parseJson(row.task, {});

  if (
    task.state === "completed" ||
    Number(row.pending_count) === 0
  ) {
    return {
      processed: false,
      reason: "Analysis already completed"
    };
  }

  if (task.state === "failed") {
    return {
      processed: false,
      reason: "Analysis previously failed"
    };
  }

  const startedAt =
    row.started_at || new Date().toISOString();

  task = {
    ...task,
    state: "working",
    started_at: startedAt
  };

  await updatePlannerTask(
    env,
    row,
    task,
    {
      pendingCount: 1,
      error: null,
      startedAt
    }
  );

  try {
    const companyContext = await getCompanyContext(
      env,
      application
    );

    const saved = await saveTenNiches(
      env,
      application,
      companyContext
    );

    const completedAt = new Date().toISOString();

    task = {
      ...task,
      state: "completed",
      company_context_used: Boolean(companyContext),
      generated_niches: saved.generated_count,
      inserted_niches: saved.inserted_count,
      total_niches_saved: saved.total_saved,
      completed_at: completedAt
    };

    await updatePlannerTask(
      env,
      row,
      task,
      {
        pendingCount: 0,
        error: null,
        startedAt
      }
    );

    // Keep the application available for the delayed niche workflow.
    await updateRows(
      env,
      "applications",
      {
        id: `eq.${application.id}`
      },
      {
        planner_status: "working"
      }
    );

    return {
      processed: true,
      state: "completed",
      total_niches_saved: saved.total_saved,
      completed_at: completedAt
    };
  } catch (error) {
    const failedAt = new Date().toISOString();

    task = {
      ...task,
      state: "failed",
      failed_at: failedAt,
      failure_message: error.message
    };

    await updatePlannerTask(
      env,
      row,
      task,
      {
        pendingCount: 0,
        error: error.message,
        startedAt
      }
    );

    throw error;
  }
}


/* ============================================================
   SECTION 11 — CHECK CONNECTED INTEGRATIONS
   ============================================================ */

function integrationName(row) {
  return normalize(
    `${row.integration_id || ""} ${row.provider || ""} ${row.name || ""}`
  );
}


function isConnected(row) {
  return normalize(row.status) === "connected";
}


async function getConnectedIntegrations(env, application) {
  const rows = [];

  // First: integrations connected specifically to this application.
  try {
    const appRows = await selectRows(env, "user_integrations", {
      select: "id,user_id,application_id,integration_id,connection_id,status",
      application_id: `eq.${application.id}`,
      status: "eq.connected"
    });

    rows.push(...appRows);
  } catch (error) {
    console.warn(
      "Could not read application integrations:",
      error.message
    );
  }

  // Second: user-level integrations with application_id IS NULL.
  if (application.user_id) {
    try {
      const userRows = await selectRows(env, "user_integrations", {
        select: "id,user_id,application_id,integration_id,connection_id,status",
        user_id: `eq.${application.user_id}`,
        application_id: "is.null",
        status: "eq.connected"
      });

      rows.push(...userRows);
    } catch (error) {
      console.warn(
        "Could not read user-level integrations:",
        error.message
      );
    }
  }

  const unique = new Map();

  for (const row of rows) {
    if (!isConnected(row)) {
      continue;
    }

    unique.set(String(row.id), row);
  }

  const connected = [...unique.values()];

  const reddit = connected.some(row => {
    const name = integrationName(row);

    return (
      name.includes("reddit") ||
      name.includes("reddit_api")
    );
  });

  const apollo = connected.some(row => {
    const name = integrationName(row);

    return (
      name.includes("apollo") ||
      name.includes("apollo.io")
    );
  });

  return {
    reddit,
    apollo,
    rows: connected
  };
}


/* ============================================================
   SECTION 12 — FIND NICHE TASKS AND RECONCILE COMPLETION
   ============================================================ */

function isNicheExecutionTask(row) {
  return (
    row.worker_type === "research" ||
    row.worker_type === "lead_generation"
  );
}


async function getNicheExecutionTasks(env, applicationId) {
  const rows = await selectRows(env, "planner_runs", {
    select: "id,application_id,user_id,worker_type,source,task,pending_count,error,niche,created_at,started_at",
    application_id: `eq.${applicationId}`,
    order: "created_at.asc"
  });

  return rows.filter(isNicheExecutionTask);
}


function getTaskState(row) {
  const task = parseJson(row.task, {});

  if (row.error || task.state === "failed") {
    return "failed";
  }

  if (
    task.state === "completed" ||
    (
      Number(row.pending_count) === 0 &&
      task.state !== "working"
    )
  ) {
    return "completed";
  }

  if (
    task.state === "working" ||
    task.state === "pending" ||
    row.started_at
  ) {
    return task.state || "working";
  }

  return "pending";
}


async function updateNicheStatus(
  env,
  nicheId,
  source,
  status
) {
  if (!nicheId) {
    return;
  }

  const column =
    source === "reddit"
      ? "reddit_status"
      : "apollo_status";

  await updateRows(
    env,
    "customer_niches",
    {
      id: `eq.${nicheId}`
    },
    {
      [column]: status
    }
  );
}


async function reconcileNicheTasks(env, applicationId) {
  const tasks = await getNicheExecutionTasks(
    env,
    applicationId
  );

  let activeTask = null;

  for (const row of tasks) {
    const task = parseJson(row.task, {});
    const state = getTaskState(row);

    const source =
      row.source === "reddit"
        ? "reddit"
        : row.source === "apollo"
          ? "apollo"
          : null;

    if (!source || !task.niche_id) {
      continue;
    }

    if (state === "completed") {
      await updateNicheStatus(
        env,
        task.niche_id,
        source,
        "completed"
      );

      continue;
    }

    if (state === "failed") {
      await updateNicheStatus(
        env,
        task.niche_id,
        source,
        "failed"
      );

      continue;
    }

    // Only one niche task can be active for this application.
    if (
      state === "working" ||
      state === "pending"
    ) {
      if (!activeTask) {
        activeTask = row;
      }
    }
  }

  return {
    tasks,
    activeTask
  };
}


/* ============================================================
   SECTION 13 — INTEGRATION PROMPT
   ============================================================ */

async function findIntegrationPrompt(env, applicationId) {
  const rows = await getPlannerRowsForApplication(
    env,
    applicationId
  );

  return rows.find(row => {
    const task = parseJson(row.task, {});

    return (
      task.type === "integration_prompt" &&
      task.task_id ===
        makeTaskId("connect_integrations", applicationId)
    );
  }) || null;
}


async function createOrUpdateIntegrationPrompt(
  env,
  application
) {
  const existing = await findIntegrationPrompt(
    env,
    application.id
  );

  const now = new Date().toISOString();

  const task = {
    type: "integration_prompt",

    task_id: makeTaskId(
      "connect_integrations",
      application.id
    ),

    application_id: application.id,

    company_name: application.name || "Your company",

    integrations: ["reddit", "apollo"],

    title: "Connect Reddit or Apollo",

    message:
      "Connect Reddit to research customer problems, " +
      "or connect Apollo to find potential customers. " +
      "Only one niche task will run at a time.",

    active: true,

    state: "pending",

    updated_at: now
  };

  if (existing) {
    const oldTask = parseJson(existing.task, {});

    if (oldTask.active === true) {
      return {
        created: false,
        reason: "Integration prompt already exists"
      };
    }

    await updatePlannerTask(
      env,
      existing,
      task,
      {
        pendingCount: 1,
        error: null
      }
    );

    return {
      created: false,
      updated: true
    };
  }

  await insertRows(env, "planner_runs", [
    {
      application_id: application.id,
      user_id: application.user_id || null,
      worker_type: "planner",
      source: "system",
      task: JSON.stringify(task),
      niche: null,
      pending_count: 1,
      error: null
    }
  ]);

  return {
    created: true
  };
}


async function deactivateIntegrationPrompt(
  env,
  applicationId
) {
  const existing = await findIntegrationPrompt(
    env,
    applicationId
  );

  if (!existing) {
    return;
  }

  const task = parseJson(existing.task, {});

  if (task.active === false) {
    return;
  }

  const updatedTask = {
    ...task,
    active: false,
    state: "completed",
    completed_at: new Date().toISOString()
  };

  await updatePlannerTask(
    env,
    existing,
    updatedTask,
    {
      pendingCount: 0,
      error: null
    }
  );
}


/* ============================================================
   SECTION 14 — FIND THE NEXT NICHE
   ============================================================ */

function getNicheStatus(niche, source) {
  return normalize(
    source === "reddit"
      ? niche.reddit_status
      : niche.apollo_status
  );
}


function isNicheAvailable(niche, source) {
  const status = getNicheStatus(niche, source);

  // Failed niches are not automatically retried here.
  // Completed, running and failed niches are skipped.
  return (
    !status ||
    status === "pending"
  );
}


async function getNextNiche(env, applicationId, source) {
  const niches = await getExistingNiches(
    env,
    applicationId
  );

  // Use saved order. Do not generate 10 new tasks.
  for (const niche of niches) {
    if (isNicheAvailable(niche, source)) {
      return niche;
    }
  }

  return null;
}


/* ============================================================
   SECTION 15 — BUILD ONE REDDIT TASK
   ============================================================ */

function buildRedditTask(application, niche) {
  const companyName =
    cleanString(application.name) || "this company";

  return {
    task_id: makeTaskId(
      "reddit",
      application.id,
      niche.id
    ),

    application_id: application.id,

    company_name: companyName,

    niche_id: niche.id,

    niche_name: niche.niche_name,

    worker: "reddit_research",

    objective:
      `Research customer problems, needs, and buying signals ` +
      `among ${niche.niche_name} relevant to ${companyName}.`,

    target_audience: [
      niche.niche_name
    ],

    problem_categories: [
      "customer_problems",
      "customer_acquisition",
      "buying_intent",
      "competitor_complaints"
    ],

    published_within_days: 7,

    target_new_posts: TARGET_REDDIT_POSTS,

    requires_integration: "reddit",

    state: "working",

    created_at: new Date().toISOString()
  };
}


/* ============================================================
   SECTION 16 — BUILD ONE APOLLO TASK
   ============================================================ */

function buildApolloTask(application, niche) {
  const companyName =
    cleanString(application.name) || "this company";

  return {
    task_id: makeTaskId(
      "apollo",
      application.id,
      niche.id
    ),

    application_id: application.id,

    company_name: companyName,

    niche_id: niche.id,

    niche_name: niche.niche_name,

    worker: "apollo_lead_generation",

    objective:
      `Find qualified prospects in the ${niche.niche_name} ` +
      `segment who may benefit from ${companyName}.`,

    target_audience: [
      niche.niche_name
    ],

    target_leads: TARGET_APOLLO_LEADS,

    qualification: {
      match_customer_niche: true,
      require_business_relevance: true
    },

    requires_integration: "apollo",

    state: "working",

    created_at: new Date().toISOString()
  };
}


/* ============================================================
   SECTION 17 — CREATE ONLY ONE NICHE TASK
   ============================================================ */

async function createOneNicheTask(
  env,
  application,
  source,
  niche
) {
  const now = new Date().toISOString();

  const task =
    source === "reddit"
      ? buildRedditTask(application, niche)
      : buildApolloTask(application, niche);

  const workerType =
    source === "reddit"
      ? "research"
      : "lead_generation";

  /*
   * Mark the niche as running before creating the task.
   * If task insertion fails, restore the niche to pending.
   */

  await updateNicheStatus(
    env,
    niche.id,
    source,
    "running"
  );

  try {
    const inserted = await insertRows(env, "planner_runs", [
      {
        application_id: application.id,
        user_id: application.user_id || null,
        worker_type: workerType,
        source,
        task: JSON.stringify(task),
        niche: niche.niche_name,
        pending_count: 1,
        error: null,
        started_at: now
      }
    ]);

    if (!inserted[0]) {
      throw new Error(
        `Could not create ${source} task for ${niche.niche_name}`
      );
    }

    return {
      created: true,
      source,
      niche: niche.niche_name,
      task_id: task.task_id,
      state: "working"
    };
  } catch (error) {
    await updateNicheStatus(
      env,
      niche.id,
      source,
      "pending"
    );

    throw error;
  }
}


/* ============================================================
   SECTION 18 — PROCESS ONE APPLICATION'S DELAYED WORKFLOW
   ============================================================ */

async function processApplication(
  env,
  application,
  counters
) {
  const applicationId = application.id;

  if (!applicationId) {
    return;
  }

  /*
   * STEP A:
   * Ensure the application has exactly one analysis task.
   */

  let analysisResult;

  try {
    analysisResult = await createAnalysisTask(
      env,
      application
    );
  } catch (error) {
    counters.errors.push({
      application_id: applicationId,
      stage: "create_analysis_task",
      error: error.message
    });

    return;
  }

  if (analysisResult.created) {
    counters.analysis_tasks_created++;
  }

  /*
   * STEP B:
   * Run the analysis task if it is still pending.
   */

  let analysisRow = analysisResult.row;

  if (isAnalysisTask(analysisRow)) {
    const analysisTask = parseJson(
      analysisRow.task,
      {}
    );

    if (
      analysisTask.state !== "completed" &&
      analysisTask.state !== "failed" &&
      Number(analysisRow.pending_count) !== 0
    ) {
      try {
        const result = await processAnalysisTask(
          env,
          application,
          analysisRow
        );

        if (result.processed) {
          counters.analysis_tasks_completed++;
          counters.niches_saved +=
            Number(result.total_niches_saved) || 0;
        }
      } catch (error) {
        counters.errors.push({
          application_id: applicationId,
          stage: "process_analysis_task",
          error: error.message
        });

        return;
      }
    }
  }

  /*
   * STEP C:
   * Re-read the analysis task so the 30-minute timer uses
   * the saved completed_at timestamp.
   */

  const plannerRows = await getPlannerRowsForApplication(
    env,
    applicationId
  );

  analysisRow = plannerRows.find(isAnalysisTask);

  if (!analysisRow) {
    return;
  }

  const savedAnalysis = parseJson(
    analysisRow.task,
    {}
  );

  if (savedAnalysis.state !== "completed") {
    return;
  }

  /*
   * STEP D:
   * Wait 30 minutes from analysis completion.
   */

  const completedAtMs = Date.parse(
    savedAnalysis.completed_at ||
    analysisRow.created_at ||
    ""
  );

  if (!Number.isFinite(completedAtMs)) {
    return;
  }

  const readyAt = completedAtMs + ANALYSIS_DELAY_MS;

  if (Date.now() < readyAt) {
    counters.waiting_for_delay++;

    return;
  }

  /*
   * STEP E:
   * Reconcile existing niche tasks.
   * If one is working, do not create another.
   */

  const reconciliation = await reconcileNicheTasks(
    env,
    applicationId
  );

  if (reconciliation.activeTask) {
    counters.niche_tasks_already_active++;

    return;
  }

  /*
   * STEP F:
   * Check integrations.
   */

  const integrations = await getConnectedIntegrations(
    env,
    application
  );

  if (!integrations.reddit && !integrations.apollo) {
    await createOrUpdateIntegrationPrompt(
      env,
      application
    );

    counters.integration_prompts_created_or_kept++;

    return;
  }

  await deactivateIntegrationPrompt(
    env,
    applicationId
  );

  /*
   * STEP G:
   * Select one integration and one niche.
   *
   * Priority:
   * 1. Reddit, if connected and niches remain.
   * 2. Apollo, if connected and niches remain.
   *
   * This creates one task only.
   */

  let selectedSource = null;
  let selectedNiche = null;

  if (integrations.reddit) {
    selectedNiche = await getNextNiche(
      env,
      applicationId,
      "reddit"
    );

    if (selectedNiche) {
      selectedSource = "reddit";
    }
  }

  if (!selectedSource && integrations.apollo) {
    selectedNiche = await getNextNiche(
      env,
      applicationId,
      "apollo"
    );

    if (selectedNiche) {
      selectedSource = "apollo";
    }
  }

  if (!selectedSource || !selectedNiche) {
    counters.no_pending_niches++;

    return;
  }

  /*
   * STEP H:
   * Create exactly ONE task for exactly ONE niche.
   */

  try {
    const created = await createOneNicheTask(
      env,
      application,
      selectedSource,
      selectedNiche
    );

    if (created.created) {
      counters.niche_tasks_created++;

      counters.created_tasks.push({
        application_id: applicationId,
        company_name: application.name,
        source: created.source,
        niche: created.niche,
        task_id: created.task_id,
        state: created.state
      });
    }
  } catch (error) {
    counters.errors.push({
      application_id: applicationId,
      stage: "create_niche_task",
      error: error.message
    });
  }
}


/* ============================================================
   SECTION 19 — MAIN PLANNER LOOP
   ============================================================ */

async function runPlanner(env) {
  const startedAt = new Date().toISOString();

  const counters = {
    started_at: startedAt,

    applications_seen: 0,

    analysis_tasks_created: 0,

    analysis_tasks_completed: 0,

    niches_saved: 0,

    waiting_for_delay: 0,

    niche_tasks_created: 0,

    niche_tasks_already_active: 0,

    integration_prompts_created_or_kept: 0,

    no_pending_niches: 0,

    created_tasks: [],

    errors: []
  };

  const applications = await getApplications(env);

  counters.applications_seen = applications.length;

  /*
   * Process every application, not only the newest one.
   *
   * Each application has its own analysis task and its own
   * 30-minute timer.
   *
   * Within an application, only one niche task may be active.
   */

  for (const application of applications) {
    try {
      await processApplication(
        env,
        application,
        counters
      );
    } catch (error) {
      counters.errors.push({
        application_id: application.id,
        stage: "process_application",
        error: error.message
      });
    }
  }

  counters.finished_at = new Date().toISOString();

  console.log(
    "Planner run summary:",
    JSON.stringify(counters)
  );

  return counters;
  }
