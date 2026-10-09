// ============================================================
// REPORTLI AI — COMPANY ANALYZER + NICHE PLANNER
// ============================================================
//
// WEBHOOK:
// New application
//   -> Create initial discovery task
//   -> Analyze company using Sarvam
//   -> Discover 10 customer niches
//   -> Save business_data
//   -> Save customer_niches
//   -> Complete discovery task
//
// CRON (EVERY 30 MINUTES):
//   -> Read active applications
//   -> Read customer niches
//   -> Check connected integrations
//   -> Select one niche
//   -> Create one Reddit OR Apollo task
//
// COMPLETION RULE:
// pending_count = 0 means completed.
//
// Required Supabase tables:
// applications
// business_data
// customer_niches
// planner_runs
// user_integrations
//
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const NICHE_TARGET =
  10;

const REDDIT_POST_TARGET =
  5;

const APOLLO_LEAD_TARGET =
  10;

const MAX_APPLICATIONS_PER_RUN =
  10;

const MAX_NICHES_PER_APPLICATION =
  10;


// ============================================================
// CORS AND RESPONSES
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Webhook-Secret",
    "Content-Type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: corsHeaders(),
    }
  );
}


// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabase(
  env,
  path,
  options = {}
) {
  if (!env.SUPABASE_URL) {
    throw new Error(
      "SUPABASE_URL is missing"
    );
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  const baseUrl =
    env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(
    `${baseUrl}${path}`,
    {
      ...options,

      headers: {
        apikey:
          env.SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {}),
      },
    }
  );

  const responseText =
    await response.text();

  let data = null;

  try {
    data = responseText
      ? JSON.parse(responseText)
      : null;
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


// ============================================================
// URL HELPERS
// ============================================================

function queryString(params) {
  return new URLSearchParams(
    params
  ).toString();
}

function applicationFilter(applicationId) {
  return encodeURIComponent(
    applicationId
  );
}


// ============================================================
// UPDATE APPLICATION
// ============================================================

async function updateApplication(
  env,
  applicationId,
  values
) {
  return await supabase(
    env,
    `/rest/v1/applications?id=eq.${applicationFilter(
      applicationId
    )}`,
    {
      method: "PATCH",

      headers: {
        Prefer: "return=representation",
      },

      body: JSON.stringify(
        values
      ),
    }
  );
}


// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(
  env,
  applicationId
) {
  const rows = await supabase(
    env,
    `/rest/v1/applications?${queryString({
      id: `eq.${applicationId}`,
      select:
        "id,name,company,domain,status,user_id,planner_status",
      limit: "1",
    })}`
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}


// ============================================================
// GET ACTIVE APPLICATIONS
// ============================================================

async function getActiveApplications(env) {
  return await supabase(
    env,
    `/rest/v1/applications?${queryString({
      status: "eq.active",
      select:
        "id,name,company,domain,status,user_id,planner_status,created_at",
      order: "created_at.asc",
      limit: String(
        MAX_APPLICATIONS_PER_RUN
      ),
    })}`
  );
}


// ============================================================
// GET CONNECTED INTEGRATIONS
// ============================================================

async function getConnectedIntegrations(
  env,
  applicationId
) {
  return await supabase(
    env,
    `/rest/v1/user_integrations?${queryString({
      application_id: `eq.${applicationId}`,
      status: "eq.connected",
      select:
        "integration_id,account_name,account_email,status",
    })}`
  );
}


// ============================================================
// NORMALIZE INTEGRATIONS
// ============================================================

function integrationSet(rows) {
  return new Set(
    (rows || []).map(
      (row) =>
        String(
          row.integration_id || ""
        )
          .trim()
          .toLowerCase()
    )
  );
}

function isRedditConnected(integrations) {
  return integrationSet(
    integrations
  ).has("reddit");
}

function isApolloConnected(integrations) {
  return integrationSet(
    integrations
  ).has("apollo");
}


// ============================================================
// GET CUSTOMER NICHES
// ============================================================

async function getCustomerNiches(
  env,
  applicationId
) {
  return await supabase(
    env,
    `/rest/v1/customer_niches?${queryString({
      application_id: `eq.${applicationId}`,
      niche_status: "eq.active",
      select:
        "id,application_id,user_id,niche_name,buying_intention,niche_status,created_at,updated_at",
      order: "created_at.asc",
      limit: String(
        MAX_NICHES_PER_APPLICATION
      ),
    })}`
  );
}


// ============================================================
// GET RECENT PLANNER RUNS
// ============================================================

async function getRecentRuns(
  env,
  applicationId
) {
  return await supabase(
    env,
    `/rest/v1/planner_runs?${queryString({
      application_id: `eq.${applicationId}`,
      select:
        "id,application_id,user_id,worker_type,source,task,pending_count,error,niche_id,created_at,started_at",
      order: "created_at.desc",
      limit: "100",
    })}`
  );
}


// ============================================================
// CREATE PLANNER TASK
// ============================================================

async function createPlannerTask(
  env,
  {
    application,
    workerType,
    source,
    task,
    pendingCount,
    nicheId = null,
  }
) {
  const payload = {
    application_id:
      application.id,

    user_id:
      application.user_id || null,

    worker_type:
      workerType,

    source:
      source,

    task:
      task,

    pending_count:
      pendingCount,

    error:
      null,

    niche_id:
      nicheId,

    started_at:
      null,
  };

  return await supabase(
    env,
    "/rest/v1/planner_runs",
    {
      method: "POST",

      headers: {
        Prefer: "return=representation",
      },

      body: JSON.stringify(
        payload
      ),
    }
  );
}


// ============================================================
// ENSURE INITIAL DISCOVERY TASK EXISTS
// ============================================================

async function ensureDiscoveryTask(
  env,
  application
) {
  const existing = await supabase(
    env,
    `/rest/v1/planner_runs?${queryString({
      application_id:
        `eq.${application.id}`,

      source:
        "eq.system",

      select:
        "id,pending_count,task",

      order:
        "created_at.asc",

      limit:
        "100",
    })}`
  );

  const alreadyExists =
    (existing || []).some(
      (row) =>
        String(row.task || "").includes(
          "Discover 10 customer niches"
        )
    );

  if (alreadyExists) {
    return {
      created: false,
      reason: "discovery_task_already_exists",
    };
  }

  const task =
    `Discover 10 customer niches for ${application.name}. ` +
    `Analyze the company's product, target audience, and value proposition. ` +
    `Save the discovered niches to customer_niches.`;

  await createPlannerTask(
    env,
    {
      application,
      workerType: "planner",
      source: "system",
      task,
      pendingCount: NICHE_TARGET,
    }
  );

  return {
    created: true,
  };
}


// ============================================================
// SARVAM API CALL
// ============================================================

async function callSarvam(
  env,
  prompt
) {
  const apiKey =
    String(
      env.SARVAM_API_KEY || ""
    ).trim();

  if (!apiKey) {
    throw new Error(
      "SARVAM_API_KEY is missing"
    );
  }

  const response = await fetch(
    SARVAM_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "api-subscription-key":
          apiKey,
      },

      body: JSON.stringify({
        model: SARVAM_MODEL,

        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],

        temperature: 0.2,

        max_tokens: 4096,

        response_format: {
          type: "json_object",
        },
      }),
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Sarvam ${response.status}: ${text}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Sarvam returned invalid response JSON"
    );
  }

  const choice =
    data?.choices?.[0];

  const content =
    choice?.message?.content;

  if (
    typeof content !== "string" ||
    !content.trim()
  ) {
    throw new Error(
      "Sarvam returned no final content. " +
      `finish_reason=${choice?.finish_reason || "unknown"}`
    );
  }

  return content;
}


