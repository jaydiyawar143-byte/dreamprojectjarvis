import type { IOrchestrator, IToolExecutor, ITool, AIToolDefinition, ShutdownLifecycle, IMemoryStore, IEmbeddingProvider, IKnowledgeRetriever } from "@jarvis/core";
import type { TokenService } from "@jarvis/security";
import type { IMemoryExtractor } from "@jarvis/core";
import {
  Orchestrator,
  AgentRegistry,
  ConversationalAssistant,
  MetaAdsAgent,
  KnowledgeAgent,
  AnalyticsAgent,
  AutomationAgent,
  CommunicationAgent,
  GoogleAdsAgent,
  PendingActionService,
  AGENT_IDS,
  AGENT_POLICIES,
  isToolAllowed,
} from "@jarvis/agents";
import { OpenAIAdapter, OpenAIEmbeddingProvider } from "@jarvis/ai-openai";
import {
  ToolExecutor,
  ToolRegistry,
  MetaGetAccountsTool,
  MetaGetCampaignsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetInsightsTool,
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaPauseAdSetTool,
  MetaResumeAdSetTool,
  MetaPauseAdTool,
  MetaResumeAdTool,
  MetaUpdateCampaignBudgetTool,
  MetaUpdateAdSetBudgetTool,
  MetaCreateCampaignTool,
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  WhatsAppSendMessageTool,
  RepositoryRecipientAuthorizer,
  N8nTriggerWorkflowTool,
} from "@jarvis/tools";
import { createMetaGraphProvider } from "@jarvis/meta-graph";
import { createGoogleAdsProvider, createGoogleConfig, isGoogleConfigured } from "@jarvis/google-ads";
import { createWhatsAppProvider, createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import {
  createN8nProvider,
  createN8nConfig,
  isN8nConfigured,
  hashPayload,
  buildIdempotencyKey,
} from "@jarvis/n8n";
import {
  PermissionService,
  ApprovalService,
  ToolApprovalService,
  TokenService as TokenServiceImpl,
  AuditLogger,
  PasswordHasher,
  AuthManager,
  EncryptionService,
} from "@jarvis/security";
import {
  prisma,
  PrismaAuditRepository,
  PrismaConversationRepository,
  PrismaUserRepository,
  PrismaRefreshTokenRepository,
  PrismaToolExecutionRepository,
  PrismaApprovalRepository,
  PrismaRecommendationRepository,
  PrismaMemoryRepository,
  PrismaKnowledgeRepository,
  PrismaGoogleConnectionRepository,
  PrismaWhatsAppRepository,
  PrismaN8nRepository,
} from "@jarvis/db";
import { MemoryExtractionService, KnowledgeRetrievalService } from "@jarvis/memory";

export interface Container {
  tokenService: TokenService;
  authService: AuthManager;
  orchestrator: IOrchestrator;
  conversationRepo: PrismaConversationRepository;
  auditLogger: AuditLogger;
  /**
   * Phase 10.6 — durable execution journal (Prisma-backed), exposed so the
   * shutdown controller can run idempotent startup recovery and so hosts
   * never treat process memory as the source of truth.
   */
  executionJournal: PrismaToolExecutionRepository;
  /**
   * PHASE 10.7 — durable approval store backing the production approval API.
   */
  approvalRepo: PrismaApprovalRepository;
  /** Registry used by the approval flow to re-validate stored parameters. */
  toolRegistry: ToolRegistry;
  /**
   * PHASE 11.6B — executor exposed for recommendation execution route so
   * the RecommendationExecutionService can route all writes through the
   * SAME Phase 10 authority (approval + journal + concurrency).
   */
  executor: IToolExecutor;
  /**
   * PHASE 11.6B — durable recommendation store for the execution route.
   */
  recommendationRepo: PrismaRecommendationRepository;
  /** Lifecycle gate consulted before approving side-effecting actions. */
  lifecycle?: ShutdownLifecycle;
  /** PHASE 11.9 — pending action service for write-tool confirmation flow. */
  pendingActionService?: import("@jarvis/agents").PendingActionService;
  /**
   * Sprint 1.1A — persistent memory store wired into the production container.
   * Null when OPENAI_API_KEY is absent (graceful degradation).
   */
  memoryStore: IMemoryStore | null;
  /** Sprint 1.1A — embedding provider. Null when OPENAI_API_KEY is absent. */
  embeddingProvider: IEmbeddingProvider | null;
  /** Sprint 1.1A — memory extractor. Null when OPENAI_API_KEY is absent. */
  memoryExtractor: IMemoryExtractor | null;
  knowledgeRepo?: PrismaKnowledgeRepository;
  /**
   * Sprint 3.7 — knowledge retriever wired into the orchestrator for RAG.
   * Null when OPENAI_API_KEY is absent, since a query cannot be embedded.
   */
  knowledgeRetriever: IKnowledgeRetriever | null;
}

/**
 * OpenAI function-calling requires names matching `^[a-zA-Z0-9_-]+$`.
 * Registry tool IDs use dots (e.g. `meta.insights`), so we sanitize them
 * for the LLM and build a reverse map so the orchestrator can resolve
 * the original ID when the model returns a tool call.
 */
function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function convertToolsToAIToolDefinitions(
  tools: ITool[]
): { definitions: AIToolDefinition[]; sanitizedToOriginal: Map<string, string> } {
  const sanitizedToOriginal = new Map<string, string>();
  const definitions = tools
    .filter((t) => t.enabled)
    .map((t) => {
      const sanitized = sanitizeToolName(t.id);
      if (sanitized !== t.id) {
        sanitizedToOriginal.set(sanitized, t.id);
      }
      return {
        name: sanitized,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ])
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      };
    });
  return { definitions, sanitizedToOriginal };
}

