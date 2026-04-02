import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;

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

export const env = {
  host: process.env.HOST || DEFAULT_HOST,
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL || '',
  enableSemanticCoreIdeaRescue: isSemanticCoreIdeaRescueEnabled()
};

export function assertRequiredEnv() {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
}