// ============================================================
// PARSE SARVAM JSON
// ============================================================

function parseSarvamJSON(content) {
  let cleaned =
    String(content).trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start =
      cleaned.indexOf("{");

    const end =
      cleaned.lastIndexOf("}");

    if (
      start >= 0 &&
      end > start
    ) {
      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
    }

    throw new Error(
      "Could not parse Sarvam JSON"
    );
  }
}


// ============================================================
// COMPANY ANALYSIS + NICHE DISCOVERY PROMPT
// ============================================================

function buildCompanyAnalysisPrompt(
  application
) {
  return `
You are Reportli AI's company analyst.

Analyze the supplied company information and identify exactly 10
distinct potential customer niches for this company.

The objective is to identify customer segments the company could
realistically serve, not to invent actual individual leads.

RULES:
1. Return only valid JSON.
2. Identify 10 distinct customer niches.
3. Use the company information supplied below.
4. Do not claim unsupported facts about the company.
5. If information is incomplete, make reasonable, clearly qualified
   business hypotheses.
6. Avoid duplicate or nearly identical niches.
7. Each niche must be specific enough to research on Reddit or
   target with a lead-generation platform.
8. Buying intention is a preliminary AI estimate, not verified
   purchasing intent.
9. buying_intention must be an integer from 1 to 10.
10. Give niches that plausibly need the company's product.
11. Do not invent actual people, contact details, or companies.
12. Do not include markdown fences or explanatory text outside JSON.

COMPANY INFORMATION:
${JSON.stringify(
  {
    application_name:
      application.name || "",

    company_description:
      application.company || "",

    website:
      application.domain || "",
  },
  null,
  2
)}

Return this exact structure:

{
  "company_analysis": {
    "business_summary": "string",
    "product_or_service": "string",
    "target_audience": "string",
    "value_proposition": "string"
  },
  "niches": [
    {
      "niche_name": "string",
      "buying_intention": 7
    }
  ]
}
`;
}


