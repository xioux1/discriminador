import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const PREPROCESSING_V2_AUTO_ENABLED_ENVS = new Set(['staging', 'production', 'prod']);

function parsePort(value) {
  if (!value) return DEFAULT_PORT;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('PORT must be a positive integer.');
  }

  return parsed;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function isSemanticCoreIdeaRescueEnabled() {
  return parseBoolean(process.env.ENABLE_SEMANTIC_CORE_IDEA_RESCUE, false);
}

export function isExperimentalOverallCoreOnlyEnabled() {
  return parseBoolean(process.env.ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY, false);
}

export function isPreprocessingV2Enabled() {
  if (process.env.ENABLE_PREPROCESSING_V2 === undefined) {
    const runtimeEnv = (process.env.APP_ENV || process.env.NODE_ENV || 'development').toLowerCase();
    return PREPROCESSING_V2_AUTO_ENABLED_ENVS.has(runtimeEnv);
  }

  return parseBoolean(process.env.ENABLE_PREPROCESSING_V2, false);
}

export const env = {
  host: process.env.HOST || DEFAULT_HOST,
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL || '',
  enableSemanticCoreIdeaRescue: isSemanticCoreIdeaRescueEnabled(),
  enableExperimentalOverallCoreOnly: isExperimentalOverallCoreOnlyEnabled(),
  enablePreprocessingV2: isPreprocessingV2Enabled()
};

export function isLLMJudgeEnabled() {
  if (process.env.ENABLE_LLM_JUDGE === undefined) {
    return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
  }

  return parseBoolean(process.env.ENABLE_LLM_JUDGE, false);
}

export const LLM_MODELS = {
  judge:    process.env.LLM_JUDGE_MODEL    || 'claude-haiku-4-5-20251001',
  socratic: process.env.LLM_SOCRATIC_MODEL || 'claude-haiku-4-5-20251001',
  micro:    process.env.LLM_MICRO_MODEL    || 'claude-haiku-4-5-20251001',
  advisor:  process.env.LLM_ADVISOR_MODEL  || 'claude-sonnet-4-6',
  binary:   process.env.LLM_BINARY_MODEL   || 'claude-opus-4-6'
};

export const DISCORD = {
  botToken: process.env.DISCORD_BOT_TOKEN || '',
  userId:   process.env.DISCORD_USER_ID   || ''
};

const VALID_CLAUDE_MODEL = /^claude-/i;

export function assertRequiredEnv() {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required.');
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters.');
  }
  if (isLLMJudgeEnabled() && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required when ENABLE_LLM_JUDGE=true.');
  }

  for (const [key, model] of Object.entries(LLM_MODELS)) {
    if (!VALID_CLAUDE_MODEL.test(model)) {
      throw new Error(`LLM model for '${key}' ("${model}") does not look like a valid Claude model name (must start with "claude-").`);
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[startup] OPENAI_API_KEY not set — speech-to-text (/transcribe) will return 503.');
  }
}
