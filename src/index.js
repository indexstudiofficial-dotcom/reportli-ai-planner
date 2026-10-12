// ============================================================
// REPORTLI AI PLANNER
// Version: 6.0 - Sarvam JSON response fix
//
// Responsibilities:
// 1. Health check
// 2. Supabase connection test
// 3. Company analysis using Sarvam AI
// 4. Discover exactly 10 short customer niches
// 5. Save company knowledge to business_data
// 6. Save niches to customer_niches
// 7. Create deterministic Reddit/Apollo planner tasks
// 8. Avoid duplicate pending planner tasks
//
// Cloudflare secrets:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// SARVAM_API_KEY
//
// Optional secret:
// WEBHOOK_SECRET
// ============================================================

const VERSION = "6.0-sarvam-json-fix";

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const BUSINESS_FIELDS = [
  "company_summary",
  "product_or_service",
  "ideal_customer_types",
  "problems_solved",
];

// These are relative buying-priority weights.
// They are distinct and total 100.
const NICHE_WEIGHTS = [
  19, 16, 13, 11, 10, 9, 8, 6, 5, 3,
];

const MAX_SARVAM_ATTEMPTS = 2;
const SARVAM_MAX_TOKENS = 4096;

// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();

    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        return jsonResponse({
          ok: true,
          worker: "reportli-ai-planner",
          version: VERSION,
          message: "Worker is running.",
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      if (request.method !== "POST") {
        return jsonResponse(
          {
            ok: false,
            requestId,
            error: "Method not allowed. Use POST.",
          },
          405
        );
      }

      // Optional webhook authentication.
      if (env.WEBHOOK_SECRET) {
        const suppliedSecret =
          request.headers.get("x-webhook-secret");

        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          return jsonResponse(
            {
              ok: false,
              requestId,
              error: "Unauthorized.",
            },
            401
          );
        }
      }

      validateEnvironment(env);

      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            ok: false,
            requestId,
            error: "Request body must be valid JSON.",
          },
          400
        );
      }

      // ------------------------------------------------------
      // ACTION: TEST SUPABASE
      // ------------------------------------------------------

      if (body.test_supabase === true) {
        const result = await supabaseRequest(
          env,
          "/applications?select=id&limit=1",
          { method: "GET" }
        );

        return jsonResponse({
          ok: true,
          requestId,
          action: "test_supabase",
          message: "Supabase connection successful.",
          rowsReturned: Array.isArray(result)
            ? result.length
            : null,
        });
      }

      // ------------------------------------------------------
      // ACTION: TEST SARVAM
      // ------------------------------------------------------

      if (body.test_sarvam === true) {
        const result = await callSarvam(
          env,
          [
            "Return exactly this JSON object:",
            '{"ok":true}',
            "Do not add any other text.",
          ].join("\n")
        );

        const parsed = parseJsonObject(result);

        return jsonResponse({
          ok: true,
          requestId,
          action: "test_sarvam",
          response: parsed,
        });
      }

      // ------------------------------------------------------
      // ACTION: ANALYZE A SPECIFIC APPLICATION
      // ------------------------------------------------------

      if (body.test_analysis === true) {
        if (!body.application_id) {
          return jsonResponse(
            {
              ok: false,
              requestId,
              error:
                "application_id is required for test_analysis.",
            },
            400
          );
        }

        const application = await getApplication(
          env,
          body.application_id
        );

        if (!application) {
          return jsonResponse(
            {
              ok: false,
              requestId,
              error: "Application not found.",
            },
            404
          );
        }

        const result = await processApplication(
          env,
          application
        );

        return jsonResponse({
          ok: true,
          requestId,
          action: "test_analysis",
          result,
        });
      }

      // ------------------------------------------------------
      // ACTION: RUN RESEARCH PLANNER NOW
      // ------------------------------------------------------

      if (body.run_research_planner === true) {
        const result = await runResearchPlanner(env);

        return jsonResponse({
          ok: true,
          requestId,
          action: "run_research_planner",
          result,
        });
      }

      // ------------------------------------------------------
      // ACTION: PROCESS SPECIFIC APPLICATION
      // ------------------------------------------------------

      if (body.application_id) {
        const application = await getApplication(
          env,
          body.application_id
        );

        if (!application) {
          return jsonResponse(
            {
              ok: false,
              requestId,
              error: "Application not found.",
            },
            404
          );
        }

        const result = await processApplication(
          env,
          application
        );

        return jsonResponse({
          ok: true,
          requestId,
          result,
        });
      }

      // ------------------------------------------------------
      // DEFAULT ACTION:
      // PROCESS THE NEXT APPLICATION
      // ------------------------------------------------------

      const applications = await supabaseRequest(
        env,
        "/applications?select=*&order=created_at.asc&limit=1",
        { method: "GET" }
      );

      if (!Array.isArray(applications) ||
          applications.length === 0) {
        return jsonResponse({
          ok: true,
          requestId,
          message: "No applications found.",
        });
      }

      const result = await processApplication(
        env,
        applications[0]
      );

      return jsonResponse({
        ok: true,
        requestId,
        result,
      });
    } catch (error) {
      console.error("Planner request failed:", {
        requestId,
        message: error?.message || String(error),
      });

      return jsonResponse(
        {
          ok: false,
          requestId,
          error: error?.message || "Unexpected Worker error.",
        },
        500
      );
    }
  },

  // ----------------------------------------------------------
  // CRON: RUN EVERY 30 MINUTES
  // ----------------------------------------------------------

  async scheduled(event, env, ctx) {
    validateEnvironment(env);

    ctx.waitUntil(
      runScheduledJobs(env).catch((error) => {
        console.error(
          "Scheduled planner failed:",
          error?.message || String(error)
        );
      })
    );
  },
};

