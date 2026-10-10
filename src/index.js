// ============================================================
// REPORTLI AI PLANNER
// Version 3.0
//
// APPLICATION WORKFLOW:
// pending -> working -> completed
//                   -> failed
//
// SOURCE CONSTRAINT:
// planner_runs.source must be one of:
// reddit, apollo, system
//
// Company planner: source = system
// Reddit research: source = reddit
// ============================================================


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
          version: "3.0",
          timestamp: new Date().toISOString()
        });
      }

      if (request.method !== "POST") {
        return jsonResponse({
          success: false,
          error: "Method not allowed"
        }, 405);
      }

      // Optional webhook authentication
      if (env.WEBHOOK_SECRET) {
        const suppliedSecret =
          request.headers.get("x-webhook-secret");

        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          return jsonResponse({
            success: false,
            error: "Unauthorized"
          }, 401);
        }
      }

      // Parse request body
      const rawBody = await request.text();
      let body = {};

      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return jsonResponse({
            success: false,
            error: "Invalid JSON request body"
          }, 400);
        }
      }

      console.log("Incoming request", {
        requestId,
        userAgent: request.headers.get("user-agent")
      });

      // Test Supabase connectivity
      if (body.test_supabase === true) {
        const result = await testSupabase(env);

        return jsonResponse({
          success: true,
          requestId,
          ...result
        });
      }

      // Manually process a specific pending application
      if (body.test_analysis === true) {
        if (!body.application_id) {
          return jsonResponse({
            success: false,
            error: "application_id is required"
          }, 400);
        }

        const result =
          await processSpecificPendingApplication(
            String(body.application_id),
            env,
            requestId,
            "manual_test"
          );

        return jsonResponse(
          result,
          result.success ? 200 : 500
        );
      }

      // Normal webhook:
      // Treat the webhook as a signal to check the queue.
      const result =
        await processNextPendingApplication(
          env,
          requestId
        );

      return jsonResponse(
        result,
        result.success ? 200 : 500
      );

    } catch (error) {
      console.error("Request failed", {
        requestId,
        message: error.message,
        stack: error.stack
      });

      return jsonResponse({
        success: false,
        requestId,
        error: error.message
      }, 500);
    }
  },


  // Scheduled Reddit research planner
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
// 2. JSON RESPONSE
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
// 3. SUPABASE REQUEST HELPER
// ============================================================

function getSupabaseConfig(env) {
  if (!env.SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
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
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.prefer
          ? { Prefer: options.prefer }
          : {})
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {})
    }
  );

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
// 4. TEST SUPABASE
// ============================================================

async function testSupabase(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,name,planner_status&limit=1"
  );

  return {
    message: "Supabase connection successful",
    rowsReturned: Array.isArray(rows) ? rows.length : 0
  };
}


// ============================================================
// 5. GET NEWEST PENDING APPLICATION
// ============================================================

