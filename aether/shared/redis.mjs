// Shared Redis connection pool helper. Supports dynamic import of 'redis' to
// keep the project zero-dependency by default for local simulation runs.
let _redisClient = null;

export async function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (_redisClient) return _redisClient;

  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => console.error("[redis] client error:", err));
    await client.connect();
    _redisClient = client;
    return _redisClient;
  } catch (err) {
    console.error("[redis] failed to initialize client:", err);
    return null;
  }
}

export async function closeRedis() {
  if (_redisClient) {
    try {
      await _redisClient.quit();
    } catch (_) {
      // Ignore force close issues
    }
    _redisClient = null;
  }
}