// ============================================================
// VALIDATE COMPANY ANALYSIS
// ============================================================

function validateCompanyAnalysis(data) {
  if (
    !data ||
    !data.company_analysis ||
    !Array.isArray(data.niches)
  ) {
    throw new Error(
      "Sarvam response is missing company_analysis or niches"
    );
  }

  const analysis =
    data.company_analysis;

  for (const key of [
    "business_summary",
    "product_or_service",
    "target_audience",
    "value_proposition",
  ]) {
    if (
      typeof analysis[key] !== "string" ||
      !analysis[key].trim()
    ) {
      throw new Error(
        `Missing company analysis field: ${key}`
      );
    }
  }

  const seen = new Set();

  const niches = [];

  for (const raw of data.niches) {
    if (
      !raw ||
      typeof raw.niche_name !== "string"
    ) {
      continue;
    }

    const name =
      raw.niche_name.trim();

    if (!name) {
      continue;
    }

    const normalized =
      name.toLowerCase();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    const score =
      Number(raw.buying_intention);

    niches.push({
      niche_name: name,

      buying_intention:
        Number.isFinite(score)
          ? Math.max(
              1,
              Math.min(
                10,
                Math.round(score)
              )
            )
          : 5,
    });
  }

  if (niches.length !== NICHE_TARGET) {
    throw new Error(
      `Expected ${NICHE_TARGET} unique niches, received ${niches.length}`
    );
  }

  return {
    company_analysis: analysis,
    niches,
  };
}


// ============================================================
// SAVE BUSINESS ANALYSIS
//
// business_data schema:
// id, application_id, field, data,
// created_at, updated_at
//
// This function checks for an existing field before inserting
// or updating, so it does not require an upsert constraint.
// ============================================================

