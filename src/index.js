// ============================================================
// REPORTLI AI PLANNER
// Version 4.0
//
// COMPANY PLANNER:
// pending -> working -> completed / failed
//
// PLANNER_RUNS SOURCE:
// reddit, apollo, system
//
// PLANNER_RUNS WORKER TYPE:
// planner, research, lead_generation
//
// SCHEDULE:
// Every 30 minutes.
//
// REDDIT / APOLLO:
// - No AI used to generate tasks.
// - At most one new plan per application per scheduled run.
// - Do not create another plan while the latest plan has
//   pending_count > 0.
// - When an integration is disconnected, create a connection
//   task instead.
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
          version: "4.0",
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

      // Test Supabase
      if (body.test_supabase === true) {
        const result = await testSupabase(env);

        return jsonResponse({
          success: true,
          requestId,
          ...result
        });
      }

      // Manually process an application
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
            requestId
          );

        return jsonResponse(
          result,
          result.success ? 200 : 500
        );
      }

      // Normal webhook: check application queue
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


  // Run every 30 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduledPlanner(env).catch(error => {
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


// ============================================================
// 3. SUPABASE CONFIGURATION
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


// ============================================================
// 4. SUPABASE REQUEST HELPER
// ============================================================

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
        ? {
            body: JSON.stringify(options.body)
          }
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
// 5. TEST SUPABASE
// ============================================================

async function testSupabase(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,name,planner_status&limit=1"
  );

  return {
    message: "Supabase connection successful",
    rowsReturned: Array.isArray(rows)
      ? rows.length
      : 0
  };
}


// ============================================================
// 6. GET NEWEST PENDING APPLICATION
// ============================================================

