/**
 * Reportli AI Planner — Cloudflare Worker
 *
 * Required secrets:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SARVAM_API_KEY
 *
 * Optional:
 *   WEBHOOK_SECRET
 *
 * Cron: every 30 minutes.
 */

const SARVAM_API_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const NICHE_PERCENTAGES = [19, 16, 13, 11, 10, 9, 8, 6, 5, 3];
const MAX_CONTEXT_CHARS = 8000;

/* =========================================================
   1. MAIN REQUEST HANDLER
========================================================= */

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    console.log("Incoming request", {
      requestId,
      method: request.method,
    });

    try {
      if (request.method === "GET") {
        return jsonResponse({
          ok: true,
          worker: "reportli-ai-planner",
          version: "5.0-short-prompts",
          time: new Date().toISOString(),
        });
      }

      if (request.method !== "POST") {
        return jsonResponse(
          { error: "Method not allowed. Use GET or POST." },
          405
        );
      }

      if (env.WEBHOOK_SECRET) {
        const supplied = request.headers.get("x-webhook-secret");

        if (supplied !== env.WEBHOOK_SECRET) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
      }

      const body = await request.json().catch(() => ({}));

      // Test Supabase connection.
      if (body.test_supabase === true) {
        const result = await testSupabase(env);

        return jsonResponse({
          ok: true,
          requestId,
          supabase: result,
        });
      }

      // Run Reddit/Apollo planner manually.
      if (body.run_research_planner === true) {
        const result = await runScheduledResearchPlanner(env);

        return jsonResponse({
          ok: true,
          requestId,
          researchPlanner: result,
        });
      }

      // Test company analysis for a specific application.
      if (body.test_analysis === true && body.application_id) {
        const result = await processSpecificApplication(
          String(body.application_id),
          env,
          true
        );

        return jsonResponse({
          ok: true,
          requestId,
          result,
        });
      }

      // Process a specific application.
      if (body.application_id) {
        const result = await processSpecificApplication(
          String(body.application_id),
          env,
          false
        );

        return jsonResponse({
          ok: true,
          requestId,
          result,
        });
      }

      // Otherwise, process the next pending application.
      const result = await processNextPendingApplication(env);

      return jsonResponse({
        ok: true,
        requestId,
        result,
      });
    } catch (error) {
      console.error("Request failed", {
        requestId,
        message: error?.message || String(error),
        stack: error?.stack,
      });

      return jsonResponse(
        {
          ok: false,
          requestId,
          error: error?.message || String(error),
        },
        500
      );
    }
  },

  // Runs automatically according to the cron schedule.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduledResearchPlanner(env).catch((error) => {
        console.error(
          "Scheduled research planner failed",
          error?.message || error
        );
      })
    );
  },
};

/* =========================================================
   2. GENERAL HELPERS
========================================================= */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function getSupabaseConfig(env) {
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret."
    );
  }

  return { url, key };
}

async function supabaseRequest(env, path, options = {}) {
  const { url, key } = getSupabaseConfig(env);

  const headers = new Headers(options.headers || {});

  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("accept", "application/json");

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (options.prefer) {
    headers.set("prefer", options.prefer);
  }

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });

  const responseText = await response.text();

  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data
        : JSON.stringify(data);

    throw new Error(
      `Supabase ${options.method || "GET"} ${path} failed ` +
      `(${response.status}): ${detail}`
    );
  }

  return data;
}

async function testSupabase(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,name&limit=1"
  );

  return {
    connected: true,
    sampleRows: Array.isArray(rows) ? rows.length : 0,
  };
}

/* =========================================================
   3. APPLICATION MANAGEMENT
========================================================= */

async function getApplication(applicationId, env) {
  const rows = await supabaseRequest(
    env,
    `applications?select=id,name,api_key,status,user_id,domain,company,planner_status,created_at&id=eq.${encodeURIComponent(applicationId)}&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getNextPendingApplication(env) {
  const rows = await supabaseRequest(
    env,
    "applications?select=id,name,api_key,status,user_id,domain,company,planner_status,created_at&planner_status=eq.pending&order=created_at.asc&limit=1"
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function claimApplication(applicationId, env, force = false) {
  const filter = force
    ? `id=eq.${encodeURIComponent(applicationId)}`
    : `id=eq.${encodeURIComponent(applicationId)}&planner_status=eq.pending`;

  const rows = await supabaseRequest(
    env,
    `applications?${filter}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        planner_status: "working",
      },
    }
  );

  if (Array.isArray(rows) && rows.length) {
    return rows[0];
  }

  if (force) {
    const app = await getApplication(applicationId, env);

    if (!app) {
      throw new Error(`Application not found: ${applicationId}`);
    }

    return app;
  }

  return null;
}