let _container: Container | null = null;

function createMetaToolRegistry(
  approvalConsumption: PrismaApprovalRepository
): ToolRegistry {
  const registry = new ToolRegistry();
  const metaAccessToken = process.env.META_ACCESS_TOKEN;
  const metaAccountId = process.env.META_AD_ACCOUNT_ID;

  console.log(JSON.stringify({
    level: "info",
    event: "meta_credentials_check",
    tokenSet: !!metaAccessToken,
    tokenLength: metaAccessToken?.length ?? 0,
    accountId: metaAccountId ?? "NOT_SET",
    apiVersion: process.env.META_GRAPH_API_VERSION ?? "NOT_SET",
  }));

  if (metaAccessToken && metaAccountId) {
    const realProvider = createMetaGraphProvider({
      accessToken: metaAccessToken,
      adAccountId: metaAccountId,
      apiVersion: process.env.META_GRAPH_API_VERSION,
    });

    // Phase 10.1: durable execution journal — DB-enforced idempotency for
    // every write tool. No in-process state may gate external side effects.
    const executionJournal = new PrismaToolExecutionRepository(prisma);

    // Phase 8: Read-only tools (provider doubles as its own authorizer)
    registry.register(new MetaGetAccountsTool(realProvider, realProvider));
    registry.register(new MetaGetCampaignsTool(realProvider, realProvider));
    registry.register(new MetaGetAdSetsTool(realProvider, realProvider));
    registry.register(new MetaGetAdsTool(realProvider, realProvider));
    registry.register(new MetaGetInsightsTool(realProvider, realProvider));

    // Phase 9.1: Write tools (pause/resume)
    registry.register(new MetaPauseCampaignTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeCampaignTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdSetTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdSetTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaPauseAdTool(realProvider, realProvider, executionJournal, approvalConsumption));
    registry.register(new MetaResumeAdTool(realProvider, realProvider, executionJournal, approvalConsumption));

    // Phase 9.2: Budget tools
    registry.register(new MetaUpdateCampaignBudgetTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));
    registry.register(new MetaUpdateAdSetBudgetTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));

    // Phase 9.3: Campaign creation
    registry.register(new MetaCreateCampaignTool(realProvider, realProvider, undefined, executionJournal, approvalConsumption));
  }

  // -------------------------------------------------------------------------
  // Sprint 5.2 — Google Ads (READ-ONLY)
  // -------------------------------------------------------------------------
  // Registered only when the server is fully configured AND an encryption key
  // exists: without the key no connection could have been stored, so the tools
  // would fail on every call. Credentials are per-user and resolved inside the
  // provider, so nothing here handles a token.
  // -------------------------------------------------------------------------
  if (isGoogleConfigured() && process.env.JARVIS_ENCRYPTION_KEY) {
    try {
      const googleProvider = createGoogleAdsProvider({
        config: createGoogleConfig(),
        connections: new PrismaGoogleConnectionRepository(prisma, EncryptionService.fromEnv()),
      });
      // Provider doubles as its own authorizer, matching the Meta wiring.
      registry.register(new GoogleGetAccountsTool(googleProvider, googleProvider));
      registry.register(new GoogleGetCampaignsTool(googleProvider, googleProvider));
      registry.register(new GoogleGetInsightsTool(googleProvider, googleProvider));
    } catch (err) {
      // Misconfiguration must not take the whole API down; Google tools simply
      // stay unregistered and /google/status reports configured: false.
      console.log(JSON.stringify({
        level: "warn",
        event: "google_ads_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Sprint 5.3 — WhatsApp outbound send (APPROVAL-GATED)
  // -------------------------------------------------------------------------
  // Registered only when every WhatsApp secret is present. The tool is
  // EXTERNAL_SIDE_EFFECT with requiresApproval, so ToolApprovalService refuses
  // to execute it without a human decision — the same gate the Meta write
  // tools pass through.
  // -------------------------------------------------------------------------
  if (isWhatsAppConfigured()) {
    try {
      const waConfig = createWhatsAppConfig();
      const waRepo = new PrismaWhatsAppRepository(prisma);
      const waProvider = createWhatsAppProvider({ config: waConfig });
      registry.register(
        new WhatsAppSendMessageTool(
          waProvider,
          new RepositoryRecipientAuthorizer(waRepo, waConfig.phoneNumberId),
          waConfig.phoneNumberId,
          waRepo
        )
      );
    } catch (err) {
      // Misconfiguration must not take the API down; the tool stays
      // unregistered and the webhook routes report themselves unconfigured.
      console.log(JSON.stringify({
        level: "warn",
        event: "whatsapp_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Sprint 5.4 — n8n workflow trigger (APPROVAL-GATED)
  // -------------------------------------------------------------------------
  // Registered only when base URL, API key and callback secret are all set.
  // The tool is EXTERNAL_SIDE_EFFECT with requiresApproval: an n8n workflow can
  // do anything its author wired up, so ToolApprovalService demands a human
  // decision exactly as it does for the Meta write tools and whatsapp.send.
  // -------------------------------------------------------------------------
  if (isN8nConfigured()) {
    try {
      const n8nRepo = new PrismaN8nRepository(prisma);
      const n8nProvider = createN8nProvider({ config: createN8nConfig() });
      registry.register(
        new N8nTriggerWorkflowTool(n8nProvider, n8nRepo, { hashPayload, buildIdempotencyKey })
      );
    } catch (err) {
      console.log(JSON.stringify({
        level: "warn",
        event: "n8n_registration_skipped",
        reason: err instanceof Error ? err.message : "unknown",
      }));
    }
  }

  return registry;
}

export function getContainer(options?: {
  /**
   * Phase 10.6 — lifecycle gate wired into the ToolExecutor so draining
   * blocks new side-effecting executions (and approval consumption) at the
   * earliest safe point.
   */
  lifecycle?: ShutdownLifecycle;
}): Container {
  if (_container) return _container;

  const tokenSecret = process.env.JWT_SECRET;
  if (!tokenSecret) {
    throw new Error("JWT_SECRET is required");
  }

  const tokenService = new TokenServiceImpl(tokenSecret);

  const auditRepo = new PrismaAuditRepository(prisma);
  const auditLogger = new AuditLogger(auditRepo);

  // Phase 10.6 — durable journal exposed on the container for idempotent
  // startup recovery and shutdown-time state inspection.
  const executionJournal = new PrismaToolExecutionRepository(prisma);

  const conversationRepo = new PrismaConversationRepository(prisma);

  const passwordHasher = new PasswordHasher();
  const userRepo = new PrismaUserRepository(prisma);
  const refreshTokenRepo = new PrismaRefreshTokenRepository(prisma);
  const authService = new AuthManager(passwordHasher, tokenService, refreshTokenRepo, userRepo);
  const knowledgeRepo = new PrismaKnowledgeRepository(prisma);

  const permissionService = new PermissionService();
  // PHASE 10.7 — real durable approval store replaces the Phase-0 noop repo.
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);

  const toolRegistry = createMetaToolRegistry(approvalRepo);

  const adapter = new OpenAIAdapter();

  const { definitions: agentTools, sanitizedToOriginal } = convertToolsToAIToolDefinitions(toolRegistry.getAll());

  // Sprint 6 — narrow the definitions offered to each agent to its policy.
  // `agentTools` holds SANITIZED names (dots are illegal in an OpenAI function
  // name), so membership is tested with the helper that understands both
  // spellings rather than by string equality against the registry ids.
  const registeredToolIds = new Set(toolRegistry.getAll().map((t) => t.id));
  const hasTool = (id: string) => registeredToolIds.has(id);
  const toolDefsFor = (allowed: readonly string[]): AIToolDefinition[] =>
    agentTools.filter((def) => isToolAllowed(def.name, allowed));

  const systemPrompt = [
    "You are JARVIS, a helpful AI assistant with direct access to the user's Meta Ads account.",
    "",
    "You have tools to read and manage Meta Ads campaigns. The Meta ad account ID is already configured in the system — you do NOT need to ask the user for it.",
    "",
    `IMPORTANT: Your configured Meta Ad Account ID is: ${process.env.META_AD_ACCOUNT_ID}. When calling any Meta tool that requires an "accountId" parameter, you MUST use exactly this value: "${process.env.META_AD_ACCOUNT_ID}". Never invent, guess, or use a different account ID.`,
    "",
    "When the user asks about their Meta Ads performance, campaigns, ad sets, ads, or insights, use the appropriate tool to fetch real data. Do NOT say you cannot access the account.",
    "",
    "For read-only queries (performance, metrics, lists), use the tools directly.",
    "For write operations (pause, resume, budget changes, create campaign), call the tool directly. The system will handle the confirmation and approval flow automatically.",
    "",
    "DATE RANGE DEFAULTS:",
    "- If the user asks about 'current performance' or 'recent performance' or doesn't specify dates, use the last 30 days.",
    "- If the user says 'this week', use the last 7 days.",
    "- If the user says 'this month', use the first day of the current month to today.",
    "- If the user says 'last month', use the first day of the previous month to the last day of the previous month.",
    "- Always use YYYY-MM-DD format.",
    "- Do NOT ask the user for dates if you can infer a reasonable default.",
    "",
    "CRITICAL RULES — ANTI-HALLUCINATION:",
    "- NEVER invent, estimate, or fabricate Meta Ads metrics (Spend, CTR, CPC, CPM, CPA, conversions, ROAS, impressions, clicks, or any other numeric values).",
    "- ONLY report data that was ACTUALLY returned by a tool. Check each tool result's STATUS field.",
    "- If a tool's STATUS is not COMPLETED, or if DATA_RETRIEVAL_FAILED appears, you MUST NOT present any metrics as factual values.",
    "- If data retrieval failed, explicitly state: 'Meta data retrieval failed' and include the ERROR from the tool result.",
    "- When presenting real data, include provenance: source (Meta API), account ID, and date range.",
    "- If a tool returns DATA: (empty — no data returned), state that no data was found for the specified criteria.",
    "- Never say 'Source: Meta API' unless the tool actually returned real data with STATUS: COMPLETED.",
    "",
    "MULTI-TURN CONTEXT RESOLUTION:",
    "- You have access to the FULL conversation history. Use it to resolve references.",
    "- When the user says short follow-ups like 'yes', 'please do', 'do it', 'proceed', 'create it', 'go ahead', 'haan', 'kar do', 'nahi tum karo', 'same', 'same details', 'proceed with that' — resolve them against the immediately preceding conversation context.",
    "- NEVER re-ask for information that was ALREADY provided in the conversation.",
    "- If all required information for a requested action is available in the conversation history, proceed directly.",
    "- If information is genuinely missing for a required action, ask ONLY for the specific missing fields.",
    "- Do NOT invent or guess values the user has not provided.",
    "- For write operations: call the tool directly with all the parameters the user has provided. The system will create a pending action and handle the confirmation flow.",
    "- When the user confirms (e.g. 'please do', 'yes', 'go ahead'), the system will automatically execute the confirmed action. You do not need to call the tool again.",
    "",
    "APPROVAL HANDLING:",
    "- The system will automatically intercept write tool calls and create pending actions for user confirmation.",
    "- When the system returns a pending action, present the details to the user and ask them to confirm.",
    "- NEVER say 'I cannot proceed' or 'unfortunately I cannot' when you see a pending action. This is a normal part of the workflow.",
    "- When the user confirms (e.g. 'haan kar do', 'yes', 'go ahead'), the system will automatically execute the action.",
    "- When the tool returns STATUS: COMPLETED with DATA, the action was executed successfully. Present the results to the user.",
  ].join("\n");

  const agent = new ConversationalAssistant({
    provider: adapter,
    systemPrompt,
    tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.general]!.allowedTools),
  });

  const metaAdsSystemPrompt = [
    "You are the JARVIS Meta Ads Agent, a specialized domain expert for Meta Ads (Facebook & Instagram).",
    "You have campaign hierarchy awareness: Account -> Campaign -> Ad Set -> Ad -> Creative.",
    "You understand performance metrics: Spend, CTR, CPC, CPM, CPA, ROAS, Conversions, Budget, and Delivery states.",
    "",
    "=== REASONING & ACCURACY RULES ===",
    "1. FACT vs INFERENCE vs HYPOTHESIS: Clearly distinguish verified facts from logical inferences and hypotheses.",
    "   - FACT: Data directly returned from a tool.",
    "   - INFERENCE: Calculations or direct logical conclusions based on raw numbers.",
    "   - HYPOTHESIS: Possibilities to explain trends that need testing.",
    "2. NO FABRICATION: Never fabricate or hallucinate any campaign IDs, ad IDs, account IDs, or metric values.",
    "3. WRITE CONFIRMATION: Never claim a mutation occurred unless you receive tool execution status confirmation.",
    "4. NO GUARANTEES: Never guarantee performance improvements or campaign success.",
    "",
    "=== WORKFLOW RULES ===",
    "1. READ-FIRST FOR ANALYSIS: When users ask analytical questions, always fetch the data first using read tools, analyze, and then explain. Never perform or suggest write mutations.",
    "2. RECOMMENDATION FLOW: When recommending optimizations, present the data evidence, metric anomalies, diagnosis, specific recommendations, risk profiles, and confidence level. Do NOT execute any write directly; present options clearly to the user.",
    "3. WRITE SAFETY & APPROVALS: For modification requests, select the appropriate write tool. The system automatically intercepts these write tools to generate pending actions for human approval. Inform the user of the pending approval ID cleanly and instruct them to confirm.",
    "4. SECURITY: Never reveal Meta access tokens or internal API credentials.",
    "",
    "=== RESPONSE FORMATTING ===",
    "When providing analytical reports or diagnostic insights, prefer this structured layout if suitable:",
    "- **Summary**: High-level overview.",
    "- **Evidence**: Metrics, anomalies, and facts.",
    "- **Diagnosis**: Explanation of performance trends.",
    "- **Recommendation**: Concrete optimization action.",
    "- **Risk & Confidence**: Risk level and confidence score.",
    "- **Next Step**: Actionable prompt.",
    "Do not force this format for simple conversational queries. Respect memory context preferences."
  ].join("\n");

  const metaAgent = new MetaAdsAgent({
    provider: adapter,
    systemPrompt: metaAdsSystemPrompt,
    tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.metaAds]!.allowedTools),
  });

  // ---------------------------------------------------------------------------
  // Sprint 6 — specialized agent registration.
  //
  // `requirePolicy` makes the allowlist a property of the deployment: an agent
  // with no entry in the compiled-in policy table cannot be registered at all,
  // so there is no path to a production agent running unrestricted.
  //
  // Each agent is offered ONLY the tool definitions its policy allows. That is
  // prompt hygiene rather than the security boundary — the Orchestrator checks
  // the same policy again before executing anything — but it stops a model
  // being tempted by a tool it would only be denied.
  //
  // Integration-backed agents register only when their tool actually exists.
  // With WhatsApp or n8n unconfigured the agent is absent, the router's next
  // candidate is taken, and the request lands on the general assistant instead
  // of on an agent that could not have helped.
  // ---------------------------------------------------------------------------
  const agentRegistry = new AgentRegistry({ requirePolicy: true });
  agentRegistry.register(agent);
  agentRegistry.register(metaAgent);

  agentRegistry.register(
    new KnowledgeAgent({
      provider: adapter,
      tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools),
    })
  );

  agentRegistry.register(
    new AnalyticsAgent({
      provider: adapter,
      tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.analytics]!.allowedTools),
    })
  );

  if (hasTool("google.accounts")) {
    agentRegistry.register(
      new GoogleAdsAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.googleAds]!.allowedTools),
      })
    );
  }

  if (hasTool("n8n.trigger")) {
    agentRegistry.register(
      new AutomationAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools),
        workflows: new PrismaN8nRepository(prisma),
      })
    );
  }

  if (hasTool("whatsapp.send")) {
    agentRegistry.register(
      new CommunicationAgent({
        provider: adapter,
        tools: toolDefsFor(AGENT_POLICIES[AGENT_IDS.communication]!.allowedTools),
        conversations: new PrismaWhatsAppRepository(prisma),
      })
    );
  }

  console.log(JSON.stringify({
    level: "info",
    event: "agent_registration",
    agents: agentRegistry.getAll().map((a) => ({
      id: a.id,
      domain: agentRegistry.getPolicy(a.id)?.domain,
      tools: agentRegistry.getPolicy(a.id)?.allowedTools.length ?? 0,
    })),
  }));

  const toolApprovalService = new ToolApprovalService(approvalRepo, auditRepo, permissionService);

  // Wrap registry so the orchestrator resolves sanitized LLM tool names
  // (e.g. "meta-insights") back to original registry IDs (e.g. "meta.insights").
  // The executor ALSO needs this mapping — it receives the sanitized name from
  // the LLM and must resolve it before looking up the tool in the real registry.
  const resolvingRegistry = sanitizedToOriginal.size > 0
    ? {
        get(toolId: string) {
          const original = sanitizedToOriginal.get(toolId) ?? toolId;
          return toolRegistry.get(original);
        },
        getAll: () => toolRegistry.getAll(),
      }
    : toolRegistry;

  const toolExecutor = new ToolExecutor(
    resolvingRegistry,
    permissionService,
    approvalService,
    auditLogger,
    { lifecycle: options?.lifecycle }
  );

  // PHASE 11.9 — Pending action service for write-tool confirmation flow
  const pendingActionService = new PendingActionService({
    approvalRepo,
    toolRegistry: resolvingRegistry,
  });

  // ---------------------------------------------------------------------------
  // Sprint 1.1A — Persistent Memory Store Wiring
  // Wire PrismaMemoryRepository → MemoryExtractionService → Orchestrator.
  // Graceful degradation: if OPENAI_API_KEY is absent, memory is disabled but
  // the application still starts (matches the existing Meta credentials pattern).
  // ---------------------------------------------------------------------------

  let memoryStore: IMemoryStore | null = null;
  let embeddingProvider: IEmbeddingProvider | null = null;
  let memoryExtractor: IMemoryExtractor | null = null;

  try {
    // PrismaMemoryRepository is always safe to instantiate — no API key needed.
    memoryStore = new PrismaMemoryRepository(prisma);

    // OpenAIEmbeddingProvider throws if OPENAI_API_KEY is absent.
    embeddingProvider = new OpenAIEmbeddingProvider();

    // MemoryExtractionService reuses the same OpenAIAdapter already wired for
    // the ConversationalAssistant — no second AI client is created.
    memoryExtractor = new MemoryExtractionService({
      aiProvider: adapter,
      store: memoryStore,
      embeddingProvider,
    });

    console.log(JSON.stringify({
      level: "info",
      event: "memory_wiring",
      status: "persistent_memory_wired",
      store: memoryStore.id,
      embeddingProvider: embeddingProvider.id,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({
      level: "warn",
      event: "memory_wiring",
      status: "memory_disabled",
      reason: message,
    }));
    // Reset all to null so partial state is never used
    memoryStore = null;
    embeddingProvider = null;
    memoryExtractor = null;
  }

  // ---------------------------------------------------------------------------
  // Sprint 3.7 — Knowledge retrieval wiring for RAG.
  // Reuses the SAME embedding provider the memory stack uses, so no second
  // client is created. Null without a provider: a query cannot be embedded, and
  // the orchestrator then behaves exactly as it did before this sprint.
  // ---------------------------------------------------------------------------
  let knowledgeRetriever: IKnowledgeRetriever | null = null;
  if (embeddingProvider !== null) {
    knowledgeRetriever = new KnowledgeRetrievalService({
      provider: embeddingProvider,
      repository: knowledgeRepo,
    });
  }
  console.log(JSON.stringify({
    level: "info",
    event: "knowledge_wiring",
    status: knowledgeRetriever ? "rag_enabled" : "rag_disabled_no_embedding_provider",
  }));

  const orchestrator = new Orchestrator(agentRegistry, toolExecutor, auditLogger, {
    toolRegistry: resolvingRegistry,
    toolApprovalService,
    // Sprint 6 — the agent permission floor is checked with the SAME service
    // the tool layer uses, so selecting an agent can never widen a role.
    permissionChecker: permissionService,
    pendingActionService: pendingActionService as unknown,
    // Sprint 1.1A: wire persistent memory into orchestrator
    ...(memoryStore !== null && embeddingProvider !== null
      ? {
          memoryStore,
          embeddingProvider,
          ...(memoryExtractor !== null ? { memoryExtractor } : {}),
        }
      : {}),
    // Sprint 3.7: RAG context injection. Absent when no provider is configured.
    ...(knowledgeRetriever !== null ? { knowledgeRetriever } : {}),
  });

  const recommendationRepo = new PrismaRecommendationRepository(prisma);

  _container = {
    tokenService,
    authService,
    orchestrator,
    conversationRepo,
    auditLogger,
    executionJournal,
    approvalRepo,
    toolRegistry,
    executor: toolExecutor,
    recommendationRepo,
    lifecycle: options?.lifecycle,
    pendingActionService,
    // Sprint 1.1A — expose memory stack for diagnostics and tests
    memoryStore,
    embeddingProvider,
    memoryExtractor,
    knowledgeRepo,
    knowledgeRetriever,
  };

  return _container;
}

export function resetContainer(): void {
  _container = null;
}
