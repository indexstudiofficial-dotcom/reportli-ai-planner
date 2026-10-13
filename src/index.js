/**
 * ============================================================
 * COMPANY PLANNER WORKER — VERSION 10
 * ============================================================
 *
 * WORKFLOW
 *
 * 1. Create ONE company-analysis task.
 * 2. Analyze the company and save 10 customer niches.
 * 3. Mark the analysis task completed.
 * 4. Wait 30 minutes.
 * 5. Create ONE niche task using Reddit or Apollo.
 * 6. Do not create another task while the current task is active.
 * 7. When the task completes, create the next niche task.
 *
 * IMPORTANT
 *
 * planner_runs.task is stored as plain TEXT.
 *
 * No JSON.stringify(task) is used for the task content.
 *
 * No planner_runs.status column is required.
 * No customer_niches.is_active column is required.
 * No SQL migration is required.
 *
 * REQUIRED ENVIRONMENT VARIABLES
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 *
 * OPTIONAL
 *
 * CRON_SECRET
 * ============================================================
 */

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

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        worker: "company-planner-worker",
        version: "10.0.0"
      });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      if (
        env.CRON_SECRET &&
        request.headers.get("Authorization") !==
          `Bearer ${env.CRON_SECRET}`
      ) {
        return json({ error: "Unauthorized" }, 401);
      }

      try {
        const result = await runPlanner(env);

        return json({
          ok: true,
          result
        });
      } catch (error) {
        console.error(error);

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
        console.error("Scheduled run failed:", error);
      })
    );
  }
};


/* ============================================================
   2. GENERAL HELPERS
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}


function text(value) {
  return value == null ? "" : String(value).trim();
}


function norm(value) {
  return text(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
}


function parseDate(value) {
  const timestamp = Date.parse(value || "");

  return Number.isFinite(timestamp)
    ? timestamp
    : null;
}


/* ============================================================
   3. SUPABASE REST API
   ============================================================ */

function config(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("SUPABASE_URL is missing");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  return {
    url: env.SUPABASE_URL.replace(/\/+$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY
  };
}


async function db(env, table, options = {}) {
  const cfg = config(env);

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
  const result = await db(env, table, {
    query
  });

  return Array.isArray(result) ? result : [];
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
    select: "id,name,user_id,company,domain,created_at,planner_status",
    order: "created_at.asc"
  });
}


/* ============================================================
   5. COMPANY CONTEXT
   ============================================================ */

async function getCompanyContext(env, app) {
  const parts = [
    `Company name: ${text(app.name) || "Unknown company"}`
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
      application_id: `eq.${app.id}`
    });

    for (const row of rows) {
      let value = row.data;

      if (typeof value !== "string") {
        value = JSON.stringify(value ?? "");
      }

      parts.push(`${row.field}: ${value}`);
    }
  } catch (error) {
    // Website knowledge is optional.
    console.warn("Could not load business data:", error.message);
  }

  return parts.join("\n").slice(0, 12000);
}


/* ============================================================
   6. GENERATE TEN CUSTOMER NICHES
   ============================================================ */

/*
 * Rule-based niche generation.
 *
 * This function does not call an AI API.
 * It uses the company name and available business context.
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
   7. FIND THE EXISTING ANALYSIS TASK
   ============================================================ */

async function getPlannerRows(env, applicationId) {
  return await select(env, "planner_runs", {
    select: "id,application_id,user_id,worker_type,source,task,pending_count,error,niche,created_at,started_at",
    application_id: `eq.${applicationId}`,
    worker_type: "eq.planner",
    source: "eq.system",
    order: "created_at.asc"
  });
}


function isAnalysisTask(row) {
  const task = text(row.task).toLowerCase();

  return (
    task.includes("task_type: company_analysis") ||
    task.includes("action: generate_customer_niches")
  );
}


/* ============================================================
   8. CREATE ONE ANALYSIS TASK AS PLAIN TEXT
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

  const companyName = text(app.name) || "Unnamed company";

  const taskText = [
    "TASK TYPE: company_analysis",
    `APPLICATION ID: ${app.id}`,
    `COMPANY NAME: ${companyName}`,
    `OBJECTIVE: Analyze the company and find 10 customer niches for ${companyName}.`,
    "ACTION: generate_customer_niches",
    "TARGET NICHES: 10",
    "STATE: pending"
  ].join("\n");

  const result = await insert(env, "planner_runs", [
    {
      application_id: app.id,
      user_id: app.user_id || null,
      worker_type: "planner",
      source: "system",

      // Plain text, NOT a JSON object.
      task: taskText,

      pending_count: 1,
      error: null,
      niche: null
    }
  ]);

  if (!result || !result[0]) {
    throw new Error("Failed to create company-analysis task");
  }

  return {
    created: true,
    row: result[0]
  };
}


/* ============================================================
   9. SAVE TEN NICHES
   ============================================================ */