async function processNextPendingApplication(env) {
  const app = await getNextPendingApplication(env);

  if (!app) {
    return {
      processed: false,
      message: "No pending applications.",
    };
  }

  return processSpecificApplication(app.id, env, false);
}

async function processSpecificApplication(
  applicationId,
  env,
  force = false
) {
  const claimed = await claimApplication(
    applicationId,
    env,
    force
  );

  if (!claimed) {
    return {
      processed: false,
      application_id: applicationId,
      message: "Application is not pending or is already claimed.",
    };
  }

  return processClaimedApplication(claimed, env);
}

/* =========================================================
   4. COMPANY PROCESSING
========================================================= */

async function processClaimedApplication(app, env) {
  let plannerRunId = null;

  const task =
    `Analyze the company and find 10 customer niches for ${app.name || "this application"}`;

  try {
    const runRows = await supabaseRequest(
      env,
      "planner_runs",
      {
        method: "POST",
        prefer: "return=representation",
        body: {
          application_id: app.id,
          user_id: app.user_id || null,
          worker_type: "planner",
          source: "system",
          task,
          pending_count: 1,
          error: null,
        },
      }
    );

    plannerRunId = Array.isArray(runRows)
      ? runRows[0]?.id || null
      : null;

    const context = await buildCompanyContext(app, env);

    const analysis = await analyzeCompany(
      app,
      context,
      env
    );

    await saveBusinessData(
      env,
      app.id,
      "company_analysis",
      analysis
    );

    const niches = await generateCustomerNiches(
      app,
      analysis,
      env
    );

    await saveCustomerNiches(app, niches, env);

    await updateApplicationStatus(
      app.id,
      "completed",
      env
    );

    if (plannerRunId) {
      await updatePlannerRun(
        plannerRunId,
        {
          pending_count: 0,
          error: null,
        },
        env
      );
    }

    return {
      processed: true,
      application_id: app.id,
      company_analysis_saved: true,
      niches_saved: niches.length,
      buying_intention_percentages: NICHE_PERCENTAGES,
    };
  } catch (error) {
    const message = error?.message || String(error);

    console.error("Application processing failed", {
      applicationId: app.id,
      message,
    });

    try {
      await updateApplicationStatus(
        app.id,
        "failed",
        env
      );
    } catch (statusError) {
      console.error(
        "Could not mark application failed",
        statusError?.message || statusError
      );
    }

    if (plannerRunId) {
      try {
        await updatePlannerRun(
          plannerRunId,
          {
            pending_count: 0,
            error: message.slice(0, 1500),
          },
          env
        );
      } catch (updateError) {
        console.error(
          "Could not update planner run",
          updateError?.message || updateError
        );
      }
    }

    throw error;
  }
}

async function updateApplicationStatus(
  applicationId,
  status,
  env
) {
  await supabaseRequest(
    env,
    `applications?id=eq.${encodeURIComponent(applicationId)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        planner_status: status,
      },
    }
  );
}

async function updatePlannerRun(runId, values, env) {
  await supabaseRequest(
    env,
    `planner_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: values,
    }
  );
}

/* =========================================================
   5. BUILD SHORT COMPANY CONTEXT
========================================================= */

async function buildCompanyContext(app, env) {
  const pieces = [
    app.name ? `Application name: ${app.name}` : "",
    app.company ? `Company: ${app.company}` : "",
    app.domain ? `Domain: ${app.domain}` : "",
  ].filter(Boolean);

  const rows = await supabaseRequest(
    env,
    `business_data?select=field,data&application_id=eq.${encodeURIComponent(app.id)}&order=updated_at.desc&limit=20`
  );

  let remaining = MAX_CONTEXT_CHARS;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.data) continue;

    const text = flattenText(row.data);

    if (!text) continue;

    const snippet = text.slice(
      0,
      Math.min(remaining, 1800)
    );

    if (snippet) {
      pieces.push(
        `${row.field || "Company information"}: ${snippet}`
      );
    }

    remaining -= snippet.length;

    if (remaining <= 0) break;
  }

  return pieces.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function flattenText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join("\n");
  }

  if (value && typeof value === "object") {
    const preferred = [
      "text",
      "content",
      "title",
      "description",
      "summary",
      "url",
      "body",
    ];

    const values = [];

    for (const key of preferred) {
      if (value[key] !== undefined) {
        values.push(
          `${key}: ${flattenText(value[key])}`
        );
      }
    }

    if (!values.length) {
      values.push(JSON.stringify(value));
    }

    return values.join("\n");
  }

  return value == null ? "" : String(value);
}