async function saveBusinessData(
  env,
  applicationId,
  field,
  data
) {
  const existing = await supabase(
    env,
    `/rest/v1/business_data?${queryString({
      application_id:
        `eq.${applicationId}`,

      field:
        `eq.${field}`,

      select:
        "id",

      limit:
        "1",
    })}`
  );

  const payload = {
    application_id:
      applicationId,

    field,

    data,

    updated_at:
      new Date().toISOString(),
  };

  if (
    Array.isArray(existing) &&
    existing.length > 0
  ) {
    return await supabase(
      env,
      `/rest/v1/business_data?id=eq.${existing[0].id}`,
      {
        method: "PATCH",

        headers: {
          Prefer: "return=representation",
        },

        body: JSON.stringify(
          payload
        ),
      }
    );
  }

  return await supabase(
    env,
    "/rest/v1/business_data",
    {
      method: "POST",

      headers: {
        Prefer: "return=representation",
      },

      body: JSON.stringify(
        payload
      ),
    }
  );
}


// ============================================================
// SAVE CUSTOMER NICHES
//
// Uses the existing customer_niches columns:
// id, application_id, niche_name, buying_intention,
// niche_status, created_at, updated_at, user_id
//
// Does not depend on a unique constraint.
// ============================================================

async function saveCustomerNiches(
  env,
  application,
  niches
) {
  const existing =
    await getCustomerNiches(
      env,
      application.id
    );

  const existingNames =
    new Set(
      (existing || []).map(
        (row) =>
          String(
            row.niche_name || ""
          )
            .trim()
            .toLowerCase()
      )
    );

  const saved = [];
  const skipped = [];

  for (const niche of niches) {
    const normalized =
      niche.niche_name
        .trim()
        .toLowerCase();

    if (
      existingNames.has(normalized)
    ) {
      skipped.push(
        niche.niche_name
      );

      continue;
    }

    const payload = {
      application_id:
        application.id,

      user_id:
        application.user_id || null,

      niche_name:
        niche.niche_name,

      buying_intention:
        niche.buying_intention,

      niche_status:
        "active",

      created_at:
        new Date().toISOString(),

      updated_at:
        new Date().toISOString(),
    };

    await supabase(
      env,
      "/rest/v1/customer_niches",
      {
        method: "POST",

        headers: {
          Prefer: "return=representation",
        },

        body: JSON.stringify(
          payload
        ),
      }
    );

    existingNames.add(normalized);

    saved.push(
      niche.niche_name
    );
  }

  return {
    saved_count:
      saved.length,

    saved,

    skipped_count:
      skipped.length,

    skipped,
  };
}


// ============================================================
// COMPLETE INITIAL DISCOVERY TASK
//
// pending_count = 0 means completed.
// ============================================================

async function completeDiscoveryTask(
  env,
  applicationId
) {
  const rows = await supabase(
    env,
    `/rest/v1/planner_runs?${queryString({
      application_id:
        `eq.${applicationId}`,

      source:
        "eq.system",

      select:
        "id,task,pending_count",

      order:
        "created_at.asc",

      limit:
        "100",
    })}`
  );

  for (const row of rows || []) {
    if (
      String(row.task || "").includes(
        "Discover 10 customer niches"
      ) &&
      Number(row.pending_count) > 0
    ) {
      await supabase(
        env,
        `/rest/v1/planner_runs?id=eq.${row.id}`,
        {
          method: "PATCH",

          headers: {
            Prefer: "return=representation",
          },

          body: JSON.stringify({
            pending_count: 0,
            error: null,
          }),
        }
      );
    }
  }
}


// ============================================================
// ANALYZE A NEW APPLICATION
// ============================================================