async function saveNiches(env, app, context) {
  const generated = generateNiches(app, context);

  const existing = await select(env, "customer_niches", {
    select: "id,niche_name",
    application_id: `eq.${app.id}`
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

      // Keep score between 1 and 10 for compatibility
      // with older database constraints.
      buying_intention: score,

      reddit_status: "pending",
      apollo_status: "pending",
      user_id: app.user_id || null
    }));

  if (newRows.length > 0) {
    await insert(env, "customer_niches", newRows);
  }

  return await select(env, "customer_niches", {
    select: "id,niche_name,buying_intention,reddit_status,apollo_status,user_id,created_at",
    application_id: `eq.${app.id}`,
    order: "created_at.asc"
  });
}


/* ============================================================
   10. PROCESS THE ANALYSIS TASK
   ============================================================ */

async function processAnalysis(env, app, row) {
  if (Number(row.pending_count) === 0) {
    return;
  }

  const startedAt = row.started_at || new Date().toISOString();

  // Mark the task working in plain text.
  const workingText = [
    "TASK TYPE: company_analysis",
    `APPLICATION ID: ${app.id}`,
    `COMPANY NAME: ${text(app.name)}`,
    `OBJECTIVE: Analyze the company and find 10 customer niches for ${text(app.name)}.`,
    "ACTION: generate_customer_niches",
    "TARGET NICHES: 10",
    "STATE: working",
    `STARTED AT: ${startedAt}`
  ].join("\n");

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

    const niches = await saveNiches(env, app, context);

    const completedAt = new Date().toISOString();

    // Store the completion timestamp as ordinary text.
    const completedText = [
      "TASK TYPE: company_analysis",
      `APPLICATION ID: ${app.id}`,
      `COMPANY NAME: ${text(app.name)}`,
      `OBJECTIVE: Analyze the company and find 10 customer niches for ${text(app.name)}.`,
      "ACTION: generate_customer_niches",
      "TARGET NICHES: 10",
      "STATE: completed",
      `STARTED AT: ${startedAt}`,
      `COMPLETED AT: ${completedAt}`,
      `TOTAL NICHES SAVED: ${niches.length}`
    ].join("\n");

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
      { planner_status: "working" }
    );

    return {
      completed: true,
      completed_at: completedAt,
      niches_saved: niches.length
    };
  } catch (error) {
    const failedText = [
      "TASK TYPE: company_analysis",
      `APPLICATION ID: ${app.id}`,
      `COMPANY NAME: ${text(app.name)}`,
      "STATE: failed",
      `ERROR: ${error.message}`
    ].join("\n");

    await update(
      env,
      "planner_runs",
      { id: `eq.${row.id}` },
      {
        task: failedText,
        pending_count: 0,
        error: error.message,
        started_at: startedAt
      }
    );

    throw error;
  }
}


/* ============================================================
   11. READ CONNECTED INTEGRATIONS
   ============================================================ */

async function getIntegrations(env, app) {
  let rows = [];

  try {
    rows = await select(env, "user_integrations", {
      select: "id,user_id,application_id,integration_id,connection_id,status",
      application_id: `eq.${app.id}`,
      status: "eq.connected"
    });
  } catch (error) {
    console.warn("Application integration lookup failed:", error.message);
  }

  // Include user-level integrations only when the application
  // has a user ID.
  if (app.user_id) {
    try {
      const userRows = await select(env, "user_integrations", {
        select: "id,user_id,application_id,integration_id,connection_id,status",
        user_id: `eq.${app.user_id}`,
        application_id: "is.null",
        status: "eq.connected"
      });

      rows = rows.concat(userRows);
    } catch (error) {
      console.warn("User integration lookup failed:", error.message);
    }
  }

  const unique = [
    ...new Map(rows.map(row => [row.id, row])).values()
  ];

  const names = unique.map(row =>
    norm(row.integration_id)
  );

  return {
    reddit: names.some(name => name.includes("reddit")),
    apollo: names.some(name => name.includes("apollo"))
  };
}


/* ============================================================
   12. FIND EXISTING NICHE TASKS
   ============================================================ */

async function getExecutionTasks(env, appId) {
  return await select(env, "planner_runs", {
    select: "id,application_id,worker_type,source,task,pending_count,error,niche,created_at,started_at",
    application_id: `eq.${appId}`,
    order: "created_at.asc"
  });
}


function getState(taskText) {
  const match = text(taskText).match(/^STATE:\s*(.+)$/im);

  return match ? norm(match[1]) : "";
}


function isExecutionTask(row) {
  return (
    row.worker_type === "research" ||
    row.worker_type === "lead_generation"
  );
}


