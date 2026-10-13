// ============================================================
// REPORTLI AI PLANNER WORKER v8.0
//
// NO AI API CALLS
// NO NEW DATABASE COLUMNS
// USES THE EXISTING SUPABASE SCHEMA
//
// Required secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional secret:
//   WEBHOOK_SECRET
//
// Existing tables:
//   applications
//   business_data
//   customer_niches
//   planner_runs
//   user_integrations
//
// planner_runs does NOT require a status column.
// ============================================================

const VERSION = "8.0.0";

const WAIT_MS = 30 * 60 * 1000;

const NICHE_SCORES = [19, 16, 13, 11, 10, 9, 8, 6, 5, 3];

// ============================================================
// 1. WORKER ENTRY POINT
// ============================================================

export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") {
        return respond({
          ok: true,
          worker: "reportli-ai-planner",
          version: VERSION,
          ai_required: false,
          message: "Planner Worker is running."
        });
      }

      if (request.method !== "POST") {
        return respond({
          ok: false,
          error: "Use GET for health checks or POST to process."
        }, 405);
      }

      if (
        env.WEBHOOK_SECRET &&
        request.headers.get("x-webhook-secret") !== env.WEBHOOK_SECRET
      ) {
        return respond({
          ok: false,
          error: "Unauthorized."
        }, 401);
      }

      const body = await request.json().catch(() => ({}));

      // Explicit application ID: process that application.
      if (body.application_id) {
        const result = await processApplication(
          env,
          body.application_id
        );

        return respond({
          ok: true,
          version: VERSION,
          result
        });
      }

      // Otherwise process one eligible application.
      const result = await processNextApplication(env);

      return respond({
        ok: true,
        version: VERSION,
        result
      });

    } catch (error) {
      console.error("Planner error:", error);

      return respond({
        ok: false,
        version: VERSION,
        error: error.message || String(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      processNextApplication(env).catch(error => {
        console.error("Scheduled execution failed:", error);
      })
    );
  }
};

// ============================================================
// 2. HTTP RESPONSE
// ============================================================

function respond(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// ============================================================
// 3. SUPABASE REST HELPERS
// ============================================================

function baseUrl(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL.");
  }

  return env.SUPABASE_URL.replace(/\/+$/, "");
}

function headers(env, extra = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  }

  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function params(values) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }

  return search.toString();
}

async function db(env, path, options = {}) {
  const response = await fetch(`${baseUrl(env)}/rest/v1/${path}`, {
    ...options,
    headers: headers(env, options.headers || {})
  });

  const text = await response.text();

  let result;

  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status} on /${path}: ` +
      `${typeof result === "string" ? result : JSON.stringify(result)}`
    );
  }

  return result;
}

// ============================================================
// 4. SELECT THE NEXT APPLICATION
//
// Prioritize the newest pending application.
// If there are no pending applications, process the newest
// working application.
//
// This handles one application per scheduled invocation.
// ============================================================

async function processNextApplication(env) {
  const pendingQuery = params({
    planner_status: "eq.pending",
    select: "*",
    order: "created_at.desc",
    limit: 1
  });

  let rows = await db(
    env,
    `applications?${pendingQuery}`
  );

  if (rows && rows.length > 0) {
    return processApplication(env, rows[0].id);
  }

  const workingQuery = params({
    planner_status: "eq.working",
    select: "*",
    order: "created_at.desc",
    limit: 1
  });

  rows = await db(
    env,
    `applications?${workingQuery}`
  );

  if (!rows || rows.length === 0) {
    return {
      processed: false,
      message: "No pending or working application."
    };
  }

  return processApplication(env, rows[0].id);
}

// ============================================================
// 5. LOAD AN APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const query = params({
    id: `eq.${applicationId}`,
    select: "*",
    limit: 1
  });

  const rows = await db(
    env,
    `applications?${query}`
  );

  return rows?.[0] || null;
}

async function updateApplication(env, applicationId, values) {
  const query = params({
    id: `eq.${applicationId}`
  });

  await db(env, `applications?${query}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal"
    },
    body: JSON.stringify(values)
  });
}

// ============================================================
// 6. MAIN APPLICATION PROCESSOR
// ============================================================