async function analyzeNewApplication(
  env,
  applicationId
) {
  let application =
    await getApplication(
      env,
      applicationId
    );

  if (!application) {
    throw new Error(
      `Application not found: ${applicationId}`
    );
  }

  console.log(
    "Analyzing application:",
    application.id,
    application.name
  );

  // ----------------------------------------------------------
  // Mark analysis as running
  // ----------------------------------------------------------

  await updateApplication(
    env,
    applicationId,
    {
      planner_status:
        "analyzing",
    }
  );

  // ----------------------------------------------------------
  // Create the initial task before analysis
  // ----------------------------------------------------------

  await ensureDiscoveryTask(
    env,
    application
  );

  // ----------------------------------------------------------
  // Company information must exist
  // ----------------------------------------------------------

  if (
    !String(
      application.company || ""
    ).trim() &&
    !String(
      application.name || ""
    ).trim() &&
    !String(
      application.domain || ""
    ).trim()
  ) {
    throw new Error(
      "Application has no company, name, or domain information"
    );
  }

  // ----------------------------------------------------------
  // Call Sarvam
  // ----------------------------------------------------------

  const prompt =
    buildCompanyAnalysisPrompt(
      application
    );

  const content =
    await callSarvam(
      env,
      prompt
    );

  const parsed =
    parseSarvamJSON(
      content
    );

  const validated =
    validateCompanyAnalysis(
      parsed
    );

  // ----------------------------------------------------------
  // Save company analysis
  // ----------------------------------------------------------

  await saveBusinessData(
    env,
    application.id,
    "company_analysis",
    validated.company_analysis
  );

  // ----------------------------------------------------------
  // Save 10 niches
  // ----------------------------------------------------------

  const nicheSaveResult =
    await saveCustomerNiches(
      env,
      application,
      validated.niches
    );

  // ----------------------------------------------------------
  // Verify at least 10 niches exist
  // ----------------------------------------------------------

  const savedNiches =
    await getCustomerNiches(
      env,
      application.id
    );

  if (
    !Array.isArray(savedNiches) ||
    savedNiches.length < NICHE_TARGET
  ) {
    throw new Error(
      `Niche verification failed: expected at least ${NICHE_TARGET} active niches, found ${savedNiches?.length || 0}`
    );
  }

  // ----------------------------------------------------------
  // Complete the discovery task
  // ----------------------------------------------------------

  await completeDiscoveryTask(
    env,
    application.id
  );

  // ----------------------------------------------------------
  // Mark application analysis complete
  // ----------------------------------------------------------

  await updateApplication(
    env,
    application.id,
    {
      planner_status:
        "completed",
    }
  );

  return {
    success: true,

    application_id:
      application.id,

    company:
      application.name,

    niches_saved:
      nicheSaveResult.saved_count,

    niches_skipped_as_existing:
      nicheSaveResult.skipped_count,

    active_niches:
      savedNiches.length,

    planner_status:
      "completed",
  };
}


// ============================================================
// NICHE ROTATION
//
// Selects the niche that has been used least recently.
// Avoids creating another task if that niche already has
// a task with pending_count > 0.
// ============================================================

function findPendingTaskForNiche(
  runs,
  nicheId
) {
  return (runs || []).find(
    (run) =>
      run.niche_id === nicheId &&
      Number(run.pending_count) > 0
  ) || null;
}

function lastTaskTimeForNiche(
  runs,
  nicheId
) {
  const matching =
    (runs || []).filter(
      (run) =>
        run.niche_id === nicheId
    );

  if (matching.length === 0) {
    return 0;
  }

  return Math.max(
    ...matching.map(
      (run) =>
        new Date(
          run.created_at || 0
        ).getTime()
    )
  );
}

function selectNextNiche(
  niches,
  runs
) {
  const candidates =
    (niches || []).filter(
      (niche) =>
        !findPendingTaskForNiche(
          runs,
          niche.id
        )
    );

  if (candidates.length === 0) {
    return null;
  }

  // Choose the niche with the oldest last-task time.
  // Niches never used before have timestamp 0.
  candidates.sort(
    (a, b) => {
      const timeA =
        lastTaskTimeForNiche(
          runs,
          a.id
        );

      const timeB =
        lastTaskTimeForNiche(
          runs,
          b.id
        );

      if (timeA !== timeB) {
        return timeA - timeB;
      }

      // Use higher buying-intention estimates as a tie-breaker.
      return (
        Number(b.buying_intention || 0) -
        Number(a.buying_intention || 0)
      );
    }
  );

  return candidates[0];
}


// ============================================================
// SELECT TASK SOURCE
//
// If both are connected, alternate between Reddit and Apollo.
// If only one is connected, use that integration.
// If neither is connected, create a setup task.
// ============================================================