// ============================================================
// HTTP RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SARVAM_API_KEY",
  ];

  const missing = required.filter(
    (key) => !env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare secrets: ${missing.join(", ")}`
    );
  }
}

function normalizeSupabaseUrl(value) {
  return value.replace(/\/+$/, "");
}

// ============================================================
// SUPABASE REST HELPERS
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const baseUrl = normalizeSupabaseUrl(
    env.SUPABASE_URL
  );

  const url = `${baseUrl}/rest/v1${path}`;

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status} on ${path}: ` +
      text.slice(0, 2000)
    );
  }

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Supabase returned invalid JSON on ${path}: ` +
      text.slice(0, 1000)
    );
  }
}

function queryValue(value) {
  return encodeURIComponent(String(value));
}

async function getApplication(env, applicationId) {
  const path =
    "/applications?select=*&id=eq." +
    queryValue(applicationId) +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    path,
    { method: "GET" }
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

// ============================================================
// SARVAM AI
//
// Main fix:
// - reasoning_effort: null disables reasoning on V1
// - max_tokens explicitly set to 4096
// - retries empty/truncated content once
// - reports finish_reason and usage when unsuccessful
// - never treats reasoning_content as the final JSON
// ============================================================

async function callSarvam(env, prompt) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_SARVAM_ATTEMPTS;
    attempt++
  ) {
    const currentPrompt = attempt === 1
      ? prompt
      : [
          "IMPORTANT: Return the requested JSON now.",
          "Do not reason aloud.",
          "Do not explain.",
          "Return one complete JSON object only.",
          "",
          prompt,
        ].join("\n");

    let response;

    try {
      response = await fetch(SARVAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": env.SARVAM_API_KEY,
        },
        body: JSON.stringify({
          model: "sarvam-105b",
          messages: [
            {
              role: "system",
              content:
                "You are a structured-data generator. " +
                "Return only the requested final JSON. " +
                "Do not include markdown fences or explanations.",
            },
            {
              role: "user",
              content: currentPrompt,
            },
          ],

          // This is the key fix for the reported issue.
          // Sarvam V1 supports null to disable reasoning.
          reasoning_effort: null,

          temperature: 0.1,
          max_tokens: SARVAM_MAX_TOKENS,
          stream: false,
        }),
      });
    } catch (error) {
      lastError = new Error(
        `Could not reach Sarvam API: ${
          error?.message || String(error)
        }`
      );

      if (attempt < MAX_SARVAM_ATTEMPTS) {
        await sleep(500);
        continue;
      }

      throw lastError;
    }

    const rawText = await response.text();

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      lastError = new Error(
        `Sarvam returned invalid response JSON. ` +
        `HTTP ${response.status}. Response: ` +
        rawText.slice(0, 1200)
      );

      if (attempt < MAX_SARVAM_ATTEMPTS) {
        await sleep(500);
        continue;
      }

      throw lastError;
    }

    if (!response.ok) {
      const apiMessage =
        data?.error?.message ||
        data?.message ||
        rawText;

      // Do not retry quota or authentication failures.
      if (
        response.status === 402 ||
        response.status === 403 ||
        response.status === 401
      ) {
        throw new Error(
          `Sarvam API HTTP ${response.status}: ` +
          String(apiMessage).slice(0, 1200)
        );
      }

      lastError = new Error(
        `Sarvam API HTTP ${response.status}: ` +
        String(apiMessage).slice(0, 1200)
      );

      if (
        attempt < MAX_SARVAM_ATTEMPTS &&
        (
          response.status === 429 ||
          response.status >= 500
        )
      ) {
        await sleep(800 * attempt);
        continue;
      }

      throw lastError;
    }

    const choice = data?.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    const finishReason = choice?.finish_reason;

    // Standard text response.
    if (
      typeof content === "string" &&
      content.trim().length > 0
    ) {
      if (finishReason === "length") {
        lastError = new Error(
          "Sarvam response was truncated at the token limit."
        );

        if (attempt < MAX_SARVAM_ATTEMPTS) {
          await sleep(500);
          continue;
        }

        throw lastError;
      }

      return content.trim();
    }

    // Some APIs return content as an array of text blocks.
    if (Array.isArray(content)) {
      const combined = content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (typeof part?.text === "string") {
            return part.text;
          }

          return "";
        })
        .join("")
        .trim();

      if (combined) {
        return combined;
      }
    }

    const usage = data?.usage || {};

    lastError = new Error(
      "Sarvam returned empty content. " +
      `finish_reason=${finishReason || "unknown"}, ` +
      `completion_tokens=${usage.completion_tokens ?? "unknown"}, ` +
      `reasoning_tokens=${
        usage.completion_tokens_details?.reasoning_tokens ??
        "unknown"
      }, ` +
      `attempt=${attempt}/${MAX_SARVAM_ATTEMPTS}.`
    );

    console.error("Sarvam empty-content diagnostic:", {
      finishReason,
      completionTokens: usage.completion_tokens,
      reasoningTokens:
        usage.completion_tokens_details?.reasoning_tokens,
      attempt,
    });

    if (attempt < MAX_SARVAM_ATTEMPTS) {
      await sleep(500);
      continue;
    }
  }

  throw lastError || new Error(
    "Sarvam failed to return content."
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// JSON PARSING AND VALIDATION
// ============================================================

function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(
      "Cannot parse Sarvam response: content is empty."
    );
  }

  let cleaned = text.trim();

  // Remove optional markdown code fences.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  // First attempt: complete response is JSON.
  try {
    const parsed = JSON.parse(cleaned);

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed;
    }
  } catch {
    // Continue to extraction below.
  }

  // Fallback: extract the outermost JSON object.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = cleaned.slice(
      firstBrace,
      lastBrace + 1
    );

    try {
      const parsed = JSON.parse(extracted);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch {
      // Report a clear error below.
    }
  }

  throw new Error(
    "Sarvam did not return a valid JSON object. Response: " +
    cleaned.slice(0, 1500)
  );
}

function normalizeString(value, maxLength = 2000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeStringArray(value, maxItems = 10) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

// ============================================================
// COMPANY CONTEXT
// ============================================================

function buildCompanyContext(application) {
  const parts = [];

  if (application.name) {
    parts.push(`Application name: ${application.name}`);
  }

  if (application.domain) {
    parts.push(`Website/domain: ${application.domain}`);
  }

  if (application.company) {
    if (typeof application.company === "string") {
      parts.push(
        `Company information: ${application.company}`
      );
    } else {
      parts.push(
        "Company information: " +
        JSON.stringify(application.company)
      );
    }
  }

  if (application.description) {
    parts.push(
      `Description: ${application.description}`
    );
  }

  return parts.join("\n").slice(0, 10000);
}

// ============================================================
// COMPANY ANALYSIS
// ============================================================

async function analyzeCompany(env, application) {
  const context = buildCompanyContext(application);

  if (!context.trim()) {
    throw new Error(
      "The application has no company name or company context. " +
      "Add company information before running analysis."
    );
  }

  const prompt = `
