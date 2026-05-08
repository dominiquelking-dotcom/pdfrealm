module.exports = function mountDevAuth(app){
  if (!app || !app.post || !app.get) return;

  function getTok(req){
    try{
      const h = (req.headers && req.headers.authorization) ? String(req.headers.authorization) : "";
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (m) return (m[1] || "").trim();
    }catch(e){}
    try{
      const c = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
      const m = c.match(/(?:^|;\s*)pdfrealm_token=([^;]+)/);
      if (m) return decodeURIComponent(m[1] || "").trim();
    }catch(e){}
    return "";
  }

  // DEV login: returns a token + sets pdfrealm_token cookie (non-HttpOnly so frontend can read it)
  app.post("/api/login", (req, res) => {
    const email = (req.body && (req.body.email || req.body.username)) ? String(req.body.email || req.body.username) : "dev@local";
    const token = "dev." + Buffer.from(email).toString("base64").replace(/=+$/,"");
    try { res.cookie("pdfrealm_token", token, { httpOnly: false, sameSite: "lax" }); } catch (e) {}
    res.json({ ok: true, token, user: { email } });
  });

  app.get("/api/me", (req, res) => {
    const tok = getTok(req);
    if (!tok) return res.status(401).json({ ok: false, error: "Not authenticated" });
    res.json({ ok: true, user: { email: "dev@local" }, token: tok });
  });

  app.post("/api/logout", (_req, res) => {
    try { res.clearCookie("pdfrealm_token"); } catch (e) {}
    res.json({ ok: true });
  });
};