/* =========================================================
   6. SARVAM API
========================================================= */

async function callSarvam(
  messages,
  env,
  maxTokens = 900
) {
  if (!env.SARVAM_API_KEY) {
    throw new Error("Missing SARVAM_API_KEY secret.");
  }

  const response = await fetch(SARVAM_API_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": env.SARVAM_API_KEY,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: {
        type: "json_object",
      },
    }),
  });

  const raw = await response.text();

  let result;

  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(
      `Sarvam returned invalid JSON (HTTP ${response.status}): ` +
      raw.slice(0, 400)
    );
  }

  if (!response.ok) {
    const message =
      result?.error?.message ||
      result?.message ||
      raw.slice(0, 400);

    throw new Error(
      `Sarvam API error ${response.status}: ${message}`
    );
  }

  let content = result?.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    content = content
      .map((part) =>
        typeof part === "string"
          ? part
          : part?.text || ""
      )
      .join("\n");
  }

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      "Sarvam returned empty content. Response: " +
      JSON.stringify(result).slice(0, 600)
    );
  }

  return content.trim();
}

function parseModelJson(content) {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    }

    throw new Error(
      `Sarvam output was not valid JSON: ${cleaned.slice(0, 400)}`
    );
  }
}

/* =========================================================
   7. SHORT COMPANY ANALYSIS PROMPT
========================================================= */