Analyze this company using only the supplied information.

COMPANY:
${context}

Return one JSON object with exactly these keys:
{
  "company_summary": "One or two short sentences",
  "product_or_service": "What the company sells or provides",
  "ideal_customer_types": [
    "Short customer type",
    "Another short customer type"
  ],
  "problems_solved": [
    "Short problem",
    "Another short problem"
  ]
}

Rules:
- Do not invent facts.
- If information is missing, say "Not enough information".
- Customer types must be concise.
- Return valid JSON only.
`.trim();

  const raw = await callSarvam(env, prompt);
  const parsed = parseJsonObject(raw);

  const analysis = {
    company_summary: normalizeString(
      parsed.company_summary
    ),
    product_or_service: normalizeString(
      parsed.product_or_service
    ),
    ideal_customer_types: normalizeStringArray(
      parsed.ideal_customer_types,
      10
    ),
    problems_solved: normalizeStringArray(
      parsed.problems_solved,
      10
    ),
  };

  if (
    !analysis.company_summary &&
    !analysis.product_or_service
  ) {
    throw new Error(
      "Sarvam returned JSON but no usable company analysis."
    );
  }

  return analysis;
}

// ============================================================
// NICHE NAME CLEANING
// ============================================================

function cleanNicheName(value) {
  if (typeof value !== "string") {
    return "";
  }

  let name = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["'`]/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Remove common filler phrases.
  name = name.replace(
    /^(companies|businesses|people|customers|target customers|ideal customers)\s+(such as|like|including)\s+/i,
    ""
  );

  const words = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 4);

  name = words.join(" ");

  if (!name) {
    return "";
  }

  return name;
}

