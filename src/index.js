// ============================================================
// REPORTLI AI — PLANNER WORKER
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

// Maximum applications processed in ONE Worker invocation.
// This prevents Cloudflare "Too many subrequests" errors.
const BATCH_SIZE = 3;

// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders(),
  });
}

// ============================================================
// SUPABASE
// ============================================================

async function supabase(env, path, options = {}) {
  if (!env.SUPABASE_URL) {
    throw new Error("SUPABASE_URL is missing");
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
  }

  const response = await fetch(
    `${env.SUPABASE_URL}${path}`,
    {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

// ============================================================
// GET ACTIVE APPLICATIONS
// ============================================================

async function getActiveApplications(env) {
  return await supabase(
    env,
    "/rest/v1/applications?status=eq.active&select=id,name,domain,company,status,user_id&order=created_at.asc"
  );
}

// ============================================================
// GET APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const data = await supabase(
    env,
    `/rest/v1/applications?id=eq.${encodeURIComponent(
      applicationId
    )}&select=id,name,domain,company,status,user_id&limit=1`
  );

  return data?.[0] || null;
}

// ============================================================
// GET CONNECTED INTEGRATIONS
// ============================================================

async function getConnectedIntegrations(env, applicationId) {
  return await supabase(
    env,
    `/rest/v1/user_integrations?application_id=eq.${encodeURIComponent(
      applicationId
    )}&status=eq.connected&select=integration_id,account_name,account_email`
  );
}

// ============================================================
// GET RECENT PLANNER RUNS
// ============================================================

async function getRecentRuns(env, applicationId) {
  return await supabase(
    env,
    `/rest/v1/planner_runs?application_id=eq.${encodeURIComponent(
      applicationId
    )}&select=id,plan_date,plan_number,plan,tasks,result,status,error,created_at,completed_at&order=created_at.desc&limit=20`
  );
}

// ============================================================
// CHECK IF APPLICATION HAS ANY PLANS
// ============================================================

async function hasAnyPlans(env, applicationId) {
  const data = await supabase(
    env,
    `/rest/v1/planner_runs?application_id=eq.${encodeURIComponent(
      applicationId
    )}&select=id&limit=1`
  );

  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// GET TODAY'S PLANS
// ============================================================

async function getTodayPlans(env, applicationId) {
  const today = new Date().toISOString().slice(0, 10);

  return await supabase(
    env,
    `/rest/v1/planner_runs?application_id=eq.${encodeURIComponent(
      applicationId
    )}&plan_date=eq.${today}&select=id,plan_number,plan,tasks,result,status,created_at,completed_at&order=plan_number.asc`
  );
}

// ============================================================
// GET COMPLETED PLANS OLDER THAN 24 HOURS
// ============================================================
//
// IMPORTANT:
// Do NOT query only the last 24 hours and then check for
// records older than 24 hours. That can never work.
//
// We directly query:
// created_at <= now - 24 hours
// ============================================================

async function getExpiredCompletedRuns(env, applicationId) {
  const cutoff = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  return await supabase(
    env,
    `/rest/v1/planner_runs?application_id=eq.${encodeURIComponent(
      applicationId
    )}&status=eq.completed&created_at=lte.${encodeURIComponent(
      cutoff
    )}&select=id,plan_date,plan_number,plan,tasks,result,status,created_at,completed_at&order=created_at.asc&limit=5`
  );
}

// ============================================================
// SAVE PLAN
// ============================================================

async function savePlan(env, applicationId, userId, plan, planNumber) {
  const today = new Date().toISOString().slice(0, 10);

  const payload = {
    application_id: applicationId,
    user_id: userId || null,
    plan_date: today,
    plan_number: planNumber,
    plan: plan,
    tasks: [
      {
        title: plan.title,
        task_type: plan.task_type,
        worker_type: plan.worker_type,
        instruction: plan.instruction,
        priority: plan.priority,
        input_data: plan.input_data || {},
        status: "pending",
      },
    ],
    result: null,
    status: "pending",
    error: null,
  };

  return await supabase(
    env,
    "/rest/v1/planner_runs",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    }
  );
}

// ============================================================
// INTEGRATION SUMMARY
// ============================================================

function buildIntegrationSummary(integrations) {
  const connected = new Set(
    (integrations || []).map((x) =>
      String(x.integration_id || "").toLowerCase()
    )
  );

  return {
    apollo: connected.has("apollo"),
    reddit: connected.has("reddit"),
    gmail: connected.has("gmail"),
    google_calendar:
      connected.has("google-calendar") ||
      connected.has("google_calendar"),
    google_meet:
      connected.has("google-meet") ||
      connected.has("google_meet") ||
      connected.has("googlemeet"),
  };
}

// ============================================================
// SARVAM PROMPT
// ============================================================

function buildPlannerPrompt({
  application,
  integrations,
  previousRuns,
  todayPlans,
  expiredRuns,
}) {
  const integrationSummary =
    buildIntegrationSummary(integrations);

  return `
You are Reportli AI's CEO Planner.

Create 3–5 practical plans that help achieve the company's goal.

Rules:
- Return ONLY valid JSON.
- Use only connected integrations.
- Apollo → lead_generation
- Reddit → research
- Gmail → gmail
- Calendar/Meet → meetings
- planner → analysis without integrations.
- Never invent integrations.
- Use past results and avoid repeated work.
- If integrations are missing, use planner tasks.
- Every plan must support the company's business objective.

Company:
${JSON.stringify(
  {
    name: application?.name || "",
    domain: application?.domain || "",
    company: application?.company || "",
    status: application?.status || "",
  },
  null,
  2
)}

Connected integrations:
${JSON.stringify(integrationSummary, null, 2)}

Previous plans/results:
${JSON.stringify(previousRuns || [], null, 2)}

Today's plans:
${JSON.stringify(todayPlans || [], null, 2)}

Completed plans older than 24 hours:
${JSON.stringify(expiredRuns || [], null, 2)}

Return exactly:

{
  "plans": [
    {
      "title": "string",
      "objective": "string",
      "worker_type": "planner | lead_generation | research | gmail | meetings",
      "task_type": "string",
      "instruction": "string",
      "priority": 1,
      "input_data": {}
    }
  ]
}
`;
}

// ============================================================
// CALL SARVAM
// ============================================================

async function callSarvam(env, prompt) {
  // ----------------------------------------------------------
  // IMPORTANT:
  // Cloudflare secrets can sometimes contain accidental
  // whitespace/newlines. Trim it before sending.
  // ----------------------------------------------------------

  const apiKey = String(env.SARVAM_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error(
      "SARVAM_API_KEY is missing. Add it with: npx wrangler secret put SARVAM_API_KEY"
    );
  }

  const response = await fetch(SARVAM_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      // Sarvam authentication
      "api-key": apiKey,
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
    }),
  });

  const text = await response.text();

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
      `Sarvam returned invalid JSON: ${text}`
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      `Sarvam returned no message content: ${JSON.stringify(
        data
      )}`
    );
  }

  return content;
}

