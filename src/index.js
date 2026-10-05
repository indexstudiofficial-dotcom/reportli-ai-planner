// ============================================================
// REPORTLI AI — PLANNER WORKER
// ============================================================
//
// Manual test:
//
// POST /
//
// {
//   "test": true
// }
//
// Cloudflare Cron:
// Runs every 30 minutes.
//
// Required secrets:
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const MAX_PLANS_PER_RUN = 5;
const MIN_PLANS_PER_RUN = 3;

const TASK_EXPIRY_HOURS = 24;


// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };
}


// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: corsHeaders()
    }
  );
}


// ============================================================
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}${path}`;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": options.prefer || "return=representation",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body
      ? JSON.stringify(options.body)
      : undefined
  });

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
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


// ============================================================
// GET ACTIVE APPLICATIONS
// ============================================================

async function getActiveApplications(env) {
  return await supabaseRequest(
    env,
    "/rest/v1/applications" +
      "?status=eq.active" +
      "&select=id,name,domain,company,user_id,status" +
      "&order=created_at.asc"
  );
}


// ============================================================
// GET ONE APPLICATION
// ============================================================

async function getApplication(env, applicationId) {
  const data = await supabaseRequest(
    env,
    `/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}` +
      `&select=id,name,domain,company,user_id,status`
  );

  return data?.[0] || null;
}


// ============================================================
// GET CONNECTED INTEGRATIONS
// ============================================================

async function getIntegrations(env, applicationId) {
  return await supabaseRequest(
    env,
    `/rest/v1/user_integrations` +
      `?application_id=eq.${encodeURIComponent(applicationId)}` +
      `&status=eq.connected` +
      `&select=integration_id,connection_id,account_name,account_email,status`
  );
}


// ============================================================
// GET RECENT PLANNER RUNS
// ============================================================

async function getRecentRuns(env, applicationId) {
  return await supabaseRequest(
    env,
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(applicationId)}` +
      `&select=id,application_id,user_id,plan_date,plan_number,plan,tasks,result,status,error,created_at,completed_at` +
      `&order=created_at.desc` +
      `&limit=50`
  );
}


// ============================================================
// GET LAST 24 HOURS RUNS
// ============================================================

async function getRecent24HourRuns(env, applicationId) {
  const since = new Date(
    Date.now() - TASK_EXPIRY_HOURS * 60 * 60 * 1000
  ).toISOString();

  return await supabaseRequest(
    env,
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(applicationId)}` +
      `&created_at=gte.${encodeURIComponent(since)}` +
      `&select=id,plan_number,plan,tasks,result,status,created_at,completed_at` +
      `&order=created_at.desc`
  );
}


// ============================================================
// CHECK IF APPLICATION HAS ANY PLANS
// ============================================================

async function hasAnyPlans(env, applicationId) {
  const data = await supabaseRequest(
    env,
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(applicationId)}` +
      `&select=id` +
      `&limit=1`
  );

  return Array.isArray(data) && data.length > 0;
}


// ============================================================
// GET TODAY'S PLANS
// ============================================================

async function getTodaysPlans(env, applicationId) {
  const today = new Date().toISOString().slice(0, 10);

  return await supabaseRequest(
    env,
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(applicationId)}` +
      `&plan_date=eq.${today}` +
      `&select=id,plan_number,plan,tasks,result,status,created_at,completed_at` +
      `&order=plan_number.asc`
  );
}


// ============================================================
// SAVE PLAN
// ============================================================

async function savePlan(env, application, planNumber, planData) {
  const today = new Date().toISOString().slice(0, 10);

  const row = {
    application_id: application.id,
    user_id: application.user_id || null,
    plan_date: today,
    plan_number: planNumber,

    plan: planData.plan || {},

    tasks: planData.tasks || [],

    result: null,

    status: "pending",

    error: null,

    created_at: new Date().toISOString(),

    completed_at: null
  };

  const data = await supabaseRequest(
    env,
    "/rest/v1/planner_runs",
    {
      method: "POST",
      body: row,
      prefer: "return=representation"
    }
  );

  return data?.[0] || data;
}


// ============================================================
// UPDATE PLAN
// ============================================================

async function updatePlan(env, id, updates) {
  const data = await supabaseRequest(
    env,
    `/rest/v1/planner_runs?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: updates,
      prefer: "return=representation"
    }
  );

  return data?.[0] || data;
}