async function processApplication(env, applicationId) {
  const app = await getApplication(env, applicationId);

  if (!app) {
    throw new Error(`Application not found: ${applicationId}`);
  }

  const companyName = String(app.name || "").trim();

  if (!companyName) {
    throw new Error(
      `Application ${applicationId} has no name.`
    );
  }

  // Mark this application as being processed.
  if (app.planner_status !== "working") {
    await updateApplication(env, app.id, {
      planner_status: "working"
    });
  }

  // Read available business information.
  const context = await getCompanyContext(
    env,
    app.id,
    companyName
  );

  // Generate ten niches without an AI API.
  const nicheNames = generateNiches(
    companyName,
    context
  );

  // Save any missing niche records.
  await saveNiches(env, app, nicheNames);

  // Retrieve the actual saved records and their UUIDs.
  const niches = await getNiches(env, app.id);

  if (niches.length === 0) {
    throw new Error(
      `No customer niches found for ${companyName}.`
    );
  }

  // Create plans using deterministic JavaScript templates.
  const plans = await createMissingPlans(
    env,
    app,
    companyName,
    niches
  );

  // Check Reddit and Apollo independently.
  const connections = await getConnections(env, app);

  // Use the existing application creation timestamp as the
  // 30-minute reference; no new timestamp column is needed.
  const applicationTime = Date.parse(app.created_at);

  const elapsed = Number.isFinite(applicationTime)
    ? Date.now() - applicationTime
    : 0;

  const timerFinished = elapsed >= WAIT_MS;

  // Persist missing-connection prompts in planner_runs.
  const promptResult = await syncConnectionPrompts(
    env,
    app,
    connections,
    timerFinished
  );

  // The planner is complete when the niches and plans exist.
  // Keep it working during the 30-minute connection grace period
  // if an integration is still missing.
  const bothConnected =
    connections.reddit && connections.apollo;

  const plannerFinished =
    bothConnected || timerFinished;

  await updateApplication(env, app.id, {
    planner_status: plannerFinished ? "completed" : "working"
  });

  return {
    application_id: app.id,
    company_name: companyName,
    version: VERSION,
    ai_required: false,
    niches_found: niches.length,
    plans_created: plans.created,
    plans_already_existing: plans.existing,
    reddit_connected: connections.reddit,
    apollo_connected: connections.apollo,
    elapsed_minutes: Math.floor(Math.max(0, elapsed) / 60000),
    connection_timer_finished: timerFinished,
    connection_prompts: promptResult.prompts,
    planner_status: plannerFinished ? "completed" : "working"
  };
}

// ============================================================
// 7. READ BUSINESS INFORMATION
//
// business_data is optional.
// If it cannot be read, use the company name only.
// ============================================================

async function getCompanyContext(env, applicationId, companyName) {
  try {
    const query = params({
      application_id: `eq.${applicationId}`,
      select: "field,data",
      limit: 100
    });

    const rows = await db(
      env,
      `business_data?${query}`
    );

    const fragments = [];

    for (const row of rows || []) {
      fragments.push(String(row.field || ""));
      fragments.push(stringify(row.data));
    }

    return `${companyName} ${fragments.join(" ")}`.trim();

  } catch (error) {
    console.warn(
      "Could not read business_data:",
      error.message
    );

    return companyName;
  }
}