function chooseTaskSource(
  integrations,
  previousRuns
) {
  const reddit =
    isRedditConnected(
      integrations
    );

  const apollo =
    isApolloConnected(
      integrations
    );

  if (reddit && !apollo) {
    return "reddit";
  }

  if (apollo && !reddit) {
    return "apollo";
  }

  if (!reddit && !apollo) {
    return "system";
  }

  // Both are connected. Alternate between them based on
  // the most recent external task.
  const latestExternal =
    (previousRuns || []).find(
      (run) =>
        run.source === "reddit" ||
        run.source === "apollo"
    );

  if (
    latestExternal?.source === "reddit"
  ) {
    return "apollo";
  }

  return "reddit";
}


// ============================================================
// BUILD NICHE TASK
// ============================================================

function buildNicheTask(
  application,
  niche,
  source
) {
  if (source === "reddit") {
    return {
      worker_type:
        "research",

      source:
        "reddit",

      pending_count:
        REDDIT_POST_TARGET,

      task:
        `Research the customer niche "${niche.niche_name}" for ${application.name}. ` +
        `Find ${REDDIT_POST_TARGET} relevant Reddit posts or discussions describing problems this customer niche experiences that may relate to the company's product. ` +
        `Check Supabase for duplicate posts before saving. ` +
        `Save each actual post URL, its problem summary, and supporting evidence. ` +
        `Do not invent posts or findings. ` +
        `Application company description: ${application.company || application.name}.`,
    };
  }

  if (source === "apollo") {
    return {
      worker_type:
        "lead_generation",

      source:
        "apollo",

      pending_count:
        APOLLO_LEAD_TARGET,

      task:
        `Find ${APOLLO_LEAD_TARGET} qualified prospects in the customer niche "${niche.niche_name}" for ${application.name}. ` +
        `Use Apollo to find real matching SaaS or e-commerce founders and decision-makers. ` +
        `Exclude prospects already saved in Supabase. ` +
        `Save actual available prospect records. ` +
        `Do not invent people, emails, companies, or contact details. ` +
        `Application company description: ${application.company || application.name}.`,
    };
  }

  return {
    worker_type:
      "planner",

    source:
      "system",

    pending_count:
      1,

    task:
      `Connect Reddit or Apollo for ${application.name} before researching the customer niche "${niche.niche_name}". ` +
      `Reddit is needed for customer-problem research. Apollo is needed for prospect discovery. ` +
      `No research or lead-generation results can be claimed until the appropriate integration is connected.`,
  };
}


// ============================================================
// CREATE ONE TASK FOR ONE NICHE
// ============================================================

async function createNextNicheTask(
  env,
  application
) {
  const niches =
    await getCustomerNiches(
      env,
      application.id
    );

  if (
    !Array.isArray(niches) ||
    niches.length === 0
  ) {
    return {
      success: true,
      skipped: true,
      reason: "no_active_customer_niches",
    };
  }

  const integrations =
    await getConnectedIntegrations(
      env,
      application.id
    );

  const runs =
    await getRecentRuns(
      env,
      application.id
    );

  // Select one niche that does not have unfinished work.
  const niche =
    selectNextNiche(
      niches,
      runs
    );

  if (!niche) {
    return {
      success: true,
      skipped: true,
      reason:
        "all_niches_have_pending_tasks",
    };
  }

  const source =
    chooseTaskSource(
      integrations,
      runs
    );

  const task =
    buildNicheTask(
      application,
      niche,
      source
    );

  // If no integration is connected, avoid repeatedly creating
  // identical setup tasks for the same niche.
  if (source === "system") {
    const existingSetupTask =
      runs.find(
        (run) =>
          run.niche_id === niche.id &&
          run.source === "system" &&
          Number(run.pending_count) > 0 &&
          String(run.task || "").includes(
            "Connect Reddit or Apollo"
          )
      );

    if (existingSetupTask) {
      return {
        success: true,
        skipped: true,
        reason:
          "integration_setup_task_already_pending",

        niche_id:
          niche.id,
      };
    }
  }

  const saved =
    await createPlannerTask(
      env,
      {
        application,

        workerType:
          task.worker_type,

        source:
          task.source,

        task:
          task.task,

        pendingCount:
          task.pending_count,

        nicheId:
          niche.id,
      }
    );

  return {
    success: true,

    skipped: false,

    application_id:
      application.id,

    niche_id:
      niche.id,

    niche_name:
      niche.niche_name,

    source:
      task.source,

    worker_type:
      task.worker_type,

    pending_count:
      task.pending_count,

    task_id:
      Array.isArray(saved)
        ? saved[0]?.id || null
        : null,
  };
}