// ============================================================
// BUILD INTEGRATION SUMMARY
// ============================================================

function buildIntegrationSummary(integrations) {
  if (!integrations || integrations.length === 0) {
    return {
      connected: [],
      available_workers: []
    };
  }

  const connected = integrations.map(item => ({
    integration_id: item.integration_id,
    account_name: item.account_name || null,
    account_email: item.account_email || null,
    status: item.status
  }));

  const availableWorkers = [];

  for (const item of integrations) {
    const integration = item.integration_id;

    if (integration === "apollo") {
      availableWorkers.push("lead_generation");
    }

    if (integration === "reddit") {
      availableWorkers.push("research");
    }

    if (integration === "gmail") {
      availableWorkers.push("gmail");
    }

    if (
      integration === "google-calendar" ||
      integration === "google-meet"
    ) {
      availableWorkers.push("meetings");
    }
  }

  return {
    connected,
    available_workers: [...new Set(availableWorkers)]
  };
}


// ============================================================
// SARVAM AI
// ============================================================

async function callSarvam(env, systemPrompt, userPrompt) {
  const response = await fetch(SARVAM_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "api-key": env.SARVAM_API_KEY
    },

    body: JSON.stringify({
      model: SARVAM_MODEL,

      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ],

      temperature: 0.2
    })
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
      "Sarvam returned invalid JSON response"
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Sarvam response did not contain message content"
    );
  }

  return content;
}


// ============================================================
// EXTRACT JSON FROM AI RESPONSE
// ============================================================

function parseAIJson(content) {
  let cleaned = String(content).trim();

  // Remove markdown code fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the first JSON object
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      const possibleJson =
        cleaned.slice(start, end + 1);

      try {
        return JSON.parse(possibleJson);
      } catch {
        // Continue
      }
    }

    throw new Error(
      "Could not parse Sarvam planner JSON"
    );
  }
}


// ============================================================
// VALIDATE PLAN
// ============================================================

function validatePlans(aiData, integrationSummary) {
  if (!aiData || typeof aiData !== "object") {
    throw new Error("Planner returned invalid data");
  }

  if (!Array.isArray(aiData.plans)) {
    throw new Error("Planner response must contain plans[]");
  }

  if (
    aiData.plans.length < MIN_PLANS_PER_RUN ||
    aiData.plans.length > MAX_PLANS_PER_RUN
  ) {
    throw new Error(
      `Planner must create ${MIN_PLANS_PER_RUN}-${MAX_PLANS_PER_RUN} plans`
    );
  }

  const allowedWorkers =
    new Set(integrationSummary.available_workers);

  const validPlans = [];

  for (const plan of aiData.plans) {
    if (!plan || typeof plan !== "object") {
      continue;
    }

    const workerType =
      String(plan.worker_type || "planner");

    // Planner itself is always allowed.
    if (
      workerType !== "planner" &&
      !allowedWorkers.has(workerType)
    ) {
      continue;
    }

    validPlans.push({
      title: String(
        plan.title || "Untitled plan"
      ),

      objective: String(
        plan.objective || ""
      ),

      worker_type: workerType,

      task_type: String(
        plan.task_type || "general"
      ),

      instruction: String(
        plan.instruction || plan.objective || ""
      ),

      priority:
        Number.isFinite(Number(plan.priority))
          ? Number(plan.priority)
          : 5,

      input_data:
        plan.input_data &&
        typeof plan.input_data === "object"
          ? plan.input_data
          : {}
    });
  }

  if (
    validPlans.length < MIN_PLANS_PER_RUN
  ) {
    throw new Error(
      "Planner did not return enough executable plans for the connected integrations"
    );
  }

  return validPlans.slice(
    0,
    MAX_PLANS_PER_RUN
  );
}