function stringify(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ============================================================
// 8. RULE-BASED CUSTOMER NICHE GENERATION
//
// No AI API calls.
// Uses business keywords and predefined templates.
// ============================================================

function generateNiches(companyName, context) {
  const text = `${companyName} ${context}`.toLowerCase();

  const industryRules = [
    {
      keywords: [
        "error monitoring",
        "error tracking",
        "bug monitoring",
        "debugging",
        "software errors",
        "developer tools",
        "api monitoring",
        "next.js",
        "nextjs",
        "react developer",
        "software development",
        "saas monitoring"
      ],
      niches: [
        "Early-stage SaaS founders",
        "Indie hackers building SaaS products",
        "Solo software developers",
        "React and Next.js developers",
        "Startup CTOs and technical co-founders",
        "Software development agencies",
        "DevOps and platform engineers",
        "Engineering managers at small SaaS companies",
        "Vibe-coding and no-code founders",
        "B2B SaaS product teams"
      ]
    },
    {
      keywords: [
        "digital marketing",
        "marketing agency",
        "social media",
        "seo agency",
        "content marketing",
        "advertising agency",
        "influencer marketing"
      ],
      niches: [
        "Small business owners needing marketing",
        "Early-stage startup founders",
        "B2B marketing managers",
        "Social media managers",
        "Digital marketing agencies",
        "E-commerce marketing teams",
        "Content creators and publishers",
        "SEO consultants and agencies",
        "Freelance marketing consultants",
        "In-house growth teams"
      ]
    },
    {
      keywords: [
        "ecommerce",
        "e-commerce",
        "shopify",
        "online store",
        "online retail",
        "product catalog"
      ],
      niches: [
        "Shopify store owners",
        "Small online retailers",
        "Direct-to-consumer brands",
        "Multi-product e-commerce businesses",
        "Subscription-box businesses",
        "Marketplace sellers",
        "E-commerce operations managers",
        "Online fashion brands",
        "Consumer electronics retailers",
        "E-commerce marketing teams"
      ]
    },
    {
      keywords: [
        "healthcare",
        "health care",
        "clinic",
        "hospital",
        "dental",
        "medical",
        "healthtech",
        "patient management"
      ],
      niches: [
        "Independent healthcare clinics",
        "Dental practices",
        "Specialty medical practices",
        "Multi-location clinic operators",
        "Hospital department managers",
        "Healthcare administrators",
        "Private healthcare providers",
        "Patient support teams",
        "Healthcare technology companies",
        "Medical practice owners"
      ]
    },
    {
      keywords: [
        "education",
        "online course",
        "e-learning",
        "elearning",
        "tutoring",
        "edtech",
        "school management"
      ],
      niches: [
        "Online course creators",
        "Independent tutors",
        "Private training institutes",
        "K-12 schools",
        "Higher education institutions",
        "Corporate learning teams",
        "Professional certification providers",
        "Education technology startups",
        "Coaching businesses",
        "Learning and development managers"
      ]
    },
    {
      keywords: [
        "recruitment",
        "recruiting",
        "staffing agency",
        "human resources",
        "hr software",
        "applicant tracking",
        "talent acquisition"
      ],
      niches: [
        "Recruitment agencies",
        "In-house talent acquisition teams",
        "Small business HR managers",
        "Technology recruiters",
        "Executive search firms",
        "Staffing companies",
        "High-growth startup hiring teams",
        "Contract staffing providers",
        "HR consultants",
        "Recruitment operations managers"
      ]
    },
    {
      keywords: [
        "real estate",
        "property management",
        "property listings",
        "realtor",
        "estate agency"
      ],
      niches: [
        "Independent real estate agents",
        "Residential real estate agencies",
        "Commercial property brokers",
        "Property management companies",
        "Real estate developers",
        "Property investment firms",
        "Rental property managers",
        "Real estate marketing teams",
        "Mortgage and property advisory firms",
        "Multi-location real estate agencies"
      ]
    },
    {
      keywords: [
        "fintech",
        "accounting",
        "bookkeeping",
        "invoicing",
        "payments",
        "expense management",
        "financial software"
      ],
      niches: [
        "Small business finance teams",
        "Accounting firms",
        "Independent accountants",
        "Bookkeeping agencies",
        "Fintech startups",
        "Online businesses managing payments",
        "Finance managers at growing companies",
        "Freelancers managing invoices",
        "Professional services firms",
        "Finance operations teams"
      ]
    },
    {
      keywords: [
        "cybersecurity",
        "security monitoring",
        "penetration testing",
        "threat detection",
        "data protection"
      ],
      niches: [
        "Small and medium-sized businesses",
        "SaaS security teams",
        "Startup CTOs",
        "IT administrators",
        "Managed security service providers",
        "Cybersecurity consultants",
        "Compliance managers",
        "Cloud infrastructure teams",
        "Enterprise security operations teams",
        "Technology companies handling sensitive data"
      ]
    },
    {
      keywords: [
        "restaurant",
        "food delivery",
        "cafe",
        "catering",
        "food ordering",
        "hospitality",
        "hotel booking"
      ],
      niches: [
        "Independent restaurants",
        "Restaurant groups",
        "Cafes and coffee shops",
        "Cloud kitchens",
        "Food delivery businesses",
        "Catering companies",
        "Hotel food and beverage teams",
        "Restaurant franchise operators",
        "Local food businesses",
        "Hospitality operations managers"
      ]
    }
  ];

  // Select the first matching industry rule.
  for (const rule of industryRules) {
    if (rule.keywords.some(keyword => text.includes(keyword))) {
      return rule.niches.slice(0, 10);
    }
  }

  // Fallback if the industry is unknown.
  return [
    "Small businesses in the target industry",
    "Founders of early-stage companies",
    "Owners of growing businesses",
    "Small and medium-sized enterprises",
    "Operations managers",
    "Business development managers",
    "Sales and marketing teams",
    "Consultants serving the target industry",
    "Professional services companies",
    "Decision-makers at growing companies"
  ];
}

// ============================================================
// 9. READ EXISTING CUSTOMER NICHES
// ============================================================

async function getNiches(env, applicationId) {
  const query = params({
    application_id: `eq.${applicationId}`,
    select: "id,application_id,niche_name,buying_intention,reddit_status,apollo_status",
    order: "buying_intention.desc",
    limit: 200
  });

  return await db(
    env,
    `customer_niches?${query}`
  );
}

// ============================================================
// 10. SAVE NICHES WITHOUT DUPLICATES
//
// Does not depend on is_active.
// Uses the existing status columns.
// ============================================================

async function saveNiches(env, app, nicheNames) {
  const existing = await getNiches(env, app.id);

  const existingNames = new Set(
    existing.map(row => normalize(row.niche_name))
  );

  const rows = [];

  for (let i = 0; i < nicheNames.length; i++) {
    const name = nicheNames[i];

    if (existingNames.has(normalize(name))) {
      continue;
    }

    rows.push({
      application_id: app.id,
      niche_name: name,
      buying_intention: NICHE_SCORES[i],
      reddit_status: "pending",
      apollo_status: "pending"
    });
  }

  if (rows.length > 0) {
    await db(env, "customer_niches", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(rows)
    });
  }

  return {
    created: rows.length,
    existing: existing.length
  };
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ============================================================
// 11. CHECK REDDIT AND APOLLO CONNECTIONS
//
// Uses the existing user_integrations table.
// Expected columns include:
// application_id, user_id, integration_id, status.
// ============================================================

async function getConnections(env, app) {
  const query = params({
    status: "eq.connected",
    select: "application_id,user_id,integration_id,status",
    limit: 1000
  });

  const rows = await db(
    env,
    `user_integrations?${query}`
  );

  let reddit = false;
  let apollo = false;

  for (const row of rows || []) {
    const sameApplication =
      row.application_id === app.id;

    const sameUser =
      row.application_id == null &&
      app.user_id != null &&
      String(row.user_id) === String(app.user_id);

    if (!sameApplication && !sameUser) {
      continue;
    }

    const name = String(
      row.integration_id || ""
    ).toLowerCase();

    if (name.includes("reddit")) {
      reddit = true;
    }

    if (name.includes("apollo")) {
      apollo = true;
    }
  }

  return { reddit, apollo };
}

// ============================================================
// 12. CREATE MISSING RESEARCH AND OUTREACH PLANS
//
// Uses the exact planner_runs schema provided by the user.
// No status column is queried or written.
//
// task is stored as JSON text.
// ============================================================

async function createMissingPlans(
  env,
  app,
  companyName,
  niches
) {
  const query = params({
    application_id: `eq.${app.id}`,
    select: "id,worker_type,source,niche,task,pending_count",
    limit: 1000
  });

  const existingRuns = await db(
    env,
    `planner_runs?${query}`
  );

  const existingKeys = new Set(
    (existingRuns || []).map(row =>
      runKey(row.worker_type, row.source, row.niche)
    )
  );

  const newRows = [];

  for (const niche of niches) {
    const nicheId = String(niche.id);
    const nicheName = String(niche.niche_name || "");

    // ---------------- REDDIT PLAN ----------------

    const redditKey = runKey(
      "research",
      "reddit",
      nicheId
    );

    if (!existingKeys.has(redditKey)) {
      const task = {
        task_id: `reddit_${app.id}_${nicheId}`,
        application_id: app.id,
        company_name: companyName,
        niche_id: nicheId,
        niche_name: nicheName,
        worker: "reddit_research",
        objective:
          `Research customer problems, needs, and buying signals ` +
          `among ${nicheName} relevant to ${companyName}.`,
        target_audience: [nicheName],
        problem_categories: [
          "customer_problems",
          "customer_acquisition",
          "buying_intent",
          "competitor_complaints"
        ],
        published_within_days: 7,
        target_new_posts: 20,
        requires_integration: "reddit"
      };

      newRows.push({
        application_id: app.id,
        user_id: app.user_id || null,
        worker_type: "research",
        source: "reddit",
        niche: nicheId,
        task: JSON.stringify(task),
        pending_count: 1,
        error: null
      });

      existingKeys.add(redditKey);
    }

    // ---------------- APOLLO PLAN ----------------

    const apolloKey = runKey(
      "lead_generation",
      "apollo",
      nicheId
    );

    if (!existingKeys.has(apolloKey)) {
      const task = {
        task_id: `apollo_${app.id}_${nicheId}`,
        application_id: app.id,
        company_name: companyName,
        niche_id: nicheId,
        niche_name: nicheName,
        worker: "apollo_lead_generation",
        objective:
          `Find qualified prospects in the ${nicheName} segment ` +
          `who may benefit from ${companyName}.`,
        target_audience: [nicheName],
        target_leads: 20,
        qualification: {
          match_customer_niche: true,
          require_business_relevance: true
        },
        requires_integration: "apollo"
      };

      newRows.push({
        application_id: app.id,
        user_id: app.user_id || null,
        worker_type: "lead_generation",
        source: "apollo",
        niche: nicheId,
        task: JSON.stringify(task),
        pending_count: 1,
        error: null
      });

      existingKeys.add(apolloKey);
    }
  }

  if (newRows.length > 0) {
    await db(env, "planner_runs", {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(newRows)
    });
  }

  return {
    created: newRows.length,
    existing: (existingRuns || []).length
  };
}

function runKey(workerType, source, niche) {
  return [
    String(workerType || ""),
    String(source || ""),
    String(niche || "")
  ].join("|");
}

// ============================================================
// 13. SAVE CONNECTION PROMPTS IN planner_runs
//
// No extra database column is needed.
//
// Prompt rows use:
// worker_type = planner
// source      = system
// niche       = null
// task        = JSON text
// pending_count = 1 while the prompt is active
//
// When the integration connects, pending_count becomes 0.
// ============================================================

async function syncConnectionPrompts(
  env,
  app,
  connections,
  timerFinished
) {
  const query = params({
    application_id: `eq.${app.id}`,
    worker_type: "eq.planner",
    source: "eq.system",
    select: "id,task,pending_count,error",
    limit: 1000
  });

  const rows = await db(
    env,
    `planner_runs?${query}`
  );

  const promptsByIntegration = new Map();

  for (const row of rows || []) {
    const task = parseJson(row.task);

    if (
      task &&
      task.type === "integration_prompt" &&
      task.integration
    ) {
      promptsByIntegration.set(task.integration, row);
    }
  }

  const desired = [];

  if (timerFinished && !connections.reddit) {
    desired.push({
      integration: "reddit",
      title: "Connect Reddit",
      message: "Connect Reddit to run your research agent."
    });
  }

  if (timerFinished && !connections.apollo) {
    desired.push({
      integration: "apollo",
      title: "Connect Apollo",
      message: "Connect Apollo to run your outreach agent."
    });
  }

  const prompts = [];

  for (const integration of ["reddit", "apollo"]) {
    const existing = promptsByIntegration.get(integration);
    const wanted = desired.find(
      prompt => prompt.integration === integration
    );

    if (wanted) {
      prompts.push(wanted);

      if (!existing) {
        const task = {
          type: "integration_prompt",
          task_id: `connect_${app.id}_${integration}`,
          application_id: app.id,
          integration,
          title: wanted.title,
          message: wanted.message,
          active: true
        };

        await db(env, "planner_runs", {
          method: "POST",
          headers: {
            Prefer: "return=minimal"
          },
          body: JSON.stringify([{
            application_id: app.id,
            user_id: app.user_id || null,
            worker_type: "planner",
            source: "system",
            niche: null,
            task: JSON.stringify(task),
            pending_count: 1,
            error: null
          }])
        });

      } else if (Number(existing.pending_count) === 0) {
        // Reactivate the prompt if the integration has
        // become disconnected again.
        await updateRun(env, existing.id, {
          pending_count: 1,
          error: null
        });
      }

    } else if (existing && Number(existing.pending_count) !== 0) {
      // Close an old prompt when the integration connects
      // or when the 30-minute timer has not finished.
      await updateRun(env, existing.id, {
        pending_count: 0
      });
    }
  }

  return { prompts };
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function updateRun(env, runId, values) {
  const query = params({
    id: `eq.${runId}`
  });

  await db(env, `planner_runs?${query}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal"
    },
    body: JSON.stringify(values)
  });
    }