// ============================================================
// PARSE SARVAM JSON
// ============================================================

function parsePlannerJSON(content) {
  let cleaned = String(content).trim();

  // Remove markdown code fences if Sarvam adds them.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting the JSON object.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    }

    throw new Error(
      `Could not parse Sarvam JSON: ${cleaned}`
    );
  }
}

// ============================================================
// VALIDATE PLANS
// ============================================================

function validatePlans(data) {
  if (!data || !Array.isArray(data.plans)) {
    throw new Error(
      "Sarvam response does not contain a plans array"
    );
  }

  if (data.plans.length < 3) {
    throw new Error(
      `Sarvam returned only ${data.plans.length} plans. Minimum is 3.`
    );
  }

  if (data.plans.length > 5) {
    data.plans = data.plans.slice(0, 5);
  }

  const allowedWorkers = new Set([
    "planner",
    "lead_generation",
    "research",
    "gmail",
    "meetings",
  ]);

  for (const plan of data.plans) {
    if (!plan.title) {
      throw new Error("Plan is missing title");
    }

    if (!plan.instruction) {
      throw new Error(
        `Plan "${plan.title}" is missing instruction`
      );
    }

    if (!allowedWorkers.has(plan.worker_type)) {
      throw new Error(
        `Unsupported worker_type: ${plan.worker_type}`
      );
    }
  }

  return data.plans;
}