// ============================================================
// NICHE DISCOVERY
// ============================================================

async function discoverNiches(env, application, analysis) {
  const companyContext = buildCompanyContext(application);

  const compactAnalysis = {
    company_summary: analysis.company_summary,
    product_or_service: analysis.product_or_service,
    ideal_customer_types: analysis.ideal_customer_types,
    problems_solved: analysis.problems_solved,
  };

  const prompt = `
Find exactly 10 distinct customer segments that may buy this company's product.

COMPANY:
${companyContext}

ANALYSIS:
${JSON.stringify(compactAnalysis)}

Return only this JSON structure:
{
  "niches": [
    "Freelancers",
    "Website Agencies"
  ]
}

Rules:
- Exactly 10 niches.
- Each niche must be 1 to 4 words.
- Use short labels, not sentences.
- Examples: "Freelancers", "Website Agencies", "SaaS Startups".
- Each niche must be a customer segment, not a marketing strategy.
- Avoid duplicate or nearly identical niches.
- Prioritize segments likely to pay for this product.
- Do not invent unsupported company facts.
- Return JSON only.
`.trim();

  const raw = await callSarvam(env, prompt);
  const parsed = parseJsonObject(raw);

  if (!Array.isArray(parsed.niches)) {
    throw new Error(
      'Sarvam niche response must contain a "niches" array.'
    );
  }

  const seen = new Set();
  const niches = [];

  for (const rawName of parsed.niches) {
    const name = cleanNicheName(rawName);
    const key = name.toLowerCase();

    if (!name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    niches.push(name);

    if (niches.length === 10) {
      break;
    }
  }

  if (niches.length !== 10) {
    throw new Error(
      `Sarvam returned only ${niches.length} unique valid niches. ` +
      "A full set of 10 is required. Please retry the analysis."
    );
  }

  return niches;
}

// ============================================================
// BUSINESS DATA SAVE
//
// Expected business_data columns:
// id
// application_id
// field
// data
// source_url (optional)
// created_at (optional)
//
// This uses GET + PATCH/POST instead of relying on a unique
// constraint that may not exist in the database.
// ============================================================

async function saveBusinessData(
  env,
  applicationId,
  field,
  data
) {
  const lookupPath =
    "/business_data?select=id,application_id,field" +
    "&application_id=eq." +
    queryValue(applicationId) +
    "&field=eq." +
    queryValue(field) +
    "&limit=1";

  const existing = await supabaseRequest(
    env,
    lookupPath,
    { method: "GET" }
  );

  const payload = {
    application_id: applicationId,
    field,
    data,
  };

  if (
    Array.isArray(existing) &&
    existing.length > 0 &&
    existing[0].id
  ) {
    const id = existing[0].id;

    await supabaseRequest(
      env,
      "/business_data?id=eq." + queryValue(id),
      {
        method: "PATCH",
        body: { data },
        headers: {
          "Prefer": "return=minimal",
        },
      }
    );

    return {
      field,
      action: "updated",
    };
  }

  await supabaseRequest(
    env,
    "/business_data",
    {
      method: "POST",
      body: payload,
      headers: {
        "Prefer": "return=minimal",
      },
    }
  );

  return {
    field,
    action: "inserted",
  };
}

// ============================================================
// SAVE COMPANY ANALYSIS
// ============================================================

async function saveCompanyAnalysis(
  env,
  applicationId,
  analysis
) {
  const results = [];

  for (const field of BUSINESS_FIELDS) {
    if (
      !Object.prototype.hasOwnProperty.call(
        analysis,
        field
      )
    ) {
      continue;
    }

    results.push(
      await saveBusinessData(
        env,
        applicationId,
        field,
        analysis[field]
      )
    );
  }

  return results;
}

// ============================================================
// CUSTOMER NICHE SAVE
//
// Expected customer_niches columns:
// application_id
// niche_name
// buying_intention
// niche_status
//
// id, created_at, and updated_at may be generated by the DB.
// user_id is included only when available.
// ============================================================

async function saveCustomerNiches(
  env,
  application,
  nicheNames
) {
  const applicationId = application.id;

  // Deactivate previously active niches.
  // Do not delete history.
  await supabaseRequest(
    env,
    "/customer_niches?application_id=eq." +
      queryValue(applicationId) +
      "&niche_status=eq.active",
    {
      method: "PATCH",
      body: {
        niche_status: "inactive",
      },
      headers: {
        "Prefer": "return=minimal",
      },
    }
  );

  const rows = nicheNames.map((name, index) => {
    const row = {
      application_id: applicationId,
      niche_name: name,
      buying_intention: NICHE_WEIGHTS[index],
      niche_status: "active",
    };

    if (application.user_id) {
      row.user_id = String(application.user_id);
    }

    return row;
  });

  await supabaseRequest(
    env,
    "/customer_niches",
    {
      method: "POST",
      body: rows,
      headers: {
        "Prefer": "return=minimal",
      },
    }
  );

  return {
    saved: rows.length,
    totalBuyingIntention: NICHE_WEIGHTS.reduce(
      (sum, value) => sum + value,
      0
    ),
  };
}

// ============================================================
// PROCESS APPLICATION
// ============================================================

async function processApplication(env, application) {
  if (!application?.id) {
    throw new Error(
      "Cannot process application without an id."
    );
  }

  console.log(
    "Processing application:",
    application.id
  );

  // Step 1: Analyze company.
  const analysis = await analyzeCompany(
    env,
    application
  );

  // Step 2: Save analysis to business_data.
  const savedAnalysis = await saveCompanyAnalysis(
    env,
    application.id,
    analysis
  );

  // Step 3: Discover 10 short customer niches.
  const niches = await discoverNiches(
    env,
    application,
    analysis
  );

  // Step 4: Save niches.
  const savedNiches = await saveCustomerNiches(
    env,
    application,
    niches
  );

  return {
    application_id: application.id,
    company_analysis: analysis,
    business_data: savedAnalysis,
    niches,
    niche_save: savedNiches,
    message: "Company analysis and niche discovery completed.",
  };
}

// ============================================================
// PLANNER TASK HELPERS
// ============================================================

function makeTaskId(source, applicationId, nicheId = "general") {
  const safeApp = String(applicationId)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);

  const safeNiche = String(nicheId)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);

  const timeBucket = Math.floor(
    Date.now() / (30 * 60 * 1000)
  );

  return `${source}_${safeApp}_${safeNiche}_${timeBucket}`;
}

