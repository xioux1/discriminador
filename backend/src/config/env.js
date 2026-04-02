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

export const env = {
  host: process.env.HOST || DEFAULT_HOST,
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL || ''
};

export function assertRequiredEnv() {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
}