// ============================================================
// CHECK WORKER CONNECTION
// ============================================================

function workerIsAvailable(workerType, integrations) {
  const summary =
    buildIntegrationSummary(integrations);

  switch (workerType) {
    case "apollo":
    case "lead_generation":
      return summary.apollo;

    case "reddit":
    case "research":
      return summary.reddit;

    case "gmail":
      return summary.gmail;

    case "meetings":
      return (
        summary.google_calendar ||
        summary.google_meet
      );

    case "planner":
      return true;

    default:
      return false;
  }
}

// ============================================================
// FILTER PLANS BY CONNECTED INTEGRATIONS
// ============================================================

function filterPlans(plans, integrations) {
  return plans.filter((plan) => {
    return workerIsAvailable(
      plan.worker_type,
      integrations
    );
  });
}

// ============================================================
// CREATE PLANS
// ============================================================

async function createPlans(
  env,
  application,
  integrations,
  previousRuns,
  todayPlans,
  expiredRuns
) {
  const prompt = buildPlannerPrompt({
    application,
    integrations,
    previousRuns,
    todayPlans,
    expiredRuns,
  });

  const content = await callSarvam(
    env,
    prompt
  );

  const parsed =
    parsePlannerJSON(content);

  const plans =
    validatePlans(parsed);

  const executablePlans =
    filterPlans(
      plans,
      integrations
    );

  // If Sarvam created plans requiring unavailable
  // integrations, don't execute those plans.
  if (executablePlans.length === 0) {
    throw new Error(
      "Sarvam returned no executable plans for the currently connected integrations"
    );
  }

  const plansToSave =
    executablePlans.slice(0, 5);

  const saved = [];

  for (let i = 0; i < plansToSave.length; i++) {
    const savedPlan = await savePlan(
      env,
      application.id,
      application.user_id,
      plansToSave[i],
      i + 1
    );

    saved.push(savedPlan);
  }

  return {
    generated: plans.length,
    saved: saved.length,
    plans: plansToSave,
  };
}

// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(
  env,
  application
) {
  const applicationId =
    application.id;

  try {
    // --------------------------------------------------------
    // Get integrations
    // --------------------------------------------------------

    const integrations =
      await getConnectedIntegrations(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // Get history
    // --------------------------------------------------------

    const previousRuns =
      await getRecentRuns(
        env,
        applicationId
      );

    const todayPlans =
      await getTodayPlans(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // Find completed work older than 24 hours
    // --------------------------------------------------------

    const expiredRuns =
      await getExpiredCompletedRuns(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // If there are no plans at all,
    // create initial plans.
    // --------------------------------------------------------

    const anyPlans =
      await hasAnyPlans(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // If today's plans already exist,
    // don't create another set unnecessarily.
    // --------------------------------------------------------

    if (
      anyPlans &&
      todayPlans.length >= 3 &&
      expiredRuns.length === 0
    ) {
      return {
        application_id: applicationId,
        success: true,
        skipped: true,
        reason: "today_already_has_plans",
        plans_today: todayPlans.length,
      };
    }

    // --------------------------------------------------------
    // Create new plans
    // --------------------------------------------------------

    const result =
      await createPlans(
        env,
        application,
        integrations,
        previousRuns,
        todayPlans,
        expiredRuns
      );

    return {
      application_id: applicationId,
      success: true,
      skipped: false,
      reason: anyPlans
        ? expiredRuns.length > 0
          ? "expired_work"
          : "new_plans"
        : "initial_plans",
      connected_integrations:
        integrations.map(
          (x) => x.integration_id
        ),
      ...result,
    };
  } catch (error) {
    return {
      application_id: applicationId,
      success: false,
      error:
        error?.message ||
        String(error),
    };
  }
}

// ============================================================
// BATCH SELECTION
// ============================================================
//
// We rotate batches based on the current 30-minute slot.
//
// Example with 15 applications and batch size 3:
//
// Slot 0 → apps 1–3
// Slot 1 → apps 4–6
// Slot 2 → apps 7–9
// Slot 3 → apps 10–12
// Slot 4 → apps 13–15
// Slot 5 → apps 1–3 again
//
// This prevents all applications being processed in
// one Worker invocation.
// ============================================================

function selectBatch(applications) {
  if (
    !Array.isArray(applications) ||
    applications.length === 0
  ) {
    return [];
  }

  if (applications.length <= BATCH_SIZE) {
    return applications;
  }

  const slots =
    Math.ceil(
      applications.length /
        BATCH_SIZE
    );

  const now = Date.now();

  const thirtyMinuteSlot =
    Math.floor(
      now / (30 * 60 * 1000)
    );

  const batchIndex =
    thirtyMinuteSlot % slots;

  const start =
    batchIndex * BATCH_SIZE;

  return applications.slice(
    start,
    start + BATCH_SIZE
  );
}

// ============================================================
// RUN PLANNER
// ============================================================

async function runPlanner(env) {
  // ----------------------------------------------------------
  // Validate important secrets BEFORE doing database work.
  // ----------------------------------------------------------

  if (
    !env.SARVAM_API_KEY ||
    !String(env.SARVAM_API_KEY).trim()
  ) {
    throw new Error(
      "SARVAM_API_KEY is missing. Run: npx wrangler secret put SARVAM_API_KEY"
    );
  }

  const applications =
    await getActiveApplications(
      env
    );

  const batch =
    selectBatch(
      applications
    );

  const results = [];

  for (const application of batch) {
    const result =
      await processApplication(
        env,
        application
      );

    results.push(result);
  }

  return {
    success: true,

    applications_total:
      applications.length,

    applications_checked:
      batch.length,

    batch_size:
      BATCH_SIZE,

    results,
  };
}

// ============================================================
// HTTP HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // --------------------------------------------------------
    // GET
    // --------------------------------------------------------

    if (request.method === "GET") {
      return json({
        success: true,
        worker:
          "reportli-ai-planner",
        status: "running",
        batch_size:
          BATCH_SIZE,
        sarvam_configured:
          !!(
            env.SARVAM_API_KEY &&
            String(
              env.SARVAM_API_KEY
            ).trim()
          ),
        time:
          new Date().toISOString(),
      });
    }

    // --------------------------------------------------------
    // POST
    // --------------------------------------------------------

    if (request.method === "POST") {
      let body = {};

      try {
        const text =
          await request.text();

        if (text) {
          body =
            JSON.parse(text);
        }
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

      // ------------------------------------------------------
      // Manual test
      //
      // POST /
      // {
      //   "test": true
      // }
      // ------------------------------------------------------

      if (body.test === true) {
        try {
          const result =
            await runPlanner(
              env
            );

          return json({
            ...result,
            mode: "test",
            reason:
              "manual_test",
          });
        } catch (error) {
          return json(
            {
              success: false,
              mode: "test",
              reason:
                "manual_test",
              error:
                error?.message ||
                String(error),
            },
            500
          );
        }
      }

      return json(
        {
          success: false,
          error:
            'Use POST / with {"test":true}',
        },
        400
      );
    }

    // --------------------------------------------------------
    // METHOD NOT ALLOWED
    // --------------------------------------------------------

    return json(
      {
        success: false,
        error:
          "Method not allowed",
      },
      405
    );
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
      runPlanner(env).catch(
        (error) => {
          console.error(
            "Scheduled planner error:",
            error
          );
        }
      )
    );
  },
};