async function analyzeCompany(app, context, env) {
  const prompt =
    `Analyze this company for customer discovery. ` +
    `Use only supplied facts; do not invent facts. ` +
    `Return JSON with keys: company_summary (string), ` +
    `product_or_service (string), ideal_customer_types (array), ` +
    `problems_solved (array). Keep values concise.\n\n` +
    `Company facts:\n${context.slice(0, 6000)}`;

  const content = await callSarvam(
    [
      {
        role: "system",
        content:
          "You are a concise B2B market analyst. Return valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    env,
    700
  );

  return parseModelJson(content);
}

/* =========================================================
   8. SHORT CUSTOMER NICHE GENERATION
========================================================= */

async function generateCustomerNiches(
  app,
  analysis,
  env
) {
  const companyFacts = JSON.stringify(analysis).slice(0, 3000);

  const prompt =
    `Generate exactly 10 distinct customer segment names. ` +
    `Each name must be 1-4 words and identify WHO buys. ` +
    `Examples: Freelancers, Website Agencies, SaaS Startups, ` +
    `Recruitment Agencies. No sentences, strategies, outreach ` +
    `methods, platforms, or near-duplicates. ` +
    `Order highest to lowest estimated buying priority. ` +
    `Return JSON only: {"niches":["Name 1","Name 2"]}. ` +
    `Do not return scores or buying_intention.\n` +
    `Company: ${app.name || "Unknown"}\n` +
    `Facts: ${companyFacts}`;

  const content = await callSarvam(
    [
      {
        role: "system",
        content:
          "Return valid JSON only. The niches array must contain exactly 10 short labels.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    env,
    500
  );

  const parsed = parseModelJson(content);

  const values = Array.isArray(parsed)
    ? parsed
    : parsed.niches;

  if (!Array.isArray(values)) {
    throw new Error(
      "Sarvam niche output must contain a niches array."
    );
  }

  const cleaned = [];
  const seen = new Set();

  for (const item of values) {
    const rawName =
      typeof item === "string"
        ? item
        : item?.niche_name || item?.name || "";

    const name = cleanNicheName(rawName);

    const key = name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (name && !seen.has(key)) {
      seen.add(key);
      cleaned.push(name);
    }
  }

  if (cleaned.length < 10) {
    throw new Error(
      `Sarvam returned only ${cleaned.length} distinct short niches; ` +
      "expected 10. Check API credits and retry."
    );
  }

  return cleaned.slice(0, 10).map(
    (niche_name, index) => ({
      niche_name,
      buying_intention: NICHE_PERCENTAGES[index],
    })
  );
}

function cleanNicheName(value) {
  let name = String(value || "").trim();

  name = name.replace(/^[-*\d.)\s]+/, "");

  name = name.replace(
    /\b(direct[- ]to[- ]consumer|brands?|companies|businesses|that want to|looking to|generating leads|attracting clients|on shopify|on linkedin|using linkedin|using shopify)\b/gi,
    " "
  );

  name = name
    .replace(/[,:;.!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 4);

  if (!words.length) return "";

  return words
    .map(
      (word) =>
        word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ");
}

/* =========================================================
   9. SAVE BUSINESS DATA
========================================================= */

async function saveBusinessData(
  env,
  applicationId,
  field,
  data
) {
  const query =
    `business_data?select=id&application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}&limit=1`;

  const existing = await supabaseRequest(env, query);

  const payload = {
    application_id: applicationId,
    field,
    data,
    updated_at: new Date().toISOString(),
  };

  if (
    Array.isArray(existing) &&
    existing.length &&
    existing[0].id
  ) {
    await supabaseRequest(
      env,
      `business_data?id=eq.${encodeURIComponent(existing[0].id)}`,
      {
        method: "PATCH",
        prefer: "return=minimal",
        body: payload,
      }
    );
  } else {
    // POST avoids depending on a unique constraint.
    await supabaseRequest(
      env,
      "business_data",
      {
        method: "POST",
        prefer: "return=minimal",
        body: payload,
      }
    );
  }
}

/* =========================================================
   10. SAVE CUSTOMER NICHES AND PERCENTAGES
========================================================= */

async function saveCustomerNiches(app, niches, env) {
  if (!Array.isArray(niches) || niches.length !== 10) {
    throw new Error(
      "Exactly 10 niches are required before saving."
    );
  }

  const total = niches.reduce(
    (sum, niche) => sum + Number(niche.buying_intention),
    0
  );

  const distinctPercentages = new Set(
    niches.map((niche) => niche.buying_intention)
  );

  if (
    total !== 100 ||
    distinctPercentages.size !== 10
  ) {
    throw new Error(
      "Niche percentages must be distinct and sum to 100."
    );
  }

  // Deactivate old active niches while preserving history.
  await supabaseRequest(
    env,
    `customer_niches?application_id=eq.${encodeURIComponent(app.id)}&niche_status=eq.active`,
    {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        niche_status: "inactive",
        updated_at: new Date().toISOString(),
      },
    }
  );

  const rows = niches.map((niche) => ({
    application_id: app.id,
    user_id: app.user_id || null,
    niche_name: niche.niche_name,
    buying_intention: niche.buying_intention,
    niche_status: "active",
  }));

  await supabaseRequest(
    env,
    "customer_niches",
    {
      method: "POST",
      prefer: "return=representation",
      body: rows,
    }
  );
}

/* =========================================================
   11. REDDIT AND APOLLO INTEGRATIONS
========================================================= */

async function getActiveNiches(applicationId, env) {
  const rows = await supabaseRequest(
    env,
    `customer_niches?select=id,niche_name,buying_intention&application_id=eq.${encodeURIComponent(applicationId)}&niche_status=eq.active&order=buying_intention.desc&limit=20`
  );

  return Array.isArray(rows) ? rows : [];
}

async function getIntegrationConnected(
  applicationId,
  integrationId,
  env
) {
  const rows = await supabaseRequest(
    env,
    `user_integrations?select=id,status,integration_id&application_id=eq.${encodeURIComponent(applicationId)}&integration_id=eq.${encodeURIComponent(integrationId)}&status=eq.connected&limit=1`
  );

  return Array.isArray(rows) && rows.length > 0;
}

async function getLatestPlan(
  applicationId,
  source,
  env
) {
  const rows = await supabaseRequest(
    env,
    `planner_runs?select=id,application_id,worker_type,source,task,pending_count,created_at&application_id=eq.${encodeURIComponent(applicationId)}&source=eq.${encodeURIComponent(source)}&order=created_at.desc&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createPlannerRun(
  app,
  workerType,
  source,
  task,
  env
) {
  const rows = await supabaseRequest(
    env,
    "planner_runs",
    {
      method: "POST",
      prefer: "return=representation",
      body: {
        application_id: app.id,
        user_id: app.user_id || null,
        worker_type: workerType,
        source,
        task,
        pending_count: 1,
        error: null,
      },
    }
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

/* =========================================================
   12. SCHEDULED REDDIT/APOLLO PLANNER
========================================================= */

async function runScheduledResearchPlanner(env) {
  const apps = await supabaseRequest(
    env,
    "applications?select=id,name,user_id,domain,company,planner_status,created_at&order=created_at.asc&limit=100"
  );

  const summary = {
    applications_checked: 0,
    plans_created: 0,
    plans_updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const app of Array.isArray(apps) ? apps : []) {
    summary.applications_checked++;

    try {
      const niches = await getActiveNiches(app.id, env);

      if (!niches.length) {
        summary.skipped++;
        continue;
      }

      // Reddit is checked first.
      const redditAction = await tryCreateSourcePlan(
        app,
        "reddit",
        niches,
        env
      );

      if (redditAction === "created") {
        summary.plans_created++;
        continue;
      }

      if (redditAction === "updated") {
        summary.plans_updated++;
        continue;
      }

      // If Reddit already has an active task, don't duplicate it.
      if (redditAction === "blocked") {
        summary.skipped++;
        continue;
      }

      // If Reddit has no eligible task, check Apollo.
      const apolloAction = await tryCreateSourcePlan(
        app,
        "apollo",
        niches,
        env
      );

      if (apolloAction === "created") {
        summary.plans_created++;
      } else if (apolloAction === "updated") {
        summary.plans_updated++;
      } else {
        summary.skipped++;
      }
    } catch (error) {
      summary.errors.push({
        application_id: app.id,
        error: (
          error?.message || String(error)
        ).slice(0, 500),
      });

      console.error("Research planner app failed", {
        applicationId: app.id,
        message: error?.message || String(error),
      });
    }
  }

  return summary;
}

async function tryCreateSourcePlan(
  app,
  source,
  niches,
  env
) {
  const integrationConnected =
    await getIntegrationConnected(
      app.id,
      source,
      env
    );

  const latest = await getLatestPlan(
    app.id,
    source,
    env
  );

  const connectTask =
    source === "reddit"
      ? "Connect Reddit to run your research agent"
      : "Connect Apollo to run your outreach agent";

  // Don't create another plan if the latest one is still pending.
  if (latest && Number(latest.pending_count) > 0) {
    const wasConnectTask = latest.task === connectTask;

    if (!integrationConnected) {
      if (latest.task !== connectTask) {
        await updatePlannerRun(
          latest.id,
          { task: connectTask },
          env
        );

        return "updated";
      }

      return "blocked";
    }

    if (!wasConnectTask) {
      return "blocked";
    }

    // Integration was connected after a connection task was created.
    await updatePlannerRun(
      latest.id,
      {
        pending_count: 0,
        error: null,
      },
      env
    );
  }

  if (!integrationConnected) {
    if (
      latest &&
      Number(latest.pending_count) === 0 &&
      latest.task === connectTask
    ) {
      return "none";
    }

    await createPlannerRun(
      app,
      source === "reddit"
        ? "research"
        : "lead_generation",
      source,
      connectTask,
      env
    );

    return "created";
  }

  const names = niches
    .map((niche) => niche.niche_name)
    .filter(Boolean)
    .slice(0, 10);

  let task;
  let workerType;

  if (source === "reddit") {
    workerType = "research";

    task = JSON.stringify({
      task_id: `reddit_${app.id}_${Date.now()}`,
      worker: "reddit_research",
      objective:
        "Research recent public discussions to identify customer problems and buying signals.",
      target_audience: names,
      problem_categories: [
        "lead_generation",
        "customer_acquisition",
        "outreach_personalization",
        "lead_qualification",
      ],
      subreddits: [
        "SaaS",
        "Entrepreneur",
        "startups",
        "indiehackers",
        "sales",
      ],
      published_within_days: 7,
      target_new_posts: 20,
    });
  } else {
    workerType = "lead_generation";

    task = JSON.stringify({
      task_id: `apollo_${app.id}_${Date.now()}`,
      worker: "apollo_outreach",
      objective:
        "Find relevant business leads for prioritized customer segments. Do not send outreach without user approval.",
      target_niches: names,
      actions: [
        "find_matching_companies",
        "identify_relevant_contacts",
        "collect_available_business_emails",
        "prepare_personalized_draft_messages",
      ],
    });
  }

  await createPlannerRun(
    app,
    workerType,
    source,
    task,
    env
  );

  return "created";
          }
