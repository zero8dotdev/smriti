/**
 * bench/corpus.ts - Realistic synthetic corpus for quality benchmarking
 *
 * 12 sessions across 3 projects, 3 agents, and multiple categories.
 * Each session has domain-specific vocabulary so queries can differentiate.
 */

import type { Database } from "bun:sqlite";
import { addMessage } from "../qmd";
import {
  upsertProject,
  upsertSessionMeta,
  tagSession,
  initializeSmritiTables,
  seedDefaults,
  migrateFTSToV2,
  insertArtifact,
  insertThinking,
  insertAttachment,
} from "../db";
import { initializeMemoryTables } from "../qmd";
import type { SessionDef, CorpusManifest, BenchProfile } from "./types";

// =============================================================================
// Session Definitions
// =============================================================================

const SESSIONS: SessionDef[] = [
  // ── project=webapp, agent=claude-code ────────────────────────────────
  {
    id: "bench-s01",
    title: "Auth System Design",
    project: "webapp",
    agent: "claude-code",
    category: "architecture/design",
    messages: [
      { role: "user", content: "We need to design the authentication system for our webapp. Should we use session-based auth or token-based?" },
      { role: "assistant", content: "For the webapp, I recommend a hybrid approach: session-based authentication with RBAC (role-based access control). We should use bcrypt for password hashing with a cost factor of 12. The middleware layer will validate session cookies on each request and check role permissions against a PostgreSQL-backed ACL table." },
      { role: "user", content: "What about the session storage? Redis or database?" },
      { role: "assistant", content: "Redis is the better choice for session storage here. Session tokens are short-lived and high-frequency reads. We can set TTL to 24 hours with sliding expiration. The session middleware will check Redis first, fall back to PostgreSQL for long-lived remember-me tokens. Use secure httpOnly cookies with SameSite=Strict." },
      { role: "user", content: "How should we handle password reset flow?" },
      { role: "assistant", content: "The password reset flow uses a time-limited token stored in the database. Generate a cryptographically secure random token with crypto.randomBytes(32), hash it with SHA-256 before storage, and set a 1-hour expiration. The reset endpoint validates the token hash, enforces password complexity rules (min 12 chars, mixed case, no common passwords via haveibeenpwned API), and invalidates all existing sessions on password change." },
      { role: "user", content: "Let's go with this approach. RBAC with bcrypt, Redis sessions, and secure password reset." },
      { role: "assistant", content: "Confirmed. I'll implement the auth system with: 1) bcrypt password hashing (cost 12), 2) Redis session store with 24h TTL, 3) RBAC middleware checking PostgreSQL ACL, 4) Secure password reset with hashed tokens and 1h expiry. The session cookie will use httpOnly, Secure, SameSite=Strict flags." },
    ],
  },
  {
    id: "bench-s02",
    title: "JWT Token Bug",
    project: "webapp",
    agent: "claude-code",
    category: "bug/fix",
    messages: [
      { role: "user", content: "Users are getting logged out randomly. The JWT token seems to expire early." },
      { role: "assistant", content: "I found the bug. The JWT refresh token logic has a race condition. When multiple API requests fire simultaneously and the access token is expired, each request independently tries to refresh the token. The first succeeds and rotates the refresh token, but subsequent requests use the now-invalidated old refresh token and get 401 Unauthorized errors." },
      { role: "user", content: "That explains the intermittent 401 errors we see in production. How do we fix it?" },
      { role: "assistant", content: "The fix involves a token refresh mutex. We add a promise-based lock in the HTTP client interceptor. When the first request detects an expired access token, it acquires the lock, refreshes both tokens, and stores the new pair. All concurrent requests wait on the same promise and reuse the refreshed tokens. I also added a 30-second buffer before actual expiry to prevent edge-case timing issues." },
      { role: "user", content: "What about the refresh token rotation? Is that still secure?" },
      { role: "assistant", content: "Yes, the rotation is still secure. Each refresh token is single-use with a grace period of 10 seconds for the race window. If a refresh token is reused outside the grace period, we invalidate the entire token family (all tokens in that refresh chain) as a security measure against token theft. The server-side stores token family IDs in the jwt_token_families table." },
      { role: "user", content: "Deploy the fix. The race condition with the refresh mutex looks good." },
      { role: "assistant", content: "Deployed. The JWT refresh race condition is fixed with a client-side mutex that serializes token refresh requests. Added 30-second pre-expiry buffer and server-side token family tracking with 10-second grace period for rotation." },
    ],
  },
  {
    id: "bench-s03",
    title: "OAuth2 Google Integration",
    project: "webapp",
    agent: "claude-code",
    category: "feature/implementation",
    messages: [
      { role: "user", content: "We need to add Google OAuth2 sign-in to the webapp. Users should be able to link their Google account." },
      { role: "assistant", content: "I'll implement Google OAuth2 using the Authorization Code flow with PKCE. The flow: 1) Generate state + code_verifier, store in session, 2) Redirect to Google's authorization endpoint with scope openid email profile, 3) Handle callback with authorization code, 4) Exchange code for tokens at Google's token endpoint, 5) Verify ID token signature with Google's JWKS, 6) Create or link local account." },
      { role: "user", content: "How do we handle the case where a user already has an account with the same email?" },
      { role: "assistant", content: "When a Google sign-in returns an email that matches an existing account, we prompt the user to link accounts. The linking flow: 1) Show confirmation screen with the existing account email, 2) Require password verification for the existing account, 3) Store the Google subject ID in the oauth_providers table linked to the user, 4) Next sign-in with Google auto-resolves to the linked account. We use the Google sub claim as the stable identifier, not the email." },
      { role: "user", content: "What about the redirect URI setup?" },
      { role: "assistant", content: "The redirect URI is configured per environment: localhost:3000/auth/google/callback for dev, app.example.com/auth/google/callback for production. The Google Cloud Console project needs both registered. The callback handler validates the state parameter against the session, exchanges the code with PKCE verification, and sets the session cookie. CSRF protection comes from the state parameter comparison." },
      { role: "user", content: "Implement it with PKCE and account linking." },
      { role: "assistant", content: "Google OAuth2 integration implemented with Authorization Code + PKCE flow. Account linking handles email collisions by requiring password verification. State parameter provides CSRF protection. Google subject ID stored in oauth_providers table for stable identity mapping." },
    ],
  },
  {
    id: "bench-s04",
    title: "Rate Limiting Middleware",
    project: "webapp",
    agent: "claude-code",
    category: "code/implementation",
    messages: [
      { role: "user", content: "We need rate limiting for our API endpoints. Different limits for authenticated vs unauthenticated users." },
      { role: "assistant", content: "I'll implement a sliding window rate limiter using Redis sorted sets. Each request adds a timestamp to the sorted set keyed by client identifier (IP for anonymous, user ID for authenticated). We trim entries older than the window, then check the cardinality. Limits: 100 req/min for authenticated users, 20 req/min for anonymous, 1000 req/min for API key holders." },
      { role: "user", content: "What about the sliding window algorithm specifically? Fixed windows have the burst problem at boundaries." },
      { role: "assistant", content: "The sliding window algorithm uses Redis ZADD with the current timestamp as both score and member. On each request: 1) ZREMRANGEBYSCORE to remove entries older than window_start = now - window_size, 2) ZCARD to count remaining entries, 3) If under limit, ZADD current timestamp, 4) EXPIRE key with window_size TTL for cleanup. This gives true per-second granularity without the boundary burst issue that fixed windows have." },
      { role: "user", content: "How do we return rate limit headers to clients?" },
      { role: "assistant", content: "Standard rate limit response headers: X-RateLimit-Limit (max requests in window), X-RateLimit-Remaining (requests left), X-RateLimit-Reset (unix timestamp when window resets), Retry-After (seconds to wait, only on 429). When limit is exceeded, return HTTP 429 Too Many Requests with a JSON body explaining the limit and retry timing. The middleware attaches these headers to every response, not just 429s." },
      { role: "user", content: "Implement the sliding window approach with Redis sorted sets." },
      { role: "assistant", content: "Rate limiting middleware implemented using Redis ZADD sliding window. Three tiers: anonymous (20/min), authenticated (100/min), API key (1000/min). Proper rate limit headers on all responses. 429 responses include Retry-After header and JSON explanation." },
    ],
    sidecar: {
      thinking: "The sliding window algorithm is better than fixed window because it prevents the boundary burst problem. With fixed windows of 1 minute, a client could send 100 requests at 0:59 and another 100 at 1:01, effectively getting 200 requests in 2 seconds. The sliding window with Redis sorted sets tracks exact timestamps, giving true per-second rate enforcement. Considered token bucket but sliding window is simpler for our use case.",
      artifact: {
        title: "rate-limiter.ts",
        content: "export class SlidingWindowRateLimiter {\n  constructor(private redis: Redis, private windowMs: number, private maxRequests: number) {}\n\n  async check(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {\n    const now = Date.now();\n    const windowStart = now - this.windowMs;\n    const multi = this.redis.multi();\n    multi.zremrangebyscore(key, 0, windowStart);\n    multi.zcard(key);\n    multi.zadd(key, now, `${now}`);\n    multi.expire(key, Math.ceil(this.windowMs / 1000));\n    const results = await multi.exec();\n    const count = results[1] as number;\n    return { allowed: count < this.maxRequests, remaining: Math.max(0, this.maxRequests - count - 1), resetAt: now + this.windowMs };\n  }\n}",
        language: "typescript",
      },
      attachment: {
        fileName: "api-rate-limit-policy.md",
        content: "API Rate Limit Policy v2.1: Anonymous users are limited to 20 requests per minute per IP address. Authenticated users get 100 requests per minute per user ID. API key holders with enterprise plans get 1000 requests per minute. Rate limits use sliding window algorithm to prevent boundary burst attacks. Exceeding limits returns HTTP 429 with Retry-After header.",
      },
    },
  },

  // ── project=ml-pipeline, agent=codex ─────────────────────────────────
  {
    id: "bench-s05",
    title: "Training Pipeline Setup",
    project: "ml-pipeline",
    agent: "codex",
    category: "project/setup",
    messages: [
      { role: "user", content: "Set up the training pipeline for our text classification model." },
      { role: "assistant", content: "I'll set up the PyTorch training pipeline with a DataLoader configuration optimized for GPU utilization. Using PyTorch Lightning for the training loop with automatic mixed precision (AMP). The DataLoader uses num_workers=4, pin_memory=True, and prefetch_factor=2 for efficient GPU feeding. Batch size 32 with gradient accumulation every 4 steps for effective batch size 128." },
      { role: "user", content: "What about experiment tracking and checkpoints?" },
      { role: "assistant", content: "Using wandb (Weights & Biases) for experiment tracking. Every training run logs: loss curves, learning rate schedule, GPU memory utilization, gradient norms, and validation metrics. Checkpoints saved every epoch with PyTorch Lightning's ModelCheckpoint callback, keeping top-3 by validation F1 score. The checkpoint includes model weights, optimizer state, and the wandb run ID for reproducibility." },
      { role: "user", content: "How should we handle the learning rate schedule?" },
      { role: "assistant", content: "Using a cosine annealing schedule with warmup. Linear warmup for the first 10% of training steps (from 1e-7 to peak lr 2e-5), then cosine decay to 1e-7. This is standard for fine-tuning transformer models. The warmup prevents early gradient explosion with randomly initialized classification head. AdamW optimizer with weight decay 0.01, betas (0.9, 0.999)." },
      { role: "user", content: "Set it up with wandb tracking and cosine schedule." },
      { role: "assistant", content: "Training pipeline configured: PyTorch Lightning with AMP, DataLoader (workers=4, pin_memory, prefetch=2), wandb experiment tracking, cosine annealing with 10% warmup, AdamW (lr=2e-5, wd=0.01), ModelCheckpoint keeping top-3 by val F1." },
    ],
  },
  {
    id: "bench-s06",
    title: "Model Overfitting Debug",
    project: "ml-pipeline",
    agent: "codex",
    category: "bug/investigation",
    messages: [
      { role: "user", content: "The model is showing high training accuracy but poor validation accuracy. Classic overfitting." },
      { role: "assistant", content: "Looking at the wandb metrics, training loss drops to 0.05 but validation loss plateaus at 0.8 after epoch 3. The train/val divergence starts at epoch 2. Key indicators: 1) Gradient norms are high (>10) suggesting the model is memorizing training examples, 2) The training data has class imbalance (80/20 split), 3) No dropout in the classifier head, 4) Augmentation is disabled." },
      { role: "user", content: "What regularization techniques should we apply?" },
      { role: "assistant", content: "Multi-pronged approach to combat overfitting: 1) Add dropout (p=0.3) to the classification head, 2) Enable label smoothing (alpha=0.1) in the cross-entropy loss, 3) Apply data augmentation (synonym replacement, random deletion, back-translation), 4) Reduce model capacity by freezing all but the last 2 transformer layers for the first 5 epochs. Additionally, implement early stopping monitoring val_loss with patience=5." },
      { role: "user", content: "What about the train/test split? Maybe we need stratified splitting." },
      { role: "assistant", content: "Good catch. The current random split doesn't preserve class distribution. Switching to stratified k-fold cross-validation with k=5 ensures each fold has the same class ratio. For the imbalanced classes, we also add class weights inversely proportional to frequency: weight_i = total_samples / (num_classes * count_i). This prevents the model from just predicting the majority class." },
      { role: "user", content: "Apply all the regularization fixes and use stratified splits." },
      { role: "assistant", content: "Applied: dropout(0.3) on classifier head, label smoothing(0.1), data augmentation (synonym replace + back-translation), layer freezing for first 5 epochs, early stopping patience=5, stratified 5-fold CV, and inverse frequency class weights. Retraining now." },
    ],
  },
  {
    id: "bench-s07",
    title: "Feature Store Design",
    project: "ml-pipeline",
    agent: "codex",
    category: "architecture/decision",
    messages: [
      { role: "user", content: "We need a feature store for our ML pipeline. Where should computed features be stored and versioned?" },
      { role: "assistant", content: "I recommend a two-tier feature store: 1) Offline store using Parquet files on S3 for batch features (computed daily), versioned by date partition and feature schema hash. 2) Online store using Redis for low-latency serving features (p99 < 5ms). The feature registry is a YAML manifest in git that defines each feature's schema, computation logic, and freshness SLA." },
      { role: "user", content: "How do we handle feature versioning when the computation logic changes?" },
      { role: "assistant", content: "Feature versioning uses semantic versioning in the registry. When computation logic changes: 1) Bump the feature version (e.g., user_embedding_v2), 2) Backfill the new version while keeping the old one active, 3) Update model configs to reference the new version, 4) Deprecate old version after all models migrate. Parquet partitions include the version: s3://features/user_embedding/v2/date=2024-01-15/. This allows A/B testing models on different feature versions." },
      { role: "user", content: "What about the columnar storage format for the features?" },
      { role: "assistant", content: "Parquet is ideal for our feature store. Benefits: 1) Columnar format enables reading only needed features without scanning entire rows, 2) Built-in compression (Snappy by default, Zstd for archival), 3) Schema evolution with column addition, 4) Predicate pushdown for efficient date range queries. For embeddings (float arrays), store as Parquet FLOAT arrays. Metadata in Parquet footer tracks feature statistics (min, max, null count) for data quality monitoring." },
      { role: "user", content: "Go with Parquet on S3 plus Redis. Use semantic versioning in the registry." },
      { role: "assistant", content: "Feature store design finalized: Offline (Parquet/S3, date-partitioned, version-prefixed), Online (Redis, sub-5ms p99), YAML registry with semver, backfill-then-migrate workflow for version upgrades." },
    ],
  },
  {
    id: "bench-s08",
    title: "Batch Inference Scaling",
    project: "ml-pipeline",
    agent: "codex",
    category: "feature/implementation",
    messages: [
      { role: "user", content: "Our batch inference job is too slow. Processing 10M records takes 6 hours. We need to scale it." },
      { role: "assistant", content: "The bottleneck is single-GPU sequential processing. The fix: 1) Async data loading with prefetch pipeline (load batch N+1 while GPU processes batch N), 2) Dynamic batching that groups similar-length sequences to minimize padding waste, 3) Model quantization with INT8 for 2x throughput on inference. With these changes, we should hit ~40k records/sec on a single A100." },
      { role: "user", content: "What about multi-GPU or distributed inference?" },
      { role: "assistant", content: "For multi-GPU: use PyTorch DataParallel or better, a Ray Serve deployment with model replicas. Ray handles load balancing across GPUs automatically. For our 10M record workload: 4 A100 GPUs with Ray Serve, each running INT8 quantized model, gives ~160k records/sec. Total time drops from 6 hours to ~62 seconds. The Ray cluster can auto-scale based on queue depth." },
      { role: "user", content: "Is the quantization accuracy loss acceptable?" },
      { role: "assistant", content: "INT8 quantization via PyTorch's dynamic quantization loses <0.1% accuracy on our validation set (F1 drops from 0.923 to 0.922). The speed gain is 2.1x on A100 with TensorRT. For even better accuracy preservation, we can use FP16 inference instead (1.6x speedup, zero measurable accuracy loss). I'd recommend FP16 for production and INT8 for non-critical batch jobs." },
      { role: "user", content: "Use FP16 for production inference with Ray Serve on 4 GPUs." },
      { role: "assistant", content: "Batch inference scaling plan: FP16 quantization (zero accuracy loss, 1.6x speedup), Ray Serve with 4 A100 replicas, async prefetch pipeline, dynamic batching by sequence length. Expected throughput: ~128k records/sec, 10M records in ~78 seconds." },
    ],
  },

  // ── project=infra, agent=claude-code ─────────────────────────────────
  {
    id: "bench-s09",
    title: "Kubernetes Migration",
    project: "infra",
    agent: "claude-code",
    category: "decision/technical",
    messages: [
      { role: "user", content: "We're migrating from bare EC2 instances to Kubernetes. What's the plan?" },
      { role: "assistant", content: "The Kubernetes migration plan: 1) Set up EKS cluster with managed node groups (m5.xlarge for general workloads, g4dn.xlarge for GPU), 2) Package each service as a Helm chart with values.yaml per environment, 3) Use namespace isolation: production, staging, development, 4) Implement resource limits and requests on all pods, 5) Set up horizontal pod autoscaler (HPA) based on CPU and custom metrics." },
      { role: "user", content: "How do we handle secrets and configuration?" },
      { role: "assistant", content: "Secrets management: AWS Secrets Manager integrated via External Secrets Operator. Secrets are synced to Kubernetes Secret objects automatically, rotated without pod restarts using the reloader controller. Configuration: ConfigMaps for non-sensitive config, separate per namespace. Environment variables injected via envFrom. No secrets in Helm values or git repos." },
      { role: "user", content: "What about pod scheduling and resource allocation?" },
      { role: "assistant", content: "Pod scheduling strategy: 1) Node affinity for GPU workloads (schedule only on g4dn nodes), 2) Pod anti-affinity for high-availability services (spread across AZs), 3) Resource requests: 256Mi memory, 250m CPU minimum per pod, 4) Resource limits: 2Gi memory, 2 CPU max, 5) Vertical Pod Autoscaler (VPA) in recommend mode to tune requests over time, 6) PodDisruptionBudgets ensuring at least 2 replicas during rolling updates." },
      { role: "user", content: "Proceed with EKS, Helm charts, namespace isolation, and External Secrets." },
      { role: "assistant", content: "Kubernetes migration finalized: EKS with managed node groups, Helm charts per service, namespace isolation (prod/staging/dev), External Secrets Operator for AWS Secrets Manager, HPA + VPA for autoscaling, pod anti-affinity for HA, PDBs for safe rolling updates." },
    ],
  },
  {
    id: "bench-s10",
    title: "CI/CD Pipeline Redesign",
    project: "infra",
    agent: "claude-code",
    category: "project/config",
    messages: [
      { role: "user", content: "Our CI/CD pipeline is too slow. GitHub Actions workflows take 45 minutes. Need to redesign." },
      { role: "assistant", content: "Analysis of the slow pipeline: 1) Docker build takes 20 min (no layer caching), 2) Tests run sequentially (15 min), 3) Linting and type-check are redundant passes (5 min each). Fix: 1) Use GitHub Actions matrix strategy to parallelize tests across 4 runners, 2) Enable Docker BuildKit with GitHub Actions cache, 3) Combine lint + type-check into a single job, 4) Add dependency caching for node_modules." },
      { role: "user", content: "What about the deployment step? We currently deploy manually." },
      { role: "assistant", content: "Automated deployment with environment protection: 1) On merge to main: auto-deploy to staging, run smoke tests, 2) Staging passes: create a deployment approval request for production, 3) On approval: canary deploy to production (10% traffic for 15 min), 4) If error rate stays below 0.1%: full rollout, else auto-rollback. Use GitHub Environments with required reviewers for production. ArgoCD syncs the Helm charts from git." },
      { role: "user", content: "How fast will the optimized pipeline be?" },
      { role: "assistant", content: "After optimization: 1) Docker build: 3 min (BuildKit cache hits), 2) Tests: 4 min (4-way parallel matrix), 3) Lint + typecheck: 2 min (single combined job), 4) Deploy to staging: 2 min. Total: ~11 min end-to-end, down from 45 min. The matrix strategy uses labels to split: unit tests, integration tests, e2e tests, and snapshot tests across runners." },
      { role: "user", content: "Implement the matrix strategy and ArgoCD deployment." },
      { role: "assistant", content: "CI/CD redesigned: GitHub Actions with matrix strategy (4-way parallel testing), Docker BuildKit caching, combined lint/typecheck job, ArgoCD for GitOps deployment, canary releases with auto-rollback on error rate threshold. Total pipeline: ~11 min, down from 45 min." },
    ],
  },
  {
    id: "bench-s11",
    title: "Database Sharding Strategy",
    project: "infra",
    agent: "claude-code",
    category: "architecture/design",
    messages: [
      { role: "user", content: "Our PostgreSQL database is hitting scaling limits. 500GB, 10k queries/sec. Need to shard." },
      { role: "assistant", content: "Sharding strategy for the main database: Use consistent hashing on tenant_id as the partition key. This gives even distribution across shards and allows adding new shards with minimal data movement. Proposed setup: 8 shards initially on RDS instances. A routing layer reads the tenant_id from each query and forwards to the correct shard using the hash ring." },
      { role: "user", content: "What about cross-shard queries? Some reports need data from all tenants." },
      { role: "assistant", content: "Cross-shard queries handled via a fan-out/fan-in pattern: 1) The query coordinator dispatches the same query to all 8 shards in parallel, 2) Each shard returns partial results, 3) The coordinator merges and aggregates. For heavy analytics, we maintain a read replica that combines all shards into a single denormalized analytics database using CDC (Change Data Capture) via Debezium. This isolates OLAP from OLTP workloads." },
      { role: "user", content: "How do we handle the consistent hashing when adding a new shard?" },
      { role: "assistant", content: "Adding a shard with consistent hashing and virtual nodes: 1) Each physical shard maps to 256 virtual nodes on the hash ring, 2) Adding shard 9 creates 256 new virtual nodes, redistributing ~12.5% of data (1/9th), 3) Data migration runs as a background process: copy affected key ranges to the new shard, update the routing table atomically, then delete migrated data from old shards. Zero downtime using double-write during migration." },
      { role: "user", content: "Go with consistent hashing on tenant_id, 8 shards, plus analytics replica via Debezium." },
      { role: "assistant", content: "Database sharding finalized: consistent hashing with 256 virtual nodes per shard on tenant_id, 8 initial RDS shards, fan-out/fan-in for cross-shard queries, Debezium CDC to analytics replica for OLAP isolation, zero-downtime shard addition via double-write migration." },
    ],
  },
  {
    id: "bench-s12",
    title: "Incident Postmortem: Production Outage",
    project: "infra",
    agent: "claude-code",
    category: "bug/fix",
    messages: [
      { role: "user", content: "We had a production outage last night. The API returned 500 errors for 23 minutes. What happened?" },
      { role: "assistant", content: "Root cause analysis: The connection pool to PostgreSQL was exhausted. pg_stat_activity showed 100 active connections (our max_connections limit) with 87 of them in 'idle in transaction' state. A deployment at 2:17 AM introduced a code path that opened a transaction but didn't close it on the error path, leaking connections on every failed validation." },
      { role: "user", content: "How did we not catch this in staging?" },
      { role: "assistant", content: "Staging has lower traffic volume (100 req/min vs 10k req/min in production) and a different connection pool size (20 vs 100). The leak rate was ~1 connection per 100 failed validations, which takes hours to manifest at staging traffic levels. The production pool filled in 23 minutes due to higher request volume and a spike in validation failures from a partner sending malformed data." },
      { role: "user", content: "What's the fix and how do we prevent this class of bug?" },
      { role: "assistant", content: "Immediate fix: Added try/finally block to ensure transaction rollback on all error paths. Prevention: 1) Add a connection pool watchdog that alerts when idle-in-transaction connections exceed 50% of pool, 2) Set idle_in_transaction_session_timeout to 60 seconds in PostgreSQL, 3) Add integration test that verifies connection count stays stable under error conditions, 4) Add pg_stat_activity monitoring to our Grafana dashboard." },
      { role: "user", content: "Implement all the prevention measures and fix the transaction leak." },
      { role: "assistant", content: "Fixes deployed: transaction leak fixed with try/finally, pg idle_in_transaction_session_timeout=60s, connection pool watchdog alerting at 50% idle-in-transaction, integration test for connection stability, Grafana pg_stat_activity dashboard. The 23-minute outage was caused by leaked database connections from unclosed transactions on the validation error path." },
    ],
  },
];