function makeConnectTask(source) {
  const isReddit = source === "reddit";

  return {
    task_type: isReddit
      ? "connect_reddit"
      : "connect_apollo",
    worker: isReddit
      ? "reddit_research"
      : "apollo_lead_generation",
    objective: isReddit
      ? "Connect Reddit so the research worker can discover recent customer problems."
      : "Connect Apollo so the lead-generation worker can find relevant prospects.",
    instructions: isReddit
      ? [
          "Ask the user to connect Reddit.",
          "Do not claim that research has been completed.",
          "Run research only after the integration is connected.",
        ]
      : [
          "Ask the user to connect Apollo.",
          "Do not claim that leads have been found.",
          "Run lead generation only after the integration is connected.",
        ],
  };
}

function makeResearchTask(application, source) {
  const isReddit = source === "reddit";

  return {
    task_id: makeTaskId(source, application.id),
    application_id: application.id,
    worker: isReddit
      ? "reddit_research"
      : "apollo_lead_generation",
    objective: isReddit
      ? "Find recent customer problems and buying signals relevant to the company's target customers."
      : "Find relevant prospects matching the company's target customer segments.",
    target_audience: [
      "Potential customers matching the company's target segments",
      "People and businesses likely to need the company's product",
    ],
    source: isReddit ? "reddit" : "apollo",
    constraints: {
      do_not_invent_results: true,
      avoid_duplicates: true,
    },
    ...(isReddit
      ? {
          subreddits: [
            "SaaS",
            "Entrepreneur",
            "startups",
            "indiehackers",
            "sales",
          ],
          published_within_days: 7,
          target_new_posts: 20,
          problem_categories: [
            "lead_generation",
            "cold_email",
            "customer_acquisition",
            "outreach_personalization",
            "lead_qualification",
          ],
        }
      : {
          target_new_leads: 25,
          require_relevant_company_fit: true,
          require_available_contact_data: true,
        }),
  };
}