// ============================================================
// PROCESS ONE APPLICATION ON CRON
// ============================================================

async function processScheduledApplication(
  env,
  application
) {
  try {
    // If the company analyzer has not completed,
    // don't create niche tasks yet.
    if (
      application.planner_status !==
      "completed"
    ) {
      return {
        application_id:
          application.id,

        skipped: true,

        reason:
          "company_analysis_not_completed",
      };
    }

    return await createNextNicheTask(
      env,
      application
    );
  } catch (error) {
    console.error(
      "Scheduled application error:",
      application.id,
      error
    );

    return {
      application_id:
        application.id,

      success: false,

      error:
        error?.message ||
        String(error),
    };
  }
}


// ============================================================
// RUN SCHEDULED PLANNER
// ============================================================

async function runScheduledPlanner(env) {
  const applications =
    await getActiveApplications(
      env
    );

  const results = [];

  for (const application of applications) {
    const result =
      await processScheduledApplication(
        env,
        application
      );

    results.push(result);
  }

  return {
    success: true,

    applications_checked:
      applications.length,

    results,
  };
}


// ============================================================
// HANDLE SUPABASE APPLICATION WEBHOOK
// ============================================================

async function handleApplicationWebhook(
  env,
  body
) {
  const eventType =
    String(body.type || "")
      .toUpperCase();

  const table =
    body.table || "";

  const schema =
    body.schema || "";

  const record =
    body.record || body.new || null;

  if (
    table !== "applications" ||
    (schema && schema !== "public")
  ) {
    return {
      success: true,
      ignored: true,
      reason:
        "not_an_applications_event",
    };
  }

  if (
    eventType &&
    eventType !== "INSERT"
  ) {
    return {
      success: true,
      ignored: true,
      reason:
        "not_an_insert_event",
    };
  }

  if (
    !record ||
    !record.id
  ) {
    throw new Error(
      "Webhook is missing record.id"
    );
  }

  // Re-fetch the record to use the current database values.
  const application =
    await getApplication(
      env,
      record.id
    );

  if (!application) {
    throw new Error(
      `Application ${record.id} was not found`
    );
  }

  // Avoid re-running an already completed analysis.
  if (
    application.planner_status ===
    "completed"
  ) {
    return {
      success: true,
      skipped: true,
      reason:
        "application_analysis_already_completed",

      application_id:
        application.id,
    };
  }

  try {
    return await analyzeNewApplication(
      env,
      application.id
    );
  } catch (error) {
    console.error(
      "Application analysis failed:",
      application.id,
      error
    );

    await updateApplication(
      env,
      application.id,
      {
        planner_status:
          "failed",
      }
    );

    // Leave the initial discovery task pending so that
    // an operator can inspect/retry the failed analysis.
    const runs =
      await supabase(
        env,
        `/rest/v1/planner_runs?${queryString({
          application_id:
            `eq.${application.id}`,

          source:
            "eq.system",

          select:
            "id,task,pending_count",

          limit:
            "100",
        })}`
      );

    for (const run of runs || []) {
      if (
        String(run.task || "").includes(
          "Discover 10 customer niches"
        ) &&
        Number(run.pending_count) > 0
      ) {
        await supabase(
          env,
          `/rest/v1/planner_runs?id=eq.${run.id}`,
          {
            method: "PATCH",

            body: JSON.stringify({
              error:
                error?.message ||
                String(error),
            }),
          }
        );
      }
    }

    throw error;
  }
}