// =============================================================================
// Corpus Seeding
// =============================================================================

/**
 * Seed the benchmark corpus into a database.
 * Returns a manifest mapping session IDs to metadata.
 */
export async function seedCorpus(db: Database, _profile: BenchProfile): Promise<CorpusManifest> {
  const sessions = SESSIONS;
  const projects = [...new Set(sessions.map((s) => s.project))];
  const agents = [...new Set(sessions.map((s) => s.agent))];
  const categories = [...new Set(sessions.map((s) => s.category))];

  // Register projects
  for (const proj of projects) {
    upsertProject(db, proj, `/bench/${proj}`);
  }

  // Insert sessions and messages
  const messageIds = new Map<string, number>();

  for (const session of sessions) {
    let lastMsgId = 0;

    for (const msg of session.messages) {
      await addMessage(db, session.id, msg.role, msg.content, {
        title: session.title,
      });
      // Get the last inserted message ID
      const row = db
        .prepare("SELECT MAX(id) as mid FROM memory_messages WHERE session_id = ?")
        .get(session.id) as { mid: number } | null;
      if (row?.mid) lastMsgId = row.mid;
    }

    messageIds.set(session.id, lastMsgId);

    // Set session metadata
    upsertSessionMeta(db, session.id, session.agent, session.project);
    tagSession(db, session.id, session.category);

    // Insert sidecar content for the last message
    if (session.sidecar && lastMsgId) {
      const now = new Date().toISOString();

      if (session.sidecar.thinking) {
        insertThinking(db, lastMsgId, session.id, session.sidecar.thinking, now);
      }
      if (session.sidecar.artifact) {
        insertArtifact(
          db,
          lastMsgId,
          session.id,
          `artifact-${session.id}`,
          "code",
          session.sidecar.artifact.title,
          null,
          session.sidecar.artifact.language,
          session.sidecar.artifact.content,
          now
        );
      }
      if (session.sidecar.attachment) {
        insertAttachment(
          db,
          lastMsgId,
          session.id,
          session.sidecar.attachment.fileName,
          "text/markdown",
          session.sidecar.attachment.content.length,
          session.sidecar.attachment.content,
          now
        );
      }
    }
  }

  // Run FTS v2 migration to index sidecar content
  migrateFTSToV2(db);

  return { sessions, projects, agents, categories, messageIds };
}

/**
 * Initialize a fresh in-memory database for benchmarking.
 */
export function createBenchDb(): Database {
  const { Database } = require("bun:sqlite");
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);
  return db;
}