async function getNewestPendingApplication(env) {
  const query = new URLSearchParams({
    select:
      "id,name,api_key,status,user_id,created_at,domain,company,planner_status",
    planner_status: "eq.pending",
    order: "created_at.desc.nullslast,id.desc",
    limit: "1"
  });

  const rows = await supabaseRequest(
    env,
    `applications?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}


// ============================================================
// 6. CLAIM APPLICATION
//
// Changes pending -> working only if the row is still pending.
//
// The conditional PATCH prevents two requests from
// successfully claiming the same row at the same time.
// ============================================================

async function claimApplication(applicationId, env) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,
    planner_status: "eq.pending",
    select:
      "id,name,api_key,status,user_id,created_at,domain,company,planner_status"
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
// 7. PROCESS NEXT PENDING APPLICATION
// ============================================================

async function processNextPendingApplication(
  env,
  requestId
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const application =
      await getNewestPendingApplication(env);

    if (!application) {
      console.log("No pending applications", {
        requestId
      });

      return {
        success: true,
        requestId,
        processed: false,
        message: "No pending applications"
      };
    }

    console.log("Attempting claim", {
      requestId,
      applicationId: application.id,
      attempt
    });

    const claimed = await claimApplication(
      application.id,
      env
    );

    if (!claimed) {
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
    requestId,
    processed: false,
    message: "Application claim retry limit reached"
  };
}


// ============================================================
// 8. MANUAL TEST OF A SPECIFIC APPLICATION
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
      requestId,
      applicationId,
      error:
        "Application not found, not pending, or already claimed"
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
// 9. PROCESS CLAIMED APPLICATION
// ============================================================

async function processClaimedApplication(
  application,
  env,
  requestId,
  triggerSource
) {
  const applicationId = application.id;
  let plannerRunId = null;

  console.log("Application claimed", {
    requestId,
    applicationId,
    triggerSource
  });

  try {
    // IMPORTANT FIX:
    // source must be reddit, apollo, or system.
    // Never use "webhook" here.

    const runRows = await supabaseRequest(
      env,
      "planner_runs?select=id",
      {
        method: "POST",
        body: {
          application_id: applicationId,
          user_id: application.user_id || null,
          worker_type: "company_planner",
          source: "system",
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

    if (Array.isArray(runRows) && runRows.length) {
      plannerRunId = runRows[0].id;
    }

    // Analyze company
    const analysis = await analyzeCompany(
      application,
      env
    );

    // Save analysis
    await saveBusinessData(
      applicationId,
      "company_analysis",
      analysis,
      env
    );

    // Generate 10 niches
    const niches = await generateCustomerNiches(
      application,
      analysis,
      env
    );

    // Save niches
    const saveResult = await saveCustomerNiches(
      application,
      niches,
      env
    );

    // Verify results
    const activeNiches = await getActiveNiches(
      applicationId,
      env
    );

    if (activeNiches.length < 10) {
      throw new Error(
        `Only ${activeNiches.length} active niches found; ` +
        "at least 10 are required"
      );
    }

    // Complete planner run
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

    // Mark application completed
    await updateApplicationStatus(
      applicationId,
      "completed",
      env
    );

    console.log("Application completed", {
      requestId,
      applicationId,
      generatedNiches: niches.length,
      insertedNiches: saveResult.inserted,
      activeNiches: activeNiches.length
    });

    return {
      success: true,
      requestId,
      applicationId,
      planner_status: "completed",
      companyAnalysisSaved: true,
      generatedNiches: niches.length,
      insertedNiches: saveResult.inserted,
      activeNiches: activeNiches.length
    };

  } catch (error) {
    console.error("Application processing failed", {
      requestId,
      applicationId,
      message: error.message,
      stack: error.stack
    });

    // Record error if the planner run was created
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
      } catch (loggingError) {
        console.error(
          "Could not save planner error",
          loggingError.message
        );
      }
    }

    // Mark application failed
    try {
      await updateApplicationStatus(
        applicationId,
        "failed",
        env
      );
    } catch (statusError) {
      console.error(
        "Could not update application status",
        statusError.message
      );
    }

    return {
      success: false,
      requestId,
      applicationId,
      planner_status: "failed",
      error: error.message
    };
  }
}


// ============================================================
// 10. UPDATE APPLICATION STATUS
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
      `Failed to set application status to ${status}`
    );
  }

  return rows[0];
}


// ============================================================
// 11. UPDATE PLANNER RUN
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
// 12. CALL SARVAM AI
// ============================================================

async function callSarvam(
  messages,
  env,
  maxTokens = 4096
) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY");
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
      "Sarvam returned invalid JSON: " +
      responseText.slice(0, 1000)
    );
  }

  if (!response.ok) {
    throw new Error(
      `Sarvam API error ${response.status}: ` +
      JSON.stringify(data).slice(0, 2000)
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Sarvam returned empty content");
  }

  return parseModelJson(content);
}


// ============================================================
// 13. PARSE SARVAM JSON
// ============================================================

function parseModelJson(content) {
  if (typeof content === "object" && content !== null) {
    return content;
  }

  if (typeof content !== "string") {
    throw new Error("Unexpected Sarvam response format");
  }

  const cleaned = content
    .trim()
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
// 14. ANALYZE COMPANY
// ============================================================

async function analyzeCompany(application, env) {
  const prompt = `
Analyze the following business using only the supplied data.

Application name: ${application.name || ""}
Website/domain: ${application.domain || ""}
Company information: ${application.company || ""}

Do not invent facts.
Use null or empty arrays for missing information.
Separate facts from assumptions.

Return valid JSON:

{
  "business_name": null,
  "website": null,
  "business_description": "",
  "industry": null,
  "products_or_services": [],
  "target_customers": [],
  "customer_problems": [],
  "value_proposition": "",
  "business_model": null,
  "known_facts": [],
  "assumptions": [],
  "missing_information": []
}
`;

  const result = await callSarvam(
    [
      {
        role: "system",
        content:
          "You are a careful business analyst. " +
          "Return valid JSON and do not invent facts."
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
    throw new Error("Invalid company analysis response");
  }

  return result;
}


// ============================================================
// 15. SAVE BUSINESS DATA
//
// Requires a unique constraint on:
// (application_id, field)
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
      prefer:
        "resolution=merge-duplicates,return=representation"
    }
  );
}


// ============================================================
// 16. GENERATE CUSTOMER NICHES
// ============================================================

async function generateCustomerNiches(
  application,
  analysis,
  env
) {
  const prompt = `
Generate exactly 10 different potential customer niches
for this business.

Company analysis:
${JSON.stringify(analysis)}

Application:
${JSON.stringify({
  name: application.name,
  domain: application.domain,
  company: application.company
})}

Each niche must describe a specific customer segment.

Avoid duplicate or nearly identical niches.
Prefer segments with a clear business problem and plausible
reason to buy.

Do not claim demand has been verified.
Do not invent real people or companies.

Return valid JSON:

{
  "niches": [
    {
      "niche_name": "Specific customer niche",
      "buying_intention": 7
    }
  ]
}

Requirements:
- Exactly 10 unique niches.
- niche_name must be a non-empty string.
- buying_intention must be an integer from 1 to 10.
- Return JSON only.
`;

  const result = await callSarvam(
    [
      {
        role: "system",
        content:
          "You are a customer segmentation planner. " +
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
    throw new Error("Sarvam response has no niches array");
  }

  const unique = [];
  const seen = new Set();

  for (const item of result.niches) {
    if (
      !item ||
      typeof item.niche_name !== "string"
    ) {
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

    unique.push({
      niche_name: name,
      buying_intention: score
    });
  }

  if (unique.length < 10) {
    throw new Error(
      `Sarvam generated ${unique.length} unique niches; ` +
      "10 are required"
    );
  }

  return unique.slice(0, 10);
}


// ============================================================
// 17. NORMALIZE NICHE NAME
// ============================================================

function normalizeNicheName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


// ============================================================
// 18. GET ACTIVE NICHES
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
// 19. SAVE CUSTOMER NICHES
//
// Preserves existing active niches.
// Adds new unique niches until at least 10 active niches exist.
// ============================================================

async function saveCustomerNiches(
  application,
  generatedNiches,
  env
) {
  const existing = await getActiveNiches(
    application.id,
    env
  );

  const existingNames = new Set(
    existing.map(row =>
      normalizeNicheName(row.niche_name)
    )
  );

  const needed = Math.max(0, 10 - existing.length);
  const rowsToInsert = [];

  for (const niche of generatedNiches) {
    if (rowsToInsert.length >= needed) {
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
      application_id: application.id,
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
// 20. SCHEDULED RESEARCH PLANNER
//
// Runs every 30 minutes.
//
// Only completed applications are eligible.
// Creates Reddit research tasks for niches without a recent
// task in the previous 7 days.
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
          const exists = await hasRecentRedditTask(
            application.id,
            niche.id,
            env
          );

          if (exists) {
            continue;
          }

          await createRedditResearchTask(
            application,
            niche,
            env
          );

          tasksCreated++;

        } catch (error) {
          console.error("Niche scheduling failed", {
            applicationId: application.id,
            nicheId: niche.id,
            message: error.message
          });
        }
      }

    } catch (error) {
      console.error("Application scheduling failed", {
        applicationId: application.id,
        message: error.message
      });
    }
  }

  console.log("Scheduled planner finished", {
    applicationsChecked: applications.length,
    tasksCreated
  });
}


// ============================================================
// 21. GET COMPLETED APPLICATIONS
// ============================================================

async function getEligibleApplications(env) {
  const query = new URLSearchParams({
    select: "id,name,user_id,domain,company,planner_status",
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
// 22. CHECK FOR RECENT REDDIT TASK
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
    source: "eq.reddit",
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
// 23. CREATE REDDIT RESEARCH TASK
//
// IMPORTANT FIX:
// source = reddit, NOT scheduled_planner.
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

    research_sources: ["Reddit"],

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
    "planner_runs?select=id",
    {
      method: "POST",
      body: {
        application_id: application.id,
        user_id: application.user_id || null,
        worker_type: "reddit_research",

        // Allowed by planner_runs_source_check
        source: "reddit",

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