// ============================================================
// HTTP HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders(),
        }
      );
    }

    // --------------------------------------------------------
    // HEALTH CHECK
    // --------------------------------------------------------

    if (
      request.method === "GET"
    ) {
      return json({
        success: true,

        worker:
          "reportli-ai-planner",

        status:
          "running",

        model:
          SARVAM_MODEL,

        niche_target:
          NICHE_TARGET,

        reddit_post_target:
          REDDIT_POST_TARGET,

        apollo_lead_target:
          APOLLO_LEAD_TARGET,

        schedule:
          "Every 30 minutes",

        completion_rule:
          "pending_count = 0 means completed",

        sarvam_configured:
          Boolean(
            String(
              env.SARVAM_API_KEY || ""
            ).trim()
          ),

        supabase_configured:
          Boolean(
            env.SUPABASE_URL &&
            env.SUPABASE_SERVICE_ROLE_KEY
          ),

        time:
          new Date().toISOString(),
      });
    }

    if (
      request.method !== "POST"
    ) {
      return json(
        {
          success: false,
          error:
            "Method not allowed",
        },
        405
      );
    }

    // --------------------------------------------------------
    // OPTIONAL WEBHOOK SECRET
    //
    // If WEBHOOK_SECRET is configured, Supabase must send
    // the same value in X-Webhook-Secret.
    //
    // --------------------------------------------------------

    if (env.WEBHOOK_SECRET) {
      const suppliedSecret =
        request.headers.get(
          "X-Webhook-Secret"
        );

      if (
        suppliedSecret !==
        env.WEBHOOK_SECRET
      ) {
        return json(
          {
            success: false,
            error:
              "Unauthorized webhook",
          },
          401
        );
      }
    }

    // --------------------------------------------------------
    // PARSE BODY
    // --------------------------------------------------------

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid JSON body",
        },
        400
      );
    }

    // --------------------------------------------------------
    // MANUAL NICHE ANALYSIS TEST
    //
    // POST:
    // {
    //   "test_analysis": true,
    //   "application_id": "YOUR_APPLICATION_ID"
    // }
    //
    // --------------------------------------------------------

    if (
      body.test_analysis === true
    ) {
      if (!body.application_id) {
        return json(
          {
            success: false,
            error:
              "application_id is required",
          },
          400
        );
      }

      try {
        const result =
          await analyzeNewApplication(
            env,
            body.application_id
          );

        return json({
          ...result,
          mode: "manual_analysis_test",
        });
      } catch (error) {
        console.error(
          "Manual analysis test failed:",
          error
        );

        return json(
          {
            success: false,
            mode:
              "manual_analysis_test",

            error:
              error?.message ||
              String(error),
          },
          500
        );
      }
    }

    // --------------------------------------------------------
    // MANUAL CRON TEST
    //
    // POST:
    // {
    //   "test_planner": true
    // }
    //
    // --------------------------------------------------------

    if (
      body.test_planner === true
    ) {
      try {
        const result =
          await runScheduledPlanner(
            env
          );

        return json({
          ...result,
          mode: "manual_planner_test",
        });
      } catch (error) {
        console.error(
          "Manual planner test failed:",
          error
        );

        return json(
          {
            success: false,

            error:
              error?.message ||
              String(error),
          },
          500
        );
      }
    }

    // --------------------------------------------------------
    // SUPABASE DATABASE WEBHOOK
    // --------------------------------------------------------

    try {
      const result =
        await handleApplicationWebhook(
          env,
          body
        );

      return json(result);
    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error
      );

      return json(
        {
          success: false,

          error:
            error?.message ||
            String(error),
        },
        500
      );
    }
  },

  // ==========================================================
  // CLOUDFLARE CRON
  // ==========================================================

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runScheduledPlanner(
        env
      ).catch(
        (error) => {
          console.error(
            "Scheduled planner failed:",
            error
          );
        }
      )
    );
  },
};