async function getNewestPendingApplication(env) {
  const query = new URLSearchParams({
    select:
      "id,name,api_key,status,user_id,created_at," +
      "domain,company,planner_status",

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
// 7. CLAIM APPLICATION
// ============================================================

async function claimApplication(applicationId, env) {
  const query = new URLSearchParams({
    id: `eq.${applicationId}`,

    planner_status: "eq.pending",

    select:
      "id,name,api_key,status,user_id,created_at," +
      "domain,company,planner_status"
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
// 8. PROCESS NEXT PENDING APPLICATION
// ============================================================

async function processNextPendingApplication(
  env,
  requestId
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const application =
      await getNewestPendingApplication(env);

    if (!application) {
      return {
        success: true,
        requestId,
        processed: false,
        message: "No pending applications"
      };
    }

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
      requestId
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
// 9. MANUAL APPLICATION PROCESSING
// ============================================================

async function processSpecificPendingApplication(
  applicationId,
  env,
  requestId
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
    requestId
  );
}


// ============================================================
// 10. PROCESS COMPANY
//
// Sarvam is used for company analysis and niche generation.
// Reddit/Apollo recurring task planning does not use AI.
// ============================================================

async function processClaimedApplication(
  application,
  env,
  requestId
) {
  const applicationId = application.id;

  let plannerRunId = null;

  try {
    const companyName =
      String(application.name || "").trim() ||
      "your company";

    // Create company planner record.
    // Use existing database worker_type and source values.
    const runRows = await supabaseRequest(
      env,
      "planner_runs?select=id",
      {
        method: "POST",

        body: {
          application_id: applicationId,

          user_id: application.user_id || null,

          worker_type: "planner",

          source: "system",

          task:
            `Analyze the company and find 10 customer niches ` +
            `for ${companyName}`,

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

    // 1. Analyze company
    const analysis = await analyzeCompany(
      application,
      env
    );

    // 2. Save company analysis
    await saveBusinessData(
      applicationId,
      "company_analysis",
      analysis,
      env
    );

    // 3. Generate short niche names
    const niches = await generateCustomerNiches(
      application,
      analysis,
      env
    );

    // 4. Save exactly 10 niches and percentage scores
    const saveResult = await saveCustomerNiches(
      application,
      niches,
      env
    );

    // 5. Verify saved active niches
    const activeNiches = await getActiveNiches(
      applicationId,
      env
    );

    if (activeNiches.length !== 10) {
      throw new Error(
        `Expected 10 active niches, found ${activeNiches.length}`
      );
    }

    const percentageTotal = activeNiches.reduce(
      (total, niche) =>
        total + Number(niche.buying_intention || 0),
      0
    );

    if (percentageTotal !== 100) {
      throw new Error(
        `Niche buying_intention percentages total ` +
        `${percentageTotal}, not 100`
      );
    }

    // 6. Complete company planner run
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

    // 7. Complete application
    await updateApplicationStatus(
      applicationId,
      "completed",
      env
    );

    return {
      success: true,
      requestId,
      applicationId,
      planner_status: "completed",
      companyAnalysisSaved: true,
      generatedNiches: niches.length,
      insertedNiches: saveResult.inserted,
      activeNiches: activeNiches.length,
      buyingIntentionTotal: percentageTotal
    };

  } catch (error) {
    console.error("Application processing failed", {
      requestId,
      applicationId,
      message: error.message,
      stack: error.stack
    });

    if (plannerRunId) {
      try {
        await updatePlannerRun(
          plannerRunId,
          {
            pending_count: 0,
            error: String(
              error.message || error
            ).slice(0, 5000)
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
// 11. UPDATE APPLICATION STATUS
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
// 12. UPDATE PLANNER RUN
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
// 13. SARVAM API
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
// 14. PARSE SARVAM JSON
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
// 15. ANALYZE COMPANY
// ============================================================

async function analyzeCompany(application, env) {
  const prompt = `
Analyze this business using only the supplied information.

Application name: ${application.name || ""}
Website/domain: ${application.domain || ""}
Company information: ${application.company || ""}

Do not invent facts.
Separate known facts from assumptions.
Use null or empty arrays for missing information.

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
// 16. SAVE BUSINESS DATA
//
// Requires UNIQUE(application_id, field).
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
// 17. GENERATE SHORT CUSTOMER NICHE NAMES
//
// Sarvam returns niche labels only.
// Percentages are calculated locally in JavaScript.
// ============================================================

async function generateCustomerNiches(
  application,
  analysis,
  env
) {
  const prompt = `
Generate exactly 10 distinct potential customer niches
for this business.

Company:
${JSON.stringify({
  name: application.name,
  domain: application.domain,
  company: application.company
})}

Company analysis:
${JSON.stringify(analysis)}

Generate exactly 10 distinct customer segment names, each 1–4 words (e.g., Freelancers, Website Agencies, SaaS Startups). Identify WHO the customers are, not their goals, strategies, or platforms. Avoid descriptions, duplicates, and near-duplicates. Order niches from highest to lowest estimated buying priority. Return JSON only, with no "buying_intention" values.

Format:

{
  "niches": [
    {
      "niche_name": "Freelancers"
    },
    {
      "niche_name": "Website Agencies"
    }
  ]
}
`;

  const result = await callSarvam(
    [
      {
        role: "system",
        content:
          "You generate short customer segment labels. " +
          "Return valid JSON only. Never write descriptions."
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

    const name = cleanNicheName(item.niche_name);

    if (!name) {
      continue;
    }

    if (name.split(/\s+/).length > 4) {
      continue;
    }

    const normalized = normalizeNicheName(name);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    unique.push({
      niche_name: name
    });
  }

  if (unique.length < 10) {
    throw new Error(
      `Only ${unique.length} unique short niches were generated. ` +
      "Ten are required. Retry company planning."
    );
  }

  // Distinct percentages, descending, totaling exactly 100.
  // These are relative priority shares, not verified
  // probabilities of a purchase.
  const percentages = [
    19, 16, 13, 11, 10,
     9,  8,  6,  5,  3
  ];

  return unique.slice(0, 10).map((niche, index) => ({
    niche_name: niche.niche_name,
    buying_intention: percentages[index]
  }));
}


// ============================================================
// 18. CLEAN NICHE NAME
// ============================================================

function cleanNicheName(value) {
  let name = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");

  // Remove generic marketing descriptions.
  name = name.replace(
    /^direct[-\s]?to[-\s]?consumer\s+/i,
    ""
  );

  name = name.replace(
    /\s+(on|using|through)\s+(shopify|linkedin|facebook|instagram|tiktok).*$/i,
    ""
  );

  name = name.replace(
    /\s+(generating leads|attracting clients|finding customers|looking for leads|by commenting|that want to|who want to).*$/i,
    ""
  );

  // Remove common filler words.
  const ignoredWords = new Set([
    "and",
    "the",
    "for",
    "with",
    "that",
    "who",
    "on",
    "in"
  ]);

  const words = name
    .split(/\s+/)
    .filter(Boolean)
    .filter(word =>
      !ignoredWords.has(word.toLowerCase())
    );

  // Keep labels short.
  name = words.slice(0, 4).join(" ");

  return name.trim();
}


// ============================================================
// 19. NORMALIZE NICHE NAME
// ============================================================

function normalizeNicheName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


// ============================================================
// 20. GET ACTIVE NICHES
// ============================================================

async function getActiveNiches(applicationId, env) {
  const query = new URLSearchParams({
    select:
      "id,application_id,niche_name,buying_intention," +
      "niche_status,user_id,created_at",

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
// 21. SAVE CUSTOMER NICHES
//
// The active set is replaced if it does not contain exactly
// 10 short labels with 10 distinct percentages totaling 100.
//
// Old active niches are marked inactive rather than deleted.
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

  const existingPercentages = existing.map(row =>
    Number(row.buying_intention)
  );

  const existingPercentageTotal =
    existingPercentages.reduce(
      (sum, value) => sum + value,
      0
    );

  const existingNamesAreShort = existing.every(row =>
    String(row.niche_name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .length <= 4
  );

  const existingPercentagesAreUnique =
    new Set(existingPercentages).size === 10;

  const existingIsValid =
    existing.length === 10 &&
    existingNamesAreShort &&
    existingPercentagesAreUnique &&
    existingPercentageTotal === 100;

  if (existingIsValid) {
    return {
      existing: existing.length,
      inserted: 0,
      preserved: true
    };
  }

  // Mark previous active niches inactive.
  if (existing.length > 0) {
    const query = new URLSearchParams({
      application_id: `eq.${application.id}`,
      niche_status: "eq.active",
      select: "id"
    });

    await supabaseRequest(
      env,
      `customer_niches?${query.toString()}`,
      {
        method: "PATCH",

        body: {
          niche_status: "inactive",
          updated_at: new Date().toISOString()
        },

        prefer: "return=representation"
      }
    );
  }

  if (generatedNiches.length !== 10) {
    throw new Error(
      "Exactly 10 niches are required before saving"
    );
  }

  const rowsToInsert = generatedNiches.map(niche => ({
    application_id: application.id,

    user_id: application.user_id || null,

    niche_name: niche.niche_name,

    buying_intention: niche.buying_intention,

    niche_status: "active",

    created_at: new Date().toISOString(),

    updated_at: new Date().toISOString()
  }));

  await supabaseRequest(
    env,
    "customer_niches?select=id,niche_name,buying_intention,niche_status",
    {
      method: "POST",

      body: rowsToInsert,

      prefer: "return=representation"
    }
  );

  return {
    existing: existing.length,
    inserted: rowsToInsert.length,
    preserved: false
  };
}


// ============================================================
// 22. GET COMPLETED APPLICATIONS
// ============================================================

async function getEligibleApplications(env) {
  const query = new URLSearchParams({
    select:
      "id,name,user_id,domain,company,planner_status",

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
// 23. CHECK USER INTEGRATION
//
// Expected user_integrations fields:
// application_id
// integration_id
// status
//
// Reddit integration_id = reddit
// Apollo integration_id = apollo
// Connected status = connected
// ============================================================

async function isIntegrationConnected(
  applicationId,
  integrationId,
  env
) {
  const query = new URLSearchParams({
    select: "id,integration_id,status",

    application_id: `eq.${applicationId}`,

    integration_id: `eq.${integrationId}`,

    status: "eq.connected",

    limit: "1"
  });

  const rows = await supabaseRequest(
    env,
    `user_integrations?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length > 0;
}


// ============================================================
// 24. GET LATEST PLAN FOR A SOURCE
//
// Checks the latest planner run for the application/source.
// The pending_count value controls whether another plan
// may be created.
// ============================================================

async function getLatestPlan(
  applicationId,
  source,
  env
) {
  const query = new URLSearchParams({
    select:
      "id,application_id,worker_type,source," +
      "pending_count,task,created_at",

    application_id: `eq.${applicationId}`,

    source: `eq.${source}`,

    order: "created_at.desc",

    limit: "1"
  });

  const rows = await supabaseRequest(
    env,
    `planner_runs?${query.toString()}`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}


// ============================================================
// 25. DETECT CONNECTION TASK
// ============================================================

function isConnectionTask(task, integrationId) {
  if (typeof task !== "string") {
    return false;
  }

  const text = task.toLowerCase();

  if (integrationId === "reddit") {
    return text.includes("connect reddit");
  }

  if (integrationId === "apollo") {
    return text.includes("connect apollo");
  }

  return false;
}


// ============================================================
// 26. CREATE REDDIT OR APOLLO TASK
//
// No AI calls are used in this section.
// ============================================================

async function createSourcePlan(
  application,
  source,
  env
) {
  const isReddit = source === "reddit";

  const integrationId = isReddit
    ? "reddit"
    : "apollo";

  const workerType = isReddit
    ? "research"
    : "lead_generation";

  const connected = await isIntegrationConnected(
    application.id,
    integrationId,
    env
  );

  const latest = await getLatestPlan(
    application.id,
    source,
    env
  );

  // ----------------------------------------------------------
  // CASE A: Integration is NOT connected.
  // Create a connection task or keep the existing active task.
  // ----------------------------------------------------------

  if (!connected) {
    const connectionTask = isReddit
      ? "Connect Reddit to run your research agent"
      : "Connect Apollo to run your outreach agent";

    if (latest && Number(latest.pending_count) !== 0) {
      // There is already an active plan.
      // If it isn't a connection task, replace its task text
      // rather than creating a duplicate planner run.
      if (!isConnectionTask(latest.task, integrationId)) {
        await updatePlannerRun(
          latest.id,
          {
            task: connectionTask,
            error: null
          },
          env
        );

        return {
          created: false,
          updated: true,
          source,
          message: connectionTask
        };
      }

      // Connection task already exists and remains pending.
      return {
        created: false,
        source,
        message: "Connection task already pending"
      };
    }

    // No active plan, or the latest plan has pending_count=0.
    await insertPlannerRun(
      application,
      {
        worker_type: workerType,
        source,
        task: connectionTask,
        pending_count: 1,
        niche_id: null
      },
      env
    );

    return {
      created: true,
      source,
      task: connectionTask,
      integrationConnected: false
    };
  }

  // ----------------------------------------------------------
  // CASE B: Integration IS connected.
  // ----------------------------------------------------------

  if (latest && Number(latest.pending_count) !== 0) {
    if (isConnectionTask(latest.task, integrationId)) {
      // The user has now connected the integration.
      // Close the old connection task before creating a
      // normal task. This keeps only one active plan per source.
      await updatePlannerRun(
        latest.id,
        {
          pending_count: 0,
          error: null
        },
        env
      );
    } else {
      // A normal task is still pending.
      return {
        created: false,
        source,
        message: "A plan for this source is already pending"
      };
    }
  }

  // Create one normal plan without using AI.
  if (isReddit) {
    const task = await buildRedditTask(
      application,
      env
    );

    await insertPlannerRun(
      application,
      {
        worker_type: "research",
        source: "reddit",
        task: JSON.stringify(task),
        pending_count: 1,
        niche_id: null
      },
      env
    );

    return {
      created: true,
      source: "reddit",
      taskId: task.task_id,
      integrationConnected: true
    };
  }

  const apolloTask = await buildApolloTask(
    application,
    env
  );

  await insertPlannerRun(
    application,
    {
      worker_type: "lead_generation",
      source: "apollo",
      task: JSON.stringify(apolloTask),
      pending_count: 1,
      niche_id: null
    },
    env
  );

  return {
    created: true,
    source: "apollo",
    taskId: apolloTask.task_id,
    integrationConnected: true
  };
}


// ============================================================
// 27. INSERT PLANNER RUN
// ============================================================

async function insertPlannerRun(
  application,
  plan,
  env
) {
  const body = {
    application_id: application.id,

    user_id: application.user_id || null,

    worker_type: plan.worker_type,

    source: plan.source,

    task: plan.task,

    pending_count: plan.pending_count,

    error: null
  };

  if (plan.niche_id) {
    body.niche_id = plan.niche_id;
  }

  const rows = await supabaseRequest(
    env,
    "planner_runs?select=id,source,worker_type,pending_count",
    {
      method: "POST",

      body,

      prefer: "return=representation"
    }
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}


// ============================================================
// 28. BUILD REDDIT TASK
//
// Uses stored company/niche data.
// No AI calls.
// ============================================================

async function buildRedditTask(
  application,
  env
) {
  const niches = await getActiveNiches(
    application.id,
    env
  );

  const taskId =
    "research_" +
    Date.now() +
    "_" +
    crypto.randomUUID().slice(0, 8);

  return {
    task_id: taskId,

    application_id: application.id,

    worker: "reddit_research",

    objective:
      "Research recent Reddit discussions to find " +
      "customer problems, buying signals, and " +
      "opportunities relevant to this company's niches.",

    company: {
      name: application.name || null,
      domain: application.domain || null,
      description: application.company || null
    },

    target_niches: niches.map(niche => ({
      niche_id: niche.id,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention
    })),

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

    created_at: new Date().toISOString()
  };
}


// ============================================================
// 29. BUILD APOLLO TASK
//
// Uses stored company/niche data.
// No AI calls.
// ============================================================

async function buildApolloTask(
  application,
  env
) {
  const niches = await getActiveNiches(
    application.id,
    env
  );

  const taskId =
    "leadgen_" +
    Date.now() +
    "_" +
    crypto.randomUUID().slice(0, 8);

  return {
    task_id: taskId,

    application_id: application.id,

    worker: "apollo_lead_generation",

    objective:
      "Find and qualify potential business leads matching " +
      "the company's highest-priority customer niches.",

    company: {
      name: application.name || null,
      domain: application.domain || null,
      description: application.company || null
    },

    target_niches: niches.map(niche => ({
      niche_id: niche.id,
      niche_name: niche.niche_name,
      buying_intention: niche.buying_intention
    })),

    lead_requirements: {
      prioritize_highest_buying_intention: true,
      require_relevant_company: true,
      require_relevant_contact: true,
      avoid_duplicate_leads: true
    },

    created_at: new Date().toISOString()
  };
}


// ============================================================
// 30. SCHEDULED PLANNER
//
// Runs every 30 minutes.
//
// For each completed application:
// 1. Check Reddit.
// 2. If no new Reddit plan can be created, check Apollo.
// 3. Create at most ONE new plan per application per run.
//
// A source with pending_count > 0 is considered active.
// A source with pending_count = 0 may receive another plan.
// ============================================================

async function runScheduledPlanner(env) {
  console.log("Scheduled planner started");

  const applications = await getEligibleApplications(env);

  let plansCreated = 0;
  let plansUpdated = 0;

  for (const application of applications) {
    try {
      // Prioritize Reddit. If a new Reddit plan is created,
      // do not create an Apollo plan for this application
      // in the same scheduled run.
      const redditResult = await createSourcePlan(
        application,
        "reddit",
        env
      );

      if (redditResult.created) {
        plansCreated++;

        console.log("Reddit plan created", {
          applicationId: application.id,
          result: redditResult
        });

        continue;
      }

      if (redditResult.updated) {
        plansUpdated++;
      }

      // Reddit has an active plan or no new Reddit plan
      // was created. Check Apollo next.
      const apolloResult = await createSourcePlan(
        application,
        "apollo",
        env
      );

      if (apolloResult.created) {
        plansCreated++;

        console.log("Apollo plan created", {
          applicationId: application.id,
          result: apolloResult
        });
      }

      if (apolloResult.updated) {
        plansUpdated++;
      }

    } catch (error) {
      console.error("Scheduled application failed", {
        applicationId: application.id,
        message: error.message,
        stack: error.stack
      });
    }
  }

  console.log("Scheduled planner finished", {
    applicationsChecked: applications.length,
    plansCreated,
    plansUpdated
  });
      }