// ============================================================
// CREATE PLANS WITH AI
// ============================================================

async function generatePlans(
  env,
  application,
  integrations,
  recentRuns,
  reason
) {
  const integrationSummary =
    buildIntegrationSummary(integrations);

  const systemPrompt = `
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

Return:
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

  const userPrompt = JSON.stringify({
    reason,

    application: {
      id: application.id,
      name: application.name,
      domain: application.domain,
      company: application.company,
      status: application.status
    },

    connected_integrations:
      integrationSummary.connected,

    available_workers:
      integrationSummary.available_workers,

    previous_runs:
      recentRuns.slice(0, 20)
  });

  const aiResponse = await callSarvam(
    env,
    systemPrompt,
    userPrompt
  );

  const aiData =
    parseAIJson(aiResponse);

  const plans =
    validatePlans(
      aiData,
      integrationSummary
    );

  return plans;
}


// ============================================================
// SAVE GENERATED PLANS
// ============================================================

async function createPlansForApplication(
  env,
  application,
  integrations,
  reason
) {
  const recentRuns =
    await getRecentRuns(
      env,
      application.id
    );

  const plans =
    await generatePlans(
      env,
      application,
      integrations,
      recentRuns,
      reason
    );

  const saved = [];

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];

    const planNumber = i + 1;

    const savedPlan =
      await savePlan(
        env,
        application,
        planNumber,
        {
          plan: {
            title: plan.title,
            objective: plan.objective,
            worker_type: plan.worker_type,
            task_type: plan.task_type,
            priority: plan.priority
          },

          tasks: [
            {
              worker_type: plan.worker_type,
              task_type: plan.task_type,
              instruction: plan.instruction,
              priority: plan.priority,
              input_data: plan.input_data,
              status: "pending"
            }
          ]
        }
      );

    saved.push(savedPlan);
  }

  return saved;
}


// ============================================================
// PROCESS ONE APPLICATION
// ============================================================

async function processApplication(
  env,
  application,
  reason = "scheduled"
) {
  const applicationId =
    application.id;

  const integrations =
    await getIntegrations(
      env,
      applicationId
    );

  const todaysPlans =
    await getTodaysPlans(
      env,
      applicationId
    );

  const recent24 =
    await getRecent24HourRuns(
      env,
      applicationId
    );

  const anyPlans =
    await hasAnyPlans(
      env,
      applicationId
    );

  // ----------------------------------------------------------
  // CASE 1:
  // No plans have ever been created.
  // ----------------------------------------------------------

  if (!anyPlans) {
    const created =
      await createPlansForApplication(
        env,
        application,
        integrations,
        "No previous planner tasks exist for this application. Create the first 3-5 plans."
      );

    return {
      application_id: applicationId,
      action: "created_initial_plans",
      plans_created: created.length
    };
  }


  // ----------------------------------------------------------
  // CASE 2:
  // Today already has 3-5 plans.
  // Do not create duplicates every 30 minutes.
  // ----------------------------------------------------------

  if (
    todaysPlans.length >= MIN_PLANS_PER_RUN
  ) {
    const hasActive =
      todaysPlans.some(
        item =>
          item.status === "pending" ||
          item.status === "running"
      );

    const hasCompleted =
      todaysPlans.some(
        item =>
          item.status === "completed"
      );

    // If there are active tasks, leave them alone.
    if (hasActive) {
      return {
        application_id: applicationId,
        action: "waiting_for_existing_tasks",
        plans_today: todaysPlans.length
      };
    }

    // If today's plans are completed,
    // don't immediately create another batch.
    if (hasCompleted) {
      return {
        application_id: applicationId,
        action: "today_plans_completed",
        plans_today: todaysPlans.length
      };
    }
  }


  // ----------------------------------------------------------
  // CASE 3:
  // Existing work is older than 24 hours and completed.
  // Create the next batch.
  // ----------------------------------------------------------

  const expiryTime =
    Date.now() -
    TASK_EXPIRY_HOURS *
      60 *
      60 *
      1000;

  const expiredCompleted =
    recent24.filter(item => {
      if (
        item.status !== "completed"
      ) {
        return false;
      }

      if (!item.created_at) {
        return false;
      }

      return (
        new Date(item.created_at).getTime() <=
        expiryTime
      );
    });

  if (expiredCompleted.length > 0) {
    const created =
      await createPlansForApplication(
        env,
        application,
        integrations,
        "Previous completed work is older than 24 hours. Create the next 3-5 plans using previous results."
      );

    return {
      application_id: applicationId,
      action: "created_follow_up_plans",
      expired_completed_tasks:
        expiredCompleted.length,
      plans_created: created.length
    };
  }


  // ----------------------------------------------------------
  // CASE 4:
  // There are fewer than 3 plans today.
  // Fill the missing plans.
  // ----------------------------------------------------------

  if (
    todaysPlans.length < MIN_PLANS_PER_RUN
  ) {
    const created =
      await createPlansForApplication(
        env,
        application,
        integrations,
        "The application has fewer than 3 plans for today. Create enough additional plans to maintain the daily minimum."
      );

    return {
      application_id: applicationId,
      action: "filled_missing_daily_plans",
      existing_plans:
        todaysPlans.length,
      plans_created:
        created.length
    };
  }


  // ----------------------------------------------------------
  // Nothing required.
  // ----------------------------------------------------------

  return {
    application_id: applicationId,
    action: "nothing_to_do",
    plans_today: todaysPlans.length
  };
}


// ============================================================
// RUN ALL APPLICATIONS
// ============================================================

async function runPlanner(env, reason) {
  const applications =
    await getActiveApplications(env);

  const results = [];

  for (const application of applications) {
    try {
      const result =
        await processApplication(
          env,
          application,
          reason
        );

      results.push({
        ...result,
        success: true
      });

    } catch (error) {
      console.error(
        `Planner failed for ${application.id}:`,
        error
      );

      results.push({
        application_id:
          application.id,

        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }

  return {
    success: true,
    reason,
    applications_checked:
      applications.length,
    results
  };
}


// ============================================================
// WORKER
// ============================================================

export default {

  // ==========================================================
  // HTTP REQUEST
  // ==========================================================

  async fetch(request, env, ctx) {

    // OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    // GET HEALTH CHECK
    if (request.method === "GET") {
      return json({
        success: true,
        worker: "reportli-ai-planner",
        status: "healthy",
        schedule: "every 30 minutes"
      });
    }


    // POST MANUAL TEST
    if (request.method === "POST") {

      let body = {};

      try {
        body = await request.json();
      } catch {
        return json({
          success: false,
          error: "Invalid JSON body"
        }, 400);
      }


      // ------------------------------------------------------
      // Manual test:
      //
      // {
      //   "test": true
      // }
      //
      // No application_id required.
      // ------------------------------------------------------

      if (body.test === true) {

        try {

          const result =
            await runPlanner(
              env,
              "manual_test"
            );

          return json({
            success: true,
            mode: "test",
            ...result
          });

        } catch (error) {

          return json({
            success: false,
            mode: "test",
            error:
              error instanceof Error
                ? error.message
                : String(error)
          }, 500);
        }
      }


      return json({
        success: false,
        error:
          'Send { "test": true } to run a manual test.'
      }, 400);
    }


    return json({
      success: false,
      error: "Method not allowed"
    }, 405);
  },


  // ==========================================================
  // CLOUDFLARE CRON
  // ==========================================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runPlanner(
        env,
        "scheduled_30_minute"
      )
        .then(result => {
          console.log(
            "Planner cron completed:",
            JSON.stringify(result)
          );
        })
        .catch(error => {
          console.error(
            "Planner cron failed:",
            error
          );
        })
    );
  }

};
