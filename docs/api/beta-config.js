module.exports = function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  const url = process.env.SUPABASE_URL || "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
  if (!url || !publishableKey) {
    return response.status(503).json({ configured: false });
  }

  return response.status(200).json({ configured: true, url, publishableKey });
};
