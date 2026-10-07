// Loads .env for local scripts. On Vercel the env vars are already set.
export function loadEnv() {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function isDryRun(env = process.env) {
  return env.DRY_RUN === 'true';
}

export function need(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export function missing(names, env = process.env) {
  return names.filter((name) => !env[name]);
}