// ============================================================
// CHECK INTEGRATION CONNECTION
// ============================================================

async function isIntegrationConnected(
  env,
  applicationId,
  integrationId
) {
  const path =
    "/user_integrations?select=id,status,integration_id" +
    "&application_id=eq." +
    queryValue(applicationId) +
    "&integration_id=eq." +
    queryValue(integrationId) +
    "&status=eq.connected" +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    path,
    { method: "GET" }
  );

  return Array.isArray(rows) && rows.length > 0;
}

// ============================================================
// PLANNER RUN LOOKUP
// ============================================================

async function getLatestPlannerRun(
  env,
  applicationId,
  source
) {
  const path =
    "/planner_runs?select=id,application_id,worker_type,source,task,pending_count,created_at" +
    "&application_id=eq." +
    queryValue(applicationId) +
    "&source=eq." +
    queryValue(source) +
    "&order=created_at.desc" +
    "&limit=1";

  const rows = await supabaseRequest(
    env,
    path,
    { method: "GET" }
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

function parseStoredTask(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  return null;
}

function isSameTaskType(task, expectedType) {
  const parsed = parseStoredTask(task);

  return parsed?.task_type === expectedType;
}

// ============================================================
// CREATE PLANNER RUN
//
// Schema constraints:
// worker_type: research, lead_generation, planner
// source: reddit, apollo, system
//
// Do not send a status field because planner_runs does not
// have a confirmed status column.
// ============================================================

async function createPlannerRun(
  env,
  application,
  source,
  task,
  pendingCount = 1
) {
  const workerType = source === "apollo"
    ? "lead_generation"
    : "research";

  const payload = {
    application_id: application.id,
    worker_type: workerType,
    source,
    task,
    pending_count: pendingCount,
  };

  if (application.user_id) {
    payload.user_id = String(application.user_id);
  }

  await supabaseRequest(
    env,
    "/planner_runs",
    {
      method: "POST",
      body: payload,
      headers: {
        "Prefer": "return=minimal",
      },
    }
  );

  return {
    created: true,
    source,
    worker_type: workerType,
    task,
  };
}

// ============================================================
// TRY TO CREATE A REDDIT OR APOLLO PLAN
//
// Rules:
// - Existing pending tasks prevent duplicates.
// - If an integration is disconnected, create one connection
//   task rather than pretending the worker ran.
// - If an existing connection task is already pending, do not
//   create it again.
// - Reddit is checked before Apollo.
// ============================================================

async function tryCreateSourcePlan(
  env,
  application,
  source
) {
  const integrationId = source;

  const latest = await getLatestPlannerRun(
    env,
    application.id,
    source
  );

  // Avoid duplicates when the most recent task is still pending.
  if (
    latest &&
    Number(latest.pending_count) > 0
  ) {
    return {
      created: false,
      source,
      reason: "A pending planner task already exists.",
    };
  }

  const connected = await isIntegrationConnected(
    env,
    application.id,
    integrationId
  );

  if (!connected) {
    const connectTask = makeConnectTask(source);

    // Avoid repeatedly creating the same connection request.
    if (
      latest &&
      isSameTaskType(
        latest.task,
        connectTask.task_type
      )
    ) {
      return {
        created: false,
        source,
        reason:
          "The connection task already exists and is not pending.",
      };
    }

    const created = await createPlannerRun(
      env,
      application,
      source,
      connectTask,
      1
    );

    return {
      ...created,
      connection_required: true,
    };
  }

  const task = makeResearchTask(
    application,
    source
  );

  return await createPlannerRun(
    env,
    application,
    source,
    task,
    1
  );
}

// ============================================================
// RUN RESEARCH PLANNER
// ============================================================

async function runResearchPlanner(env) {
  const applications = await supabaseRequest(
    env,
    "/applications?select=id,name,user_id&order=created_at.asc",
    { method: "GET" }
  );

  if (!Array.isArray(applications) ||
      applications.length === 0) {
    return {
      applications_checked: 0,
      created: [],
      message: "No applications found.",
    };
  }

  const created = [];
  let checked = 0;

  for (const application of applications) {
    checked++;

    // Reddit is always checked first.
    const redditResult = await tryCreateSourcePlan(
      env,
      application,
      "reddit"
    );

    if (redditResult.created) {
      created.push({
        application_id: application.id,
        ...redditResult,
      });

      // At most one new task per application per run.
      continue;
    }

    // If Reddit is already pending, do not create another task.
    if (
      redditResult.reason ===
      "A pending planner task already exists."
    ) {
      continue;
    }

    // If Reddit is disconnected, its connection task takes
    // priority. Apollo is checked in a later run.
    if (redditResult.connection_required) {
      continue;
    }

    // If Reddit has no pending task, check Apollo.
    const apolloResult = await tryCreateSourcePlan(
      env,
      application,
      "apollo"
    );

    if (apolloResult.created) {
      created.push({
        application_id: application.id,
        ...apolloResult,
      });
    }
  }

  return {
    applications_checked: checked,
    tasks_created: created.length,
    created,
  };
}

// ============================================================
// CRON HANDLER
// ============================================================

async function runScheduledJobs(env) {
  console.log(
    "Running scheduled Reportli planner:",
    new Date().toISOString()
  );

  const result = await runResearchPlanner(env);

  console.log(
    "Scheduled planner completed:",
    JSON.stringify(result)
  );

  return result;
   }
