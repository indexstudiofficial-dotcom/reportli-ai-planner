// ============================================================
// REPORTLI AI — PLANNER WORKER
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

// Maximum applications processed per invocation
const BATCH_SIZE = 3;

// Minimum plans per application
const MIN_PLANS = 3;

// Maximum plans per application/day
const MAX_PLANS = 5;

// ============================================================
// CORS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
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
// SUPABASE
// ============================================================

async function supabase(env, path, options = {}) {
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

  const response = await fetch(
    `${env.SUPABASE_URL}${path}`,
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

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
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
  return await supabase(
    env,
    "/rest/v1/applications" +
      "?status=eq.active" +
      "&select=id,name,domain,company,status,user_id" +
      "&order=created_at.asc"
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
    `/rest/v1/user_integrations` +
      `?application_id=eq.${encodeURIComponent(
        applicationId
      )}` +
      `&status=eq.connected` +
      `&select=integration_id,account_name,account_email`
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
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(
        applicationId
      )}` +
      `&select=id,plan_date,plan_number,plan,tasks,result,status,error,created_at,completed_at` +
      `&order=created_at.desc` +
      `&limit=20`
  );
}

// ============================================================
// CHECK ANY PLANS
// ============================================================

async function hasAnyPlans(
  env,
  applicationId
) {
  const data =
    await supabase(
      env,
      `/rest/v1/planner_runs` +
        `?application_id=eq.${encodeURIComponent(
          applicationId
        )}` +
        `&select=id` +
        `&limit=1`
    );

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}

// ============================================================
// GET TODAY'S PLANS
// ============================================================

async function getTodayPlans(
  env,
  applicationId
) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  return await supabase(
    env,
    `/rest/v1/planner_runs` +
      `?application_id=eq.${encodeURIComponent(
        applicationId
      )}` +
      `&plan_date=eq.${today}` +
      `&select=id,plan_number,plan,tasks,result,status,created_at,completed_at` +
      `&order=plan_number.asc`
  );
}

// ============================================================
// GET OLD RUNS
// ============================================================
//
// We intentionally query ALL completed/old candidates
// older than 24 hours instead of querying the last 24 hours.
//
// ============================================================

async function getExpiredCompletedRuns(
  env,
  applicationId
) {
  const cutoff =
    new Date(
      Date.now() -
        24 * 60 * 60 * 1000
    ).toISOString();

  const data =
    await supabase(
      env,
      `/rest/v1/planner_runs` +
        `?application_id=eq.${encodeURIComponent(
          applicationId
        )}` +
        `&created_at=lte.${encodeURIComponent(
          cutoff
        )}` +
        `&select=id,plan_date,plan_number,plan,tasks,result,status,error,created_at,completed_at` +
        `&order=created_at.asc` +
        `&limit=20`
    );

  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter(
    (run) =>
      isRunCompleted(run)
  );
}

// ============================================================
// CHECK WHETHER A RUN/TASK IS COMPLETED
// ============================================================

function isRunCompleted(run) {
  if (!run) {
    return false;
  }

  // Top-level completed
  if (
    String(
      run.status || ""
    ).toLowerCase() ===
    "completed"
  ) {
    return true;
  }

  // Check tasks array
  if (
    Array.isArray(
      run.tasks
    ) &&
    run.tasks.length > 0
  ) {
    return run.tasks.every(
      (task) =>
        String(
          task?.status || ""
        ).toLowerCase() ===
        "completed"
    );
  }

  return false;
}

// ============================================================
// INTEGRATION SUMMARY
// ============================================================

function buildIntegrationSummary(
  integrations
) {
  const connected =
    new Set(
      (integrations || []).map(
        (item) =>
          String(
            item.integration_id || ""
          ).toLowerCase()
      )
    );

  return {
    apollo:
      connected.has("apollo"),

    reddit:
      connected.has("reddit"),

    gmail:
      connected.has("gmail"),

    google_calendar:
      connected.has(
        "google-calendar"
      ) ||
      connected.has(
        "google_calendar"
      ),

    google_meet:
      connected.has(
        "google-meet"
      ) ||
      connected.has(
        "google_meet"
      ) ||
      connected.has(
        "googlemeet"
      ),
  };
}

// ============================================================
// WORKER AVAILABILITY
// ============================================================

function workerIsAvailable(
  workerType,
  integrations
) {
  const summary =
    buildIntegrationSummary(
      integrations
    );

  switch (
    workerType
  ) {
    case "planner":
      return true;

    case "lead_generation":
      return summary.apollo;

    case "research":
      return summary.reddit;

    case "gmail":
      return summary.gmail;

    case "meetings":
      return (
        summary.google_calendar ||
        summary.google_meet
      );

    default:
      return false;
  }
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
  const summary =
    buildIntegrationSummary(
      integrations
    );

  return `
You are Reportli AI's CEO Planner.

Create 3 to 5 practical, executable plans for this SaaS company.

Rules:

1. Return ONLY valid JSON.
2. Return between 3 and 5 plans.
3. Every plan must be executable.
4. Apollo is available only when Apollo is connected.
5. Reddit is available only when Reddit is connected.
6. Gmail is available only when Gmail is connected.
7. Meetings are available only when Google Calendar or Google Meet is connected.
8. planner is always available.
9. Never invent an integration.
10. If an integration is missing, use planner instead.
11. Use previous results to improve future work.
12. Avoid unnecessarily repeating completed work.
13. Every plan must support the company's business objective.
14. Make each instruction specific and actionable.
15. Do not create fake leads, fake emails, fake research results, or fake meetings.
16. Do not create plans requiring unavailable integrations.

Worker mapping:

Apollo → lead_generation
Reddit → research
Gmail → gmail
Google Calendar/Meet → meetings
No external integration → planner

Company:

${JSON.stringify(
  {
    name:
      application?.name || "",

    domain:
      application?.domain || "",

    company:
      application?.company || "",

    status:
      application?.status || "",
  },
  null,
  2
)}

Connected integrations:

${JSON.stringify(
  summary,
  null,
  2
)}

Previous plans and results:

${JSON.stringify(
  previousRuns || [],
  null,
  2
)}

Today's plans:

${JSON.stringify(
  todayPlans || [],
  null,
  2
)}

Completed work older than 24 hours:

${JSON.stringify(
  expiredRuns || [],
  null,
  2
)}

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

  const response =
    await fetch(
      SARVAM_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          "api-subscription-key":
            apiKey,
        },

        body:
          JSON.stringify({
            model:
              SARVAM_MODEL,

            messages: [
              {
                role:
                  "user",

                content:
                  prompt,
              },
            ],

            temperature:
              0.2,

            max_tokens:
              4096,

            response_format: {
              type:
                "json_object",
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
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Sarvam returned invalid JSON: ${text}`
    );
  }

  const message =
    data
      ?.choices?.[0]
      ?.message;

  if (!message) {
    throw new Error(
      `Sarvam returned no message: ${JSON.stringify(
        data
      )}`
    );
  }

  const content =
    message.content;

  // Some Sarvam responses can stop in reasoning
  // when max_tokens is too small.
  if (!content) {
    throw new Error(
      `Sarvam returned no final content. finish_reason=${
        data?.choices?.[0]?.finish_reason || "unknown"
      }`
    );
  }

  return content;
}

// ============================================================
// PARSE JSON
// ============================================================

function parsePlannerJSON(
  content
) {
  let cleaned =
    String(
      content
    ).trim();

  cleaned =
    cleaned
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    const start =
      cleaned.indexOf(
        "{"
      );

    const end =
      cleaned.lastIndexOf(
        "}"
      );

    if (
      start !== -1 &&
      end !== -1 &&
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
      `Could not parse Sarvam JSON: ${cleaned}`
    );
  }
}

// ============================================================
// VALIDATE PLANS
// ============================================================

function validatePlans(
  data
) {
  if (
    !data ||
    !Array.isArray(
      data.plans
    )
  ) {
    throw new Error(
      "Sarvam response does not contain a plans array"
    );
  }

  if (
    data.plans.length < MIN_PLANS
  ) {
    throw new Error(
      `Sarvam returned ${data.plans.length} plans. Minimum is ${MIN_PLANS}.`
    );
  }

  const plans =
    data.plans.slice(
      0,
      MAX_PLANS
    );

  const allowedWorkers =
    new Set([
      "planner",
      "lead_generation",
      "research",
      "gmail",
      "meetings",
    ]);

  for (
    const plan of plans
  ) {
    if (
      !plan ||
      typeof plan !==
        "object"
    ) {
      throw new Error(
        "Invalid plan object"
      );
    }

    if (
      !plan.title
    ) {
      throw new Error(
        "Plan is missing title"
      );
    }

    if (
      !plan.instruction
    ) {
      throw new Error(
        `Plan "${plan.title}" is missing instruction`
      );
    }

    if (
      !allowedWorkers.has(
        plan.worker_type
      )
    ) {
      throw new Error(
        `Unsupported worker_type: ${plan.worker_type}`
      );
    }

    if (
      typeof plan.priority !==
      "number"
    ) {
      plan.priority =
        1;
    }

    if (
      !plan.input_data ||
      typeof plan.input_data !==
        "object" ||
      Array.isArray(
        plan.input_data
      )
    ) {
      plan.input_data =
        {};
    }

    if (
      !plan.objective
    ) {
      plan.objective =
        "";
    }

    if (
      !plan.task_type
    ) {
      plan.task_type =
        "general";
    }
  }

  return plans;
}

// ============================================================
// MAKE PLAN EXECUTABLE
// ============================================================
//
// If Sarvam accidentally chooses an unavailable integration,
// convert that task into a planner task instead of deleting it.
//
// This guarantees we don't end up with only 1–2 plans.
//
// ============================================================

function makeExecutablePlan(
  plan,
  integrations
) {
  if (
    workerIsAvailable(
      plan.worker_type,
      integrations
    )
  ) {
    return plan;
  }

  return {
    ...plan,

    worker_type:
      "planner",

    task_type:
      "planning",

    instruction:
      `Analyze and prepare the next actionable step for this objective without using an external integration. Original planned task: ${plan.instruction}`,

    input_data: {
      ...(plan.input_data || {}),

      original_worker_type:
        plan.worker_type,

      integration_unavailable:
        true,
    },
  };
}

// ============================================================
// SAVE PLAN
// ============================================================

async function savePlan(
  env,
  applicationId,
  userId,
  plan,
  planNumber
) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const payload = {
    application_id:
      applicationId,

    user_id:
      userId || null,

    plan_date:
      today,

    plan_number:
      planNumber,

    plan:
      plan,

    tasks: [
      {
        title:
          plan.title,

        objective:
          plan.objective || "",

        task_type:
          plan.task_type,

        worker_type:
          plan.worker_type,

        instruction:
          plan.instruction,

        priority:
          plan.priority,

        input_data:
          plan.input_data || {},

        status:
          "pending",
      },
    ],

    result:
      null,

    status:
      "pending",

    error:
      null,
  };

  return await supabase(
    env,
    "/rest/v1/planner_runs",
    {
      method:
        "POST",

      headers: {
        Prefer:
          "return=representation",
      },

      body:
        JSON.stringify(
          payload
        ),
    }
  );
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
  expiredRuns,
  numberToCreate
) {
  const prompt =
    buildPlannerPrompt({
      application,
      integrations,
      previousRuns,
      todayPlans,
      expiredRuns,
    });

  const content =
    await callSarvam(
      env,
      prompt
    );

  const parsed =
    parsePlannerJSON(
      content
    );

  const generatedPlans =
    validatePlans(
      parsed
    );

  // Convert unavailable integration work
  // into planner work instead of deleting it.
  const executablePlans =
    generatedPlans.map(
      (plan) =>
        makeExecutablePlan(
          plan,
          integrations
        )
    );

  // We need enough plans to fill the requested slots.
  if (
    executablePlans.length <
    numberToCreate
  ) {
    throw new Error(
      `Only ${executablePlans.length} executable plans available. Need ${numberToCreate}.`
    );
  }

  const plansToSave =
    executablePlans.slice(
      0,
      numberToCreate
    );

  const saved = [];

  // Existing number of plans determines numbering.
  const startingNumber =
    todayPlans.length + 1;

  for (
    let i = 0;
    i <
    plansToSave.length;
    i++
  ) {
    const planNumber =
      startingNumber + i;

    const savedPlan =
      await savePlan(
        env,
        application.id,
        application.user_id,
        plansToSave[i],
        planNumber
      );

    saved.push(
      savedPlan
    );
  }

  return {
    generated:
      generatedPlans.length,

    saved:
      saved.length,

    plans:
      plansToSave,
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
    // Integrations
    // --------------------------------------------------------

    const integrations =
      await getConnectedIntegrations(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // History
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

    const expiredRuns =
      await getExpiredCompletedRuns(
        env,
        applicationId
      );

    const anyPlans =
      await hasAnyPlans(
        env,
        applicationId
      );

    // --------------------------------------------------------
    // Current number of plans today
    // --------------------------------------------------------

    const todayCount =
      todayPlans.length;

    // --------------------------------------------------------
    // If already at maximum, stop.
    // --------------------------------------------------------

    if (
      todayCount >=
      MAX_PLANS
    ) {
      return {
        application_id:
          applicationId,

        success:
          true,

        skipped:
          true,

        reason:
          "today_has_maximum_plans",

        plans_today:
          todayCount,

        expired_completed_runs:
          expiredRuns.length,

        connected_integrations:
          integrations.map(
            (x) =>
              x.integration_id
          ),
      };
    }

    // --------------------------------------------------------
    // Determine how many plans we need.
    //
    // New application:
    //     create 3–5
    //
    // Existing application:
    //     if less than 3 today → fill to 3
    //
    //     if 3–4 today and old completed work exists
    //     → create replacement work up to 5
    //
    // --------------------------------------------------------

    let numberToCreate = 0;

    let reason =
      "new_plans";

    if (
      !anyPlans
    ) {
      numberToCreate =
        Math.min(
          MIN_PLANS,
          MAX_PLANS -
            todayCount
        );

      reason =
        "initial_plans";
    } else if (
      todayCount <
      MIN_PLANS
    ) {
      numberToCreate =
        MIN_PLANS -
        todayCount;

      reason =
        "fill_daily_minimum";
    } else if (
      expiredRuns.length >
        0
    ) {
      numberToCreate =
        Math.min(
          expiredRuns.length,
          MAX_PLANS -
            todayCount
        );

      reason =
        "expired_completed_work";
    }

    // --------------------------------------------------------
    // Nothing to create
    // --------------------------------------------------------

    if (
      numberToCreate <= 0
    ) {
      return {
        application_id:
          applicationId,

        success:
          true,

        skipped:
          true,

        reason:
          "no_new_plans_needed",

        plans_today:
          todayCount,

        expired_completed_runs:
          expiredRuns.length,

        connected_integrations:
          integrations.map(
            (x) =>
              x.integration_id
          ),
      };
    }

    // --------------------------------------------------------
    // Generate and save
    // --------------------------------------------------------

    const result =
      await createPlans(
        env,
        application,
        integrations,
        previousRuns,
        todayPlans,
        expiredRuns,
        numberToCreate
      );

    return {
      application_id:
        applicationId,

      success:
        true,

      skipped:
        false,

      reason,

      plans_today_before:
        todayCount,

      plans_created:
        result.saved,

      plans_today_after:
        todayCount +
        result.saved,

      expired_completed_runs:
        expiredRuns.length,

      connected_integrations:
        integrations.map(
          (x) =>
            x.integration_id
        ),

      ...result,
    };
  } catch (error) {
    console.error(
      `Planner error for ${applicationId}:`,
      error
    );

    return {
      application_id:
        applicationId,

      success:
        false,

      error:
        error?.message ||
        String(error),
    };
  }
}

// ============================================================
// BATCH SELECTION
// ============================================================

function selectBatch(
  applications
) {
  if (
    !Array.isArray(
      applications
    ) ||
    applications.length ===
      0
  ) {
    return [];
  }

  if (
    applications.length <=
    BATCH_SIZE
  ) {
    return applications;
  }

  const slots =
    Math.ceil(
      applications.length /
        BATCH_SIZE
    );

  const thirtyMinuteSlot =
    Math.floor(
      Date.now() /
        (30 * 60 * 1000)
    );

  const batchIndex =
    thirtyMinuteSlot %
    slots;

  const start =
    batchIndex *
    BATCH_SIZE;

  return applications.slice(
    start,
    start +
      BATCH_SIZE
  );
}

// ============================================================
// RUN PLANNER
// ============================================================

async function runPlanner(
  env
) {
  // ----------------------------------------------------------
  // Validate secrets
  // ----------------------------------------------------------

  if (
    !env.SARVAM_API_KEY ||
    !String(
      env.SARVAM_API_KEY
    ).trim()
  ) {
    throw new Error(
      "SARVAM_API_KEY is missing"
    );
  }

  if (
    !env.SUPABASE_URL
  ) {
    throw new Error(
      "SUPABASE_URL is missing"
    );
  }

  if (
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is missing"
    );
  }

  // ----------------------------------------------------------
  // Get active applications
  // ----------------------------------------------------------

  const applications =
    await getActiveApplications(
      env
    );

  // ----------------------------------------------------------
  // Select batch
  // ----------------------------------------------------------

  const batch =
    selectBatch(
      applications
    );

  const results = [];

  // ----------------------------------------------------------
  // Process sequentially
  // ----------------------------------------------------------

  for (
    const application of batch
  ) {
    const result =
      await processApplication(
        env,
        application
      );

    results.push(
      result
    );
  }

  return {
    success:
      true,

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
  async fetch(
    request,
    env
  ) {
    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders(),
        }
      );
    }

    // --------------------------------------------------------
    // GET HEALTH CHECK
    // --------------------------------------------------------

    if (
      request.method ===
      "GET"
    ) {
      return json({
        success:
          true,

        worker:
          "reportli-ai-planner",

        status:
          "running",

        batch_size:
          BATCH_SIZE,

        minimum_plans:
          MIN_PLANS,

        maximum_plans:
          MAX_PLANS,

        sarvam_model:
          SARVAM_MODEL,

        sarvam_configured:
          !!(
            env.SARVAM_API_KEY &&
            String(
              env.SARVAM_API_KEY
            ).trim()
          ),

        supabase_configured:
          !!(
            env.SUPABASE_URL &&
            env.SUPABASE_SERVICE_ROLE_KEY
          ),

        time:
          new Date().toISOString(),
      });
    }

    // --------------------------------------------------------
    // POST
    // --------------------------------------------------------

    if (
      request.method ===
      "POST"
    ) {
      let body = {};

      try {
        const text =
          await request.text();

        if (text) {
          body =
            JSON.parse(
              text
            );
        }
      } catch {
        return json(
          {
            success:
              false,

            error:
              "Invalid JSON body",
          },
          400
        );
      }

      // ------------------------------------------------------
      // MANUAL TEST
      //
      // POST /
      //
      // {
      //   "test": true
      // }
      // ------------------------------------------------------

      if (
        body.test === true
      ) {
        try {
          const result =
            await runPlanner(
              env
            );

          return json({
            ...result,

            mode:
              "test",

            reason:
              "manual_test",
          });
        } catch (
          error
        ) {
          console.error(
            "Manual planner error:",
            error
          );

          return json(
            {
              success:
                false,

              mode:
                "test",

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
          success:
            false,

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
        success:
          false,

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
      runPlanner(
        env
      ).catch(
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