async function hasActiveTask(env, appId) {
  const rows = await getExecutionTasks(env, appId);

  for (const row of rows) {
    if (!isExecutionTask(row)) {
      continue;
    }

    if (Number(row.pending_count) === 0) {
      continue;
    }

    const state = getState(row.task);

    // Legacy tasks without a STATE line are treated as active
    // when pending_count = 1.
    if (
      state === "pending" ||
      state === "working" ||
      state === ""
    ) {
      return true;
    }
  }

  return false;
}


/* ============================================================
   13. SELECT NEXT NICHE
   ============================================================ */

async function getNextNiche(env, appId, source) {
  const statusColumn = source === "reddit"
    ? "reddit_status"
    : "apollo_status";

  const niches = await select(env, "customer_niches", {
    select: "id,application_id,niche_name,buying_intention,reddit_status,apollo_status,user_id,created_at",
    application_id: `eq.${appId}`,
    order: "created_at.asc"
  });

  for (const niche of niches) {
    const status = norm(niche[statusColumn]);

    if (!status || status === "pending") {
      return niche;
    }
  }

  return null;
}


/* ============================================================
   14. CREATE ONE PLAIN-TEXT NICHE TASK
   ============================================================ */

async function createOneNicheTask(
  env,
  app,
  niche,
  source
) {
  const companyName = text(app.name) || "Your company";

  const reddit = source === "reddit";

  const workerType = reddit
    ? "research"
    : "lead_generation";

  const workerName = reddit
    ? "reddit_research"
    : "apollo_lead_generation";

  const objective = reddit
    ? `Research customer problems, needs, and buying signals among ${niche.niche_name} relevant to ${companyName}.`
    : `Find qualified prospects in the ${niche.niche_name} segment who may benefit from ${companyName}.`;

  const taskText = [
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
      ? `PROBLEM CATEGORIES: customer_problems, customer_acquisition, buying_intent, competitor_complaints`
      : "QUALIFICATION: match customer niche and require business relevance",
    reddit
      ? "PUBLISHED WITHIN DAYS: 7"
      : `TARGET LEADS: ${TARGET_APOLLO_LEADS}`,
    reddit
      ? `TARGET NEW POSTS: ${TARGET_REDDIT_POSTS}`
      : "",
    `REQUIRES INTEGRATION: ${source}`,
    "STATE: working",
    `STARTED AT: ${new Date().toISOString()}`
  ].filter(Boolean).join("\n");

  // Reserve the niche before inserting the task.
  await update(
    env,
    "customer_niches",
    { id: `eq.${niche.id}` },
    {
      [reddit ? "reddit_status" : "apollo_status"]: "running"
    }
  );

  try {
    const result = await insert(env, "planner_runs", [
      {
        application_id: app.id,
        user_id: app.user_id || null,
        worker_type: workerType,
        source,
        task: taskText,
        pending_count: 1,
        error: null,
        niche: niche.niche_name,
        started_at: new Date().toISOString()
      }
    ]);

    if (!result || !result[0]) {
      throw new Error("Niche task insertion failed");
    }

    return result[0];
  } catch (error) {
    await update(
      env,
      "customer_niches",
      { id: `eq.${niche.id}` },
      {
        [reddit ? "reddit_status" : "apollo_status"]: "pending"
      }
    );

    throw error;
  }
}


/* ============================================================
   15. PROCESS ONE APPLICATION
   ============================================================ */

async function processApplication(env, app, summary) {
  // A. Ensure there is one analysis task.
  const analysisResult = await createAnalysisTask(env, app);

  if (analysisResult.created) {
    summary.analysis_tasks_created++;
  }

  let analysisRow = analysisResult.row;

  // B. Run the analysis if it has not already completed.
  if (Number(analysisRow.pending_count) !== 0) {
    const result = await processAnalysis(
      env,
      app,
      analysisRow
    );

    if (result && result.completed) {
      summary.analysis_tasks_completed++;
      summary.niches_saved += result.niches_saved;
    }
  }

  // C. Re-read the analysis row to get its completion timestamp.
  const plannerRows = await getPlannerRows(env, app.id);

  analysisRow = plannerRows.find(isAnalysisTask);

  if (!analysisRow || Number(analysisRow.pending_count) !== 0) {
    return;
  }

  const completedMatch = text(analysisRow.task).match(
    /^COMPLETED AT:\s*(.+)$/im
  );

  const completedAt = parseDate(
    completedMatch ? completedMatch[1] : analysisRow.created_at
  );

  if (!completedAt) {
    summary.errors.push({
      application_id: app.id,
      error: "Cannot determine analysis completion time"
    });

    return;
  }

  // D. Wait 30 minutes after analysis completion.
  if (Date.now() < completedAt + ANALYSIS_DELAY_MS) {
    summary.waiting_for_30_minutes++;
